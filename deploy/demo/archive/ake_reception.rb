# Authoritative office presence and assignment. All AI message creation shares
# the same lock as heartbeats, so a newly online seat fences a delayed AI reply.
module AkeReception
  LEASE = 75.seconds
  def self.enabled?(account_id)
    ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true' && AkeSeatRouting.enabled?(account_id)
  end

  def self.lock(account_id, &block)
    Account.transaction do
      Account.connection.execute("SELECT pg_advisory_xact_lock(48232, #{Integer(account_id)})")
      block.call
    end
  end

  def self.online_ids(inbox)
    # Legacy mail/WhatsApp channels explicitly owned by an administrator remain
    # receivable by that owner; administrators do not enter the shared seat pool.
    settings = inbox.auto_assignment_config || {}
    inbox.account.account_users.where(user_id: inbox.member_ids).includes(:user).select do |member|
      eligible_role = member.agent? || (member.administrator? && settings['ake_admin_owned'] == true && settings['ake_owner_id'].to_i == member.user_id)
      eligible_role && member.user.confirmed? && member.availability == 'online' &&
        leased?(inbox.account_id, member.user_id)
    end.map(&:user_id).sort
  end

  def self.instance_key(account_id, user_id)
    "ake-reception-instances:#{account_id}:#{user_id}"
  end

  def self.leased?(account_id, user_id)
    now = Time.now.to_f
    Redis::Alfred.get("ake-reception:#{account_id}:#{user_id}").to_f > now ||
      Redis::Alfred.zcount(instance_key(account_id, user_id), "(#{now}", '+inf').positive?
  end

  # The account lock also fences assignment and AI delivery. Releasing a desktop
  # instance must never change another instance's or an older web client's lease.
  def self.renew_instance(account_id, user_id, client_id, online)
    key = instance_key(account_id, user_id)
    now = Time.now.to_f
    Redis::Alfred.with do |redis|
      redis.zremrangebyscore(key, '-inf', now)
      if online
        redis.zadd(key, [[now + LEASE.to_f, client_id]])
        redis.expire(key, LEASE.to_i)
      else
        redis.zrem(key, client_id)
      end
    end
  end

  def self.route(conversation)
    lock(conversation.account_id) do
      conversation.reload
      ids = online_ids(conversation.inbox)
      owner = ids.include?(conversation.assignee_id) ? conversation.assignee_id : nil
      if owner.nil? && ids.any?
        inbox = conversation.inbox
        cursor = (inbox.auto_assignment_config || {})['ake_reception_cursor'].to_i
        owner = ids.find { |id| id > cursor } || ids.first
        inbox.update!(auto_assignment_config: (inbox.auto_assignment_config || {}).merge('ake_reception_cursor' => owner))
      end
      conversation.update!(assignee_id: owner) if conversation.assignee_id != owner
      { mode: owner ? 'human' : 'ai', assigneeId: owner, onlineCount: ids.length, leaseSeconds: LEASE.to_i }
    end
  end

  module Eligibility
    def eligible_ids(inbox)
      return super unless AkeReception.enabled?(inbox.account_id)
      AkeReception.online_ids(inbox)
    end
  end

  module AvailabilityFence
    def ake_fence_availability_change
      return unless AkeReception.enabled?(account_id) && will_save_change_to_availability?
      # Native profile-menu changes must use the same fence as our heartbeat UI.
      self.class.connection.execute("SELECT pg_advisory_xact_lock(48232, #{Integer(account_id)})")
    end
  end

  module OfficeIngress
    def perform(url, payload, webhook_type = :account_webhook, secret: nil, delivery_id: nil)
      account_id = payload.dig(:account, :id) || payload.dig('account', 'id')
      trusted = [ENV['AKE_OFFICE_INGRESS_URL'], ENV['AKE_OFFICE_WHATSAPP_DISPATCH_URL']].compact
      return super unless trusted.include?(url) && secret.present? && AkeReception.enabled?(account_id)

      attributes = payload.with_indifferent_access
      if url == ENV['AKE_OFFICE_WHATSAPP_DISPATCH_URL'] && attributes.dig(:content_attributes, :ake_inbox_job)
        conversation = Conversation.find_by!(account_id: account_id, display_id: attributes.dig(:conversation, :id))
        return AkeReception.lock(account_id) do
          next if AkeReception.online_ids(conversation.inbox).any?
          ake_deliver_to_office(url, payload, secret, delivery_id)
        end
      end
      ake_deliver_to_office(url, payload, secret, delivery_id)
    end

    private

    def ake_deliver_to_office(url, payload, secret, delivery_id)

      # Only the operator-configured office endpoint can use the private network.
      # All other webhooks retain Chatwoot's normal SSRF protection.
      uri = URI(url)
      body = JSON.generate(payload)
      stamp = Time.now.to_i.to_s
      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request['X-Chatwoot-Timestamp'] = stamp
      request['X-Chatwoot-Signature'] = 'sha256=' + OpenSSL::HMAC.hexdigest('SHA256', secret, stamp + '.' + body)
      request['X-Chatwoot-Delivery'] = delivery_id if delivery_id
      request.body = body
      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 3, read_timeout: 30) { |http| http.request(request) }
      # Raising retains the job in Sidekiq's durable retry queue. Core deduplicates
      # by the native message/event identity, including after uncertain timeouts.
      raise AkeInboxControl::Unavailable, 'Office ingress has not acknowledged this event' unless response.is_a?(Net::HTTPSuccess)
    end
  end

  module AiMessageFence
    def perform
      attributes = content_attributes
      return super unless AkeReception.enabled?(@conversation.account_id) &&
        (attributes['ake_inbox_job'] || attributes[:ake_inbox_job])

      AkeReception.lock(@conversation.account_id) do
        raise AkeInboxControl::Unavailable, 'An online receptionist owns reception' if AkeReception.online_ids(@conversation.inbox).any?
        super
      end
    end
  end

  # Recheck after queue delay, before a provider delivery job starts.
  module DeliveryFence
    def perform(message_id)
      message = Message.find(message_id)
      return super unless AkeReception.enabled?(message.account_id) && message.content_attributes['ake_inbox_job'].present?
      AkeReception.lock(message.account_id) do
        return AkeInboxControl.prevent_delivery(message) if AkeReception.online_ids(message.inbox).any?
        super
      end
    end
  end
