"""Instance leases and private unread summaries against a fresh QA-only office."""
import argparse,json,pathlib,subprocess,time,urllib.request,urllib.error
p=argparse.ArgumentParser();p.add_argument('runtime');a=p.parse_args();root=pathlib.Path(a.runtime)
f=json.loads((root/'private/office-fixtures.json').read_text());assert f['nativeUrl']=='http://127.0.0.1:14750'
op=urllib.request.build_opener(urllib.request.ProxyHandler({}));users=f['users'];checks={}
def api(path,body=None,user=2):
 r=urllib.request.Request('http://127.0.0.1:14750/api/v1/accounts/1'+path,headers={'Content-Type':'application/json','api_access_token':users[user]['token']},data=json.dumps(body).encode() if body is not None else None)
 with op.open(r,timeout=20) as response:return json.load(response)
def sql(db,q):return subprocess.check_output(['docker','exec','ake-inbox-qa021-postgres-1','psql','-U','postgres','-d',db,'-At','-c',q],text=True).strip()
# Use the outsider seat for leases so live Windows baseline/candidate stay untouched.
a='qa-integration-client-001';b='qa-integration-client-002'
for client in [a,b]:assert api('/ake_reception/heartbeat',{'clientId':client,'state':'online'})['instanceOnline']
r=api('/ake_reception/heartbeat',{'clientId':a,'state':'offline'});assert r['online'] and not r['instanceOnline'];checks['releaseOneKeepsOtherInstance']=True
r=api('/ake_reception/heartbeat',{'clientId':b,'state':'offline'});assert not r['online'];checks['releaseLastGoesOffline']=True
r=api('/ake_reception/heartbeat',{'state':'online'});assert r['online']
api('/ake_reception/heartbeat',{'clientId':a,'state':'online'});assert api('/ake_reception/heartbeat',{'clientId':a,'state':'offline'})['online'];checks['legacyLeasePreserved']=True
api('/ake_reception/heartbeat',{'state':'offline'})
try:api('/ake_reception/heartbeat',{'clientId':'bad','state':'online'});raise AssertionError('invalid instance accepted')
except urllib.error.HTTPError as e:assert e.code==422;checks['invalidInstanceRejected']=True
assert api('/ake_reception/desktop')['unreadCount']==0;checks['unassignedSeatHasNoUnread']=True
# Actual expiry: use an instance on the excluded test user, not an altered clock.
api('/ake_reception/heartbeat',{'clientId':a,'state':'online'});began=time.monotonic()
time.sleep(77)
r=api('/ake_reception/heartbeat',{'clientId':b,'state':'offline'});assert not r['online'];checks['real75SecondExpiry']=True
report={'checks':checks,'leaseObservationSeconds':round(time.monotonic()-began,2),'syntheticQaOnly':True,'testedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
(root/'evidence/instance-api.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
