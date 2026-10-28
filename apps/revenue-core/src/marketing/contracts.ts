import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const consentSchema=z.object({analytics:z.enum(['unknown','denied','granted']).default('unknown'),adStorage:z.enum(['unknown','denied','granted']).default('unknown'),adUserData:z.enum(['unknown','denied','granted']).default('unknown'),adPersonalization:z.enum(['unknown','denied','granted']).default('unknown')});
export const sessionSchema=z.object({siteId:z.string().min(1).max(100),visitorToken:z.string().max(2000).optional(),visitToken:z.string().max(2000).optional(),consent:consentSchema,policyVersion:z.string().min(1).max(80),pageUrl:z.url().max(2048),referrer:z.string().max(2048).default(''),storageAvailable:z.boolean().default(true)});
export const eventSchema=z.object({eventId:z.uuid(),eventType:z.enum(['page_view','contact_click','form_submit_attempt','form_submit_failed','page_engagement']),pageUrl:z.url().max(2048),title:z.string().max(200).default(''),clientAt:z.iso.datetime().optional(),target:z.enum(['whatsapp','email','phone','chat','form','other']).optional(),formId:z.uuid().optional(),activeMs:z.number().int().min(0).max(60000).optional(),pageViewId:z.uuid().optional()});
export const fieldSchema=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),label:z.string().min(1).max(100),type:z.enum(['text','email','tel','textarea','select','checkbox']),required:z.boolean().default(false),options:z.array(z.string().max(100)).max(30).default([]),mapping:z.enum(['name','email','phone','company','message','custom']).default('custom')});
export const formSchema=z.object({language:z.string().max(12).default('en'),heading:z.string().min(1).max(100),submitLabel:z.string().min(1).max(60),successMessage:z.string().min(1).max(300),placement:z.enum(['inline','dialog']).default('inline'),fields:z.array(fieldSchema).min(1).max(20)}).superRefine((v,c)=>{if(new Set(v.fields.map(f=>f.key)).size!==v.fields.length)c.addIssue({code:'custom',message:'Duplicate field key'});});
export const submissionSchema=z.object({siteId:z.string().min(1).max(100),sessionToken:z.string().max(2000),sourceSubmissionId:z.uuid(),formId:z.uuid(),version:z.number().int().positive(),fields:z.record(z.string().max(40),z.union([z.string().max(4000),z.boolean()])),honeypot:z.string().max(100).default('')});
export type Consent=z.infer<typeof consentSchema>;
export type SessionClaims={siteId:string;visitorId:string|null;visitId:string|null;consentId:string;exp:number};
const utms=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
const adKeys=['gclid','gbraid','wbraid'];
export function safeTelemetryText(value:string){return value.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,'[redacted]').replace(/\+?\d[\d ()-]{7,}\d/g,'[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted]');}
export function safeUrl(input:string,ads=false){
  try{const u=new URL(input);if(!['http:','https:'].includes(u.protocol))return '';u.username='';u.password='';u.hash='';
    u.pathname=u.pathname.split('/').map(part=>{let text=part;try{text=decodeURIComponent(part);}catch{}return encodeURIComponent(/^[a-zA-Z0-9_-]{32,}$/.test(text)?'[redacted]':safeTelemetryText(text));}).join('/');
    for(const key of [...u.searchParams.keys()])if(!utms.includes(key)&&!(ads&&adKeys.includes(key)))u.searchParams.delete(key);
    for(const [k,v] of u.searchParams)u.searchParams.set(k,adKeys.includes(k)?v.slice(0,160):safeTelemetryText(v).slice(0,160));return u.toString();
  }catch{return '';}
}
export function touch(pageUrl:string,referrer:string,consent:Consent){
  const page=safeUrl(pageUrl),u=new URL(page),refs=safeUrl(referrer),params=u.searchParams,originalParams=new URL(pageUrl).searchParams;
  const identifiers:Record<string,string>=consent.adStorage==='granted'?Object.fromEntries(adKeys.filter(k=>originalParams.has(k)).map(k=>[k,originalParams.get(k)!.slice(0,250)])):{};
  const fbclid=originalParams.get('fbclid');
  // Build fbc only from an observed click ID, at the time it was observed.
  if(consent.adStorage==='granted'&&fbclid&&/^[A-Za-z0-9_-]{1,500}$/.test(fbclid))identifiers.fbc='fb.1.'+Date.now()+'.'+fbclid;
  return {pageUrl:page,referrer:refs,utm:Object.fromEntries(utms.filter(k=>params.has(k)).map(k=>[k,params.get(k)!.slice(0,160)])),source:params.get('utm_source')?.slice(0,160)||(refs&&new URL(refs).origin!==u.origin?new URL(refs).hostname:'direct'),identifiers};
}
export function marketingAttribution(ids:Record<string,unknown>){
  const google=adKeys.some(k=>!!ids[k]),meta=!!ids.fbc;
  // Conflicting platforms are retained for review, never attributed by guesswork.
  const provider: 'google'|'meta'|'organic'=google&&!meta?'google':meta&&!google?'meta':'organic';
  return {provider,identifiers:Object.entries(ids).filter(([k])=>adKeys.includes(k)||k==='fbc').map(([k,v])=>({type:(k==='fbc'?'meta_fbc':'google_'+k) as any,value:String(v)}))};
}
export function stable(value:any):string{return JSON.stringify(value&&typeof value==='object'?(Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]??null))]))):value??null);}
export function hash(value:any){return createHash('sha256').update(stable(value)).digest('hex');}
function key(){const k=process.env.FIELD_ENCRYPTION_KEY;if(!k)throw new Error('Marketing encryption key required');return k;}
export function signToken(value:Record<string,unknown>){const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return payload+'.'+createHmac('sha256',key()).update('marketing:'+payload).digest('base64url');}
export function readToken(token:string):any{
  try{const [p,s,...rest]=token.split('.');if(rest.length||!p||!s)throw 0;const expected=createHmac('sha256',key()).update('marketing:'+p).digest();const actual=Buffer.from(s,'base64url');if(expected.length!==actual.length||!timingSafeEqual(actual,expected))throw 0;const v=JSON.parse(Buffer.from(p,'base64url').toString());if(!Number.isFinite(v.exp)||v.exp<Date.now())throw 0;return v;}catch{return null;}
}
export function shortCode(){const a='0123456789ABCDEFGHJKMNPQRSTVWXYZ';return [...randomBytes(12)].map(n=>a[n&31]).join('');}
export function codeFromMessage(text:string){const codes=[...text.toUpperCase().matchAll(/\bAKE-([0-9A-HJKMNP-TV-Z]{12})\b/g)].map(m=>m[1]);return [...new Set(codes)];}
export function validateFields(definition:z.infer<typeof formSchema>,fields:Record<string,string|boolean>){
  const clean:Record<string,string|boolean>={};
  for(const f of definition.fields){const raw=fields[f.key];const v=typeof raw==='string'?raw.trim():raw;
    if(f.required&&(v===undefined||v===''||(f.type==='checkbox'&&v!==true)))throw new Error('required:'+f.key);
    if(v===undefined)continue;
    if(f.type==='checkbox'&&typeof v!=='boolean')throw new Error('invalid:'+f.key);
    if(f.type!=='checkbox'&&typeof v!=='string')throw new Error('invalid:'+f.key);
    if(f.type==='email'&&v&&!z.email().safeParse(v).success)throw new Error('invalid:'+f.key);
    if(f.type==='select'&&v&&!f.options.includes(String(v)))throw new Error('invalid:'+f.key);
    clean[f.key]=v;
  }return clean;
}
