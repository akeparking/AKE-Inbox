# Mounted as a Chatwoot initializer. Original records and file bytes are retained
# independently of the live database. No customer content is written to logs.
require 'digest'
require 'fileutils'
require 'json'
require 'tempfile'
require 'time'

module AkeArchive
  ROOT = ENV.fetch('AKE_ARCHIVE_ROOT', '/var/lib/ake-archive').freeze
  ACCOUNT_ID = Integer(ENV.fetch('AKE_ARCHIVE_ACCOUNT_ID', '1'))
  READ_GROUP = Integer(ENV.fetch('AKE_ARCHIVE_GID', '1000'))

  def self.directory(path)
    root = File.expand_path(ROOT)
    current = File.expand_path(path)
    raise ArgumentError, 'archive path outside root' unless current == root || current.start_with?(root + '/')
    FileUtils.mkdir_p(current, mode: 0o2750)
    # mkdir_p can create several parents. Every one must be traversable by the
    # read-only Core process, not just the deepest message/blob directory.
    loop do
      File.chown(nil, READ_GROUP, current)
      File.chmod(0o2750, current)
      break if current == root
      current = File.dirname(current)
    end
  end

  def self.atomic_bytes(path, bytes)
    directory(File.dirname(path))
    return if File.exist?(path)
    Tempfile.create(['archive-', '.tmp'], File.dirname(path)) do |file|
      file.binmode
      file.write(bytes)
      file.flush
      file.fsync
      File.rename(file.path, path)
    end
    File.chmod(0o640, path)
    File.chown(nil, READ_GROUP, path)
  end

  def self.snapshot(kind, id, payload)
    bytes = JSON.generate(payload)
    sha = Digest::SHA256.hexdigest(bytes)
    path = File.join(ROOT, kind, id.to_s, "#{sha}.json")
    atomic_bytes(path, bytes)
    sha
  end

  def self.blob(file_blob)
    sha = nil
    file_blob.open do |source|
      sha = Digest::SHA256.file(source.path).hexdigest
      target = File.join(ROOT, 'blobs', sha[0, 2], sha)
      unless File.exist?(target)
        directory(File.dirname(target))
        Tempfile.create(['blob-', '.tmp'], File.dirname(target)) do |out|
          out.binmode
          IO.copy_stream(source, out)
          out.flush
          out.fsync
          File.rename(out.path, target)
        end
        File.chmod(0o640, target)
        File.chown(nil, READ_GROUP, target)
      end
    end
    { id: file_blob.id, key: file_blob.key, filename: file_blob.filename.to_s,
      content_type: file_blob.content_type, byte_size: file_blob.byte_size,
      checksum: file_blob.checksum, sha256: sha, path: "blobs/#{sha[0, 2]}/#{sha}" }
  end

  def self.capture_message(message, require_files: false)
    return unless message.account_id == ACCOUNT_ID
    attachments = message.attachments.map do |attachment|
      value = attachment.attributes
      if attachment.file.attached?
        begin
          value['file'] = blob(attachment.file.blob)
        rescue ActiveStorage::FileNotFoundError
          raise if require_files
          # Active Storage uploads after the attachment's commit callback. Keep
          # the original text now; a retryable job saves the committed file.
          value['archive_pending'] = true
        end
      end
      value
    end
    snapshot('messages', message.id, { schema_version: 1, record: message.attributes, attachments: attachments })
  end

  def self.capture_conversation(conversation)
    return unless conversation.account_id == ACCOUNT_ID
    snapshot('conversations', conversation.id, { schema_version: 1, record: conversation.attributes,
      contact: conversation.contact&.attributes })
  end

  def self.capture_raw_email(channel, mail)
    return unless channel.account_id == ACCOUNT_ID
    headers = %w[auto-submitted precedence x-auto-response-suppress].to_h { |key| [key, mail.respond_to?(:[]) ? mail[key].to_s : ''] }
    normalized_id = mail.message_id.to_s.delete_prefix('<').delete_suffix('>')
    snapshot('email_ids', Digest::SHA256.hexdigest(normalized_id), { account_id: channel.account_id, inbox_id: channel.inbox.id, headers: headers })
    raw = mail.raw_source
    return if raw.nil? || raw.empty?
    sha = Digest::SHA256.hexdigest(raw)
    atomic_bytes(File.join(ROOT, 'email', 'raw', "#{sha}.eml"), raw)
    snapshot('email', sha, { schema_version: 1, account_id: channel.account_id,
      inbox_id: channel.inbox.id, message_id: mail.message_id,
      sha256: sha, path: "email/raw/#{sha}.eml", byte_size: raw.bytesize })
  end

  def self.guard
    yield
  rescue StandardError => error
    # The native database remains the primary durable store; the reconciliation
    # timer retries snapshots and attachments after a transient archive failure.
    Rails.logger.error("[AKE_ARCHIVE] capture_failed class=#{error.class.name}")
  end

  module RawImap
    private

    def process_message_id(message_id_with_seq)
      mail = super
      # Archive BEFORE parsing into a conversation; if this write fails the
      # mailbox job retries, instead of silently discarding the original MIME.
      AkeArchive.capture_raw_email(channel, mail) if mail
      mail
    end
  end

  module MessageCallbacks
    extend ActiveSupport::Concern
    included do
      after_commit(on: [:create, :update]) { AkeArchive.guard { AkeArchive.capture_message(self) } }
      before_destroy { AkeArchive.guard { AkeArchive.capture_message(self) } }
    end
  end

  module ConversationCallbacks
    extend ActiveSupport::Concern
    included do
      after_commit(on: [:create, :update]) { AkeArchive.guard { AkeArchive.capture_conversation(self) } }
      before_destroy { AkeArchive.guard { AkeArchive.capture_conversation(self) } }
    end
  end

  module AttachmentCallbacks
    extend ActiveSupport::Concern
    included do
      after_commit(on: [:create, :update]) do
        AkeArchive.guard do
          if message
            AkeArchive.capture_message(message)
            AkeArchiveCaptureJob.perform_later(message.id)
          end
        end
      end
      before_destroy { AkeArchive.guard { AkeArchive.capture_message(message) if message } }
    end
  end
end

Rails.application.config.to_prepare do
  Message.include(AkeArchive::MessageCallbacks) unless Message < AkeArchive::MessageCallbacks
  Conversation.include(AkeArchive::ConversationCallbacks) unless Conversation < AkeArchive::ConversationCallbacks
  Attachment.include(AkeArchive::AttachmentCallbacks) unless Attachment < AkeArchive::AttachmentCallbacks
  Imap::BaseFetchEmailService.prepend(AkeArchive::RawImap) unless Imap::BaseFetchEmailService < AkeArchive::RawImap
end
