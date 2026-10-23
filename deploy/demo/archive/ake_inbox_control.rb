# Account-scoped Chatwoot v4.18 extension. Fail closed for sends/notifications,
# preserve incoming records and the independent original archive.
require 'net/http'
require 'json'
module AkeInboxControl
  class Unavailable < StandardError
    attr_reader :status
    def initialize(message, status=503)
      super(message)
      @status=status
    end
  end
  def self.enabled?(conversation)
    return false unless ENV['AKE_INBOX_V2_ENABLED'] == 'true' && conversation.account_id == ENV.fetch('AKE_INBOX_ACCOUNT_ID','1').to_i
    return false if ENV.fetch('AKE_INBOX_EXCLUDED','').split(',').map(&:to_i).include?(conversation.display_id)
    return true if ENV.fetch('AKE_INBOX_IDS','').split(',').map(&:to_i).include?(conversation.inbox_id)
    return false unless ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true'
    # A seat may bind a new mailbox after cutover. Trust native ownership and
    # membership, never an inbox id supplied by a webhook or browser.
    inbox = conversation.inbox
    owner = (inbox.auto_assignment_config || {})['ake_owner_id'].to_i
    return false unless owner.positive? && inbox.account_id == conversation.account_id && inbox.member_ids.include?(owner)
    inbox.channel_type == 'Channel::Email' || (inbox.channel_type == 'Channel::Api' && inbox.channel.additional_attributes['ake_instance'].to_s.match?(/\Aake-seat-\d+\z/))
  end
  def self.call(path, payload)
    uri=URI(ENV.fetch('AKE_INBOX_CORE_URL')+'/api/v1/inbox-v2/'+path)
    request=Net::HTTP::Post.new(uri); request['Content-Type']='application/json';request['x-inbox-key']=ENV.fetch('AKE_INBOX_INTERNAL_KEY')
    request.body=JSON.generate(payload)
    result=Net::HTTP.start(uri.hostname,uri.port,open_timeout:2,read_timeout:8){|http|http.request(request)}
    raise Unavailable.new('Inbox control unavailable', result.code.to_i) unless result.is_a?(Net::HTTPSuccess)
    JSON.parse(result.body)
  end
  def self.allowed?(conversation, attributes={})
    return true unless enabled?(conversation)
    return false if conversation.contact.blocked?
    call('admission',{accountId:conversation.account_id,conversationId:conversation.display_id,jobId:attributes['ake_inbox_job']||attributes[:ake_inbox_job],revision:attributes['ake_inbox_revision']||attributes[:ake_inbox_revision]})['allowed']==true
  rescue StandardError
    false
  end
  module Builder
    def perform
      if AkeInboxControl.enabled?(@conversation) && ['outgoing',1].include?(@message_type) && !ActiveModel::Type::Boolean.new.cast(@private)
        attributes=content_attributes
        # A job reference is accepted only if Core verifies its persisted state.
        raise AkeInboxControl::Unavailable,'Sending is paused or contact is blocked' unless AkeInboxControl.allowed?(@conversation,attributes)
        unless attributes['ake_inbox_job']||attributes[:ake_inbox_job]
          AkeInboxControl.call('human-reply',{accountId:@conversation.account_id,conversationId:@conversation.display_id})
        end
      end
      super
    end
  end
  module SendJob
    def perform(message_id)
      message=Message.find(message_id)
      return unless AkeInboxControl.allowed?(message.conversation,message.content_attributes||{})
      super
    end
  end
  module Notifications
    def perform
      return unless AkeInboxControl.allowed?(message.conversation)
      super
    end
  end
  module NotificationCreation
    def perform
      conversation=primary_actor.is_a?(Conversation) ? primary_actor : primary_actor.try(:conversation)
      return if conversation && !AkeInboxControl.allowed?(conversation)
      super
    end
  end
  module ContactChanges
    def ake_sync_block
      return unless ENV['AKE_INBOX_V2_ENABLED']=='true' && account_id==ENV.fetch('AKE_INBOX_ACCOUNT_ID','1').to_i && will_save_change_to_blocked?
      AkeInboxControl.call('native-block',{accountId:account_id,contactId:id,blocked:blocked})
    end
  end
  # Mail is checked again by the delivery interceptor, after native queue delays.
  module MailTag
    def email_reply(message)
      result=super
      if result && AkeInboxControl.enabled?(message.conversation)
        result['X-AKE-Inbox-Message']=message.id.to_s
        if message.content_attributes['ake_inbox_job'].present?
          result['Auto-Submitted']='auto-replied'
          result['X-Auto-Response-Suppress']='All'
        end
      end
      result
    end
  end
  class DeliveryGuard
    def self.delivering_email(mail)
      id=mail['X-AKE-Inbox-Message']&.value
      return unless id && id.match?(/\A\d+\z/)
      message=Message.find_by(id:id)
      unless message && AkeInboxControl.allowed?(message.conversation,message.content_attributes||{})
        mail.perform_deliveries=false
        return
      end
      AkeArchive.capture_raw_email(message.inbox.channel,Mail.read_from_string(mail.encoded))
    end
  end
end

Rails.application.config.to_prepare do
  require '/opt/ake-archive/ake_mail_loop_guard'
  AkeMailLoopGuard.install!
  require '/opt/ake-archive/ake_seat_routing' if ENV['AKE_SEAT_ROUTING_ENABLED'] == 'true'
  require '/opt/ake-archive/ake_conversation_experience' if ENV['AKE_SEAT_ROUTING_ENABLED'] == 'true'
  AkeConversationExperience.install! if ENV['AKE_SEAT_ROUTING_ENABLED'] == 'true'
  Messages::MessageBuilder.prepend(AkeInboxControl::Builder) unless Messages::MessageBuilder < AkeInboxControl::Builder
  SendReplyJob.prepend(AkeInboxControl::SendJob) unless SendReplyJob < AkeInboxControl::SendJob
  Messages::NewMessageNotificationService.prepend(AkeInboxControl::Notifications) unless Messages::NewMessageNotificationService < AkeInboxControl::Notifications
  unless Contact < AkeInboxControl::ContactChanges
    Contact.include(AkeInboxControl::ContactChanges)
    Contact.before_update :ake_sync_block
  end
  NotificationBuilder.prepend(AkeInboxControl::NotificationCreation) unless NotificationBuilder < AkeInboxControl::NotificationCreation
  ConversationReplyMailer.prepend(AkeInboxControl::MailTag) unless ConversationReplyMailer < AkeInboxControl::MailTag
  require '/opt/ake-archive/ake_reception' if ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true'
end
# Leave Action Mailer unloaded until Chatwoot's mailer initializer sets SMTP.
# Eagerly loading it here freezes Rails' localhost:25 defaults for system mail.
ActiveSupport.on_load(:action_mailer) do
  register_interceptor(AkeInboxControl::DeliveryGuard)
end

# Widget requests arrive through the private reverse proxy. Its forwarded IP is
# supplied by Caddy, not accepted from an arbitrary Internet client header.
if defined?(Rack::Attack) && ENV['AKE_INBOX_V2_ENABLED']=='true'
  Rack::Attack.throttle('ake/inbox/widget',limit:40,period:60) do |request|
    if request.post? && request.path.match?(%r{\A/api/v1/widget/(messages|conversations|ake_offline)\z})
      request.ip
    end
  end
end
