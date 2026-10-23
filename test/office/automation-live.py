"""Integration of real queues and send fences with an explicitly SIMULATED model.
Never proves model authentication or live AI quality. Restores disabled AI flags.
"""
import base64,hashlib,hmac,http.server,json,pathlib,subprocess,sys,threading,time,urllib.request
root=pathlib.Path(sys.argv[1]);repo=pathlib.Path(__file__).resolve().parents[2]
f=json.loads((root/'private/office-fixtures.json').read_text());envfile=root/'private/core.env';original=envfile.read_text()
env=dict(l.split('=',1) for l in original.splitlines() if '=' in l and not l.startswith('#'))
assert env['INBOX_TEST_CONTACT_IDS']==str(f['contactId']) and f['inboxId']>7
op=urllib.request.build_opener(urllib.request.ProxyHandler({}));model_calls=[];conversation_ids=[]
def request(url,body=None,headers=None):
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json',**(headers or {})})
 with op.open(req,timeout=35) as response:return json.load(response)
def native(path,body=None,token=None):return request('http://127.0.0.1:14720/api/v1/accounts/1'+path,body,{'api_access_token':token or env['CHATWOOT_API_TOKEN']})
def widget(path,body):return request('http://127.0.0.1:14720/api/v1/widget'+path+'?website_token='+f['websiteToken'],body,{'X-Auth-Token':f['widgetToken']})
def query(sql):
 r=subprocess.run(['docker','exec','ake-inbox-office-postgres-1','psql','-U','postgres','-d','sales_workspace','-At','-c',sql],capture_output=True,text=True,check=True);return r.stdout.strip()
def state(cid):
 r=query("SELECT json_build_object('mode',mode,'revision',revision,'hold',reception_hold) FROM inbox_v2_conversations WHERE account_id=1 AND conversation_id="+str(int(cid)));return json.loads(r) if r else {}
def wait(predicate,seconds=70):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  result=predicate()
  if result:return result
  time.sleep(1)
 raise TimeoutError('Simulated-model integration assertion timed out')
def messages(cid):return native('/conversations/'+str(cid)+'/messages')['payload']
def outgoing(cid):return [m for m in messages(cid) if m['message_type']==1 and not m['private']]
def start(marker):
 c=widget('/conversations',{'message':{'content':'Synthetic acceptance parking inquiry. '+marker,'timestamp':time.time(),'referer_url':'https://office-acceptance.example.invalid'}})
 conversation_ids.append(c['id']);return c['id']
def resolve(cid):native('/conversations/'+str(cid)+'/toggle_status',{'status':'resolved'})
def compose(*args):
 subprocess.run(['docker','compose','--env-file',str(root/'private/compose.env'),'-f',str(repo/'deploy/office/compose.yaml'),*args],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
class SimulatedModel(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  if not hmac.compare_digest(self.headers.get('x-inbox-key',''),env['INBOX_INTERNAL_KEY']):self.send_error(401);return
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));last=body['messages'][-1]['text'];model_calls.append({'started':time.monotonic(),'delayed':'DELAYED_PROBE' in last})
  if 'DELAYED_PROBE' in last:time.sleep(20)
  if 'FAILURE_PROBE' in last:self.send_error(503);return
  data=json.dumps({'mode':'api','reply':'[模拟 AI 验收] 已收到测试咨询。','summary':'Synthetic acceptance only','needsHuman':False,'hasProductClaims':False,'knowledgeIds':[],'askedFields':[],'fields':{},'evidence':[]}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
gateway=f['officeGateway'];server=http.server.ThreadingHTTPServer((gateway,14732),SimulatedModel);threading.Thread(target=server.serve_forever,daemon=True).start()
report={'model':'deterministic simulation','liveAiVerified':False,'checks':{}}
try:
 for user in f['users']:native('/ake_reception/heartbeat',{'state':'offline'},user['token'])
 # Retire previous synthetic fixture conversations before enabling the simulator.
 known=subprocess.run(['docker','exec','ake-inbox-office-postgres-1','psql','-U','postgres','-d','chatwoot','-At','-c','SELECT display_id FROM conversations WHERE inbox_id='+str(f['inboxId'])+' AND status<>1'],capture_output=True,text=True,check=True).stdout.split()
 for cid in known:resolve(int(cid))
 updates={'INBOX_MODEL_URL':'http://'+gateway+':14732','INBOX_MODEL_READY':'true','INBOX_AUTO_SEND':'true','INBOX_AUTO_CHANNELS':'website'}
 envfile.write_text('\n'.join(l for l in original.splitlines() if l.partition('=')[0] not in updates)+'\n'+'\n'.join(k+'='+v for k,v in updates.items())+'\n')
 compose('up','-d','core');time.sleep(5)
 cid=start('OFFLINE_PROBE');reply=wait(lambda:outgoing(cid));assert len(reply)==1 and reply[0]['content'].startswith('[模拟 AI 验收]')
 report['checks']['allOfflineQueuesAndDelivers']=True;print('Simulated model: offline queue and native delivery passed',flush=True)
 incoming=next(m for m in messages(cid) if m['message_type']==0)
 body={'account':{'id':1},'event':'message_created','id':incoming['id'],'message_type':'incoming','private':False,'content':incoming['content'],'created_at':incoming['created_at'],'conversation':{'id':cid,'inbox_id':f['inboxId']}}
 duplicate=request('http://127.0.0.1:14722/api/v1/inbox-v2/events',body,{'x-inbox-key':env['INBOX_INTERNAL_KEY']});assert duplicate.get('duplicate')
 time.sleep(3);assert len(outgoing(cid))==1;report['checks']['duplicateEventSendsOnce']=True;resolve(cid)
 before=len(model_calls);cid=start('DELAYED_PROBE');wait(lambda:len(model_calls)>before)
 native('/ake_reception/heartbeat',{'state':'online'},f['users'][1]['token']);wait(lambda:state(cid).get('mode')=='human');time.sleep(22)
 assert not outgoing(cid);report['checks']['onlineReturnCancelsDelayedAi']=True;resolve(cid)
 native('/ake_reception/heartbeat',{'state':'offline'},f['users'][1]['token']);print('Simulated model: returning human cancelled delayed AI; duplicate event sent once',flush=True)
 # Prove accepted native messages survive an unavailable Core and replay once.
 compose('stop','-t','5','core');cid=start('DURABLE_PROBE');time.sleep(5);compose('up','-d','core')
 reply=wait(lambda:outgoing(cid),100);assert len(reply)==1;time.sleep(4);assert len(outgoing(cid))==1
 report['checks']['nativeQueueSurvivesCoreOutage']=True;resolve(cid)
 cid=start('FAILURE_PROBE');wait(lambda:state(cid).get('mode')=='human_pending' and state(cid).get('hold'),60)
 assert not outgoing(cid);report['checks']['modelFailureWaitsForHuman']=True;resolve(cid)
 print(json.dumps(report),flush=True)
finally:
 for cid in conversation_ids:
  try:resolve(cid)
  except Exception:pass
 envfile.write_text(original);envfile.chmod(0o600);compose('up','-d','core');server.shutdown()
 report['aiFlagsRestored']=True;report['testConversationIds']=conversation_ids
 (root/'evidence/automation-simulated-integration.json').write_text(json.dumps(report,indent=2))
 print('Simulation finished; original disabled AI configuration restored',flush=True)
