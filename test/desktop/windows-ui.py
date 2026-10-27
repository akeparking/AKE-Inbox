"""WSL acceptance driver; Windows only transports UI commands over loopback CDP."""
import base64,json,pathlib,subprocess,sys,time

class WindowsUI:
 def __init__(self,port,node=False):
  repo=pathlib.Path(__file__).resolve().parents[2]
  bridge=subprocess.check_output(['wslpath','-w',str(repo/'test/office/windows-cdp.ps1')],text=True).strip()
  self.p=subprocess.Popen(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',bridge,'-Port',str(port)]+(['-NodeInspector'] if node else []),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',bufsize=1)
  assert json.loads(self.p.stdout.readline())['ready'];self.sequence=0
 def call(self,method,params=None,session=None):
  self.sequence+=1;r={'id':self.sequence,'method':method,'params':params or {}}
  if session:r['sessionId']=session
  self.p.stdin.write(json.dumps(r)+'\n');self.p.stdin.flush();reply=json.loads(self.p.stdout.readline())
  if 'error' in reply:raise RuntimeError('CDP command failed: '+reply['error'].get('message',''))
  return reply.get('result',{})
 def targets(self):return self.call('Target.getTargets')['targetInfos']
 def attach(self,target):return self.call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
 def evaluate(self,session,expression):
  r=self.call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True},session)
  if 'exceptionDetails' in r:raise RuntimeError('UI expression failed')
  return r['result'].get('value')
 def close(self):self.p.stdin.close();self.p.wait(timeout=10)

def wait(predicate,seconds=60):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:value=predicate()
  except RuntimeError:value=False
  if value:return value
  time.sleep(1)
 raise TimeoutError('Windows UI condition timed out')

def signin(client,fixtures,seat=0):
 main=client.attach(next(t for t in client.targets() if t['url'].startswith('file:///') and '/resources/app.asar/' in t['url']))
 if not any(':14750/' in t['url'] for t in client.targets()):
  client.evaluate(main,"window.inboxDesktop.connect({inboxUrl:'http://localhost:14750/app/login',workspaceUrl:'http://localhost:14752/sales/inbox'})")
 native=client.attach(wait(lambda:next((t for t in client.targets() if ':14750/' in t['url']),None)))
 user=fixtures['users'][seat]
 if not client.evaluate(native,"location.pathname.includes('/app/accounts/')"):
  wait(lambda:client.evaluate(native,'!!document.querySelector("input[type=password]")'))
  expr='''(() => { const values=%s;for(const [selector,value] of values){const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('button[type=submit]').click();return true;})()'''%json.dumps([['input[name=email_address]',user['email']],['input[type=password]',user['password']]])
  client.evaluate(native,expr);wait(lambda:client.evaluate(native,"location.pathname.includes('/app/accounts/')"))
 return main,native

if __name__=='__main__':
 runtime=pathlib.Path(sys.argv[1]);port=int(sys.argv[2]);seat=int(sys.argv[3]);f=json.loads((runtime/'private/office-fixtures.json').read_text())
 c=WindowsUI(port)
 try:
  main,native=signin(c,f,seat)
  if port!=14759:
   s=wait(lambda:(lambda s:s if s.get('reception',{}).get('online') else None)(c.evaluate(main,'window.inboxDesktop.status()')))
   result={'version':s['version'],'connection':s['connection'],'reception':s['reception']}
  else:
   wait(lambda:c.evaluate(native,"!!document.getElementById('ake-reception-status')"))
   c.evaluate(native,"window.akeApi(1,'/ake_reception/heartbeat',{state:'online'})")
   result={'version':'0.2.0-rc.1','signIn':True,'legacyHeartbeat':True}
  result.update({'platform':c.evaluate(main,'navigator.platform'),'remoteNodeDisabled':c.evaluate(native,"typeof require==='undefined' && typeof inboxDesktop==='undefined'")})
  (runtime/'evidence'/('windows-login-'+str(port)+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
 finally:c.close()
