require 'net/http'
require 'net/imap'
require 'net/smtp'
require 'json'
require 'resolv'
require 'ipaddr'
require 'timeout'

module AkeSeatChannels
  class ConnectorUnavailable < StandardError; end

  def self.evolution(path)
    uri = URI('http://whatsapp-web:8080' + path)
    request = Net::HTTP::Get.new(uri)
    request['apikey'] = ENV.fetch('AKE_WHATSAPP_API_KEY')
    response = Net::HTTP.start(uri.hostname, uri.port, open_timeout: 4, read_timeout: 15) { |http| http.request(request) }
    raise ConnectorUnavailable unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body)
  end

  def self.public_mail_host!(host)
    raise ArgumentError unless host.to_s.match?(/\A[a-zA-Z0-9][a-zA-Z0-9.-]{1,252}\z/)
    addresses = Resolv.getaddresses(host)
    raise ArgumentError if addresses.empty?
    networks = %w[0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 ::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8].map { |n| IPAddr.new(n) }
    raise ArgumentError if addresses.any? { |ip| networks.any? { |net| net.include?(ip) } }
  end

  def self.validate_mail!(attrs)
    public_mail_host!(attrs['imap_address'])
    public_mail_host!(attrs['smtp_address'])
    raise ArgumentError unless attrs['imap_port'] == 993 && [465, 587].include?(attrs['smtp_port'])
    imap = Net::IMAP.new(attrs['imap_address'], port: 993, ssl: { verify_mode: OpenSSL::SSL::VERIFY_PEER }, open_timeout: 8)
    begin
      Timeout.timeout(12) { imap.login(attrs['imap_login'], attrs['imap_password']); imap.logout }
    ensure
      imap.disconnect unless imap.disconnected?
    end
    smtp = Net::SMTP.new(attrs['smtp_address'], attrs['smtp_port'])
    smtp.open_timeout = 8
    smtp.read_timeout = 12
    context = OpenSSL::SSL::SSLContext.new
    context.set_params(verify_mode: OpenSSL::SSL::VERIFY_PEER)
    attrs['smtp_port'] == 465 ? smtp.enable_tls(context) : smtp.enable_starttls(context)
    # Authenticate only. No test email or other external message is sent.
    smtp.start(attrs['smtp_domain'], attrs['smtp_login'], attrs['smtp_password'], :login) { |_connection| }
  end
end

class AkeSeatAssetsController < ActionController::Base
  # These routes serve public static files, without user data or mutations.
  skip_forgery_protection
  def page
    response.headers['Cache-Control'] = 'no-store'
    render html: File.read('/opt/ake-archive/ake-seat-channels.html').html_safe
  end

  def customers
    response.headers['Cache-Control'] = 'no-store'
    render html: File.read('/opt/ake-archive/ake-customers.html').html_safe
  end

  def asset
    name = params[:name]
    return head :not_found unless %w[ake-seat-channels.js ake-seat-nav.js ake-offline-widget.js ake-conversation-widget.js ake-customers.js ake-api.js ake-marketing.js ake-reception.js ake-meta-feedback.js].include?(name)

    response.headers['Cache-Control'] = 'no-cache'
    render plain: File.read('/opt/ake-archive/' + name), content_type: 'application/javascript'
  end
end

require_relative 'ake_customers'
require_relative 'ake_marketing'

