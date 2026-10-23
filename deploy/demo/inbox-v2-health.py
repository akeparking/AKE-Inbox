"""Content-free channel health snapshot for the Inbox operator panel."""
import json,pathlib,urllib.request,datetime
root=pathlib.Path('/opt/ai-sales-demo')
cfg=json.loads((root/'private/reception-config.json').read_text());wa=json.loads((root/'private/whatsapp-config.json').read_text());native=json.loads((root/'private/whatsapp-chatwoot.json').read_text())
def get(url,headers=None):
 with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=15) as r:return json.load(r)
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
try:inboxes=get('http://127.0.0.1:13000/api/v1/accounts/1/inboxes',{'api_access_token':native['token']})['payload']
except Exception:inboxes=[]
try:state=get('http://127.0.0.1:14808/instance/connectionState/ake-whatsapp',{'apikey':wa['api_key']})['instance']['state']
except Exception:state='unreachable'
acceptance=json.loads((root/'evidence/inbox-v02-channel-acceptance.json').read_text()) if (root/'evidence/inbox-v02-channel-acceptance.json').exists() else {}
result={str(i):{'checkedAt':now,'acceptance':acceptance.get(str(i),{}).get('acceptance','pending'),'connection':('native_api_available' if i==1 else 'configured_transport_requires_roundtrip' if i==2 else state)} for i in [1,2,3]}
for i in result:
 if not any(str(v['id'])==i for v in inboxes):result[i]['connection']='unreachable'
 if i=='2' and acceptance.get(i,{}).get('acceptance')=='passed':result[i]['connection']='smtp_imap_roundtrip_verified'
request=urllib.request.Request('http://127.0.0.1:14100/api/v1/inbox-v2/channel-health',data=json.dumps(result).encode(),headers={'Content-Type':'application/json','x-inbox-key':cfg['inbox_internal_key']})
with urllib.request.urlopen(request,timeout=15) as r:assert r.status==201
(root/'evidence/inbox-v02-channel-health.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
