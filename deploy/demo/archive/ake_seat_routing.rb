# Account-scoped seat isolation. Loaded by ake_inbox_control.rb on both web and worker.
Rails.application.config.filter_parameters += %i[imap_password smtp_password imap_login smtp_login message company email name q]
ActiveJob::Base.log_arguments = false
module AkeSeatRouting
  def self.enabled?(account_id)
    ENV['AKE_SEAT_ROUTING_ENABLED'] == 'true' && account_id.to_i == ENV.fetch('AKE_INBOX_ACCOUNT_ID', '1').to_i
  end

  def self.restricted?(user, account)
    enabled?(account&.id) && user.is_a?(User) && account.account_users.find_by(user_id: user.id)&.agent?
  end

  def self.owner(inbox)
    (inbox.auto_assignment_config || {})['ake_owner_id'].to_i
  end

  def self.owned_inbox_ids(user, account)
    account.inboxes.where("auto_assignment_config ->> 'ake_owner_id' = ?", user.id.to_s).select(:id)
  end

  def self.conversations(scope, user, account)
    return scope unless restricted?(user, account)

    scope.where(assignee_id: user.id)
  end

  def self.contact_ids(user, account)
    conversations(account.conversations, user, account).select(:contact_id)
  end

  def self.eligible_ids(inbox)
    inbox.account.account_users.agent.where(user_id: inbox.member_ids).includes(:user).select do |member|
      member.user.confirmed? && member.availability_status == 'online'
    end.map(&:user_id)
  end

  def self.enqueue_backlog(account)
    return unless enabled?(account.id)
    return unless Rails.cache.write("ake-seat-backlog:#{account.id}", true, expires_in: 15.seconds, unless_exist: true)

    AkeSeatBacklogJob.perform_later(account.id)
  end

  module ConversationAccess
    def show?
      return super unless AkeSeatRouting.restricted?(user, account)

      record.account_id == account.id && record.assignee_id == user.id
    end
  end

  module PermissionFilter
    def perform
      AkeSeatRouting.conversations(super, user, account)
    end
  end

  module Search
    private

    def should_run_advanced_search?
      return false if AkeSeatRouting.restricted?(current_user, current_account)

      super
    end

    def filter_conversations
      @conversations = AkeSeatRouting.conversations(super, current_user, current_account)
    end

    def message_base_query
      scope = super
      return scope unless AkeSeatRouting.restricted?(current_user, current_account)

      scope.where(conversation_id: AkeSeatRouting.conversations(current_account.conversations, current_user, current_account).select(:id))
    end

    def filter_contacts
      scope = super
      return scope unless AkeSeatRouting.restricted?(current_user, current_account)

      @contacts = scope.where(id: AkeSeatRouting.contact_ids(current_user, current_account))
    end
  end

  module Notifications
    private

    def find_all_notifications
      super
      return unless AkeSeatRouting.restricted?(current_user, current_account)

      @notifications = @notifications.where(primary_actor_type: 'Conversation',
        primary_actor_id: AkeSeatRouting.conversations(current_account.conversations, current_user, current_account).select(:id))
    end
  end

  module NotificationAccess
    private

    def fetch_notification
      super
      return unless AkeSeatRouting.restricted?(Current.user, Current.account)
      raise Pundit::NotAuthorizedError unless @notification.primary_actor_type == 'Conversation' &&
        AkeSeatRouting.conversations(Current.account.conversations, Current.user, Current.account).exists?(id: @notification.primary_actor_id)
    end
  end

  module Contacts
    private

    def ake_contacts_scope(scope)
      return scope unless AkeSeatRouting.restricted?(Current.user, Current.account)

      scope.where(id: AkeSeatRouting.contact_ids(Current.user, Current.account))
    end

    def fetch_contacts(contacts)
      super(ake_contacts_scope(contacts))
    end

    def fetch_contacts_with_has_more(contacts)
      super(ake_contacts_scope(contacts))
    end

    def fetch_contact
      super
      return unless AkeSeatRouting.restricted?(Current.user, Current.account)
      raise Pundit::NotAuthorizedError unless AkeSeatRouting.contact_ids(Current.user, Current.account).where(contact_id: @contact.id).exists?
    end
  end

  module ContactFilter
    def base_relation
      scope = super
      return scope unless AkeSeatRouting.restricted?(@user, @account)

      scope.where(id: AkeSeatRouting.contact_ids(@user, @account))
    end
  end

  module ContactChildren
    private

    def ensure_contact
      super
      return unless AkeSeatRouting.restricted?(Current.user, Current.account)
      raise Pundit::NotAuthorizedError unless AkeSeatRouting.contact_ids(Current.user, Current.account).where(contact_id: @contact.id).exists?
    end
  end

  module Availability
    def available_agents
      return super unless AkeSeatRouting.enabled?(account_id)

      inbox_members.where(user_id: AkeSeatRouting.eligible_ids(self)).includes(:user)
    end

    def member_ids_with_assignment_capacity
      return super unless AkeSeatRouting.enabled?(account_id)

      super & AkeSeatRouting.eligible_ids(self)
    end
  end

  module RoundRobin
    def available_agent(allowed_agent_ids: [])
      return if ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true' && AkeSeatRouting.enabled?(inbox.account_id)
      return super unless AkeSeatRouting.enabled?(inbox.account_id)

      allowed = allowed_agent_ids.map(&:to_s) & AkeSeatRouting.eligible_ids(inbox).map(&:to_s)
      return if allowed.empty?

      # Redis queue rotation must be serialized across simultaneous conversations.
      Inbox.connection_pool.with_connection do |connection|
        connection.transaction do
          connection.execute("SELECT pg_advisory_xact_lock(48231, #{Integer(inbox.id)})")
          super(allowed_agent_ids: allowed)
        end
      end
    end
  end

  module PersonalAssignment
    def ake_assign_personal_owner
      return if ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true'
      return unless AkeSeatRouting.enabled?(account_id) && inbox
      id = AkeSeatRouting.owner(inbox)
      return unless id.positive?

      if (inbox.auto_assignment_config || {})['ake_admin_owned'] == true
        self.assignee_id = id if account.account_users.administrator.exists?(user_id: id)
        return
      end
      member = account.account_users.agent.find_by(user_id: id)
      self.assignee_id = id if member&.user&.confirmed? && member.availability_status == 'online'
    end
  end

  module AssignmentControl
    def create
      if AkeSeatRouting.restricted?(Current.user, Current.account)
        # Agents cannot move conversations to another seat or claim others' work.
        raise Pundit::NotAuthorizedError unless params[:assignee_id].to_i == Current.user.id && params[:team_id].blank?
      end
      if AkeSeatRouting.enabled?(Current.account.id) && params[:assignee_id].present? && params[:assignee_type] != 'AgentBot'
        member = Current.account.account_users.find_by(user_id: params[:assignee_id])
        raise Pundit::NotAuthorizedError unless member&.agent? && member.user.confirmed?
      end
      super
    end
  end

  module Presence
    private

    def update_subscription
      super
      AkeSeatRouting.enqueue_backlog(@current_account) if @current_account && @current_user.is_a?(User)
    end
  end

  module Broadcast
    def perform(members, event_name, data)
      payload = data.with_indifferent_access
      account = Account.find_by(id: payload[:account_id])
      return super unless account && AkeSeatRouting.enabled?(account.id)

      cid = if event_name.start_with?('conversation.') || %w[assignee.changed team.changed].include?(event_name)
              payload.dig(:conversation, :id) || payload[:id]
            elsif event_name.start_with?('message.') || event_name == 'first.reply.created'
              payload[:conversation_id] || payload.dig(:conversation, :id)
            elsif event_name.start_with?('notification.')
              payload.dig(:notification, :primary_actor, :id)
            end
      conversation = account.conversations.find_by(display_id: cid) if cid
      if cid
        allowed_users = account.administrators.pluck(:id) + [conversation&.assignee_id]
        all_user_tokens = account.users.pluck(:pubsub_token)
        permitted_tokens = account.users.where(id: allowed_users.compact).pluck(:pubsub_token)
        # Contact tokens remain unchanged; only staff receive staff-scoped events.
        members = (members - all_user_tokens - ["account_#{account.id}"]) + (members & permitted_tokens)
      elsif event_name.start_with?('contact.')
        contact_id = payload[:id]
        owners = account.conversations.where(contact_id: contact_id).pluck(:assignee_id)
        members = account.users.where(id: account.administrators.pluck(:id) + owners.compact).pluck(:pubsub_token)
      end
      super(members.uniq, event_name, data)
    end
  end

  module WidgetAgents
    def index
      super
      return unless AkeSeatRouting.enabled?(@web_widget.inbox.account_id)

      @inbox_members = @inbox_members.where(user_id: AkeSeatRouting.eligible_ids(@web_widget.inbox))
    end
  end

  module Assets
    def ake_seat_assets
      return unless response.media_type == 'text/html' && ENV['AKE_SEAT_ROUTING_ENABLED'] == 'true'
      asset = is_a?(WidgetsController) ? 'ake-offline-widget.js' : 'ake-seat-nav.js'
      return unless is_a?(WidgetsController) || controller_name == 'dashboard'

      experience = is_a?(WidgetsController) ? '<script src="/ake/assets/ake-conversation-widget.js" defer></script>' : ''
      response.body = response.body.sub('</body>', "<script src=\"/ake/assets/ake-api.js\" defer></script><script src=\"/ake/assets/#{asset}\" defer></script>#{experience}</body>")
      response.headers.delete('Content-Length')
    end
  end
