"""Local-only QR viewer. API credentials and complete phone numbers never reach its page."""
import os,json,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import requests
root=Path(os.environ['LOCAL_RUNTIME_ROOT']);env=dict(x.split('=',1) for x in (root/'private/waha.env').read_text().splitlines());pair=json.loads((root/'private/waha-test-pair.json').read_text());base='http://127.0.0.1:14627';session=pair['session']
client=requests.Session();client.headers['X-Api-Key']=env['WAHA_API_KEY']
page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Inbox 独立测试号扫码</title><style>body{font:17px system-ui;background:#eef3f9;color:#17243a;margin:0;padding:32px}main{max-width:560px;margin:auto;background:white;border-radius:18px;padding:28px}img{width:300px;height:300px;max-width:100%;image-rendering:pixelated}h1{font-size:24px}p{line-height:1.7}#state{color:#087960}small{color:#5d6b7e}</style><main><h1>连接 Inbox 测试接待号</h1><p>请用尾号 <b>8474</b> 的 WhatsApp 打开「设置 → 已关联设备 → 关联设备」，扫描下方二维码。</p><img id="qr" alt="正在获取二维码"><p id="state">正在连接独立测试会话…</p><small>二维码自动刷新。这里只连接本机测试 Inbox。</small></main><script>async function refresh(){try{let d=await(await fetch('/status')).json();document.querySelector('#state').textContent=d.label;let q=document.querySelector('#qr');q.hidden=d.status==='WORKING';if(d.status==='SCAN_QR_CODE')q.src='/qr?t='+Date.now();}catch{document.querySelector('#state').textContent='连接暂时中断，正在重试…'}}refresh();setInterval(refresh,8000);</script></html>'''
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.headers.get('Host','').split(':')[0] not in ['localhost','127.0.0.1','[::1]']:self.send_error(403);return
  try:
   if self.path=='/':data=page.encode();ct='text/html; charset=utf-8'
   elif self.path=='/status':
    d=client.get(base+'/api/sessions/'+session,timeout=6).json();status=d.get('status','unknown');me=(d.get('me') or {}).get('id','').split('@')[0];expected=pair['receptionNumber'].lstrip('+');ok=status=='WORKING' and me==expected
    if status=='WORKING' and me and not ok:client.post(base+'/api/sessions/'+session+'/stop',timeout=8);status='WRONG_NUMBER'
    label={'SCAN_QR_CODE':'二维码已就绪，请扫码。','WORKING':'已连接测试接待号，号码核对通过。','WRONG_NUMBER':'扫码号码与测试接待号不符，会话已停止。','STARTING':'正在连接 WhatsApp…','STOPPED':'测试会话已停止。','FAILED':'连接失败，请回到 Codex 查看。'}.get(status,status)
    data=json.dumps({'status':status,'verified':ok,'label':label},ensure_ascii=False).encode();ct='application/json'
    (root/'private/waha-pairing-status.json').write_text(json.dumps({'status':status,'verified':ok,'at':time.time()}))
   elif self.path.startswith('/qr'):
    r=client.get(base+'/api/'+session+'/auth/qr',headers={'Accept':'image/png'},timeout=8);r.raise_for_status();data=r.content;ct='image/png';(root/'private/waha-qr.png').write_bytes(data)
   else:self.send_error(404);return
   self.send_response(200);self.send_header('Content-Type',ct);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  except Exception:self.send_error(503,'Pairing temporarily unavailable')
ThreadingHTTPServer(('127.0.0.1',14628),Handler).serve_forever()
