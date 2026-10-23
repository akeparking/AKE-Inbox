# Run with Rails runner in an isolated Chatwoot 4.18 container and disposable DB.
require 'json'
require 'securerandom'

raise 'isolated database required' unless ENV['AKE_SEAT_TEST'] == 'true' && ActiveRecord::Base.connection_db_config.database == 'chatwoot_test'
Rails.logger.level = Logger::ERROR
ActiveJob::Base.logger = Logger.new(File::NULL)
Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
def check(value, label)
  raise "FAILED: #{label}" unless value
  puts "PASS: #{label}"
end

account = Account.find_or_create_by!(id: 1) { |a| a.name = 'Fictional seat tests'; a.locale = 'en' }
users = 5.times.map do |i|
  user = User.find_or_initialize_by(email: "seat-#{i}@example.invalid")
  if user.new_record?
    user.name = "Fixture #{i}"
    user.password = 'A1!' + SecureRandom.hex(20)
    user.skip_confirmation_notification!
    user.confirmed_at = Time.current unless i == 4
    user.save!
  end
  member = AccountUser.find_or_create_by!(account: account, user: user)
  member.update!(role: i.zero? ? :administrator : :agent, availability: :online, auto_offline: true)
  OnlineStatusTracker.update_presence(account.id, 'User', user.id)
  OnlineStatusTracker.set_status(account.id, user.id, 'online')
  user
end
admin, a, b, offline, inactive = users
offline.account_users.find_by!(account: account).update!(availability: :offline)
channel = Channel::WebWidget.create!(account: account, website_url: 'https://example.invalid', widget_color: '#da251d', welcome_title: 'Fixture', welcome_tagline: 'Test')
inbox = account.inboxes.create!(name: 'Fixture website', channel: channel, enable_auto_assignment: false)
users.each { |u| InboxMember.create!(inbox: inbox, user: u) }

check(AkeSeatRouting.eligible_ids(inbox).sort == [a.id, b.id].sort, 'only confirmed online agents are eligible; admin, offline and unconfirmed excluded')
selector = AutoAssignment::InboxRoundRobinService.new(inbox: inbox)
sequence = 6.times.map { selector.available_agent(allowed_agent_ids: users.map { |u| u.id.to_s }).id }
check(sequence[0] != sequence[1] && sequence[0, 2] * 3 == sequence, 'strict rotating assignment across two online seats')
parallel = 8.times.map do
  Thread.new do
    Rails.application.executor.wrap do
      ActiveRecord::Base.connection_pool.with_connection do
        AutoAssignment::InboxRoundRobinService.new(inbox: Inbox.find(inbox.id)).available_agent(allowed_agent_ids: users.map { |u| u.id.to_s }).id
      end
    end
  end
end.map(&:value)
check(parallel.count(a.id) == 4 && parallel.count(b.id) == 4, 'simultaneous arrivals keep round robin balanced')

def conversation_for(account, inbox, assignee)
  contact = account.contacts.create!(name: 'Fictional test contact', email: "test-#{SecureRandom.hex(6)}@example.invalid")
  ci = ContactInbox.create!(contact: contact, inbox: inbox, source_id: SecureRandom.uuid)
  account.conversations.create!(inbox: inbox, contact: contact, contact_inbox: ci, assignee: assignee, status: :open)
end
own = conversation_for(account, inbox, a)
other = conversation_for(account, inbox, b)
other.messages.create!(account: account, inbox: inbox, sender: other.contact, content: 'FICTIONAL_OTHER_SEAT_MARKER', message_type: :incoming)
context = ->(u) { { user: u, account: account, account_user: u.account_users.find_by!(account: account) } }
check(ConversationPolicy.new(context.call(a), own).show?, 'owner can open own conversation')
check(!ConversationPolicy.new(context.call(a), other).show?, 'direct conversation access across seats is denied')
check(ConversationPolicy.new(context.call(admin), other).show?, 'administrator can see all conversations')
scope = Conversations::PermissionFilterService.new(account.conversations, a, account).perform
check(scope.exists?(id: own.id) && !scope.exists?(id: other.id), 'list, filters and contact history respect ownership')
Current.account = account
Current.user = a
search = SearchService.new(current_user: a, current_account: account, params: { q: 'FICTIONAL_OTHER_SEAT_MARKER' }, search_type: 'Message').perform
check(search[:messages].empty?, 'global message search does not expose another seat')

# Capture actual broadcast destinations without opening a socket or printing tokens.
job = ActionCableBroadcastJob.new
destinations = []
job.define_singleton_method(:broadcast_to_members) { |members, *_args| destinations.replace(members) }
all_tokens = users.map(&:pubsub_token) + [own.contact_inbox.pubsub_token]
job.perform(all_tokens, 'conversation.created', own.push_event_data.merge(account_id: account.id))
check(destinations.sort == [admin.pubsub_token, a.pubsub_token, own.contact_inbox.pubsub_token].sort, 'websocket conversation payload reaches only admin, owner and visitor')
job.perform(users.map(&:pubsub_token), 'first.reply.created', {account_id: account.id, conversation_id: own.display_id})
check(destinations.sort == [admin.pubsub_token, a.pubsub_token].sort, 'first-reply events respect the same seat isolation')
job.perform(["account_#{account.id}"], 'contact.updated', other.contact.push_event_data.merge(account_id: account.id))
check(destinations.sort == [admin.pubsub_token, b.pubsub_token].sort, 'contact updates are not broadcast to the whole account')