class Api::V1::Accounts::AkeSeatsController < Api::V1::Accounts::BaseController
  before_action :ake_enabled

  def index
    members = Current.account.account_users.agent.includes(:user)
    members = members.where(user_id: Current.user.id) unless Current.account_user.administrator?
    seats = members.map { |m| seat_data(m) }
    if Current.account_user.administrator?
      legacy = Current.account.inboxes.find_by(id: ENV.fetch('AKE_LEGACY_WHATSAPP_INBOX_ID', '3').to_i)
      if legacy && (AkeSeatRouting.owner(legacy).zero? || legacy.auto_assignment_config['ake_admin_owned'] == true)
        mail = Current.account.inboxes.find_by(id: ENV.fetch('AKE_LEGACY_EMAIL_INBOX_ID', '2').to_i, channel_type: 'Channel::Email')
        seats << { id: 'legacy', name: '原有 WhatsApp（管理员）', activated: true, availability: 'offline', legacy: true,
                   whatsapp_inbox_id: legacy.id, email_inbox_id: mail&.id, email: nil }
      end
    end
    render json: { role: Current.account_user.role, seats: seats, marketing_enabled: ENV['AKE_MARKETING_ENABLED'] == 'true' && ENV['AKE_MARKETING_UI_ENABLED'] != 'false' }
  end

  def whatsapp
    inbox = seat_inbox('Channel::Api')
    return render json: { configured: false, state: 'not_configured' } unless inbox

    instance = inbox.channel.additional_attributes['ake_instance'] || (params[:user_id] == 'legacy' ? 'ake-whatsapp' : nil)
    result = AkeSeatChannels.evolution('/instance/connectionState/' + ERB::Util.url_encode(instance))
    render json: { configured: true, inbox_id: inbox.id, state: result.dig('instance', 'state') || 'unknown' }
  rescue AkeSeatChannels::ConnectorUnavailable, Net::ReadTimeout, Net::OpenTimeout, SocketError
    render json: { error: 'WhatsApp 连接服务暂时不可用，请稍后刷新。' }, status: :service_unavailable
  end

  def connect
    inbox = seat_inbox('Channel::Api')
    return render json: { error: '该坐席的 WhatsApp 渠道尚未配置。' }, status: :conflict unless inbox

    instance = ERB::Util.url_encode(inbox.channel.additional_attributes['ake_instance'] || (params[:user_id] == 'legacy' ? 'ake-whatsapp' : nil))
    state = AkeSeatChannels.evolution('/instance/connectionState/' + instance).dig('instance', 'state')
    return render json: { state: 'open', connected: true } if state == 'open'

    qr = AkeSeatChannels.evolution('/instance/connect/' + instance)
    response.headers['Cache-Control'] = 'no-store'
    # Pairing data is delivered solely to the authenticated owner/admin, never logged.
    image = qr['base64'].to_s
    return render json: { state: 'connecting', pending: true } unless image.start_with?('data:image/png;base64,')

    render json: { state: 'connecting', qr: image, expires_in: 35 }
  rescue AkeSeatChannels::ConnectorUnavailable, Net::ReadTimeout, Net::OpenTimeout, SocketError
    render json: { error: '暂时无法取得二维码，请稍后重新生成。' }, status: :service_unavailable
  end

  def email
    member = seat_member
    input = params.require(:channel).permit(:email, :imap_address, :imap_login, :imap_password, :smtp_address, :smtp_port, :smtp_login, :smtp_password).to_h
    raise ArgumentError unless input['email'].to_s.match?(URI::MailTo::EMAIL_REGEXP) && input['email'].length <= 254

    inbox = seat_inbox('Channel::Email')
    attrs = input.merge('imap_port' => 993, 'imap_enable_ssl' => true, 'imap_authentication' => 'plain',
                        'smtp_port' => input['smtp_port'].to_i, 'smtp_domain' => input['email'].split('@').last,
                        'smtp_authentication' => 'login', 'smtp_openssl_verify_mode' => 'peer',
                        'smtp_enable_ssl_tls' => input['smtp_port'].to_i == 465, 'smtp_enable_starttls_auto' => input['smtp_port'].to_i == 587)
    %w[imap smtp].each do |kind|
      attrs[kind + '_login'] = input[kind + '_login'].presence || input['email']
      attrs[kind + '_password'] = input[kind + '_password'].presence || inbox&.channel&.public_send(kind + '_password')
      raise ArgumentError if attrs[kind + '_password'].blank?
    end
    AkeSeatChannels.validate_mail!(attrs)
    Inbox.transaction do
      Current.account.lock!
      # Recheck under the account lock so retries cannot create multiple channels.
      inbox = seat_inbox('Channel::Email')
      channel = inbox&.channel || Channel::Email.new(account: Current.account)
      channel.update!(attrs.merge('imap_enabled' => true, 'smtp_enabled' => true))
      inbox ||= Current.account.inboxes.create!(channel: channel, name: member.user.name + ' Email', enable_auto_assignment: false,
                                                auto_assignment_config: { ake_owner_id: member.user_id })
      InboxMember.find_or_create_by!(inbox: inbox, user_id: member.user_id)
    end
    render json: { ok: true, inbox_id: inbox.id, receiving: true, sending: true }
  rescue ArgumentError, ActiveRecord::RecordInvalid
    render json: { error: '请检查邮箱地址、服务器和端口；此邮箱可能已属于其他渠道。' }, status: :unprocessable_entity
  rescue Net::IMAP::Error, Net::SMTPError, Net::ReadTimeout, Net::OpenTimeout, Timeout::Error, SocketError, OpenSSL::SSL::SSLError, IOError
    render json: { error: '邮箱验证失败。请检查 IMAP/SMTP 是否开启、授权码和服务器地址；原有配置未被替换。' }, status: :unprocessable_entity
  end

  private

  def ake_enabled
    raise Pundit::NotAuthorizedError unless AkeSeatRouting.enabled?(Current.account.id) && Current.user.is_a?(User) && Current.user.confirmed?
  end

  def seat_member
    id = params[:user_id].presence || Current.user.id
    raise Pundit::NotAuthorizedError unless Current.account_user.administrator? || id.to_i == Current.user.id

    Current.account.account_users.agent.find_by!(user_id: id)
  end

  def seat_inbox(type)
    if params[:user_id] == 'legacy'
      raise Pundit::NotAuthorizedError unless Current.account_user.administrator? && type == 'Channel::Api'
      legacy = Current.account.inboxes.find_by(id: ENV.fetch('AKE_LEGACY_WHATSAPP_INBOX_ID', '3').to_i, channel_type: type)
      return legacy if legacy && (AkeSeatRouting.owner(legacy).zero? || legacy.auto_assignment_config['ake_admin_owned'] == true)
      return nil
    end
    member = seat_member
    Current.account.inboxes.where(channel_type: type).find_by("auto_assignment_config ->> 'ake_owner_id' = ?", member.user_id.to_s)
  end

  def seat_data(member)
    inboxes = Current.account.inboxes.where("auto_assignment_config ->> 'ake_owner_id' = ?", member.user_id.to_s).to_a
    mail = inboxes.find(&:email?)
    wa = inboxes.find { |i| i.channel_type == 'Channel::Api' }
    { id: member.user_id, name: member.user.name, activated: member.user.confirmed?, availability: member.availability_status,
      whatsapp_inbox_id: wa&.id, email_inbox_id: mail&.id,
      email: mail && { address: mail.channel.email, imap_address: mail.channel.imap_address, imap_login: mail.channel.imap_login,
                       smtp_address: mail.channel.smtp_address, smtp_login: mail.channel.smtp_login, smtp_port: mail.channel.smtp_port,
                       receiving: mail.channel.imap_enabled, sending: mail.channel.smtp_enabled } }
  end
