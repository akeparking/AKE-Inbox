"""Read Windows process counters from WSL; no writes to the installed application."""
import argparse,base64,datetime,json,pathlib,statistics,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--exe',required=True);p.add_argument('--output',required=True);p.add_argument('--seconds',type=int,required=True);p.add_argument('--interval',type=int,default=30);p.add_argument('--root-pid',type=int);a=p.parse_args()
assert a.exe.lower().endswith('ake-inbox.exe')
script="""[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$target='%s'
$items=@(Get-Process -Name AKE-Inbox -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $target})
@{processors=[Environment]::ProcessorCount; processes=@($items | ForEach-Object {@{pid=$_.Id; cpu=$_.CPU; rss=$_.WorkingSet64; private=$_.PrivateMemorySize64; handles=$_.HandleCount; started=$_.StartTime.ToUniversalTime().ToString('o')}})} | ConvertTo-Json -Depth 4 -Compress
"""%a.exe.replace("'","''")
cmd=['powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()]
out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
begin=time.monotonic();last=None;last_wall=None;tot_cpu=0;tot_time=0;peak=0;samples=0;missing=0;maxgap=0;maxwallgap=0;root_started=None;root_missing=0;rss_samples=[]
with out.open('x') as f:
 while True:
  stamp=time.monotonic();wall=datetime.datetime.now(datetime.timezone.utc);row={'utc':wall.isoformat(),'elapsed':round(stamp-begin,3)}
  if last_wall:maxwallgap=max(maxwallgap,(wall-last_wall).total_seconds())
  last_wall=wall
  try:
   r=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=20,check=True);data=json.loads(r.stdout);row.update(data)
   processes=data['processes'];rss=sum(x['rss'] for x in processes);row['totalRss']=rss;row['totalPrivate']=sum(x['private'] for x in processes);peak=max(peak,rss)
   if not processes:missing+=1
   else:rss_samples.append(rss)
   if a.root_pid:
    root=next((x for x in processes if x['pid']==a.root_pid),None)
    if root and root_started is None:root_started=root['started']
    row['sameRootProcess']=bool(root and root['started']==root_started)
    if not row['sameRootProcess']:root_missing+=1
   if last:
    dt=stamp-last[0];maxgap=max(maxgap,dt);prev={x['pid']:x for x in last[1]}
    dc=sum(max(0,x['cpu']-prev[x['pid']]['cpu']) for x in processes if x['pid'] in prev and x['started']==prev[x['pid']]['started'])
    if processes and last[1] and dt<3*a.interval:tot_cpu+=dc;tot_time+=dt;row['cpuPct']=dc/dt/data['processors']*100
   last=(stamp,processes);samples+=1
  except Exception as e:row['error']=type(e).__name__;missing+=1
  f.write(json.dumps(row)+'\n');f.flush()
  if time.monotonic()-begin>=a.seconds:break
  time.sleep(min(a.interval,max(0,a.seconds-(time.monotonic()-begin))))
window=max(1,min(60,len(rss_samples)//4));first_mean=statistics.mean(rss_samples[:window]) if rss_samples else 0;last_mean=statistics.mean(rss_samples[-window:]) if rss_samples else 0
receipt={'startedUtc':json.loads(out.read_text().splitlines()[0])['utc'],'finishedUtc':row['utc'],'durationSeconds':round(time.monotonic()-begin,1),'requestedSeconds':a.seconds,'samples':samples,'missingSamples':missing,'rootPid':a.root_pid,'missingOrReplacedRootSamples':root_missing,'maxSampleGapSeconds':round(maxgap,1),'maxWallClockGapSeconds':round(maxwallgap,1),'averageCpuPercent':round(tot_cpu/tot_time/row.get('processors',1)*100,3) if tot_time else None,'meanRssMiB':round(statistics.mean(rss_samples)/1048576,1) if rss_samples else None,'peakRssBytes':peak,'lastRssBytes':row.get('totalRss'),'growthWindowSamples':window,'firstWindowMeanRssMiB':round(first_mean/1048576,1),'lastWindowMeanRssMiB':round(last_mean/1048576,1),'growthMiB':round((last_mean-first_mean)/1048576,1),'complete':time.monotonic()-begin>=a.seconds and missing==0 and root_missing==0 and maxgap<3*a.interval and maxwallgap<3*a.interval}
out.with_suffix('.summary.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt),flush=True)