personal = account.inboxes.create!(name: 'Fixture personal', channel: Channel::Api.create!(account: account), enable_auto_assignment: false, auto_assignment_config: {ake_owner_id: a.id})
InboxMember.create!(inbox: personal, user: a)
check(conversation_for(account, personal, nil).assignee_id == a.id, 'personal channel assigns its confirmed online owner')
legacy = account.inboxes.create!(name: 'Fixture legacy admin', channel: Channel::Api.create!(account: account), enable_auto_assignment: false, auto_assignment_config: {ake_owner_id: admin.id, ake_admin_owned: true})
check(conversation_for(account, legacy, nil).assignee_id == admin.id, 'retained historical channels belong to the administrator')

session = ActionDispatch::Integration::Session.new(Rails.application)
auth = a.create_new_auth_token
session.get("/api/v1/accounts/1/conversations/#{other.display_id}", headers: auth)
check([401, 403, 404].include?(session.response.status), 'HTTP direct-object request is rejected')
session.get('/api/v1/accounts/1/ake_seats', headers: auth)
check(session.response.status == 200 && JSON.parse(session.response.body)['seats'].map { |s| s['id'] } == [a.id], 'seat settings API returns only the signed-in seat')
session.get("/api/v1/accounts/1/ake_seats/#{b.id}/whatsapp", headers: auth)
check([401, 403, 404].include?(session.response.status), 'one seat cannot request another WhatsApp pairing session')
session.get("/api/v1/accounts/1/contacts/#{other.contact_id}/notes", headers: auth)
check([401, 403, 404].include?(session.response.status), 'contact notes also reject cross-seat access')
session.get('/api/v1/accounts/1/ake_customers', headers: auth)
customers = JSON.parse(session.response.body)['customers']
check(session.response.status == 200 && customers.any? { |c| c['id'] == own.contact_id } && customers.none? { |c| c['id'] == other.contact_id }, 'customer table follows conversation ownership')
session.get("/api/v1/accounts/1/ake_customers/#{other.contact_id}", headers: auth)
check([401, 403, 404].include?(session.response.status), 'customer detail rejects another seat customer ID')
original_mail_validation = AkeSeatChannels.method(:validate_mail!)
AkeSeatChannels.define_singleton_method(:validate_mail!) { |_attrs| true }
mail = {email: 'seat-mail@example.invalid', imap_address: 'imap.example.invalid', imap_password: 'fixture-imap-password', smtp_address: 'smtp.example.invalid', smtp_password: 'fixture-smtp-password', smtp_port: 465}
session.post("/api/v1/accounts/1/ake_seats/#{a.id}/email", params: {channel: mail}, headers: auth, as: :json)
check(session.response.status == 200, 'seat can save an independently authenticated email channel')
mail_inbox = account.inboxes.find(JSON.parse(session.response.body)['inbox_id'])
check(AkeSeatRouting.owner(mail_inbox) == a.id && mail_inbox.member_ids == [a.id], 'email inbox belongs only to its seat')
AkeSeatChannels.define_singleton_method(:validate_mail!) { |_attrs| raise Net::OpenTimeout }
session.post("/api/v1/accounts/1/ake_seats/#{a.id}/email", params: {channel: mail.merge(imap_password: 'wrong-new-password')}, headers: auth, as: :json)
check(session.response.status == 422 && mail_inbox.channel.reload.imap_password == 'fixture-imap-password', 'failed mailbox authentication preserves previous working credentials')
AkeSeatChannels.define_singleton_method(:validate_mail!, original_mail_validation)
session.get('/ake/assets/ake-seat-nav.js')
check(session.response.status == 200 && session.response.media_type.include?('javascript'), 'native dashboard asset route works')
session.get('/app/accounts/1/dashboard')
check(session.response.status == 200 && session.response.body.include?('/ake/assets/ake-seat-nav.js'), 'native dashboard loads the channel and customer navigation')

[a, b].each { |u| u.account_users.find_by!(account: account).update!(availability: :offline) }
check(AkeSeatRouting.eligible_ids(inbox).empty?, 'no seats available when all agents are offline')
check(selector.available_agent(allowed_agent_ids: users.map { |u| u.id.to_s }).nil?, 'no fallback assignment to the online administrator')
session.get('/api/v1/widget/ake_availability', params: { website_token: channel.website_token })
check(session.response.status == 200 && JSON.parse(session.response.body)['online'] == false, 'widget changes to offline mode even with an online administrator')
session.get('/widget', params: { website_token: channel.website_token })
html = session.response.body
check(session.response.status == 200 && html.include?('/ake/assets/ake-offline-widget.js'), 'offline widget script is included')
auth_token = html.match(/window.authToken = '([^']+)'/)[1]
submission = SecureRandom.uuid
payload = { website_token: channel.website_token, name: 'Fictional Visitor', email: 'visitor@example.invalid', message: 'Fictional offline inquiry', submission_id: submission }
2.times do
  session.post('/api/v1/widget/ake_offline', params: payload, headers: { 'X-Auth-Token' => auth_token }, as: :json)
  check(session.response.status == 200, 'offline form submission accepted')
end
forms = account.conversations.where("additional_attributes ->> 'ake_submission_id' = ?", submission)
check(forms.count == 1 && forms.first.messages.incoming.count == 1 && forms.first.assignee_id.nil?, 'offline retry is idempotent and stays unassigned')
a.account_users.find_by!(account: account).update!(availability: :online)
OnlineStatusTracker.update_presence(account.id, 'User', a.id)
inbox.update!(enable_auto_assignment: true)
AkeSeatBacklogJob.perform_now(account.id)
check(forms.first.reload.assignee_id == a.id, 'offline backlog is assigned when a confirmed seat comes online')
puts JSON.generate({ result: 'passed', tests: 'seat permissions, availability, rotation, concurrent assignment and offline intake' })
