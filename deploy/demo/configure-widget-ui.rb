# Rails runner; account-scoped customer presentation only. No account locale change.
# Usage: AKE_WIDGET_UI_ACCOUNT=1 AKE_WIDGET_UI_INBOX=1 AKE_WIDGET_UI_BACKUP=/private/before.json
require 'json'
Rails.logger.level = Logger::ERROR
account = Account.find(Integer(ENV.fetch('AKE_WIDGET_UI_ACCOUNT')))
inbox = account.inboxes.find(Integer(ENV.fetch('AKE_WIDGET_UI_INBOX')))
raise 'Website inbox required' unless inbox.web_widget?
web = inbox.channel
backup = ENV.fetch('AKE_WIDGET_UI_BACKUP')
raise 'Backup already exists; choose a new path' if File.exist?(backup)
before = { account_id: account.id, account_locale: account.locale, inbox_id: inbox.id,
           widget: web.attributes.slice('welcome_title', 'welcome_tagline', 'pre_chat_form_options') }
File.write(backup, JSON.pretty_generate(before), mode: 'wx', perm: 0o600)
options = web.pre_chat_form_options.deep_dup
# Preserve enabled/required flags, custom fields, values, rules and field order.
copy = {
  'emailAddress' => ['Work email', 'you@company.com'],
  'fullName' => ['Your name', 'Full name'],
  'phoneNumber' => ['Phone number', 'Include country code']
}
options.fetch('pre_chat_fields', []).each do |field|
  next unless copy.key?(field['name']) && field['field_type'] == 'standard'
  field['label'], field['placeholder'] = copy.fetch(field['name'])
end
options['pre_chat_message'] = 'Tell us about your parking project and leave your email so our team can follow up.'
web.update!(welcome_title: 'Talk to AKE Parking', welcome_tagline: 'Parking solutions for your project. How can we help?', pre_chat_form_options: options)
raise 'Staff locale changed unexpectedly' unless account.reload.locale == before[:account_locale]
raise 'Widget settings did not persist' unless web.reload.pre_chat_form_options == options
puts JSON.generate({updated: true, account_id: account.id, inbox_id: inbox.id, staff_locale_unchanged: true, required_fields_unchanged: true})
