# Run in the local Chatwoot container, then read the probe as Core's uid 1000.
raise 'local acceptance only' unless ENV['FRONTEND_URL']&.include?('localhost:14620')
sha = AkeArchive.snapshot('permission_probe', 'nested', { fixture: 'no customer data' })
root = AkeArchive::ROOT
%w[permission_probe permission_probe/nested].each do |relative|
  stat = File.stat(File.join(root, relative))
  raise 'archive parent group cannot be traversed' unless stat.gid == AkeArchive::READ_GROUP && (stat.mode & 0o050) == 0o050
end
puts JSON.generate(result: 'passed', sha256: sha, cross_user_probe: 'permission_probe/nested')
