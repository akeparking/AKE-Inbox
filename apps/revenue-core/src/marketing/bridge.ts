import {ConflictException} from '@nestjs/common';
import {InboxRepository} from '../inbox-v2/repository';
import {config,type Actor} from '../inbox-v2/contracts';
import {z} from 'zod';

// One shared authority for an enrolled inbox. Old native message IDs never
// acquire new delivery permission when a connector is replaced or restored.
export class BridgeControl {
  constructor(private repo:InboxRepository){}
  async claim(db:any,b:{inboxId:number;messageId:number;provider:'waha'|'evolution';parts:number}){
    const account=config().accountId;
    const owner=(await db.query('SELECT * FROM marketing_bridge_owners WHERE account_id=$1 AND inbox_id=$2',[account,b.inboxId])).rows[0];
    if(!owner)return {allowed:false,reason:'bridge_not_registered'};
    if(owner.provider!==b.provider)return {allowed:false,reason:'bridge_not_owner'};
    if(b.messageId<=Number(owner.cutoff_message_id))return {allowed:false,reason:'message_predates_cutover'};
    const old=(await db.query('SELECT * FROM marketing_bridge_dispatches WHERE account_id=$1 AND inbox_id=$2 AND message_id=$3',[account,b.inboxId,b.messageId])).rows[0];
    if(old&&(old.provider!==b.provider||old.parts!==b.parts||b.provider==='evolution'||old.state==='review'))return {allowed:false,reason:'message_already_attempted'};
    if(!old)await db.query("INSERT INTO marketing_bridge_dispatches(account_id,inbox_id,message_id,provider,state,parts) VALUES($1,$2,$3,$4,'processing',$5)",[account,b.inboxId,b.messageId,b.provider,b.parts]);
    return {allowed:true};
  }
  async transition(actor:Actor,input:any){
    const b=z.object({inboxId:z.number().int().positive(),provider:z.enum(['paused','waha','evolution']),expectedRevision:z.number().int().min(0),lastKnownMessageId:z.number().int().min(0),reason:z.string().min(8).max(500)}).parse(input);
    return this.repo.transaction('bridge:'+actor.accountId+':'+b.inboxId,async db=>{
      const old=(await db.query('SELECT * FROM marketing_bridge_owners WHERE account_id=$1 AND inbox_id=$2 FOR UPDATE',[actor.accountId,b.inboxId])).rows[0];
      if((old?.revision||0)!==b.expectedRevision)throw new ConflictException('Bridge revision changed');
      if(!old&&b.provider!=='paused')throw new ConflictException('Register paused before enabling a bridge');
      if(old&&old.provider!=='paused'&&b.provider!=='paused')throw new ConflictException('Pause and inspect both queues before changing owner');
      if(b.provider!=='paused'){
        const pending=(await db.query("SELECT 1 FROM marketing_bridge_dispatches WHERE account_id=$1 AND inbox_id=$2 AND state IN ('processing','review') UNION ALL SELECT 1 FROM marketing_waha_sends WHERE account_id=$1 AND inbox_id=$2 AND state IN ('processing','review') LIMIT 1",[actor.accountId,b.inboxId])).rowCount;
        if(pending)throw new ConflictException('Reconcile uncertain or in-flight sends first');
      }
      const maximum=(await db.query('SELECT COALESCE(max(message_id),0) AS id FROM marketing_bridge_dispatches WHERE account_id=$1 AND inbox_id=$2',[actor.accountId,b.inboxId])).rows[0].id;
      const cutoff=Math.max(Number(old?.cutoff_message_id||0),Number(maximum),b.lastKnownMessageId),revision=(old?.revision||0)+1;
      await db.query('INSERT INTO marketing_bridge_owners(account_id,inbox_id,provider,revision,cutoff_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,inbox_id) DO UPDATE SET provider=excluded.provider,revision=excluded.revision,cutoff_message_id=excluded.cutoff_message_id,updated_at=now()',[actor.accountId,b.inboxId,b.provider,revision,cutoff]);
      await this.repo.audit(String(actor.userId),'marketing.bridge_transition',String(b.inboxId),{from:old?.provider||null,...b,revision,cutoff},db);
      return {provider:b.provider,revision,cutoffMessageId:cutoff};
    });
  }
}
