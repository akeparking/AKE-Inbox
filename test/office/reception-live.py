"""Real native/Core/worker routing check. Uses a dedicated synthetic inbox only."""
import json,pathlib,sys,urllib.request,urllib.error,time,threading,subprocess,base64
root=pathlib.Path(sys.argv[1]);fixtures=json.loads((root/'private/office-fixtures.json').read_text())
env=dict(l.split('=',1) for l in (root/'private/core.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
assert fixtures['inboxId']>7 and fixtures['contactId']>110
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def api(path,body=None,token=None):
 req=urllib.request.Request('http://127.0.0.1:14720/api/v1/accounts/1'+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json','api_access_token':token or env['CHATWOOT_API_TOKEN']})
 try:
  with op.open(req,timeout=25) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError('Native API returned '+str(e.code)+' at '+path) from None

def wait(predicate,seconds=50):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  value=predicate()
  if value:return value
  time.sleep(1)
 raise TimeoutError('Routing acceptance condition not met')

def core(cid):
 query="SELECT json_build_object('mode',mode,'revision',revision,'managed',reception_managed,'hold',reception_hold) FROM inbox_v2_conversations WHERE account_id=1 AND conversation_id="+str(int(cid))
 r=subprocess.run(['docker','exec','ake-inbox-office-postgres-1','psql','-U','postgres','-d','sales_workspace','-At','-c',query],capture_output=True,text=True,check=True)
 return json.loads(r.stdout) if r.stdout.strip() else None

def widget(path,body):
 req=urllib.request.Request('http://127.0.0.1:14720/api/v1/widget'+path+'?website_token='+fixtures['websiteToken'],data=json.dumps(body).encode(),headers={'content-type':'application/json','X-Auth-Token':fixtures['widgetToken']})
 with op.open(req,timeout=25) as r:return json.load(r)
def incoming():
 c=widget('/conversations',{'message':{'content':'Hello. This is a synthetic office acceptance inquiry about a parking project.','timestamp':time.time(),'referer_url':'https://office-acceptance.example.invalid'}})
 return c['id'],None

alpha,beta,outsider=fixtures['users']
# Alpha is the Windows application. Beta simulates a second authenticated seat.
api('/ake_reception/heartbeat',{'state':'online'},beta['token'])
api('/ake_reception/heartbeat',{'state':'online'},outsider['token'])
stop=threading.Event()
def renew():
 while not stop.wait(15):api('/ake_reception/heartbeat',{},beta['token'])
threading.Thread(target=renew,daemon=True).start()
cids=[];owners=[]
try:
 for n in range(4):
  cid,mid=incoming();cids.append(cid)
  wait(lambda:((core(cid) or {}).get('mode')=='human' and (core(cid) or {}).get('managed')))
  c=api('/conversations/'+str(cid));owners.append(c.get('meta',{}).get('assignee',{}).get('id'))
 assert owners[0] in [alpha['id'],beta['id']] and owners[1]!=owners[0] and owners==owners[:2]*2,owners
 assert outsider['id'] not in owners
 print('Actual webhook → Core → native assignment rotates between eligible online seats',flush=True)
 # Repeated ingress leaves the existing online owner unchanged.
 widget('/messages',{'message':{'content':'The project location is a fictional test site.','timestamp':time.time()}})
 time.sleep(3)
 assert api('/conversations/'+str(cids[-1]))['meta']['assignee']['id']==owners[-1]
 # Resolve all but the final inquiry; the AI acceptance must not reply to old tests.
 for cid in cids[:-1]:api('/conversations/'+str(cid)+'/toggle_status',{'status':'resolved'})
 api('/ake_reception/heartbeat',{'state':'offline'},beta['token']);stop.set()
 api('/ake_reception/heartbeat',{'state':'offline'},outsider['token'])
 # This is the exact tested Windows package; no other desktop processes are stopped.
 ps="$exe='"+fixtures['windowsExecutablePath'].replace("'","''")+"';Get-Process -Name AKE-Inbox -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe} | Stop-Process -Force"
 subprocess.run(['powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,check=True)
 print('Windows app exited; waiting for its real 75-second presence lease to expire',flush=True)
 began=time.monotonic()
 wait(lambda:((core(cids[-1]) or {}).get('mode') in ['human_pending','ai']),100)
 seconds=round(time.monotonic()-began,1)
 result={'roundRobinOwners':owners,'outsiderSkipped':True,'stickyOwner':True,'windowsExitLeaseExpired':True,'observedSeconds':seconds,'offlineMode':core(cids[-1])['mode'],'activeSyntheticConversation':cids[-1],'aiVerified':False}
 (root/'private/acceptance-conversations.json').write_text(json.dumps(cids))
 (root/'evidence/routing-live.json').write_text(json.dumps(result,indent=2))
 print(json.dumps(result),flush=True)
finally:stop.set()