end

class AkeSeatBacklogJob < ApplicationJob
  queue_as :low
  def perform(account_id)
    return if ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true'
    return unless AkeSeatRouting.enabled?(account_id)

    account = Account.find(account_id)
    account.inboxes.where(channel_type: 'Channel::WebWidget', enable_auto_assignment: true).find_each do |inbox|
      next if AkeSeatRouting.eligible_ids(inbox).empty?
      inbox.conversations.unassigned.open.order(:created_at).limit(50).each do |conversation|
        AutoAssignment::AgentAssignmentService.new(conversation: conversation, allowed_agent_ids: AkeSeatRouting.eligible_ids(inbox)).perform
      end
    end
    account.inboxes.where("auto_assignment_config ? 'ake_owner_id'").find_each do |inbox|
      owner = AkeSeatRouting.owner(inbox)
      next unless AkeSeatRouting.eligible_ids(inbox).include?(owner)

      inbox.conversations.unassigned.open.order(:created_at).limit(50).each do |conversation|
        conversation.with_lock { conversation.update!(assignee_id: owner) if conversation.assignee_id.nil? }
      end
    end
  end
end

begin
  {
    ConversationPolicy => AkeSeatRouting::ConversationAccess,
    Conversations::PermissionFilterService => AkeSeatRouting::PermissionFilter,
    SearchService => AkeSeatRouting::Search,
    NotificationFinder => AkeSeatRouting::Notifications,
    Api::V1::Accounts::NotificationsController => AkeSeatRouting::NotificationAccess,
    Api::V1::Accounts::ContactsController => AkeSeatRouting::Contacts,
    Api::V1::Accounts::Contacts::BaseController => AkeSeatRouting::ContactChildren,
    Contacts::FilterService => AkeSeatRouting::ContactFilter,
    Inbox => AkeSeatRouting::Availability,
    AutoAssignment::InboxRoundRobinService => AkeSeatRouting::RoundRobin,
    Api::V1::Accounts::Conversations::AssignmentsController => AkeSeatRouting::AssignmentControl,
    RoomChannel => AkeSeatRouting::Presence,
    ActionCableBroadcastJob => AkeSeatRouting::Broadcast,
    Api::V1::Widget::InboxMembersController => AkeSeatRouting::WidgetAgents
  }.each { |klass, extension| klass.prepend(extension) unless klass < extension }
  unless Conversation < AkeSeatRouting::PersonalAssignment
    Conversation.include(AkeSeatRouting::PersonalAssignment)
    Conversation.before_validation :ake_assign_personal_owner, on: :create
  end
  [ApplicationController, DashboardController, WidgetsController].each do |klass|
    next if klass < AkeSeatRouting::Assets

    klass.include(AkeSeatRouting::Assets)
    klass.after_action :ake_seat_assets
  end
end

require_relative 'ake_seat_channels'
