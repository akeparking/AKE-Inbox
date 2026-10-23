import fs from 'node:fs/promises';import pg from 'pg';import {spawn} from 'node:child_process';
const root=process.env.LOCAL_RUNTIME_ROOT;if(!root)throw Error('LOCAL_RUNTIME_ROOT required');
const env=Object.fromEntries((await fs.readFile(root+'/private/core.env','utf8')).trim().split('\n').map(l=>{let i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
const u=new URL(env.DATABASE_URL);u.hostname='localhost';u.port='14623';u.pathname='/postgres';const admin=new pg.Client({connectionString:u.toString()});await admin.connect();
const urls=[];for(const name of ['marketing_unit_revenue','marketing_unit_inbox','marketing_unit_gaps']){
 if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await admin.query('CREATE DATABASE '+name);
 u.pathname='/'+name;urls.push(u.toString());const db=new pg.Client({connectionString:u.toString()});await db.connect();for(const file of (await fs.readdir('apps/revenue-core/src/database/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.query(await fs.readFile('apps/revenue-core/src/database/migrations/'+file,'utf8'));await db.end();
}await admin.end();
const child=spawn('npm',['test','--workspace','@ake/revenue-core'],{env:{...process.env,TEST_DATABASE_URL:urls[0],INBOX_TEST_DATABASE_URL:urls[1],MARKETING_TEST_DATABASE_URL:urls[2]},stdio:'inherit'});child.on('exit',c=>process.exitCode=c);
