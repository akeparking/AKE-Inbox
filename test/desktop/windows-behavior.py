"""Windows executable acceptance on the isolated fixture ports only.
OS power events below are injected; they do not claim a physical host sleep/lock.
"""
import importlib.util,json,pathlib,subprocess,sys,time,urllib.request
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('ui',pathlib.Path(__file__).with_name('windows-ui.py'));ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
f=json.loads((root/'private/office-fixtures.json').read_text());assert f['nativeUrl']=='http://127.0.0.1:14750'
a=ui.WindowsUI(14769);b=ui.WindowsUI(14779);node=ui.WindowsUI(14770,node=True);node2=ui.WindowsUI(14780,node=True)
main,native=ui.signin(a,f,1);main2,native2=ui.signin(b,f,1)
def state():return a.evaluate(main,'window.inboxDesktop.status()')
def instances():
 return int(subprocess.check_output(['docker','exec','ake-inbox-qa021-redis-1','redis-cli','ZCOUNT','alfred:ake-reception-instances:1:8','('+str(time.time()),'+inf'],text=True))
checks={}
try:
 ui.wait(lambda:state()['reception']['online'] and instances()==2);checks['twoInstancesAutoOnlineSameAccount']=True
 b.evaluate(main2,'window.inboxDesktop.setOnline(false)');ui.wait(lambda:instances()==1);assert state()['reception']['online'];checks['pauseOneKeepsOtherOnline']=True
 b.evaluate(main2,'window.inboxDesktop.setOnline(true)');ui.wait(lambda:instances()==2)
 node2.evaluate(None,"setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true");node2.close();node2=None;b.close();b=None
 ui.wait(lambda:instances()==1);assert state()['reception']['online'];checks['exitReleasesOnlyOwnInstance']=True
 node.evaluate(None,"process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close();true")
 assert node.evaluate(None,"!process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].isVisible()")
 time.sleep(25);assert state()['reception']['online'];checks['closeToTrayHeartbeat']=True
 node.evaluate(None,"(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];w.showInactive();w.minimize();return true})()")
 a.evaluate(main,"window.inboxDesktop.open('inbox')")
 bounds=node.evaluate(None,"process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds()")
 assert bounds['width']>0 and bounds['height']>0;checks['minimizedNativeViewportRetained']=True
 node.evaluate(None,"(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];w.restore();w.hide();return true})()")
 node.evaluate(None,"process.mainModule.require('electron').powerMonitor.emit('lock-screen');true");assert state()['reception']['online'];checks['injectedLockEventKeepsOnline']=True
 node.evaluate(None,"process.mainModule.require('electron').powerMonitor.emit('suspend');true");ui.wait(lambda:instances()==0);assert not state()['reception']['online'];checks['injectedSuspendReleasesLease']=True
 node.evaluate(None,"process.mainModule.require('electron').powerMonitor.emit('resume');true");ui.wait(lambda:instances()==1 and state()['reception']['online']);checks['injectedResumeRenewsLease']=True
 assert a.evaluate(native,"typeof require==='undefined' && typeof inboxDesktop==='undefined' && Object.keys(akeDesktopReception).sort().join(',')==='setOnline,status,subscribe'");checks['remoteBridgeRestricted']=True
 # Repeated authentication events must not cause a heartbeat renewal loop.
 node.evaluate(None,"(() => {globalThis.qaHeartbeatCount=0;const s=process.mainModule.require('electron').session.fromPartition('persist:ake-inbox'),f=s.fetch.bind(s);globalThis.qaOriginalFetch=f;s.fetch=(url,options)=>{if(String(url).endsWith('/ake_reception/heartbeat'))qaHeartbeatCount++;return f(url,options)};return true})()")
 time.sleep(22);n=node.evaluate(None,'qaHeartbeatCount');node.evaluate(None,"process.mainModule.require('electron').session.fromPartition('persist:ake-inbox').fetch=qaOriginalFetch;true")
 assert 1<=n<=3,n;checks['heartbeatBoundedAfterCookieRefresh']=True
 # Exercise a real gateway outage; production gateway is a different service.
 subprocess.run(['docker','stop','-t','1','ake-inbox-qa021-gateway-1'],capture_output=True,check=True)
 try:ui.wait(lambda:state()['connection']=='failed' and not state()['reception']['online'],45);checks['realNetworkOutageNotConnected']=True
 finally:subprocess.run(['docker','start','ake-inbox-qa021-gateway-1'],capture_output=True,check=True)
 ui.wait(lambda:state()['connection']=='connected' and state()['reception']['online'],50);checks['realNetworkRecovery']=True
 report={'checks':checks,'observedHeartbeatsOver22s':n,'physicalLockVerified':False,'physicalSleepVerified':False,'version':state()['version'],'testedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
 (root/'evidence/windows-behavior.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
finally:
 for client in [node2,b,node,a]:
  if client:
   try:client.close()
   except Exception:pass
