"""Create a content-free deployment receipt. No credentials or message bodies."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import subprocess
import urllib.request
from urllib.parse import urlsplit

root = Path.cwd()
archive = root / 'runtime/inbox-archive'
config = json.loads((root/'private/whatsapp-config.json').read_text())

def command(args, stdin=None):
    value = subprocess.run(args, input=stdin, text=True, capture_output=True, check=True)
    return value.stdout

query = '''SELECT json_agg(t) FROM (
SELECT i.id,i.name,i.channel_type,
(SELECT count(*) FROM messages m WHERE m.inbox_id=i.id) AS messages,
(SELECT count(*) FROM attachments a JOIN messages m ON a.message_id=m.id WHERE m.inbox_id=i.id) AS attachments
FROM inboxes i WHERE i.account_id=1 ORDER BY i.id) t;'''
inboxes = json.loads(command(['docker','compose','exec','-T','postgres','psql','-U','postgres','-d','chatwoot','-tA','-c',query]).strip())
blobs = list((archive/'blobs').glob('*/*'))
emls = list((archive/'email/raw').glob('*.eml'))
assert all(hashlib.sha256(p.read_bytes()).hexdigest() == p.name for p in blobs)
assert all(hashlib.sha256(p.read_bytes()).hexdigest() == p.stem for p in emls)
request = urllib.request.Request('http://127.0.0.1:14808/instance/connectionState/ake-whatsapp', headers={'apikey':config['api_key']})
with urllib.request.urlopen(request,timeout=30) as response:
    state = json.load(response)['instance']['state']
health = json.loads(command(['docker','exec','ai-sales-demo-whatsapp-archive-1','node','-e',
    'fetch("http://127.0.0.1:4312/health").then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))']))
containers = []
for name in ['chatwoot-web','chatwoot-worker','whatsapp-web','whatsapp-archive','sales-core','sales-workspace']:
    data = json.loads(command(['docker','inspect','ai-sales-demo-'+name+'-1']))[0]
    containers.append({'service':name,'running':data['State']['Running'],'oom_killed':data['State']['OOMKilled'],
        'restarts':data['RestartCount'],'health':data['State'].get('Health',{}).get('Status'),
        'image_id':data['Image']})
public = {}
inbox_url = json.loads((root/'private/whatsapp-chatwoot.json').read_text())['public_url']
site_url = next(line.split('=',1)[1].strip().strip('\"\'') for line in (root/'private/site.env').read_text().splitlines() if line.startswith('SITE_URL='))
for url in [site_url.rstrip('/')+'/', inbox_url.rstrip('/')+'/app/login']:
    with urllib.request.urlopen(url,timeout=30) as response:
        public[urlsplit(url).netloc] = response.status
result = {'verified_at_utc':datetime.now(timezone.utc).isoformat(), 'inboxes':inboxes,
    'raw_eml_files':len(emls), 'archive_blob_files':len(blobs), 'archive_hashes_verified':True,
    'message_versions':len(list((archive/'messages').glob('*/*.json'))),
    'latest_reconciliation':json.loads((archive/'latest-reconciliation.json').read_text()),
    'whatsapp_state':state, 'whatsapp_real_send_receive_verified':False,
    'whatsapp_archive':health, 'public_http':public, 'containers':containers,
    'timer_active':command(['systemctl','is-active','ake-inbox-archive.timer']).strip() == 'active',
    'temporary_mailbox_secret_removed':not (root/'private/mailbox-setup.json').exists()}
(root/'evidence').mkdir(exist_ok=True)
(root/'evidence/inbox-upgrade-20261003.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
