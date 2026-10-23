import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { FieldCipher } from '../common/crypto';
import { config, type Conversation, type Job } from './contracts';

@Injectable()
export class InboxRepository implements OnModuleDestroy {
  readonly pool?: Pool;
  readonly cipher = new FieldCipher(process.env.FIELD_ENCRYPTION_KEY);
  constructor() { if (config().enabled) this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 }); }
  get db() { if (!this.pool) throw new Error('inbox_disabled'); return this.pool; }
  pack(value: unknown) { return this.cipher.encrypt(JSON.stringify(value)); }
  unpack(value: string | null | undefined): any { return value ? JSON.parse(this.cipher.decrypt(value)) : null; }
  identity(value: string) { return createHmac('sha256', process.env.FIELD_ENCRYPTION_KEY || 'local-test-only').update(value).digest('hex'); }
  async transaction<T>(key: string, fn: (c: PoolClient) => Promise<T>) {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['inbox-v2:'+key]);
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async conversation(id: number, client: Pool | PoolClient = this.db): Promise<Conversation | undefined> {
    return (await client.query(`SELECT v.*, c.group_key,c.blocked,c.opted_out,c.timezone,c.profile AS contact_profile
      FROM inbox_v2_conversations v JOIN inbox_v2_contacts c USING(account_id,contact_id)
      WHERE v.account_id=$1 AND v.conversation_id=$2`, [config().accountId,id])).rows[0];
  }
  async audit(actor: string, action: string, target: string, detail: any = {}, client: Pool | PoolClient = this.db) {
    await client.query('INSERT INTO inbox_v2_audit(account_id,actor,action,target,detail) VALUES($1,$2,$3,$4,$5)', [config().accountId,actor,action,target,detail]);
  }
  async job(kind: string, id: string, cid: number | null, group: string | null, revision: number | null, payload: any, due = new Date(), client: Pool | PoolClient = this.db) {
    await client.query(`INSERT INTO inbox_v2_jobs(id,account_id,conversation_id,group_key,kind,revision,payload,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [id,config().accountId,cid,group,kind,revision,this.pack(payload),due]);
  }
  async claim(kinds: string[]): Promise<Job | undefined> {
    const result = await this.db.query(`UPDATE inbox_v2_jobs SET state='processing',claimed_at=now(),attempts=attempts+1 WHERE id=(
      SELECT id FROM inbox_v2_jobs WHERE account_id=$1 AND state='pending' AND kind=ANY($2) AND due_at<=now()
      ORDER BY due_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [config().accountId,kinds]);
    return result.rows[0];
  }
  async finish(id: string, state: string, result: any = {}, error: string | null = null, client: Pool | PoolClient = this.db) {
    await client.query("UPDATE inbox_v2_jobs SET state=$2,result=$3,error=$4 WHERE id=$1 AND state<>'cancelled'", [id,state,result,error]);
  }
  async cancel(group: string, reason: string, client: Pool | PoolClient = this.db, cid?: number) {
    await client.query(`UPDATE inbox_v2_jobs SET state='cancelled',error=$3 WHERE account_id=$1 AND group_key=$2
      AND kind=ANY($4) AND state IN ('pending','processing') AND ($5::bigint IS NULL OR conversation_id=$5)`,
    [config().accountId,group,reason,['ai','send','followup','reminder'],cid ?? null]);
  }
  async recover() {
    // Side effects are never automatically replayed after a crash. Their receipts remain available.
    await this.db.query(`UPDATE inbox_v2_jobs SET state=CASE WHEN kind='ai' THEN 'pending' ELSE 'review' END,
      error='interrupted_before_verified_completion' WHERE account_id=$1 AND state='processing' AND claimed_at<now()-interval '5 minutes'`, [config().accountId]);
  }
  async actionOnce(key: string, hash: string, fn: (c: PoolClient) => Promise<any>) {
    return this.transaction('action:'+key, async c => {
      const old = (await c.query('SELECT * FROM inbox_v2_writes WHERE account_id=$1 AND operation_key=$2', [config().accountId,key])).rows[0];
      if (old) { if (old.request_hash !== hash) throw new Error('idempotency_conflict'); return old.receipt; }
      const result = await fn(c);
      await c.query(`INSERT INTO inbox_v2_writes(account_id,operation_key,kind,request_hash,state,receipt) VALUES($1,$2,'control',$3,'confirmed',$4)`, [config().accountId,key,hash,result]);
      return result;
    });
  }
  id(prefix: string) { return prefix+'_'+randomUUID(); }
  async onModuleDestroy() { await this.pool?.end(); }
}
