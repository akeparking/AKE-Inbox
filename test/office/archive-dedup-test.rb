require 'tmpdir'
require 'json'
require 'digest'
Dir.mktmpdir do |root|
  ENV['AKE_ARCHIVE_ROOT'] = root
  ENV['AKE_ARCHIVE_GID'] = Process.gid.to_s
  original = File.expand_path('../../deploy/demo/archive/ake_archive.rb', __dir__)
  eval(File.read(original).split('  module RawImap').first + "\nend\n", TOPLEVEL_BINDING, original)
  require_relative '../../deploy/demo/archive/ake_archive_dedup'
  contact = Struct.new(:attributes).new({'id'=>1, 'name'=>'测试', 'last_activity_at'=>'2026-10-01', 'updated_at'=>'2026-10-01'})
  conversation = Struct.new(:id, :account_id, :attributes, :contact).new(1, 1, {'id'=>1, 'account_id'=>1, 'status'=>0}, contact)
  count = -> { Dir.glob(root + '/conversations/1/[a-f0-9]*.json').length }
  first = AkeArchive.capture_conversation(conversation)
  contact.attributes['last_activity_at'] = '2026-10-23'
  contact.attributes['updated_at'] = '2026-10-23'
  raise 'timestamp duplicates' unless AkeArchive.capture_conversation(conversation) == first && count.call == 1
  contact.attributes['name'] = 'Changed customer field'
  AkeArchive.capture_conversation(conversation)
  raise 'contact change lost' unless count.call == 2
  conversation.attributes['status'] = 1
  last = AkeArchive.capture_conversation(conversation)
  raise 'conversation change lost' unless count.call == 3
  threads = 8.times.map { Thread.new { AkeArchive.capture_conversation(conversation) } }
  threads.each(&:join)
  raise 'concurrent duplicates' unless count.call == 3
  File.unlink(root + '/conversations/1/' + last + '.json')
  AkeArchive.capture_conversation(conversation)
  raise 'missing target not repaired' unless count.call == 3
  Dir.glob(root + '/conversations/1/[a-f0-9]*.json').each do |path|
    raise 'original hash changed' unless Digest::SHA256.file(path).hexdigest == File.basename(path, '.json')
  end
  conversation.account_id = 2
  raise 'account scope ignored' unless AkeArchive.capture_conversation(conversation).nil?
  puts JSON.generate({checks: 7, passed: true, original_json_bytes_preserved: true})
end
