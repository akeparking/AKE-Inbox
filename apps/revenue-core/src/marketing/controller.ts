import { Body, Controller, Get, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MarketingService } from './service';
import { secretEquals } from '../inbox-v2/chatwoot';
import { config } from '../inbox-v2/contracts';
import { createHmac } from 'node:crypto';

@Controller('api/v1/inbox-v2/marketing')
export class MarketingController {
  private windows=new Map<string,{at:number;count:number}>();
  constructor(private readonly marketing:MarketingService){}
  private origin(req:Request){
    const origin=String(req.headers.origin||'');if(!origin)throw new UnauthorizedException('A registered website origin is required');
    const now=Date.now(),key=req.ip||'unknown',old=this.windows.get(key);if(old&&now-old.at<60000&&old.count>240)throw new UnauthorizedException('Rate limited');
    for(const [k,v] of this.windows)if(now-v.at>60000)this.windows.delete(k);
    this.windows.set(key,{at:old&&now-old.at<60000?old.at:now,count:old&&now-old.at<60000?old.count+1:1});return origin;
  }
  @Post('public/session') session(@Body() b:unknown,@Req() req:Request){return this.marketing.session(b,this.origin(req),req.get('user-agent'));}
  @Post('public/events') events(@Body() b:unknown,@Req() req:Request){return this.marketing.events(b,this.origin(req));}
  @Get('public/forms/:site/:id') form(@Param('site') site:string,@Param('id') id:string,@Req() req:Request){return this.marketing.publicForm(site,id,this.origin(req));}
  @Post('public/submissions') submit(@Body() b:unknown,@Req() req:Request){return this.marketing.submit(b,this.origin(req));}
  @Post('public/iframe-context') iframe(@Body() b:unknown,@Req() req:Request){return this.marketing.iframeContext(b,this.origin(req));}
  @Post('public/whatsapp-reference') code(@Body() b:unknown,@Req() req:Request){return this.marketing.issueCode(b,this.origin(req));}
  @Post('native') async native(@Body() b:any,@Req() req:Request){
    if(!secretEquals(String(req.headers['x-inbox-key']||''),config().internalKey))throw new UnauthorizedException();
    const actor=await this.marketing.nativeActor(b);return this.marketing.action(actor,String(b.action||''),b.input||{});
  }
  @Post('trusted/form-receipt') async trustedReceipt(@Body() b:any,@Req() req:Request){
    const timestamp=String(req.headers['x-ake-timestamp']||''),signature=String(req.headers['x-ake-signature']||'');
    let keys:Record<string,string>={};try{keys=JSON.parse(process.env.MARKETING_FORM_KEYS_JSON||'{}');}catch{}
    const key=keys[String(b.siteId)],raw=(req as any).rawBody;
    if(!key||key.length<32||!Buffer.isBuffer(raw)||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)throw new UnauthorizedException();
    const expected=createHmac('sha256',key).update(timestamp+'.').update(raw).digest('hex');
    if(!secretEquals(signature,expected))throw new UnauthorizedException();
    if(typeof b.persistedReceiptId!=='string'||b.persistedReceiptId.length<1||b.persistedReceiptId.length>200)throw new UnauthorizedException('Persistent source receipt required');
    const site=await this.marketing.site(b.siteId);
    return this.marketing.trustedReceipt(b,site.origin);
  }
  @Post('waha/:operation') async waha(@Param('operation') operation:string,@Body() b:any,@Req() req:Request){
    if(!secretEquals(String(req.headers['x-inbox-key']||''),config().internalKey))throw new UnauthorizedException();
    return this.marketing.waha(operation,b);
  }
  @Post('bridge/:operation') async bridge(@Param('operation') operation:string,@Body() b:any,@Req() req:Request){
    if(!secretEquals(String(req.headers['x-inbox-key']||''),config().internalKey))throw new UnauthorizedException();
    return this.marketing.bridge(operation,b);
  }
}
