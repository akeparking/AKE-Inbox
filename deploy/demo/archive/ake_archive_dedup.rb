# Installation maintenance patch: retain original JSON bytes, but do not create
# another conversation snapshot for contact activity timestamps alone.
module AkeArchiveDedup
  def semantic_value(value)
    case value
    when Hash then value.keys.sort.to_h { |key| [key, semantic_value(value[key])] }
    when Array then value.map { |item| semantic_value(item) }
    else value
    end
  end

  def capture_conversation(conversation)
    return unless conversation.account_id == AkeArchive::ACCOUNT_ID
    payload = { schema_version: 1, record: conversation.attributes, contact: conversation.contact&.attributes }
    semantic = JSON.parse(JSON.generate(payload))
    if semantic['contact'].is_a?(Hash)
      semantic['contact'].delete('last_activity_at')
      semantic['contact'].delete('updated_at')
    end
    fingerprint = Digest::SHA256.hexdigest(JSON.generate(semantic_value(semantic)))
    folder = File.join(AkeArchive::ROOT, 'conversations', conversation.id.to_s)
    directory(folder)
    File.open(File.join(folder, '.ake-dedup.lock'), File::RDWR | File::CREAT, 0o640) do |lock|
      lock.flock(File::LOCK_EX)
      state_path = File.join(folder, '.ake-dedup.json')
      state = begin
        JSON.parse(File.read(state_path))
      rescue Errno::ENOENT, JSON::ParserError
        {}
      end
      content_hash = state['content_sha256'].to_s
      if state['semantic_sha256'] == fingerprint && content_hash.match?(/\A[a-f0-9]{64}\z/) && File.file?(File.join(folder, content_hash + '.json'))
        return content_hash
      end
      content_hash = snapshot('conversations', conversation.id, payload)
      Tempfile.create(['dedup-', '.tmp'], folder) do |file|
        file.write(JSON.generate({ semantic_sha256: fingerprint, content_sha256: content_hash }))
        file.flush
        file.fsync
        File.chmod(0o640, file.path)
        File.chown(nil, AkeArchive::READ_GROUP, file.path)
        File.rename(file.path, state_path)
      end
      content_hash
    end
  end
end

AkeArchive.singleton_class.prepend(AkeArchiveDedup) unless AkeArchive.singleton_class < AkeArchiveDedup
