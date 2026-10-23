import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InboxRepository } from './repository';
import { Chatwoot } from './chatwoot';
import { config, exportSchema, type Actor } from './contracts';
import { csv,pdf,xlsx,zip } from './export-format';

const date=(v:any)=>typeof v==='number'?new Date(v*1000):new Date(v);
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
@Injectable()
export class InboxExports {
  constructor(private readonly store:InboxRepository,private readonly cw:Chatwoot){}
  async create(input:unknown,actor:Actor) {
    const filters=exportSchema.parse(input);
    if(filters.includePrivate&&actor.role!=='administrator')throw new ForbiddenException('Only administrators can export internal notes');
    const c=await this.store.db.query(`SELECT conversation_id,channel FROM inbox_v2_conversations WHERE account_id=$1 AND ($2::bigint[] IS NULL OR conversation_id=ANY($2)) AND ($3::bigint IS NULL OR contact_id IN(SELECT contact_id FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=(SELECT group_key FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$3))) AND ($4::text IS NULL OR channel=$4) ORDER BY conversation_id LIMIT 201`,[config().accountId,filters.conversationIds||null,filters.contactId||null,filters.channel||null]);
    if(c.rows.length>200)throw new Error('Narrow the export to 200 conversations');
    if(!c.rows.length)throw new NotFoundException('No indexed conversations match');
    for(const row of c.rows)await this.cw.allowed(actor,Number(row.conversation_id));
    const id=this.store.id('export'),selection={...filters,conversationIds:c.rows.map(r=>Number(r.conversation_id))};
    await this.store.db.query('INSERT INTO inbox_v2_exports(id,account_id,user_id,format,filters,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'24 hours\')',[id,config().accountId,actor.userId,filters.format,this.store.pack(selection)]);
    await this.store.audit(String(actor.userId),'export.requested',id,{format:filters.format,count:c.rows.length,includePrivate:filters.includePrivate});
    // The request is durable. Interrupted generation is shown as failed and can be requested again.
    void this.build(id,selection,actor).catch(async()=>{await this.store.db.query("UPDATE inbox_v2_exports SET state='failed',error='export_failed_or_archive_incomplete' WHERE id=$1",[id]);});
    return {id,state:'pending'};
  }
  async build(id:string,filters:any,actor:Actor) {
    await this.store.db.query("UPDATE inbox_v2_exports SET state='processing' WHERE id=$1",[id]);
    const rows:unknown[][]=[['Conversation','Channel','Date (UTC)','Direction','Message','Attachments']];
    const files:Record<string,Buffer>={},sourceIds=new Set<string>();
    for(const cid of filters.conversationIds) {
      const c=await this.cw.allowed(actor,cid),channel=config().channels[String(c.inbox_id)];
      const nativeId=filters.format==='zip'?await this.addConversationVersions(files,cid):cid;
      const messages=(await this.cw.messages(cid,actor.credentials,true)).filter(m=>(filters.includePrivate||!m.private)&&(!filters.from||date(m.created_at)>=new Date(filters.from))&&(!filters.to||date(m.created_at)<=new Date(filters.to)));
      for(const m of messages) {
        rows.push([cid,channel,date(m.created_at).toISOString(),m.private?'internal':[0,'incoming'].includes(m.message_type)?'incoming':'outgoing',m.content||'',(m.attachments||[]).map((a:any)=>a.file_name||a.file_type||'attachment').join('; ')]);
        if(m.source_id)sourceIds.add(String(m.source_id).replace(/^<|>$/g,''));
        if(filters.format==='zip')await this.addVersions(files,cid,m.id,filters.includePrivate,nativeId);
      }
      if(filters.format==='zip'){
        const archived=await this.addArchivedMessages(files,cid,nativeId,filters,new Set(messages.map(m=>Number(m.id))));
        for(const m of archived)if(m.source_id)sourceIds.add(String(m.source_id).replace(/^<|>$/g,''));
        files[`conversations/${cid}/current.json`]=Buffer.from(JSON.stringify({conversationId:cid,channel,messages,archivedMessages:archived},null,2));
      }
    }
    let data:Buffer;
    if(filters.format==='zip') {
      const root=config().archiveRoot;
      for(const entry of await readdir(join(root,'email')).catch(()=>[] as string[])) {
        if(!/^[a-f0-9]{64}$/.test(entry))continue;
        for(const name of await readdir(join(root,'email',entry))) {
          if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
          const raw=await readFile(join(root,'email',entry,name)),meta=JSON.parse(raw.toString());
          if(meta.account_id!==config().accountId||!sourceIds.has(String(meta.message_id).replace(/^<|>$/g,'')))continue;
          const bytes=await readFile(join(root,'email','raw',entry+'.eml'));if(digest(bytes)!==meta.sha256)throw new Error('eml_hash_mismatch');
          files['email/'+entry+'.eml']=bytes;files['email/'+entry+'.json']=raw;
        }
      }

      const links=(await this.store.db.query('SELECT DISTINCT l.lead_id,l.company_id,l.customer_ids FROM inbox_v2_links l JOIN inbox_v2_contacts c USING(account_id,group_key) JOIN inbox_v2_conversations v USING(account_id,contact_id) WHERE l.account_id=$1 AND v.conversation_id=ANY($2)',[config().accountId,filters.conversationIds])).rows;
      files['manifest.json']=Buffer.from(JSON.stringify({version:'0.2.0',accountId:config().accountId,conversationIds:filters.conversationIds,crmLinks:links,includePrivate:filters.includePrivate,createdAt:new Date().toISOString(),files:Object.keys(files)},null,2));
      files['SHA256SUMS']=Buffer.from(Object.entries(files).map(([p,b])=>digest(b)+'  '+p).join('\n')+'\n');
      if(Object.values(files).reduce((n,b)=>n+b.length,0)>32*1024*1024)throw new Error('narrow_export_size');
      data=zip(files);
    }else data=filters.format==='csv'?csv(rows):filters.format==='xlsx'?xlsx(rows):await pdf(rows);
    const name=id+'.'+filters.format;await mkdir(config().exportRoot,{recursive:true,mode:0o700});await writeFile(join(config().exportRoot,name),data,{mode:0o600});
    await this.store.db.query("UPDATE inbox_v2_exports SET state='ready',file_name=$2,sha256=$3 WHERE id=$1",[id,name,digest(data)]);
    await this.store.audit(String(actor.userId),'export.ready',id,{sha256:digest(data)});
  }
  async addConversationVersions(files:Record<string,Buffer>,cid:number) {
    const root=join(config().archiveRoot,'conversations');let nativeId=cid;
    for(const id of await readdir(root).catch(()=>[] as string[])){
      if(!/^\d+$/.test(id))continue;
      for(const name of await readdir(join(root,id))){
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const bytes=await readFile(join(root,id,name)),m=JSON.parse(bytes.toString());
        if(Number(m.record?.account_id)!==config().accountId||Number(m.record?.display_id)!==cid)continue;
        if(digest(bytes)!==name.slice(0,-5))throw new Error('conversation_archive_hash_mismatch');
        nativeId=Number(m.record.id);files[`conversations/${cid}/conversation-versions/${name}`]=bytes;
      }
    }
    return nativeId;
  }
  async addArchivedMessages(files:Record<string,Buffer>,cid:number,nativeId:number,filters:any,current:Set<number>) {
    const root=join(config().archiveRoot,'messages'),archived:any[]=[];
    for(const id of await readdir(root)){
      if(!/^\d+$/.test(id)||current.has(Number(id)))continue;
      let latest:any;
      for(const name of await readdir(join(root,id))){
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const value=JSON.parse(await readFile(join(root,id,name),'utf8')),r=value.record;
        if(Number(r?.account_id)!==config().accountId||Number(r?.conversation_id)!==nativeId||(!filters.includePrivate&&r.private))continue;
        if((filters.from&&date(r.created_at)<new Date(filters.from))||(filters.to&&date(r.created_at)>new Date(filters.to)))continue;
        if(!latest||date(r.updated_at)>date(latest.updated_at))latest=r;
      }
      if(latest){await this.addVersions(files,cid,Number(id),filters.includePrivate,nativeId);archived.push(latest);}
    }
    return archived;
  }
  async addVersions(files:Record<string,Buffer>,cid:number,mid:number,includePrivate:boolean,nativeId=cid) {
    const root=config().archiveRoot;if(!root)throw new Error('archive_not_mounted');
    const names=await readdir(join(root,'messages',String(mid)));if(!names.length)throw new Error('archive_pending');
    const expected=new Set<string>(),present=new Set<string>();
    for(const name of names) {
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const bytes=await readFile(join(root,'messages',String(mid),name)),m=JSON.parse(bytes.toString());
      if(Number(m.record?.account_id)!==config().accountId||Number(m.record?.conversation_id)!==nativeId)throw new Error('archive_scope_mismatch');
      if(m.record?.private&&!includePrivate)continue;
      if(digest(bytes)!==name.slice(0,-5))throw new Error('archive_hash_mismatch');
      files[`conversations/${cid}/versions/${mid}/${name}`]=bytes;
      for(const a of m.attachments||[]) {
        expected.add(String(a.id));
        if(a.archive_pending||!a.file)continue;
        present.add(String(a.id));
        const sha=a.file.sha256;if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('invalid_blob_hash');
        const data=await readFile(join(root,'blobs',sha.slice(0,2),sha));if(digest(data)!==sha)throw new Error('attachment_hash_mismatch');
        files[`blobs/${sha}`]=data;
        if(Object.values(files).reduce((n,b)=>n+b.length,0)>32*1024*1024)throw new Error('narrow_export_size');
      }
    }
    if([...expected].some(id=>!present.has(id)))throw new Error('attachment_archive_pending');
  }
  async get(id:string,actor:Actor) {
    const row=(await this.store.db.query('SELECT * FROM inbox_v2_exports WHERE id=$1 AND account_id=$2 AND expires_at>now()',[id,config().accountId])).rows[0];
    if(!row)throw new NotFoundException('Export expired or does not exist');
    if(Number(row.user_id)!==actor.userId&&actor.role!=='administrator')throw new ForbiddenException();
    const filters=this.store.unpack(row.filters);
    if(filters.includePrivate&&actor.role!=='administrator')throw new ForbiddenException();
    for(const cid of filters.conversationIds)await this.cw.allowed(actor,cid);
    return row;
  }
  async cleanup() {
    await this.store.db.query('DELETE FROM inbox_v2_sessions WHERE expires_at<=now()');
    const rows=(await this.store.db.query('DELETE FROM inbox_v2_exports WHERE expires_at<=now() RETURNING file_name')).rows;
    for(const r of rows)if(/^export_[a-f0-9-]+\.(pdf|csv|xlsx|zip)$/.test(r.file_name||''))await unlink(join(config().exportRoot,r.file_name)).catch(()=>undefined);
    await this.store.db.query("UPDATE inbox_v2_exports SET state='failed',error='interrupted_export' WHERE state IN ('pending','processing') AND created_at<now()-interval '30 minutes'");
  }
}