end

class Api::V1::Accounts::AkeReceptionController < Api::V1::Accounts::BaseController
  def heartbeat
    return head :not_found unless AkeReception.enabled?(Current.account.id)
    return head :forbidden unless (Current.account_user.agent? || Current.account_user.administrator?) && Current.user.confirmed?
    state = params[:state]
    return head :unprocessable_entity unless state.nil? || %w[online offline].include?(state)
    client_id = params[:clientId]
    return head :unprocessable_entity if client_id && !client_id.to_s.match?(/\A[a-zA-Z0-9_-]{16,64}\z/)
    result = AkeReception.lock(Current.account.id) do
      member = Current.account_user.reload
      # Explicit native profile changes still pause the whole account. Desktop
      # pause/release only removes this instance, so a second device stays online.
      member.update!(availability: state) if state && (!client_id || state == 'online')
      online = member.reload.availability == 'online'
      if client_id
        instance_online = online && state != 'offline'
        AkeReception.renew_instance(Current.account.id, Current.user.id, client_id, instance_online)
      else
        key = "ake-reception:#{Current.account.id}:#{Current.user.id}"
        online ? Redis::Alfred.set(key, Time.now.to_f + AkeReception::LEASE, ex: AkeReception::LEASE.to_i) : Redis::Alfred.delete(key)
        instance_online = online
      end
      { online: online && AkeReception.leased?(Current.account.id, Current.user.id), instanceOnline: instance_online,
        protocolVersion: 2, leaseSeconds: AkeReception::LEASE.to_i, userId: Current.user.id }
    end
    response.headers['Cache-Control'] = 'no-store'
    render json: result
  end

  def desktop
    return head :not_found unless AkeReception.enabled?(Current.account.id)
    return head :forbidden unless (Current.account_user.agent? || Current.account_user.administrator?) && Current.user.confirmed?

    # Counts come from native read watermarks, never from a client-side guess.
    # Even administrators only get notifications for conversations assigned to
    # themselves. No customer text/contact data is sent to the desktop bridge.
    scope = Current.account.conversations.where(assignee_id: Current.user.id)
    scope = scope.where(inbox_id: Current.user.inboxes.select(:id)) unless Current.account_user.administrator?
    incoming = Current.account.messages.incoming.reorder(nil).where(private: false)
      .joins(:conversation).merge(scope)
      .where('conversations.assignee_last_seen_at IS NULL OR messages.created_at > conversations.assignee_last_seen_at')
    rows = incoming.group('conversations.display_id').order(Arel.sql('MAX(messages.id) DESC'))
      .limit(100).pluck('conversations.display_id', Arel.sql('MAX(messages.id)'), Arel.sql('COUNT(*)'))
    response.headers['Cache-Control'] = 'no-store'
    render json: { protocolVersion: 2, userId: Current.user.id, accountId: Current.account.id,
      pubsubToken: Current.user.pubsub_token, unreadCount: incoming.count,
      conversations: rows.map { |id, last_id, count| { conversationId: id, lastMessageId: last_id, unreadCount: count } } }
  end
