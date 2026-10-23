# Rails runner; JSON on stdin. Reuses an existing authenticated Email inbox.
# No credentials, customer messages or external test emails are emitted.
require 'json'
Rails.logger.level = Logger::ERROR
input = JSON.parse(STDIN.read)
account = Account.find(input.fetch('account_id'))
website = account.inboxes.find(input.fetch('website_inbox_id'))
mailbox = account.inboxes.find(input.fetch('email_inbox_id'))
raise 'Website inbox required' unless website.web_widget?
raise 'Connected IMAP and SMTP mailbox required' unless mailbox.email? && mailbox.channel.imap_enabled && mailbox.channel.smtp_enabled
raise 'Conversation experience extension is not loaded' unless defined?(AkeConversationExperience)
bot = account.agent_bots.find(input.fetch('bot_id'))
human = account.account_users.find_by!(user_id: input.fetch('human_user_id')).user
name = input.fetch('human_display_name').to_s.strip
raise 'Display name required' unless name.length.between?(1, 80)
web = website.channel
before = { account_id: account.id, website_inbox_id: website.id,
  auto_assignment_config: website.auto_assignment_config,
  widget: web.attributes.slice('continuity_via_email', 'pre_chat_form_enabled', 'pre_chat_form_options'),
  bot: {id: bot.id, name: bot.name}, human: {id: human.id, display_name: human.display_name} }
receipt = '/tmp/ake-conversation-experience-before.json'
File.write(receipt, JSON.pretty_generate(before))
File.chmod(0o600, receipt)
Account.transaction do
  website.update!(auto_assignment_config: website.auto_assignment_config.merge('ake_continuity_email_inbox_id' => mailbox.id))
  options = web.pre_chat_form_options.deep_dup
  fields = options.fetch('pre_chat_fields', [])
  email_field = fields.find { |field| field['name'] == 'emailAddress' }
  unless email_field
    email_field = {'field_type' => 'standard', 'name' => 'emailAddress', 'type' => 'email', 'label' => 'Email'}
    fields << email_field
  end
  email_field.merge!('enabled' => true, 'required' => true)
  options.merge!('pre_chat_fields' => fields, 'require_email' => true,
    'pre_chat_message' => "Ask your question and leave your email. We'll email unread replies, and you can reply directly to continue the conversation.")
  web.update!(continuity_via_email: true, pre_chat_form_enabled: true, pre_chat_form_options: options)
  human.update!(display_name: name)
  bot.update!(name: 'AI Agent')
end
raise 'Email continuity mapping did not persist' unless AkeConversationExperience.email_channel(website.reload)&.id == mailbox.channel.id
puts JSON.generate({configured: true, website_inbox_id: website.id, email_inbox_id: mailbox.id,
  sender_identity: true, email_required_for_new_conversations: true, rollback_receipt: receipt})
