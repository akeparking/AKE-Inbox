# Run through the existing Chatwoot Rails runtime. A nonzero exit is a failed
# reconciliation, never a successful-but-partial archive receipt.
require 'json'
require 'time'
started = Time.now.utc.iso8601
messages = 0
conversations = 0
Message.unscoped.where(account_id: AkeArchive::ACCOUNT_ID).find_each do |message|
  AkeArchive.capture_message(message, require_files: true)
  messages += 1
end
Conversation.where(account_id: AkeArchive::ACCOUNT_ID).find_each do |conversation|
  AkeArchive.capture_conversation(conversation)
  conversations += 1
end
# Forwarding ingress also keeps MIME copies; IMAP uses the initializer hook.
ActionMailbox::InboundEmail.find_each do |email|
  next unless Message.unscoped.where(account_id: AkeArchive::ACCOUNT_ID, source_id: email.message_id).exists?
  next unless email.raw_email.attached?
  item = AkeArchive.blob(email.raw_email.blob)
  AkeArchive.snapshot('forwarded_email', email.id, { schema_version: 1, record: email.attributes, file: item })
end
result = { status: 'ok', started_at: started, completed_at: Time.now.utc.iso8601,
           account_id: AkeArchive::ACCOUNT_ID, messages: messages, conversations: conversations,
           message_versions: Dir.glob(File.join(AkeArchive::ROOT, 'messages', '*', '*.json')).length,
           blobs: Dir.glob(File.join(AkeArchive::ROOT, 'blobs', '*', '*')).length }
path = File.join(AkeArchive::ROOT, 'latest-reconciliation.json')
temporary = path + '.tmp'
File.write(temporary, JSON.pretty_generate(result), mode: 'w', perm: 0o600)
File.rename(temporary, path)
puts JSON.generate(result)
