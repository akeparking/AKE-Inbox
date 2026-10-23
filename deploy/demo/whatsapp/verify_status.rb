# Private notes in the API inbox exercise status updates without contacting a
# WhatsApp recipient. Evolution explicitly excludes private messages from sends.
require 'json'
require 'securerandom'
account = Account.find(1)
inbox = account.inboxes.find_by!(name: 'AKE WhatsApp')
contact = account.contacts.find_or_create_by!(identifier: 'ake-wa-archive-test-20261003') { |value| value.name = '[AKE ARCHIVE TEST] Delivery status' }
link = ContactInbox.find_or_create_by!(contact: contact, inbox: inbox) { |value| value.source_id = SecureRandom.uuid }
conversation = contact.conversations.find_or_create_by!(account: account, inbox: inbox, contact_inbox: link)
message = conversation.messages.find_or_create_by!(source_id: 'WAID:AKE-STATUS-TEST-20261003') do |value|
  value.account = account
  value.inbox = inbox
  value.message_type = :outgoing
  value.private = true
  value.sender = account.users.first
  value.content = '[AKE ARCHIVE TEST] Private synthetic delivery-status verification'
end
puts JSON.generate({conversation_id: conversation.display_id, message_id: message.id, inbox_id: inbox.id})
