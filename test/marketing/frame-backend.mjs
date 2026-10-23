// Reference fixture for a third-party form backend: persist first, sign second.
// Credentials, durable receipts and retry bodies stay in the private WSL runtime.
import http from 'node:http';
import fs from 'node:fs/promises';
import {createHmac,createHash} from 'node:crypto';
const root=process.env.LOCAL_RUNTIME_ROOT;if(!root)throw Error('LOCAL_RUNTIME_ROOT required');
const env=Object.fromEntries((await fs.readFile(process.env.FRAME_CONFIG_PATH||root+'/private/core.env','utf8')).split('\n').filter(l=>l.includes('=')).map(l=>{const n=l.indexOf('=');return[l.slice(0,n),l.slice(n+1)];}));
const siteId='local-acceptance',formId='a0000000-0000-4000-8000-000000000001',childOrigin=process.env.FRAME_CHILD_ORIGIN||'http://127.0.0.1:14629',parentOrigin=process.env.FRAME_PARENT_ORIGIN||'http://localhost:14621',directory=root+'/private/frame-receipts';await fs.mkdir(directory,{recursive:true,mode:0o700});
const page=`<!doctype html><html><meta charset="utf-8"><title>独立域表单验收</title><body><form><label>咨询内容<textarea name="message" required></textarea></label><button>提交独立域表单</button></form><p role="status">等待来源上下文</p><script>
const challenge=crypto.randomUUID(),parentOrigin=${JSON.stringify(parentOrigin)};let context,submission=crypto.randomUUID();
const announce=()=>parent.postMessage({type:'AKE_FORM_READY',challenge},parentOrigin);const interval=setInterval(announce,500);announce();
addEventListener('message',e=>{if(e.source!==parent||e.origin!==parentOrigin||e.data?.type!=='AKE_FORM_CONTEXT'||e.data.challenge!==challenge)return;context=e.data;clearInterval(interval);document.querySelector('[role=status]').textContent='表单已就绪';});
document.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!context)return;const message=e.target.message.value;const response=await fetch('/receipt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submission,token:context.token,version:context.version,message})});const receipt=await response.json();document.querySelector('[role=status]').textContent=response.ok&&receipt.confirmed?'已持久收件 '+receipt.inquiryId:'收件失败，可重试';if(receipt.confirmed){window.receipt=receipt;parent.postMessage({type:'AKE_FORM_SUCCESS',inquiryId:receipt.inquiryId},parentOrigin);}};
</script></body></html>`;
http.createServer(async(req,res)=>{const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 try{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"frame-ancestors "+parentOrigin});return res.end(page);}
  if(req.url!=='/receipt'||req.method!=='POST'||req.headers.origin!==childOrigin)return reply(403,{error:'origin'});
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>30000)return reply(413,{error:'size'});}const b=JSON.parse(raw);
  if(!/^[a-f0-9-]{36}$/.test(b.submission||'')||typeof b.message!=='string'||b.message.trim().length<3||b.message.length>4000)return reply(422,{error:'fields'});
  const persisted={siteId,formId,version:b.version,persistedReceiptId:'frame:'+b.submission,iframeOrigin:childOrigin,iframeToken:b.token,fields:{name:'Fictional iframe visitor',email:'iframe@example.invalid',company:'Fictional iframe company',message:b.message}};
  const filename=directory+'/'+b.submission+'.json',bytes=JSON.stringify(persisted);
  try{const f=await fs.open(filename,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}catch(e){if(e.code!=='EEXIST')throw e;if(createHash('sha256').update(await fs.readFile(filename)).digest('hex')!==createHash('sha256').update(bytes).digest('hex'))return reply(409,{error:'changed'});}
  const timestamp=String(Math.floor(Date.now()/1000)),key=JSON.parse(env.MARKETING_FORM_KEYS_JSON)[siteId],signature=createHmac('sha256',key).update(timestamp+'.'+bytes).digest('hex');
  const response=await fetch((process.env.FRAME_CORE_URL||'http://localhost:14622')+'/api/v1/inbox-v2/marketing/trusted/form-receipt',{method:'POST',headers:{'content-type':'application/json','x-ake-timestamp':timestamp,'x-ake-signature':signature},body:bytes,signal:AbortSignal.timeout(15000)});if(!response.ok)return reply(502,{error:'backend_receipt_pending'});reply(200,await response.json());
 }catch{reply(503,{error:'backend_unavailable_retry_same_receipt'});}
}).listen(14629,process.env.FRAME_HOST||'127.0.0.1',()=>console.log('Isolated cross-origin form fixture listening on 14629'));
