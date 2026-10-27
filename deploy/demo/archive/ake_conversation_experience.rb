# Chatwoot 4.18: visitor receipts, truthful sender labels and website/email
# continuity through an already authenticated account-owned IMAP/SMTP inbox.
# Only explicitly mapped Website inboxes use the email bridge.
module AkeConversationExperience
  def self.enabled?(inbox)
    inbox&.web_widget? && AkeSeatRouting.enabled?(inbox.account_id)
  end

  def self.email_channel(inbox)
    return unless enabled?(inbox) && inbox.channel.continuity_via_email

    id = inbox.auto_assignment_config['ake_continuity_email_inbox_id'].to_i
    return unless id.positive?

    transport = inbox.account.inboxes.find_by(id: id, channel_type: 'Channel::Email')&.channel
    transport if transport&.imap_enabled && transport.smtp_enabled && transport.smtp_password.present?
  end

  def self.transport?(channel)
    return false unless channel.is_a?(Channel::Email) && AkeSeatRouting.enabled?(channel.account_id)

    channel.account.inboxes.where(channel_type: 'Channel::WebWidget').any? do |inbox|
      inbox.channel.continuity_via_email && inbox.auto_assignment_config['ake_continuity_email_inbox_id'].to_i == channel.inbox.id
    end
  end

  def self.reply_conversation(mail, channel)
    return unless transport?(channel)

    sender = Array(mail.from).first.to_s.downcase
    domain = channel.email.to_s.split('@').last.to_s.downcase
    references = (Array(mail.in_reply_to) + Array(mail.references).reverse).first(100)
    references.each do |reference|
      # Match an actual public outgoing message. Subject lines, arbitrary
      # conversation numbers, different senders and other accounts never join.
      match = reference.to_s.match(%r{\A<?conversation/([0-9a-f-]{36})/messages/(\d+)@([^<>\s]+)>?\z}i)
      next unless match && match[3].downcase == domain

      conversation = channel.account.conversations.find_by(uuid: match[1])
      next unless conversation && email_channel(conversation.inbox)&.id == channel.id
      next unless conversation.contact.email.to_s.downcase == sender && sender.present?
      next unless conversation.messages.where(id: match[2], private: false, message_type: [:outgoing, :template]).exists?

      return conversation
    end
    nil
  end

  def self.read_at(conversation)
    conversation.additional_attributes['ake_human_last_seen_at'].to_f
  end

  # Preserve the highest human viewing watermark when an agent marks a thread
  # unread later. AI processing never advances this watermark.
  module HumanRead
    def update_last_seen
      enabled = AkeConversationExperience.enabled?(@conversation.inbox)
      return head :forbidden if enabled && !Current.user.is_a?(User)

      result = super
      if enabled && Current.user.is_a?(User)
        # The native endpoint can throttle its own timestamp after an automatic
        # update. An authenticated human visit still supplies a genuine receipt.
        Conversation.where(id: @conversation.id).update_all([
          "additional_attributes = jsonb_set(COALESCE(additional_attributes, '{}'::jsonb), '{ake_human_last_seen_at}', " \
          "to_jsonb(GREATEST(COALESCE((additional_attributes->>'ake_human_last_seen_at')::double precision, 0), ?::double precision)), true)",
          Time.current.to_f
        ])
      end
      result
    end
  end

  module WebsiteMailer
    def reply_with_summary(conversation, last_queued_id)
      @ake_continuity_channel = AkeConversationExperience.email_channel(conversation.inbox)
      ake_tag_website_mail(super)
    end

    def reply_without_summary(conversation, last_queued_id)
      @ake_continuity_channel = AkeConversationExperience.email_channel(conversation.inbox)
      ake_tag_website_mail(super)
    end

    private

    def smtp_config_set_or_development?
      @ake_continuity_channel.present? || super
    end

    def email_from
      @ake_continuity_channel ? sender_name(@ake_continuity_channel.email) : super
    end

    def email_reply_to
      @ake_continuity_channel ? @ake_continuity_channel.email : super
    end

    def channel_email_domain
      @ake_continuity_channel ? @ake_continuity_channel.email.split('@').last : super
    end

    def custom_message_id
      return super unless @ake_continuity_channel

      message = @messages&.reverse&.find { |item| item.outgoing? || item.template? }
      return super unless message

      "<conversation/#{@conversation.uuid}/messages/#{message.id}@#{channel_email_domain}>"
    end

    def set_delivery_method
      return super unless @ake_continuity_channel

      channel = @ake_continuity_channel
      @options[:delivery_method] = :smtp
      @options[:delivery_method_options] = {
        address: channel.smtp_address, port: channel.smtp_port,
        user_name: channel.smtp_login, password: channel.smtp_password,
        domain: channel.smtp_domain, authentication: channel.smtp_authentication,
        tls: channel.smtp_enable_ssl_tls,
        enable_starttls_auto: channel.smtp_enable_starttls_auto,
        openssl_verify_mode: channel.smtp_openssl_verify_mode,
        **smtp_timeout_settings
      }
    end

    def ake_tag_website_mail(result)
      return result unless @ake_continuity_channel && result

      message = @messages&.reverse&.find(&:outgoing?)
      if message
        # Reuse the existing post-queue block/opt-out guard and MIME archive.
        result['X-AKE-Inbox-Message'] = message.id.to_s
        if message.sender.is_a?(AgentBot) || message.content_attributes['ake_inbox_job'].present?
          result['Auto-Submitted'] = 'auto-replied'
          result['X-Auto-Response-Suppress'] = 'All'
        end
      end
      result
    end
  end

  module ImapContinuity
    def process(mail, channel)
      target = AkeConversationExperience.reply_conversation(mail, channel)
      return super unless target

      @inbound_mail, @channel, @account = mail, channel, channel.account
      @conversation, @inbox = target, target.inbox
      @contact, @contact_inbox = target.contact, target.contact_inbox
      @processed_mail = MailPresenter.new(mail, @account)
      @ake_transport_inbox_id = channel.inbox.id
      @message = nil
      return unless incoming_email_from_valid_email?

      ActiveRecord::Base.transaction do
        @conversation.lock!
        create_message
        add_attachments_to_message
      end
    ensure
      @ake_transport_inbox_id = nil
    end

    private

    def sanitized_message_attributes(source_id)
      attributes = super
      if @ake_transport_inbox_id
        attributes[:content_attributes] = attributes[:content_attributes].merge(
          'ake_email_transport_inbox_id' => @ake_transport_inbox_id
        )
      end
      attributes
    end
  end

  # The native IMAP poller normally checks only the Email inbox for duplicate
  # Message-IDs. Continuity replies are stored in the Website inbox instead.
  module ImapDeduplication
    private

    def email_already_present?(channel, message_id)
      return true if super
      return false unless AkeConversationExperience.transport?(channel)

      # Chatwoot's JSON-coded store is serialized inside a JSON column; access
      # it through the model after narrowing by account and Message-ID.
      Message.where(account_id: channel.account_id, source_id: message_id).any? do |message|
        message.content_attributes['ake_email_transport_inbox_id'].to_i == channel.inbox.id
      end
    end
  end
