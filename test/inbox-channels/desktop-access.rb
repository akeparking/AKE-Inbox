# Disposable native database only. Checks the real desktop endpoint and policy.
require 'json'
require 'securerandom'
raise 'isolated database required' unless ENV['AKE_SEAT_TEST'] == 'true' && ActiveRecord::Base.connection_db_config.database == 'chatwoot_test'
Rails.logger.level = Logger::ERROR
ActiveJob::Base.queue_adapter = :test
ActiveJob::Base.logger = Logger.new(File::NULL)
Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)

def check(value, label)
  raise "FAILED: #{label}" unless value
  puts "PASS: #{label}"
end

Account.transaction do
  account = Account.find_or_create_by!(id: 1) { |a| a.name = 'Fictional desktop acceptance' }
  agent = User.new(email: "desktop-#{SecureRandom.hex(4)}@example.invalid", name: 'Fixture agent', password: 'A1!' + SecureRandom.hex(20), confirmed_at: Time.current)
  agent.skip_confirmation_notification!
  agent.save!
  member = AccountUser.create!(account: account, user: agent, role: :agent, availability: :offline)
  inboxes = 2.times.map do
    channel = Channel::WebWidget.create!(account: account, website_url: 'https://example.invalid', widget_color: '#5da883')
    account.inboxes.create!(name: 'Synthetic desktop fixture', channel: channel, enable_auto_assignment: false)
  end
  membership = InboxMember.create!(inbox: inboxes[0], user: agent)
  conversations = inboxes.map do |inbox|
    contact = account.contacts.create!(name: 'Fictional visitor')
    ci = ContactInbox.create!(contact: contact, inbox: inbox, source_id: SecureRandom.uuid)
    conversation = account.conversations.create!(contact: contact, contact_inbox: ci, inbox: inbox, assignee: agent, status: :open)
    conversation.messages.create!(account: account, inbox: inbox, sender: contact, message_type: :incoming, content: 'PRIVATE_FIXTURE_BODY')
    # Model callbacks can route an offline seat away; deliberately retain stale
    # ownership here to exercise revoked-membership filtering at the endpoint.
    conversation.update_columns(assignee_id: agent.id, assignee_last_seen_at: nil)
    conversation.reload # display_id is assigned by a PostgreSQL trigger.
  end
  session = ActionDispatch::Integration::Session.new(Rails.application)
  auth = agent.create_new_auth_token
  path = '/api/v1/accounts/1/ake_reception/desktop'
  session.get(path, headers: auth)
  data = JSON.parse(session.response.body)
  check(session.response.successful? && data['unreadCount'] == 1 && data['conversations'].map { |r| r['conversationId'] } == [conversations[0].display_id], "agent unread requires both ownership and current inbox membership (status #{session.response.status}, count #{data['unreadCount']})")
  check(!session.response.body.include?('PRIVATE_FIXTURE_BODY') && data['conversations'][0].keys.sort == %w[conversationId lastMessageId unreadCount].sort, 'desktop summary exposes no customer content')
  membership.destroy!
  session.get(path, headers: auth)
  check(JSON.parse(session.response.body)['unreadCount'].zero?, 'revoking membership immediately removes desktop unread')
  member.update!(role: :administrator)
  conversations[1].update!(assignee: nil)
  session.get(path, headers: auth)
  data = JSON.parse(session.response.body)
  check(data['unreadCount'] == 1 && data['conversations'].map { |r| r['conversationId'] } == [conversations[0].display_id], 'administrator summary still excludes work not assigned to that administrator')
  session.get(path)
  check([401, 403].include?(session.response.status), 'desktop endpoint requires authentication')
  raise ActiveRecord::Rollback
end
