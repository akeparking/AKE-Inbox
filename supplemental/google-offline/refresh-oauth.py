"""Refresh this task's dedicated OAuth credential without uploading any event."""
import os
import datetime
import json
import time
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if os.environ.get('GOOGLE_OFFLINE_LIVE_ENABLED') != 'true':
    raise SystemExit('Explicit live acceptance opt-in is required')
root = Path(os.environ['GOOGLE_AUTH_ROOT'])
proof_root = Path(os.environ['GOOGLE_ACCEPTANCE_ROOT'])
scope_config = json.loads((proof_root / 'private/acceptance-scope.json').read_text())
client = json.loads((root / 'private/google-oauth-client.json').read_text())['installed']
token_path = root / 'private/google-oauth-token.json'
token = json.loads(token_path.read_text())
scope = 'https://www.googleapis.com/auth/datamanager'
assert scope_config.get('oauthProjectId') and client['project_id'] == scope_config['oauthProjectId']
assert set(token['scope'].split()) == {scope}
fields = {'client_id': client['client_id'], 'client_secret': client['client_secret'],
          'refresh_token': token['refresh_token'], 'grant_type': 'refresh_token'}
request = urllib.request.Request('https://oauth2.googleapis.com/token',
    data=urllib.parse.urlencode(fields).encode(),
    headers={'Content-Type': 'application/x-www-form-urlencoded'})
opener = urllib.request.build_opener()  # Uses the operator's existing proxy environment.
try:
    with opener.open(request, timeout=30) as response:
        refreshed = json.load(response)
    assert refreshed.get('access_token') and set(refreshed.get('scope', token['scope']).split()) == {scope}
    token.update(refreshed)
    token['received_at'] = time.time()
    token['expires_at'] = time.time() + int(token['expires_in'])
    tmp = token_path.with_suffix('.tmp')
    tmp.touch(mode=0o600)
    tmp.write_text(json.dumps(token))
    tmp.chmod(0o600)
    tmp.replace(token_path)
    proof = {'status': 'passed', 'grant': 'refresh_token', 'scope': scope,
             'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'credentialsExported': False, 'adsUploadExecuted': False}
    (proof_root / 'evidence/google-refresh.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps(proof))
except urllib.error.HTTPError as error:
    print(json.dumps({'status': 'failed', 'httpStatus': error.code, 'credentialsLogged': False}))
    raise SystemExit(1)
