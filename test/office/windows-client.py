"""Windows EXE acceptance driven from WSL; only synthetic fixture accounts."""
import base64,json,pathlib,subprocess,sys,time
runtime=pathlib.Path(sys.argv[1]);repo=pathlib.Path(__file__).resolve().parents[2]
fixtures=json.loads((runtime/'private/office-fixtures.json').read_text())
bridge=subprocess.check_output(['wslpath','-w',str(repo/'test/office/windows-cdp.ps1')],text=True).strip()
p=subprocess.Popen(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',bridge,'-Port','14749'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',bufsize=1)
assert json.loads(p.stdout.readline())['ready']; sequence=0

def call(method,params=None,session=None):
 global sequence;sequence+=1;request={'id':sequence,'method':method,'params':params or {}}
 if session:request['sessionId']=session
 p.stdin.write(json.dumps(request)+'\n');p.stdin.flush();reply=json.loads(p.stdout.readline())
 assert 'error' not in reply,reply.get('error');return reply.get('result',{})
def attach(target):return call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
def targets():return call('Target.getTargets')['targetInfos']
def evaluate(session,expression):
 r=call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True},session)
 if 'exceptionDetails' in r:raise RuntimeError('Windows renderer evaluation failed: '+r['exceptionDetails']['text'])
 return r['result'].get('value')
def wait(predicate,seconds=45):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:v=predicate()
  except AssertionError as e:
   if 'navigated or closed' not in str(e):raise
   v=False
  if v:return v
  time.sleep(1)
 raise TimeoutError('Windows acceptance condition was not met')
main=attach(next(t for t in targets() if t['url'].startswith('file:///') and '/resources/app.asar/' in t['url']))
assert evaluate(main,'navigator.platform')=='Win32'
evaluate(main,"window.inboxDesktop.connect({inboxUrl:'http://localhost:14720/app/login',workspaceUrl:'http://localhost:14721/sales/inbox'})")
native=attach(wait(lambda:next((t for t in targets() if ':14720/' in t['url']),None)))
user=fixtures['users'][0]
if not evaluate(native,"location.pathname.includes('/app/accounts/')"):
 wait(lambda:evaluate(native,'!!document.querySelector("input[type=password]")'))
 print('Windows native login form loaded',flush=True)
 # Native input events exercise the same Vue form used by the receptionist.
 expr='''(() => { const values=%s;for(const [selector,value] of values){const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('button[type=submit]').click();return true;})()'''%json.dumps([['input[name=email_address]',user['email']],['input[type=password]',user['password']]])
 evaluate(native,expr)
 wait(lambda:evaluate(native,"location.pathname.includes('/app/accounts/')"))
wait(lambda:evaluate(native,"!!document.getElementById('ake-reception-status')"))
state=evaluate(native,"window.akeApi(1,'/ake_reception/heartbeat',{state:'online'})")
assert state['online'] and state['userId']==user['id']
assert evaluate(native,"typeof require==='undefined' && typeof inboxDesktop==='undefined'")
print('Windows sign-in and authenticated online heartbeat verified',flush=True)
evaluate(main,"window.inboxDesktop.open('workspace')")
work=attach(wait(lambda:next((t for t in targets() if ':14721/' in t['url']),None)))
assert evaluate(work,"typeof require==='undefined' && typeof inboxDesktop==='undefined'")
assert any(':14720/' in t['url'] for t in targets())
wait(lambda:evaluate(work,"!!document.querySelector('input[name=password]')"))
expression="""(() => { const values=%s;for(const [selector,value] of values){const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('form button').click();return true;})()"""%json.dumps([['input[name=email]',user['email']],['input[name=password]',user['password']]])
evaluate(work,expression)
wait(lambda:evaluate(work,"fetch('/sales/api/inbox/session').then(r=>r.ok?r.json():null).then(x=>x?.userId)")==user['id'])
print('Windows workbench sign-in and local session cookie verified',flush=True)

time.sleep(23)
assert evaluate(native,"document.getElementById('ake-reception-status').textContent.includes('接待中')")
evaluate(main,"window.inboxDesktop.open('inbox')")
assert evaluate(native,"location.pathname.includes('/app/accounts/')")
screen=call('Page.captureScreenshot',{'format':'png'},native)['data']
(runtime/'evidence/windows-signed-in.png').write_bytes(base64.b64decode(screen))
receipt={'platform':'Win32','appVersion':'0.2.0-rc.1','nativeSignIn':True,'workbenchSignIn':True,'localCookieVerified':True,'authenticatedHeartbeat':True,'nativeAliveAcrossWorkspaceTab':True,'remoteNodeDisabled':True,'remoteDesktopBridgeAbsent':True,'testedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
(runtime/'evidence/windows-live-client.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt),flush=True)
p.stdin.close();p.wait(timeout=10)