end

# Internal Core credential only; never grants a seat access to other seats' work.
class AkeReceptionRoutingController < ActionController::Base
  skip_forgery_protection
  before_action :authenticate_office
  def route
    render json: AkeReception.route(@conversation)
  end

  def status
    # This read must not acquire the account lock: native send admission can
    # call it while its caller already holds that lock.
    ids = AkeReception.online_ids(@conversation.inbox)
    render json: { mode: ids.any? ? 'human' : 'ai', assigneeId: @conversation.assignee_id, onlineCount: ids.length }
  end

  private

  def authenticate_office
    key = ENV.fetch('AKE_INBOX_INTERNAL_KEY', '')
    supplied = request.headers['x-inbox-key'].to_s
    return head :unauthorized if key.empty? || !ActiveSupport::SecurityUtils.secure_compare(key, supplied)
    account_id = ENV.fetch('AKE_INBOX_ACCOUNT_ID', '1').to_i
    return head :not_found unless AkeReception.enabled?(account_id)
    @conversation = Conversation.find_by!(account_id: account_id, display_id: params[:conversationId])
    head :forbidden unless AkeInboxControl.enabled?(@conversation)
  end
end

AkeSeatRouting.singleton_class.prepend(AkeReception::Eligibility) unless AkeSeatRouting.singleton_class < AkeReception::Eligibility
unless AccountUser < AkeReception::AvailabilityFence
  AccountUser.include(AkeReception::AvailabilityFence)
  AccountUser.before_update :ake_fence_availability_change
end
Messages::MessageBuilder.prepend(AkeReception::AiMessageFence) unless Messages::MessageBuilder < AkeReception::AiMessageFence
SendReplyJob.prepend(AkeReception::DeliveryFence) unless SendReplyJob < AkeReception::DeliveryFence
WebhookJob.prepend(AkeReception::OfficeIngress) unless WebhookJob < AkeReception::OfficeIngress
Rails.application.routes.prepend do
  post '/api/v1/accounts/:account_id/ake_reception/heartbeat', to: 'api/v1/accounts/ake_reception#heartbeat'
  get '/api/v1/accounts/:account_id/ake_reception/desktop', to: 'api/v1/accounts/ake_reception#desktop'
  post '/ake/internal/reception/route', to: 'ake_reception_routing#route'
  post '/ake/internal/reception/status', to: 'ake_reception_routing#status'
end
