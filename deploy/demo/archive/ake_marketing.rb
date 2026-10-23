# Native authentication and seat policy remain authoritative for marketing views.
require 'net/http'
require 'json'

class AkeMarketingEventJob < ApplicationJob
  queue_as :default
  retry_on AkeInboxControl::Unavailable, wait: :polynomially_longer, attempts: 5
  def perform(message_id)
    message=Message.find_by(id: message_id)
    return unless message && AkeInboxControl.enabled?(message.conversation)
    AkeInboxControl.call('events', message.webhook_data.merge(event: 'message_created'))
  end
end

module AkeMarketingMessageEvents
  def ake_marketing_publish
    return unless ENV['AKE_MARKETING_ENABLED']=='true' && AkeInboxControl.enabled?(conversation)
    AkeMarketingEventJob.perform_later(id) if incoming? && !private?
  end
end
Message.include(AkeMarketingMessageEvents)
Message.after_create_commit(:ake_marketing_publish)

class Api::V1::Accounts::AkeMarketingController < Api::V1::Accounts::BaseController
  def dispatch_action
    raise Pundit::NotAuthorizedError unless ENV['AKE_MARKETING_ENABLED'] == 'true' && Current.user.is_a?(User) && Current.user.confirmed? && AkeSeatRouting.enabled?(Current.account.id)
    token = Current.user.access_token.token
    result = AkeInboxControl.call('marketing/native', {accountId: Current.account.id, userId: Current.user.id, token: token, action: params[:operation], input: params[:input]&.to_unsafe_h || {}})
    response.headers['Cache-Control'] = 'no-store'
    render json: result
  rescue AkeInboxControl::Unavailable => error
    render json: {error: '营销服务拒绝了该操作，请检查权限或刷新后重试。'}, status: [400,401,403,404,409,422,429,503].include?(error.status) ? error.status : 503
  end
end

class AkeMarketingIntakeController < ActionController::API
  def create
    expected = ENV.fetch('AKE_INBOX_INTERNAL_KEY','')
    supplied = request.headers['x-inbox-key'].to_s
    return head :unauthorized unless ENV['AKE_MARKETING_ENABLED'] == 'true' && expected.present? && ActiveSupport::SecurityUtils.secure_compare(supplied, expected)
    account_id = params[:accountId].to_i
    return head :forbidden unless account_id == ENV.fetch('AKE_INBOX_ACCOUNT_ID','1').to_i
    inquiry = params[:inquiryId].to_s
    return head :unprocessable_entity unless inquiry.match?(/\A[0-9a-f-]{36}\z/)
    account = Account.find(account_id)
    inbox = account.inboxes.find(params[:inboxId])
    reference = params[:visitorReference].to_s
    return head :unprocessable_entity unless reference.match?(/\A[0-9a-f-]{36,64}\z/)
    receipt = ActiveRecord::Base.transaction do
      connection = ActiveRecord::Base.connection
      lock = connection.quote("ake-marketing:#{account.id}:#{reference}")
      connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(#{lock},0))")
      conversation = account.conversations.where("additional_attributes->>'ake_inquiry_id' = ?", inquiry).first
      unless conversation
        identifier = "ake-website:#{reference}"
        contact = account.contacts.find_by(identifier: identifier)
        contact ||= account.contacts.create!(identifier: identifier, name: params[:name].to_s[0,120].presence || 'Website visitor', additional_attributes: {ake_identity_status: 'unverified'})
        contact_inbox = ContactInbox.find_or_create_by!(contact: contact, inbox: inbox) { |ci| ci.source_id = SecureRandom.uuid }
        conversation = account.conversations.create!(contact: contact, contact_inbox: contact_inbox, inbox: inbox, status: :open,
          additional_attributes: {ake_inquiry_id: inquiry, ake_offline_submission: true, ake_marketing_receipt: 'persisted_form'})
        fields = params[:fields].respond_to?(:to_unsafe_h) ? params[:fields].to_unsafe_h : {}
        content = fields.map { |k,v| "#{k.to_s[0,40]}: #{v.to_s[0,4000]}" }.join("\n")[0,16000]
        conversation.messages.create!(account: account, inbox: inbox, sender: contact, message_type: :incoming,
          content: content.presence || params[:summary].to_s[0,1000], source_id: "marketing:#{inquiry}", content_attributes: {ake_inquiry_id: inquiry})
      end
      message = conversation.messages.find_by!(source_id: "marketing:#{inquiry}")
      {inquiryId: inquiry, conversationId: conversation.display_id, contactId: conversation.contact_id, messageId: message.id}
    end
    render json: receipt
  end
end

class AkeSeatAssetsController
  def marketing
    return head :not_found if ENV['AKE_MARKETING_UI_ENABLED'] == 'false'
    response.headers['Cache-Control'] = 'no-store'
    render html: File.read('/opt/ake-archive/ake-marketing.html').html_safe
  end
end

Rails.application.routes.prepend do
  get '/ake/marketing', to: 'ake_seat_assets#marketing'
  post '/api/v1/accounts/:account_id/ake_marketing/:operation', to: 'api/v1/accounts/ake_marketing#dispatch_action'
  post '/api/v1/ake_marketing/intake', to: 'ake_marketing_intake#create'
end
