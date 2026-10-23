import {NextRequest,NextResponse} from 'next/server';
const cookie='ake_inbox_session';
async function proxy(req:NextRequest,ctx:{params:Promise<{path:string[]}>}) {
  const route=(await ctx.params).path.join('/');
  const reads=/^(session|status|conversations(?:\/\d+)?|knowledge|okki\/dictionaries|okki\/stages\/\d+|conversations\/\d+\/customers|exports\/export_[a-f0-9-]+(?:\/download)?)$/;
  const writes=/^(session|logout|conversations\/\d+\/(control|profile|customer|opportunity|refresh|link|retry)|knowledge(?:\/[a-zA-Z0-9_-]+\/review)?|exports)$/;
  if(req.method==='GET'?!reads.test(route):!writes.test(route))return NextResponse.json({message:'Route unavailable'},{status:404});
  if(req.method!=='GET'&&req.headers.get('origin')!==(process.env.WORKSPACE_PUBLIC_ORIGIN||req.nextUrl.origin))return NextResponse.json({message:'Invalid origin'},{status:403});
  const token=req.cookies.get(cookie)?.value;
  if(route==='logout'){
    if(token)await fetch((process.env.SERVER_API_URL||'http://127.0.0.1:4100')+'/api/v1/inbox-v2/logout',{method:'POST',headers:{'x-inbox-session':token},signal:AbortSignal.timeout(15000)}).catch(()=>undefined);
    const r=NextResponse.json({ok:true});r.cookies.set(cookie,'',{path:(process.env.NEXT_PUBLIC_BASE_PATH||'')+'/',maxAge:0});return r;
  }
  if(route!=='session'&&!token)return NextResponse.json({message:'请使用您的 Inbox 个人账号登录'},{status:401});
  try{
    const response=await fetch((process.env.SERVER_API_URL||'http://127.0.0.1:4100')+'/api/v1/inbox-v2/'+route,{method:req.method,headers:{'content-type':'application/json',...(token?{'x-inbox-session':token}:{})},body:req.method==='GET'?undefined:await req.text(),cache:'no-store',signal:AbortSignal.timeout(60000)});
    if(route==='session'&&req.method==='POST'&&response.ok){
      const data=await response.json();const r=NextResponse.json({userId:data.userId,role:data.role,accountId:data.accountId});
      r.cookies.set(cookie,data.token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:(process.env.NEXT_PUBLIC_BASE_PATH||'')+'/',maxAge:8*3600});return r;
    }
    const headers:Record<string,string>={'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'};
    const attachment=response.headers.get('content-disposition');if(attachment)headers['content-disposition']=attachment;
    return new NextResponse(response.body,{status:response.status,headers});
  }catch{return NextResponse.json({message:'服务暂时不可用，请稍后重试'},{status:502});}
}
export const GET=proxy;export const POST=proxy;
