require 'json'
account = Account.find(1)
inbox = account.inboxes.find_by!(name: 'AKE WhatsApp')
url = ENV.fetch('FRONTEND_URL').delete_suffix('/') + '/whatsapp/dispatch'
hook = account.webhooks.find_or_initialize_by(url: url)
hook.name = 'AKE WhatsApp signed relay'
hook.subscriptions = ['message_created', 'message_updated', 'conversation_status_changed']
hook.save!
# The account webhook supplies a native HMAC signature. Disable the unsigned
# API-inbox webhook to prevent duplicate deliveries and private-IP failures.
inbox.channel.update!(webhook_url: nil)
File.write('/tmp/whatsapp-relay.json', {secret:hook.secret, url:url, webhook_id:hook.id}.to_json, perm:0600)
puts({signed_relay:true, inbox_id:inbox.id, webhook_id:hook.id}.to_json)
