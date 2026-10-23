"""Bind Evolution to a native Chatwoot API inbox without printing API tokens."""
import json
import os
import subprocess
from pathlib import Path
import urllib.request
import urllib.error

root = Path.cwd()
private = root / 'private'
config = json.loads((private / 'whatsapp-config.json').read_text())
chatwoot = json.loads((private / 'whatsapp-chatwoot.json').read_text())
instance = 'ake-whatsapp'

def api(path, payload=None):
    request = urllib.request.Request('http://127.0.0.1:14808' + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'apikey': config['api_key'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

existing = api('/instance/fetchInstances')
if not any(item.get('name') == instance or item.get('instance', {}).get('instanceName') == instance for item in existing):
    api('/instance/create', {
        'instanceName': instance, 'integration': 'WHATSAPP-BAILEYS', 'qrcode': False,
        'groupsIgnore': True, 'alwaysOnline': False, 'readMessages': False,
        'readStatus': False, 'syncFullHistory': False,
    })
api('/chatwoot/set/' + instance, {
    'enabled': True, 'accountId': '1', 'token': chatwoot['token'],
    'url': 'http://chatwoot-web:3000', 'nameInbox': 'AKE WhatsApp',
    'signMsg': False, 'reopenConversation': True, 'conversationPending': False,
    'mergeBrazilContacts': False, 'importContacts': False, 'importMessages': False,
    'daysLimitImportMessages': 30, 'autoCreate': True,
    'organization': 'AKE WhatsApp Connection', 'logo': chatwoot['public_url'].rstrip('/') + '/ake-mark.svg',
})
api('/webhook/set/' + instance, {'webhook': {
    'enabled': True, 'url': 'http://whatsapp-archive:4312/webhook',
    'headers': {'Authorization': 'Bearer ' + config['archive_key']},
    'webhookByEvents': False, 'webhookBase64': False,
    'events': ['MESSAGES_UPSERT','MESSAGES_UPDATE','MESSAGES_DELETE','MESSAGES_SET','SEND_MESSAGE','SEND_MESSAGE_UPDATE'],
}})
request = urllib.request.Request('http://127.0.0.1:13000/api/v1/accounts/1/inboxes', headers={'api_access_token':chatwoot['token']})
with urllib.request.urlopen(request, timeout=30) as response:
    inbox = next(item for item in json.load(response)['payload'] if item['name'] == 'AKE WhatsApp')
commands = [
    ['docker','cp','deploy/configure-whatsapp-relay.rb','ai-sales-demo-chatwoot-web-1:/tmp/configure-whatsapp-relay.rb'],
    ['docker','compose','exec','-T','chatwoot-web','bundle','exec','rails','runner','/tmp/configure-whatsapp-relay.rb'],
    ['docker','cp','ai-sales-demo-chatwoot-web-1:/tmp/whatsapp-relay.json','private/whatsapp-relay.json'],
    ['docker','compose','exec','-T','chatwoot-web','rm','-f','/tmp/whatsapp-relay.json'],
]
for command in commands:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('signed_relay_configuration_failed')
(private / 'whatsapp-relay.json').chmod(0o600)
relay = json.loads((private / 'whatsapp-relay.json').read_text())
archive = {
    'account_id': 1, 'inbox_id': inbox['id'], 'instance': instance,
    'chatwoot_url': 'http://chatwoot-web:3000', 'chatwoot_token': chatwoot['token'],
    'archive_key': config['archive_key'], 'dispatch_key': relay['secret'],
    'database_url': 'postgresql://whatsapp_web:' + config['database_password'] + '@postgres:5432/whatsapp_web',
}
path = private / 'whatsapp-archive.json'
fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump(archive, stream)
print(json.dumps({'instance': instance, 'inbox_id': inbox['id'], 'channel_type': inbox['channel_type'],
  'historical_import': False, 'groups': False, 'ready_for_qr': True}))
