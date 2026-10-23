"""Provision one unpaired WhatsApp slot per seat. Run on the deployment host.

Does not send customer messages or activate invited users. Legacy channels remain
owned by the administrator, as requested by the deployment owner.
Secrets are read and written only in the existing private deployment directory.
"""
import json
import os
from pathlib import Path
import subprocess
import urllib.request

root = Path.cwd()
private = root / 'private'
config = json.loads((private / 'whatsapp-config.json').read_text())
chatwoot = json.loads((private / 'whatsapp-chatwoot.json').read_text())

def api(path, payload=None):
    req = urllib.request.Request('http://127.0.0.1:14808' + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'apikey': config['api_key'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=35) as response:
        return json.load(response)

ruby = r'''
require 'json'
account=Account.find(ENV.fetch('AKE_INBOX_ACCOUNT_ID','1'))
websites=account.inboxes.where(channel_type:'Channel::WebWidget')
members=account.account_users.agent.includes(:user)
previous={websites:websites.map{|i|{id:i.id,auto_assignment:i.enable_auto_assignment,members:i.member_ids}},admin_assignments:[],legacy:[]}
seats=[]
administrator=account.account_users.administrator.first!.user
account.inboxes.where(id:[ENV.fetch('AKE_LEGACY_EMAIL_INBOX_ID','2').to_i,ENV.fetch('AKE_LEGACY_WHATSAPP_INBOX_ID','3').to_i]).each do |inbox|
  previous[:legacy] << {id:inbox.id,auto_assignment:inbox.enable_auto_assignment,config:inbox.auto_assignment_config,members:inbox.member_ids,assignments:inbox.conversations.pluck(:id,:assignee_id)}
  inbox.update!(enable_auto_assignment:false,auto_assignment_config:(inbox.auto_assignment_config||{}).merge('ake_owner_id'=>administrator.id,'ake_admin_owned'=>true))
  InboxMember.find_or_create_by!(inbox:inbox,user_id:administrator.id)
  inbox.inbox_members.where.not(user_id:administrator.id).each(&:destroy!)
  # Ownership migration does not emit customer replies or assignment emails.
  inbox.conversations.update_all(assignee_id:administrator.id)
end
members.each do |member|
  instance="ake-seat-#{member.user_id}"
  inbox=account.inboxes.where(channel_type:'Channel::Api').find_by("auto_assignment_config ->> 'ake_owner_id' = ?",member.user_id.to_s)
  unless inbox
    channel=Channel::Api.create!(account:account,additional_attributes:{ake_instance:instance})
    inbox=account.inboxes.create!(channel:channel,name:member.user.name+' WhatsApp',enable_auto_assignment:false,auto_assignment_config:{ake_owner_id:member.user_id})
  end
  InboxMember.find_or_create_by!(inbox:inbox,user_id:member.user_id)
  instance=inbox.channel.additional_attributes['ake_instance']||instance
  seats << {user_id:member.user_id,inbox_id:inbox.id,name:inbox.name,instance:instance}
end
websites.each do |inbox|
  inbox.update!(enable_auto_assignment:true)
  members.each{|member|InboxMember.find_or_create_by!(inbox:inbox,user_id:member.user_id)}
  inbox.inbox_members.where(user_id:account.account_users.administrator.select(:user_id)).each(&:destroy!)
  inbox.conversations.open.where(assignee_id:account.account_users.administrator.select(:user_id)).each do |conversation|
    previous[:admin_assignments] << {id:conversation.id,assignee_id:conversation.assignee_id}
    conversation.update_columns(assignee_id:nil)
  end
end
puts JSON.generate({seats:seats,previous:previous})
'''
run = subprocess.run(['docker', 'exec', 'ai-sales-demo-chatwoot-web-1', 'bundle', 'exec', 'rails', 'runner', ruby],
                     capture_output=True, text=True, timeout=90)
if run.returncode:
    raise RuntimeError('native_seat_provision_failed')
receipt = next(json.loads(line) for line in run.stdout.splitlines() if line.startswith('{"seats"'))
receipt_path = private / 'seat-channel-provision.json'
if not receipt_path.exists():
    with os.fdopen(os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(receipt, stream)

instances = {item.get('name') or item.get('instance', {}).get('instanceName') for item in api('/instance/fetchInstances')}
archive_path = private / 'whatsapp-archive.json'
archive = json.loads(archive_path.read_text())
bindings = archive.get('bindings') or [{key: archive[key] for key in ['inbox_id', 'instance', 'dispatch_key']}]
bindings[0].setdefault('controlled', True)
for seat in receipt['seats']:
    instance = seat['instance']
    if instance not in instances:
        api('/instance/create', {'instanceName': instance, 'integration': 'WHATSAPP-BAILEYS', 'qrcode': False,
                                'groupsIgnore': True, 'alwaysOnline': False, 'readMessages': False,
                                'readStatus': False, 'syncFullHistory': False})
    api('/chatwoot/set/' + instance, {
        'enabled': True, 'accountId': str(archive['account_id']), 'token': chatwoot['token'],
        'url': 'http://chatwoot-web:3000', 'nameInbox': seat['name'], 'signMsg': False,
        'reopenConversation': True, 'conversationPending': False, 'mergeBrazilContacts': False,
        'importContacts': False, 'importMessages': False, 'daysLimitImportMessages': 1,
        'autoCreate': False, 'organization': 'AKE WhatsApp Connection',
        'logo': chatwoot['public_url'].rstrip('/') + '/ake-mark.svg',
    })
    api('/webhook/set/' + instance, {'webhook': {
        'enabled': True, 'url': 'http://whatsapp-archive:4312/webhook',
        'headers': {'Authorization': 'Bearer ' + config['archive_key']},
        'webhookByEvents': False, 'webhookBase64': False,
        'events': ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'MESSAGES_SET', 'SEND_MESSAGE', 'SEND_MESSAGE_UPDATE'],
    }})
    if not any(b['inbox_id'] == seat['inbox_id'] for b in bindings):
        bindings.append({'inbox_id': seat['inbox_id'], 'instance': instance,
                         'dispatch_key': archive['dispatch_key'], 'controlled': False})
# Native account webhook already provides signed, deduplicated forwarding.
ids = [int(s['inbox_id']) for s in receipt['seats']]
cleanup = 'Inbox.where(id:' + json.dumps(ids) + ').each{|i|i.channel.update!(webhook_url:nil)}'
result = subprocess.run(['docker', 'exec', 'ai-sales-demo-chatwoot-web-1', 'bundle', 'exec', 'rails', 'runner', cleanup],
                        capture_output=True, timeout=60)
if result.returncode:
    raise RuntimeError('unsigned_callback_cleanup_failed')
archive['bindings'] = bindings
# Preserve the inode of the Docker bind-mounted config.
with archive_path.open('w') as stream:
    json.dump(archive, stream)
os.chmod(archive_path, 0o600)

env_path = private / 'inbox-control.env'
lines = env_path.read_text().splitlines()
values = {'AKE_SEAT_ROUTING_ENABLED': 'true', 'AKE_WHATSAPP_API_KEY': config['api_key']}
lines = [line for line in lines if line.partition('=')[0] not in values]
env_path.write_text('\n'.join(lines + [k + '=' + v for k, v in values.items()]) + '\n')
os.chmod(env_path, 0o600)
print(json.dumps({'seat_channels': [{'user_id': s['user_id'], 'inbox_id': s['inbox_id']} for s in receipt['seats']],
                  'paired_by_user': False, 'legacy_channels_preserved': True}))