end

class Api::V1::Widget::AkeConversationStateController < Api::V1::Widget::BaseController
  prepend_before_action :ake_require_visitor_token

  def show
    return head :not_found unless AkeConversationExperience.enabled?(@web_widget.inbox)

    ids = params[:ids].to_s.split(',').first(100).select { |id| id.match?(/\A\d+\z/) }.map(&:to_i)
    # Use Chatwoot's authenticated visitor scope, including its HMAC identity
    # rules. No email address, message text or internal notes leave this API.
    scope = conversations
    messages = Message.where(conversation_id: scope.select(:id), id: ids, private: false)
                      .where(message_type: [:incoming, :outgoing, :template]).includes(:sender, :conversation)
    payload = messages.map do |message|
      sender = message.sender
      api_ai = message.outgoing? && message.content_attributes['ake_inbox_job'].present?
      kind = (sender.is_a?(AgentBot) || api_ai) ? 'ai' : sender.is_a?(User) ? 'human' : 'system'
      name = kind == 'ai' ? 'AI Agent' : kind == 'human' ? sender.available_name : @web_widget.inbox.name
      receipt = if message.incoming?
                  AkeConversationExperience.read_at(message.conversation) >= message.created_at.to_f ? 'read' : 'delivered'
                end
      { id: message.id, direction: message.incoming? ? 'incoming' : 'outgoing',
        created_at: message.created_at.iso8601, sender_name: name, sender_kind: kind, receipt: receipt }
    end
    response.headers['Cache-Control'] = 'no-store'
    render json: { messages: payload, has_conversation: scope.exists?, has_email: @contact.email.present?,
                   email_continuity: AkeConversationExperience.email_channel(@web_widget.inbox).present? }
  end

  private

  def ake_require_visitor_token
    head :unauthorized if request.headers['X-Auth-Token'].blank?
  end
end

Rails.application.routes.prepend do
  get '/api/v1/widget/ake_conversation_state', to: 'api/v1/widget/ake_conversation_state#show'
end

def AkeConversationExperience.install!
  {
    Api::V1::Accounts::ConversationsController => AkeConversationExperience::HumanRead,
    ConversationReplyMailer => AkeConversationExperience::WebsiteMailer,
    Imap::ImapMailbox => AkeConversationExperience::ImapContinuity,
    Imap::BaseFetchEmailService => AkeConversationExperience::ImapDeduplication
  }.each { |klass, extension| klass.prepend(extension) unless klass < extension }
end