end

class Api::V1::Widget::AkeOfflineController < Api::V1::Widget::BaseController
  skip_before_action :set_contact, only: [:availability]

  def availability
    return head :not_found unless AkeSeatRouting.enabled?(@web_widget.inbox.account_id)

    response.headers['Cache-Control'] = 'no-store'
    human = AkeSeatRouting.eligible_ids(@web_widget.inbox).any?
    ai = ENV['AKE_OFFICE_RECEPTION_ENABLED'] == 'true' && ENV['AKE_OFFICE_AI_READY'] == 'true'
    render json: { online: human || ai, reception: human ? 'human' : ai ? 'ai' : 'offline' }
  end

  def create
    return head :not_found unless AkeSeatRouting.enabled?(@web_widget.inbox.account_id)

    input = params.permit(:name, :email, :company, :message, :submission_id)
    unless input[:name].to_s.strip.length <= 120 && input[:email].to_s.match?(URI::MailTo::EMAIL_REGEXP) &&
           input[:email].length <= 254 && input[:company].to_s.strip.length <= 200 &&
           input[:message].to_s.strip.length.between?(1, 5000) && input[:submission_id].to_s.match?(/\A[0-9a-f-]{36}\z/)
      return render json: { error: 'Please enter your name, a valid email and a message.' }, status: :unprocessable_entity
    end
    result = nil
    Conversation.transaction do
      @contact_inbox.lock!
      previous = @contact_inbox.conversations.where("additional_attributes ->> 'ake_submission_id' = ?", input[:submission_id]).first
      if previous
        result = previous
        next
      end
      details = { email: input[:email].downcase }
      details[:name] = input[:name].strip if input[:name].present?
      @contact = ContactIdentifyAction.new(contact: @contact, params: details,
                                           retain_original_contact_name: true, discard_invalid_attrs: false).perform
      @contact.update!(additional_attributes: @contact.additional_attributes.merge('company_name' => input[:company].strip)) if input[:company].present?
      @contact_inbox.reload
      result = Conversation.create!(account_id: @web_widget.inbox.account_id, inbox: @web_widget.inbox, contact: @contact,
                                     contact_inbox: @contact_inbox, status: :open,
                                     additional_attributes: { ake_offline_submission: true, ake_submission_id: input[:submission_id] })
      result.messages.create!(account_id: result.account_id, inbox_id: result.inbox_id, sender: @contact, message_type: :incoming,
                              content: input[:message].strip, content_attributes: { ake_offline_submission: true })
    end
    render json: { accepted: true, conversation_id: result.display_id }
  end
end

Rails.application.routes.prepend do
  get '/ake/channels', to: 'ake_seat_assets#page'
  get '/ake/assets/:name', to: 'ake_seat_assets#asset', constraints: { name: /[^\/]+/ }, format: false
  get '/api/v1/accounts/:account_id/ake_seats', to: 'api/v1/accounts/ake_seats#index'
  get '/api/v1/accounts/:account_id/ake_seats/:user_id/whatsapp', to: 'api/v1/accounts/ake_seats#whatsapp'
  post '/api/v1/accounts/:account_id/ake_seats/:user_id/whatsapp/connect', to: 'api/v1/accounts/ake_seats#connect'
  post '/api/v1/accounts/:account_id/ake_seats/:user_id/email', to: 'api/v1/accounts/ake_seats#email'
  get '/api/v1/widget/ake_availability', to: 'api/v1/widget/ake_offline#availability'
  post '/api/v1/widget/ake_offline', to: 'api/v1/widget/ake_offline#create'
end
