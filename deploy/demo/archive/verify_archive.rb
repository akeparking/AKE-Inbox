require 'json'
require 'stringio'
require 'digest'
require 'securerandom'
account = Account.find(AkeArchive::ACCOUNT_ID)
inbox = account.inboxes.find_by!(channel_type: 'Channel::WebWidget')
contact = account.contacts.find_or_create_by!(identifier: 'ake-archive-fixture-20261003') do |value|
  value.name = '[AKE ARCHIVE TEST] Synthetic contact'
end
contact_inbox = ContactInbox.find_or_create_by!(contact: contact, inbox: inbox) { |value| value.source_id = SecureRandom.uuid }
conversation = contact.conversations.find_or_create_by!(account: account, inbox: inbox, contact_inbox: contact_inbox)
message = conversation.messages.create!(account: account, inbox: inbox, message_type: :outgoing,
  private: true, content: '[AKE ARCHIVE TEST] Original synthetic note', sender: account.users.first)
file_bytes = "AKE archive attachment verification\nOriginal file bytes.\n".b
attachment = message.attachments.build(account: account, file_type: :file)
attachment.file.attach(io: StringIO.new(file_bytes), filename: 'ake-archive-test.txt', content_type: 'text/plain')
attachment.save!
message.reload.update!(content: '[AKE ARCHIVE TEST] Edited synthetic note', status: :read)
conversation.update!(status: :resolved)
versions = Dir.glob(File.join(AkeArchive::ROOT, 'messages', message.id.to_s, '*.json')).map { |path| JSON.parse(File.read(path)) }
raise 'missing_original' unless versions.any? { |value| value['record']['content'].include?('Original synthetic note') }
raise 'missing_edit' unless versions.any? { |value| value['record']['content'].include?('Edited synthetic note') && value['record']['status'] == 'read' }
sha = Digest::SHA256.hexdigest(file_bytes)
archived = File.join(AkeArchive::ROOT, 'blobs', sha[0, 2], sha)
raise 'attachment_mismatch' unless File.binread(archived) == file_bytes
puts JSON.generate({status: 'passed', conversation_id: conversation.display_id, message_id: message.id,
  original_preserved: true, edit_and_read_status_preserved: true, attachment_sha256: sha,
  message_versions: versions.length, external_message_sent: false})
