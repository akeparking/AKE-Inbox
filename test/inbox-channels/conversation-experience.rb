# Run only in the disposable Chatwoot 4.18 test database; never sends email.
require 'json'
require 'securerandom'
raise 'isolated database required' unless ENV['AKE_SEAT_TEST'] == 'true' && ActiveRecord::Base.connection_db_config.database == 'chatwoot_test'
Rails.logger.level = Logger::ERROR
ActiveJob::Base.queue_adapter = :test
ActiveJob::Base.logger = Logger.new(File::NULL)
ActionMailer::Base.logger = Logger.new(File::NULL)
Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
def check(value, label)
  raise "FAILED: #{label}" unless value
  puts "PASS: #{label}"
end

account = Account.find_or_create_by!(id: 1) { |a| a.name = 'Fictional AKE support'; a.locale = 'en' }
password = 'A1!' + SecureRandom.hex(20)
agent = User.find_or_initialize_by(email: 'experience-agent@example.invalid')
agent.assign_attributes(name: 'Fixture operator', display_name: 'Fixture Agent', password: password, confirmed_at: Time.current)
agent.skip_confirmation_notification!
agent.save!
AccountUser.find_or_create_by!(account: account, user: agent).update!(role: :administrator, availability: :offline)
bot = AgentBot.create!(account: account, name: 'AI Agent', outgoing_url: 'https://example.invalid/bot')
web = Channel::WebWidget.create!(account: account, website_url: 'https://example.invalid', widget_color: '#da251d', welcome_title: 'AKE Parking', welcome_tagline: 'How can we help?', continuity_via_email: true)
inbox = account.inboxes.create!(name: 'AKE Website fixture', channel: web, enable_auto_assignment: false)
InboxMember.create!(inbox: inbox, user: agent)
email = Channel::Email.create!(account: account, email: "support-#{SecureRandom.hex(4)}@example.invalid", imap_enabled: true, imap_address: 'imap.example.invalid',
  imap_login: 'support@example.invalid', imap_password: 'fixture-only', imap_port: 993, imap_enable_ssl: true,
  smtp_enabled: true, smtp_address: 'smtp.example.invalid', smtp_login: 'support@example.invalid', smtp_password: 'fixture-only',
  smtp_domain: 'example.invalid', smtp_port: 465, smtp_enable_ssl_tls: true, smtp_enable_starttls_auto: false, smtp_authentication: 'login', smtp_openssl_verify_mode: 'peer')
email_inbox = account.inboxes.create!(name: 'Fictional mailbox', channel: email, enable_auto_assignment: false)
inbox.update!(auto_assignment_config: {ake_continuity_email_inbox_id: email_inbox.id})

def fixture_conversation(account, inbox, address)
  contact = account.contacts.create!(name: 'Fictional Visitor', email: address)
  ci = ContactInbox.create!(contact: contact, inbox: inbox, source_id: SecureRandom.uuid)
  account.conversations.create!(contact: contact, contact_inbox: ci, inbox: inbox, status: :open)
end
conversation = fixture_conversation(account, inbox, "visitor-#{SecureRandom.hex(4)}@example.invalid")
incoming = conversation.messages.create!(account: account, inbox: inbox, sender: conversation.contact, message_type: :incoming, content: 'I need a parking guidance quote.', created_at: 3.minutes.ago)
human = conversation.messages.create!(account: account, inbox: inbox, sender: agent, message_type: :outgoing, content: 'Thanks. I will help with your project.', created_at: 2.minutes.ago)
ai = conversation.messages.create!(account: account, inbox: inbox, sender: bot, message_type: :outgoing, content: 'Which country is the project in?', created_at: 1.minute.ago)
note = conversation.messages.create!(account: account, inbox: inbox, sender: agent, message_type: :outgoing, private: true, content: 'PRIVATE_FIXTURE_DO_NOT_EXPOSE')
stranger = fixture_conversation(account, inbox, "stranger-#{SecureRandom.hex(4)}@example.invalid")
stranger_message = stranger.messages.create!(account: account, inbox: inbox, sender: stranger.contact, message_type: :incoming, content: 'OTHER_VISITOR_DO_NOT_EXPOSE')
auth_token = Widget::TokenService.new(payload: {source_id: conversation.contact_inbox.source_id, inbox_id: inbox.id}).generate_token
conversation.update_columns(agent_last_seen_at: Time.current)
session = ActionDispatch::Integration::Session.new(Rails.application)
query = {website_token: web.website_token, ids: [incoming, human, ai, note, stranger_message].map(&:id).join(',')}
session.get('/api/v1/widget/ake_conversation_state', params: query, headers: {'X-Auth-Token' => auth_token})
data = JSON.parse(session.response.body)
check(session.response.status == 200 && data['messages'].size == 3, 'visitor metadata excludes private notes and other visitors')
check(data['messages'].find { |m| m['id'] == incoming.id }['receipt'] == 'delivered', 'persisted visitor message starts Delivered before human viewing')
check(AkeConversationExperience.read_at(conversation).zero?, 'an automatic/native seen timestamp alone cannot impersonate human reading')
check(data['messages'].find { |m| m['id'] == human.id }['sender_name'] == 'Fixture Agent', 'human message uses the actual agent display name')
check(data['messages'].find { |m| m['id'] == ai.id }.values_at('sender_name', 'sender_kind') == ['AI Agent', 'ai'], 'AI reply has its own visible identity')
check(data['messages'].all? { |m| Time.iso8601(m['created_at']).present? }, 'every visible message has a server timestamp')
check(data['has_conversation'] && data['has_email'] && data['email_continuity'], 'existing offline conversation remains resumable with email continuity')
session.get('/api/v1/widget/ake_conversation_state', params: query)
check([401, 403].include?(session.response.status), 'visitor metadata rejects missing authentication')

