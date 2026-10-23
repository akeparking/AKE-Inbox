// Isolated, fictional acceptance website. No external message or advertising calls.
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
const formId='a0000000-0000-4000-8000-000000000001';
const siteOrigin=process.env.MARKETING_TEST_SITE_ORIGIN||'http://localhost:14621';
const publicCore=process.env.MARKETING_PUBLIC_CORE_URL||'http://localhost:14622';
const frameOrigin=process.env.MARKETING_FRAME_ORIGIN||'http://127.0.0.1:14629';
const products={
'/iframe':'跨域表单验收','/':'测试产品目录','/products/guidance':'停车引导系统','/products/payment':'停车收费系统','/contact':'联系测试团队','/spa':'SPA 产品演示'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,siteOrigin);
  if(url.pathname==='/collector.js'){res.setHeader('Content-Type','text/javascript');return res.end(await readFile('deploy/marketing/collector.js'));}
  if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({ok:true,mailCount:mails.length}));}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${products[url.pathname]||'产品详情'} · 本地验收</title><style>body{font:16px/1.6 system-ui;color:#263747;background:#f4f7fa;max-width:1000px;margin:auto;padding:24px}nav{display:flex;gap:24px;flex-wrap:wrap}a{color:#1768ab}main,aside{background:#fff;padding:24px;margin:24px 0;border:1px solid #dbe3eb;border-radius:8px}label{display:block;margin:14px 0}input,textarea,select{display:block;padding:10px;box-sizing:border-box;width:100%;max-width:520px}button{padding:10px 18px;margin:4px;border:1px solid #397ab0;background:white;color:#174b74;border-radius:4px;cursor:pointer}.status{color:#526578;font-size:13px}</style>
  <nav><a href="/">目录</a><a href="/products/guidance">引导系统</a><a href="/products/payment">收费系统</a><a href="/contact">询盘表单</a><a href="/spa">SPA</a><a href="/iframe">跨域表单</a></nav>
  <aside><strong>本地验收环境 · 所有业务数据均为虚构</strong><p>选择是否允许浏览分析。允许后可在 Inbox 查看本次浏览轨迹。广告同意独立记录。</p><button id="consent-allow">允许分析</button><button id="consent-all">允许分析和广告数据</button><button id="consent-deny">拒绝 / 撤回</button><p class="status" id="coverage">尚未授权分析；无历史轨迹。</p></aside>
  <main><h1>${products[url.pathname]||'产品详情'}</h1><p>本页用于验证多页访问、直接回访、来源变化和持久收件，不连接生产客户或广告。</p><button id="spa-next">SPA 查看另一产品</button><button id="dynamic-form">加载动态表单</button><a data-ake-wa-binding="test" href="#">WhatsApp 询价</a><div class="ake-marketing-form" data-form-id="${formId}"></div><div id="dynamic"></div>${url.pathname==='/iframe'?'<iframe id="embedded-form" title="独立域询盘表单" style="width:100%;height:300px;border:1px solid #ccd6df" src="'+frameOrigin+'/"></iframe>':''}</main>
  <script>window.AKE_MARKETING={apiBase:${JSON.stringify(publicCore+'/api/v1/inbox-v2/marketing')},siteId:'local-acceptance',policyVersion:'test-v1'};</script>
  <script src="/collector.js"${url.searchParams.has('delay')?' defer':''}></script><script>
  const status=()=>document.querySelector('#coverage').textContent=JSON.stringify(window.AKEMarketing.getState().coverage||'等待同意回执');
  document.querySelector('#consent-allow').onclick=async()=>{await AKEMarketing.setConsent({analytics:'granted',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'});status()};
  document.querySelector('#consent-all').onclick=async()=>{await AKEMarketing.setConsent({analytics:'granted',adStorage:'granted',adUserData:'granted',adPersonalization:'denied'});status()};
  document.querySelector('#consent-deny').onclick=async()=>{await AKEMarketing.setConsent({analytics:'denied',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'});status()};
  document.querySelector('#spa-next').onclick=()=>{history.pushState({},'', '/spa/product-'+Date.now());document.querySelector('h1').textContent='SPA 新产品'};
  document.querySelector('#dynamic-form').onclick=()=>{const el=document.createElement('div');el.className='ake-marketing-form';el.dataset.formId='${formId}';document.querySelector('#dynamic').append(el)};
  if(document.querySelector('#embedded-form'))AKEMarketing.connectFrame(document.querySelector('#embedded-form'),{origin:${JSON.stringify(frameOrigin)},formId:'${formId}'});
  setInterval(status,1500);</script></html>`);
});
const mails=[];
// SMTP sink consumes notification mail in memory; messages never leave this network.
net.createServer(socket=>{socket.setEncoding('utf8');socket.write('220 local.test ESMTP\r\n');let buffer='',data=false,content='';socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const n=buffer.indexOf('\n'),line=buffer.slice(0,n).replace(/\r$/,'');buffer=buffer.slice(n+1);if(data){if(line==='.'){mails.push({bytes:content.length});content='';data=false;socket.write('250 accepted locally\r\n');}else content+=line+'\n';continue;}if(/^DATA/i.test(line)){data=true;socket.write('354 end with dot\r\n');}else if(/^QUIT/i.test(line)){socket.end('221 bye\r\n');}else if(/^EHLO/i.test(line))socket.write('250-local.test\r\n250 SIZE 10485760\r\n');else socket.write('250 OK\r\n');}});}).listen(14625,'0.0.0.0');
server.listen(14621,'0.0.0.0');
