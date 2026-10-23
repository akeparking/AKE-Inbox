# Empty local database only. Credentials are created by bootstrap-local.mjs.
require 'json'
raise 'Expected empty local database' unless Account.count.zero? && User.count.zero?
input=JSON.parse(File.read('/tmp/ake-fixtures/bootstrap-input.json'))
account=Account.create!(name:'Local marketing acceptance')
user=User.new(name:'Local acceptance admin',email:'admin@local-inbox.invalid',password:input.fetch('password'),password_confirmation:input.fetch('password'))
user.skip_confirmation!;user.save!
AccountUser.create!(account:account,user:user,role: :administrator)
channel=Channel::Api.create!(account:account)
inbox=Inbox.create!(account:account,channel:channel,name:'Local website inquiries')
InboxMember.create!(inbox:inbox,user:user)
user.create_access_token! unless user.access_token
# The pinned Chatwoot release keeps its onboarding marker in Redis, not in an
# InstallationConfig row. Clear only the fresh installation's marker.
::Redis::Alfred.delete(::Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
File.write('/tmp/ake-fixtures/accounts.json',JSON.generate({accountId:account.id,inboxId:inbox.id,users:{admin:{id:user.id,email:user.email,password:input.fetch('password'),token:user.access_token.token}}}))
File.chmod(0600,'/tmp/ake-fixtures/accounts.json')
File.chown(input.fetch('uid'),input.fetch('gid'),'/tmp/ake-fixtures/accounts.json')
puts 'Fresh local account and API inbox created; credentials saved privately'