agent_auth = agent.create_new_auth_token
session.post("/api/v1/accounts/1/conversations/#{conversation.display_id}/update_last_seen", headers: agent_auth)
check(session.response.successful?, 'native agent viewing endpoint works')
session.get('/api/v1/widget/ake_conversation_state', params: query, headers: {'X-Auth-Token' => auth_token})
check(JSON.parse(session.response.body)['messages'].find { |m| m['id'] == incoming.id }['receipt'] == 'read', 'actual human viewing changes the visitor receipt to Read')
session.post("/api/v1/accounts/1/conversations/#{conversation.display_id}/unread", headers: agent_auth)
check(AkeConversationExperience.read_at(conversation.reload) >= incoming.created_at.to_f, 'marking a thread unread cannot retract a delivered Read receipt')

# Restore an unread outbound message for the native continuity mailer.
conversation.update_columns(contact_last_seen_at: 1.day.ago)
delivery = ConversationReplyMailer.with(account: account).reply_with_summary(conversation, human.id)
mail = delivery.message
check(mail.to == [conversation.contact.email] && mail.from == [email.email] && mail.reply_to == [email.email], 'website notification uses the selected authenticated mailbox for From and Reply-To')
check(mail.delivery_method.settings[:address] == email.smtp_address, 'website notification uses mailbox SMTP instead of an unrelated system sender')
check(!mail.encoded.include?('PRIVATE_FIXTURE_DO_NOT_EXPOSE'), 'email recap excludes internal notes')
check(mail['X-AKE-Inbox-Message'].present? && mail['Auto-Submitted'].to_s == 'auto-replied', 'AI continuity mail retains outbound guard and loop suppression')
check(mail.message_id.match?(%r{\Aconversation/#{conversation.uuid}/messages/\d+@example.invalid\z}), 'notification carries a verifiable message and conversation reference')

def reply_mail(conversation, channel, reference, body, sender: nil)
  Mail.new do
    from sender || conversation.contact.email
    to channel.email
    subject 'Re: parking project'
    message_id "fixture-#{SecureRandom.uuid}@example.invalid"
    in_reply_to reference
    references [reference]
    text_part { body body }
  end
end
reply = reply_mail(conversation, email, mail.message_id, 'The project is in Singapore.')
reply.attachments['project.txt'] = 'Fictional project attachment'
before = account.conversations.count
2.times { Imap::ImapMailbox.new.process(reply, email) }
saved = conversation.messages.find_by(source_id: reply.message_id)
check(saved&.incoming? && saved.content.include?('Singapore') && saved.content_type == 'incoming_email', 'customer email Reply lands in the original Website conversation')
check(account.conversations.count == before && conversation.messages.where(source_id: reply.message_id).count == 1, 'email replay creates neither a duplicate conversation nor a duplicate message')
check(saved.attachments.count == 1 && saved.attachments.first.file.download == 'Fictional project attachment', 'email attachment survives reply ingestion and replay without duplication')
check(Imap::FetchEmailService.new(channel: email).send(:email_already_present?, email, reply.message_id), 'later IMAP polling recognizes a reply stored in the Website inbox')

wrong = reply_mail(conversation, email, mail.message_id, 'Unrelated sender', sender: 'unrelated@example.invalid')
check(AkeConversationExperience.reply_conversation(wrong, email).nil?, 'another sender cannot append to a known conversation reference')
forged = reply_mail(conversation, email, "conversation/#{conversation.uuid}/messages/#{note.id}@example.invalid", 'Invalid private reference')
check(AkeConversationExperience.reply_conversation(forged, email).nil?, 'private note identifiers cannot be used as email thread references')
wrong_domain = reply_mail(conversation, email, mail.message_id.sub('@example.invalid', '@other.invalid'), 'Invalid domain')
check(AkeConversationExperience.reply_conversation(wrong_domain, email).nil?, 'unrelated notification domain cannot claim a Website thread')

next_human = conversation.messages.create!(account: account, inbox: inbox, sender: agent, message_type: :outgoing, content: 'Thanks, I have the location and attachment.')
followup = ConversationReplyMailer.with(account: account).reply_without_summary(conversation.reload, next_human.id).message
check(followup.in_reply_to == reply.message_id && followup.reply_to == [email.email], 'the next agent reply stays in the same email thread')
conversation.update_columns(contact_last_seen_at: 1.minute.from_now)
seen = ConversationReplyMailer.with(account: account).reply_with_summary(conversation.reload, next_human.id).message
check(seen.to.blank?, 'already viewed website replies do not produce duplicate email notifications')

session.get('/widget', params: {website_token: web.website_token, cw_conversation: auth_token})
check(session.response.body.include?('/ake/assets/ake-conversation-widget.js'), 'native widget loads the receipt and timestamp enhancement')
session.get('/ake/assets/ake-conversation-widget.js')
check(session.response.successful? && session.response.body.include?('Viewed by a member'), 'public enhancement asset is served')

File.write('/tmp/ake-fixtures/experience-fixture.json', JSON.generate({email: agent.email, password: password, website_token: web.website_token,
  auth_token: auth_token, conversation_id: conversation.display_id, incoming_id: incoming.id, human_id: human.id, ai_id: ai.id}))
File.chmod(0o600, '/tmp/ake-fixtures/experience-fixture.json')
puts JSON.generate({result: 'passed', scope: 'visitor receipts, sender identity, native email continuity, attachments and isolation'})
