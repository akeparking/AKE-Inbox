# Import the bounded existing inbox after explicit mailbox connection. Never
# delete mail, change its read flag, or generate a reply from this script.
require 'json'
channel = Channel::Email.find_by!(account_id: 1, email: ENV.fetch('AKE_IMPORT_MAILBOX'))
inbox = channel.inbox
inbox.update!(greeting_enabled: false, enable_auto_assignment: false, csat_survey_enabled: false)
count_before = inbox.messages.count
failures = 0
mails = Imap::FetchEmailService.new(channel: channel, interval: (Date.today - Date.new(1970, 1, 1)).to_i).perform
mails.each do |mail|
  begin
    Imap::ImapMailbox.new.process(mail, channel)
  rescue StandardError
    failures += 1
  end
end
puts JSON.generate({ fetched: mails.length, messages_before: count_before, messages_after: inbox.messages.count,
  failures: failures, raw_eml_files: Dir.glob(File.join(AkeArchive::ROOT, 'email/raw/*.eml')).length,
  attachment_records: inbox.messages.joins(:attachments).count, test_email_sent: false })
raise 'mail_import_incomplete' if failures.positive?
