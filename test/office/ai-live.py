"""Real API acceptance against a dedicated synthetic native inbox only."""
import json,pathlib,subprocess,sys,time,urllib.request
root=pathlib.Path(sys.argv[1]);repo=pathlib.Path(__file__).resolve().parents[2]
f=json.loads((root/'private/office-fixtures.json').read_text());envfile=root/'private/core.env';original=envfile.read_text();env=dict(l.split('=',1) for l in original.splitlines() if '=' in l and not l.startswith('#'))
assert f['inboxId']>7 and env['INBOX_TEST_CONTACT_IDS']==str(f['contactId'])
op=urllib.request.build_opener(urllib.request.ProxyHandler({}));ids=[]
def request(url,body=None,headers=None):
 with op.open(urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json',**(headers or {})}),timeout=25) as r:return json.load(r)
def native(path,body=None,token=None):return request('http://127.0.0.1:14720/api/v1/accounts/1'+path,body,{'api_access_token':token or env['CHATWOOT_API_TOKEN']})
def sql(q):return subprocess.check_output(['docker','exec','ake-inbox-office-postgres-1','psql','-U','postgres','-d','sales_workspace','-At','-c',q],text=True).strip()
def outgoing(cid):return [m for m in native('/conversations/'+str(cid)+'/messages')['payload'] if m['message_type']==1 and not m['private']]
def wait(fn,timeout=110):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  x=fn()
  if x:return x
  time.sleep(1)
 raise TimeoutError('Real API acceptance condition not met')
def compose():subprocess.run(['docker','compose','--env-file',str(root/'private/compose.env'),'-f',str(repo/'deploy/office/compose.yaml'),'up','-d','core'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
def start(text):
 r=request('http://127.0.0.1:14720/api/v1/widget/conversations?website_token='+f['websiteToken'],{'message':{'content':text,'timestamp':time.time(),'referer_url':'https://office-acceptance.example.invalid'}},{'X-Auth-Token':f['widgetToken']});ids.append(r['id']);return r['id']
report={'realApi':True,'syntheticInboxOnly':True,'requestedModel':f.get('modelName','configured-api'),'checks':{}}
try:
 for u in f['users']:native('/ake_reception/heartbeat',{'state':'offline'},u['token'])
 updates={'INBOX_MODEL_URL':'http://'+f['officeGateway']+':14731','INBOX_MODEL_READY':'true','INBOX_AUTO_SEND':'true','INBOX_AUTO_CHANNELS':'website'}
 envfile.write_text('\n'.join(l for l in original.splitlines() if l.partition('=')[0] not in updates)+'\n'+'\n'.join(k+'='+v for k,v in updates.items())+'\n');compose();time.sleep(5)
 began=time.monotonic();cid=start('你好，这是一条本机验收消息，准备开展停车项目。项目地点和预算尚未确定。')
 reply=wait(lambda:outgoing(cid));assert len(reply)==1 and '[模拟' not in reply[0]['content']
 report['checks']['allOfflineRealApiNativeReply']=True;report['replyLatencySeconds']=round(time.monotonic()-began,1);report['syntheticReply']=reply[0]['content'];native('/conversations/'+str(cid)+'/toggle_status',{'status':'resolved'})
 print('Real company API → Core → native outgoing reply verified',flush=True)
 cid=start('Hello, this is a second synthetic acceptance parking inquiry. The location and budget are not yet known.')
 wait(lambda:sql("SELECT count(*) FROM inbox_v2_jobs WHERE conversation_id="+str(cid)+" AND kind='ai' AND state='processing'")=='1')
 wait(lambda:request('http://'+f['officeGateway']+':14731/health').get('busy'),20)
 native('/ake_reception/heartbeat',{'state':'online'},f['users'][1]['token'])
 wait(lambda:sql('SELECT mode FROM inbox_v2_conversations WHERE conversation_id='+str(cid))=='human')
 wait(lambda:sql("SELECT count(*) FROM inbox_v2_jobs WHERE conversation_id="+str(cid)+" AND kind='ai' AND state='processing'")=='0')
 wait(lambda:not request('http://'+f['officeGateway']+':14731/health').get('busy'),90)
 time.sleep(5);assert not outgoing(cid);report['checks']['humanReturnCancelsRealAi']=True;native('/conversations/'+str(cid)+'/toggle_status',{'status':'resolved'})
 print('Human return cancelled real API acceptance reply',flush=True)
finally:
 for cid in ids:
  try:native('/conversations/'+str(cid)+'/toggle_status',{'status':'resolved'})
  except Exception:pass
 for u in f['users']:
  try:native('/ake_reception/heartbeat',{'state':'offline'},u['token'])
  except Exception:pass
 envfile.write_text(original);envfile.chmod(0o600);compose();report['flagsRestored']=True;report['testConversationIds']=ids
 (root/'evidence/ai-live-integration.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));print(json.dumps(report,ensure_ascii=False),flush=True)
