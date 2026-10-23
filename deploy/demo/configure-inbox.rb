require 'json'

# Secrets arrive through a root-owned stdin file, never through process arguments
# or stdout. Does not send a test email or modify existing messages.
input = JSON.parse(STDIN.read)
account = Account.find(input.fetch('account_id', 1))
brand = input.fetch('brand', 'AKE')
{
  'INSTALLATION_NAME' => brand,
  'BRAND_NAME' => brand,
  'WIDGET_BRAND_URL' => input.fetch('brand_url'),
  'BRAND_URL' => input.fetch('brand_url'),
  'LOGO_THUMBNAIL' => '/ake-mark.svg'
}.each do |key, value|
  item = InstallationConfig.find_or_initialize_by(name: key)
  item.value = value
  item.save!
end
GlobalConfig.clear_cache

email = input['email']
receipt = { brand: brand, branding_configured: true }
if email
  channel = Channel::Email.find_or_initialize_by(account_id: account.id, email: email.fetch('address'))
  channel.assign_attributes(
    imap_enabled: true, imap_address: email.fetch('imap_host'), imap_port: 993,
    imap_enable_ssl: true, imap_authentication: 'plain',
    imap_login: email.fetch('address'), imap_password: email.fetch('password'),
    smtp_enabled: true, smtp_address: email.fetch('smtp_host'), smtp_port: 465,
    smtp_enable_ssl_tls: true, smtp_enable_starttls_auto: false,
    smtp_authentication: 'login', smtp_openssl_verify_mode: 'peer',
    smtp_login: email.fetch('address'), smtp_password: email.fetch('password'),
    smtp_domain: email.fetch('address').split('@').last, verified_for_sending: true
  )
  channel.save!
  inbox = channel.inbox || account.inboxes.create!(name: 'AKE Export Email', channel: channel)
  account.users.each { |user| InboxMember.find_or_create_by!(inbox: inbox, user: user) }
  receipt[:email_inbox_id] = inbox.id
  receipt[:email_channel_type] = inbox.channel_type
  receipt[:imap_enabled] = channel.reload.imap_enabled
  receipt[:smtp_enabled] = channel.smtp_enabled
end
puts receipt.to_json
