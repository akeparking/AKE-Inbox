require 'json'
account = Account.find(1)
user = account.account_users.find_by!(role: :administrator).user
File.write('/tmp/whatsapp-chatwoot.json', {token:user.access_token.token, public_url:ENV.fetch('FRONTEND_URL')}.to_json, perm:0600)
puts({ready:true}.to_json)
