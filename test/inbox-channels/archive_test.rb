require 'minitest/autorun'
require 'tmpdir'
require 'ostruct'
require 'active_support/all'

ENV['AKE_ARCHIVE_ROOT'] = Dir.mktmpdir('ake-archive-test-')
module Rails
  def self.application = OpenStruct.new(config: self)
  def self.to_prepare; end
end
require_relative '../../deploy/demo/archive/ake_archive'

class ArchiveTest < Minitest::Test
  def setup
    FileUtils.rm_rf(Dir.glob(File.join(AkeArchive::ROOT, '*')))
  end

  def test_changed_messages_keep_original_and_new_versions
    old = AkeArchive.snapshot('messages', 7, { content: 'original', status: 'sent' })
    changed = AkeArchive.snapshot('messages', 7, { content: 'edited', status: 'read' })
    AkeArchive.snapshot('messages', 7, { content: 'edited', status: 'read' })
    assert_equal 2, Dir.glob(File.join(AkeArchive::ROOT, 'messages/7/*.json')).length
    refute_equal old, changed
    assert_equal 'original', JSON.parse(File.read(File.join(AkeArchive::ROOT, 'messages/7', old + '.json')))['content']
  end

  def test_raw_mime_retains_exact_bytes_and_does_not_use_message_id_as_path
    raw = "Message-ID: <../../outside>\r\nSubject: test\r\n\r\n\x00binary\xff".b
    channel = OpenStruct.new(account_id: 1, inbox: OpenStruct.new(id: 2))
    mail = OpenStruct.new(raw_source: raw, message_id: '../../outside')
    AkeArchive.capture_raw_email(channel, mail)
    files = Dir.glob(File.join(AkeArchive::ROOT, 'email/raw/*.eml'))
    assert_equal 1, files.length
    assert_equal raw, File.binread(files.first)
    assert_equal 0o640, File.stat(files.first).mode & 0o777
  end

  def test_other_account_is_excluded
    AkeArchive.capture_raw_email(OpenStruct.new(account_id: 2), OpenStruct.new(raw_source: 'secret'))
    assert_empty Dir.glob(File.join(AkeArchive::ROOT, '**/*'))
  end

  def test_attachment_bytes_and_original_filename_are_retained
    bytes = "\x00\xff\x01original file".b
    file = Tempfile.new('source'); file.binmode; file.write(bytes); file.flush
    blob = OpenStruct.new(id: 4, key: 'provider-key', filename: '../../unsafe.pdf', content_type: 'application/pdf', byte_size: bytes.bytesize, checksum: 'native')
    blob.define_singleton_method(:open) { |&block| file.rewind; block.call(file) }
    result = AkeArchive.blob(blob)
    assert_equal bytes, File.binread(File.join(AkeArchive::ROOT, result[:path]))
    assert_equal Digest::SHA256.hexdigest(bytes), result[:sha256]
    assert_equal '../../unsafe.pdf', result[:filename]
    assert_match %r{\Ablobs/[0-9a-f]{2}/[0-9a-f]{64}\z}, result[:path]
  ensure
    file&.close!
  end

  def test_imap_is_archived_before_mailbox_processing
    channel = OpenStruct.new(account_id: 1, inbox: OpenStruct.new(id: 2))
    raw_mail = OpenStruct.new(raw_source: "Subject: fixture\r\n\r\nhello", message_id: 'fixture')
    base = Class.new do
      attr_accessor :channel, :fixture
      def process_message_id(_) = fixture
    end
    base.prepend(AkeArchive::RawImap)
    fetcher = base.new; fetcher.channel = channel; fetcher.fixture = raw_mail
    assert_same raw_mail, fetcher.send(:process_message_id, [3, 'fixture'])
    assert_equal 1, Dir.glob(File.join(AkeArchive::ROOT, 'email/raw/*.eml')).length
  end
end
