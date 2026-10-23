// Build a fresh, local-only acceptance stack. Never imports existing configuration,
// customer messages, credentials, browser sessions or provider authentication.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const formId='a0000000-0000-4000-8000-000000000001';
const secret=()=>randomBytes(32).toString('hex');
const envText=values=>Object.entries(values).map(([key,value])=>key+'='+value).join('\n')+'\n';

async function seedCore(){
  if(process.env.LOCAL_EMPTY_INSTALL!=='true'||process.env.ADS_MODE!=='mock'||process.env.OKKI_WRITE_ENABLED!=='false')throw Error('Isolated bootstrap configuration required');
  const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO marketing_sites(id,account_id,name,origin,inbox_id,settings,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',['local-acceptance',Number(process.env.INBOX_ACCOUNT_ID),'Local acceptance',process.env.LOCAL_SITE_ORIGIN,Number(process.env.LOCAL_SITE_INBOX),{iframeOrigins:[process.env.LOCAL_FRAME_ORIGIN]}]);
    const definition={heading:'Contact our local test team',language:'en',placement:'inline',submitLabel:'Send inquiry',successMessage:'Your inquiry has been received',fields:[
      {key:'name',label:'Name',type:'text',required:true,mapping:'name',options:[]},
      {key:'email',label:'Email',type:'email',required:true,mapping:'email',options:[]},
      {key:'company',label:'Company',type:'text',required:true,mapping:'company',options:[]},
      {key:'message',label:'Message',type:'textarea',required:true,mapping:'message',options:[]}]};
    await db.query('INSERT INTO marketing_forms(id,site_id,name,draft,published_version) VALUES($1,$2,$3,$4,1)',[formId,'local-acceptance','Local inquiry',definition]);
    await db.query('INSERT INTO marketing_form_versions(form_id,version,definition,published_by) VALUES($1,1,$2,$3)',[formId,definition,Number(process.env.LOCAL_ADMIN_ID||1)]);
    await db.query('COMMIT');
  } catch(error){await db.query('ROLLBACK');throw error;} finally {await db.end();}
}

async function bootstrap(){
  const [runtimeArg,project,portArg,image]=process.argv.slice(2);
  if(!runtimeArg||!/^ake-mkt-rebuild-[a-z0-9-]+$/.test(project||'')||!image)throw Error('Usage: node deploy/marketing/bootstrap-local.mjs /home/<user>/<new-directory> ake-mkt-rebuild-<name> <base-port> <installed-Node24-image>');
  const root=path.resolve(runtimeArg),base=Number(portArg);
  if(!root.startsWith('/home/')||!Number.isInteger(base)||base<1024||base>65000)throw Error('Use a new WSL ext4 directory and valid localhost port range');
  const realParent=await fs.realpath(path.dirname(root));if(!realParent.startsWith('/home/'))throw Error('Runtime parent must remain on the Linux filesystem');
  if(await fs.stat(root).then(()=>true,()=>false))throw Error('Refusing to overwrite an existing runtime; use local.sh for restart');
  await fs.access(path.join(source,'apps/revenue-core/dist/main.js'));await fs.access(path.join(source,'node_modules'));
  if(Number(process.versions.node.split('.')[0])<24)throw Error('Node 24+ is required');
  const installed=name=>JSON.parse(execFileSync('docker',['image','inspect',name],{encoding:'utf8'}))[0].Id;
  const images={node:installed(image),postgres:installed('pgvector/pgvector:pg16'),redis:installed('redis:7.4-alpine'),chatwoot:installed('chatwoot/chatwoot@sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1')};
  const imageNode=execFileSync('docker',['run','--rm','--network','none','--entrypoint','node',images.node,'--version'],{encoding:'utf8'}).trim();
  if(Number(imageNode.replace(/^v/,'').split('.')[0])<24)throw Error('The selected local image must provide Node 24+');
  if(execFileSync('docker',['volume','ls','-q','--filter','label=com.docker.compose.project='+project],{encoding:'utf8'}).trim())throw Error('Refusing to reuse existing project volumes');
  for(const offset of [0,1,2,3,4,6,9])await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error('Port occupied: '+(base+offset))));server.listen(base+offset,'127.0.0.1',()=>server.close(resolve));});
  await fs.mkdir(root,{mode:0o700});for(const name of ['private','archive','qa'])await fs.mkdir(path.join(root,name),{mode:0o700});
  const write=(name,text)=>fs.writeFile(path.join(root,'private',name),text,{mode:0o600});
  const password=secret(),internal=secret(),cipher=secret(),formKey=secret(),login='Local!'+secret();
  const compose={LOCAL_RUNTIME_ROOT:root,INBOX_SOURCE_ROOT:source,LOCAL_COMPOSE_PROJECT:project,LOCAL_DATABASE_PASSWORD:password,LOCAL_NODE_IMAGE:images.node,LOCAL_POSTGRES_IMAGE:images.postgres,LOCAL_REDIS_IMAGE:images.redis};
  for(const [key,offset] of Object.entries({INBOX:0,SITE:1,CORE:2,PG:3,REDIS:4,WP:6,FRAME:9}))compose['LOCAL_'+key+'_PORT']=base+offset;
  await write('compose.env',envText(compose));await write('init.sql','CREATE DATABASE revenue_marketing;\n');
  // PostgreSQL drops privileges before reading init SQL. This file has no secrets;
  // credentials and its private parent directory remain 0600 / 0700.
  await fs.chmod(path.join(root,'private/init.sql'),0o644);
  const core={PORT:4100,STORE_DRIVER:'postgres',DATABASE_URL:`postgresql://postgres:${password}@postgres:5432/revenue_marketing`,REDIS_URL:'redis://redis:6379/1',FIELD_ENCRYPTION_KEY:cipher,API_AUTH_MODE:'api-key',API_KEY:secret(),DEMO_SEED:false,ADS_MODE:'mock',GOOGLE_VALIDATE_ONLY:true,INBOX_V2_ENABLED:true,INBOX_INTERNAL_KEY:internal,INBOX_ACCOUNT_ID:1,INBOX_CHANNELS:'{"1":"website"}',INBOX_EFFECTIVE_FROM:new Date().toISOString(),INBOX_AUTO_SEND:false,INBOX_AUTO_CHANNELS:'',OKKI_WRITE_ENABLED:false,CHATWOOT_URL:'http://web:3000',CHATWOOT_PUBLIC_URL:`http://localhost:${base}`,CHATWOOT_API_TOKEN:secret(),MARKETING_ENABLED:true,ATTRIBUTION_CAPTURE_ENABLED:true,ATTRIBUTION_UI_ENABLED:true,QUALIFIED_FEEDBACK_ENABLED:true,WHATSAPP_REFERENCE_ENABLED:false,WAHA_BRIDGE_ENABLED:false,WAHA_ENABLED:false,MARKETING_TEST_MODE:true,CORS_ORIGIN:`http://localhost:${base},http://localhost:${base+1}`,MARKETING_FORM_KEYS_JSON:JSON.stringify({'local-acceptance':formKey}),INBOX_ARCHIVE_ROOT:'/archive',LOCAL_EMPTY_INSTALL:true,LOCAL_SITE_ORIGIN:`http://localhost:${base+1}`,LOCAL_FRAME_ORIGIN:`http://127.0.0.1:${base+9}`,LOCAL_SITE_INBOX:1};
  const native={RAILS_ENV:'production',SECRET_KEY_BASE:secret()+secret(),POSTGRES_HOST:'postgres',POSTGRES_USERNAME:'postgres',POSTGRES_PASSWORD:password,POSTGRES_DATABASE:'chatwoot_test',REDIS_URL:'redis://redis:6379/0',FRONTEND_URL:`http://localhost:${base}`,ACTIVE_STORAGE_SERVICE:'local',INSTALLATION_NAME:'Local Inbox acceptance',ENABLE_ACCOUNT_SIGNUP:false,RAILS_LOG_LEVEL:'warn',LOG_LEVEL:'warn',AKE_SEAT_ROUTING_ENABLED:true,AKE_SEAT_TEST:true,AKE_INBOX_V2_ENABLED:true,AKE_INBOX_CORE_URL:'http://core:4100',AKE_INBOX_INTERNAL_KEY:internal,AKE_MARKETING_ENABLED:true,AKE_MARKETING_UI_ENABLED:true,SMTP_ADDRESS:'test-site',SMTP_PORT:14625,SMTP_DOMAIN:'local.invalid',SMTP_ENABLE_STARTTLS_AUTO:false,MAILER_SENDER_EMAIL:'local@example.invalid',AKE_INBOX_IDS:'1',AKE_INBOX_ACCOUNT_ID:1,SAFE_FETCH_ALLOW_PRIVATE_NETWORK:true};
  await write('core.env',envText(core));await write('chatwoot.env',envText(native));await write('bootstrap-input.json',JSON.stringify({password:login,uid:process.getuid(),gid:process.getgid()}));
  await fs.copyFile(path.join(source,'deploy/marketing/seed-local.rb'),path.join(root,'private/bootstrap-seed.rb'));
  await write('waha.env','# Provider intentionally not installed\n');await write('wordpress.env','# WordPress source must be separately installed\n');
  await write('local-install.json',JSON.stringify({status:'preparing',project,basePort:base,images,scope:'empty local data; no WordPress/provider session or external credentials'},null,2));
  const common=['compose','--env-file',path.join(root,'private/compose.env'),'-f','deploy/marketing/compose.local.yaml','--profile','marketing'];
  let step=0;
  async function run(args,label){
    console.log(label);const logfile=await fs.open(path.join(root,'private',String(++step).padStart(2,'0')+'-bootstrap.log'),'w',0o600);
    try {await new Promise((resolve,reject)=>{const child=spawn('docker',[...common,...args],{cwd:source,stdio:['ignore',logfile.fd,logfile.fd]});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Bootstrap step failed; inspect private log '+step)));});}finally{await logfile.close();}
  }
  await run(['up','-d','--wait','--wait-timeout','120','postgres','redis'],'Starting independent empty database and Redis volumes');
  await run(['run','--rm','--no-deps','core','apps/revenue-core/dist/database/migrate.js'],'Applying Core incremental migrations');
  await run(['run','--rm','--no-deps','--entrypoint','bundle','web','exec','rails','db:chatwoot_prepare'],'Preparing the pinned Chatwoot schema');
  await run(['run','--rm','--no-deps','--entrypoint','bundle','web','exec','rails','runner','/tmp/ake-fixtures/bootstrap-seed.rb'],'Creating a new local administrator and website inbox');
  const accounts=JSON.parse(await fs.readFile(path.join(root,'private/accounts.json'),'utf8'));
  Object.assign(core,{CHATWOOT_API_TOKEN:accounts.users.admin.token,INBOX_ACCOUNT_ID:accounts.accountId,LOCAL_SITE_INBOX:accounts.inboxId,LOCAL_ADMIN_ID:accounts.users.admin.id,INBOX_CHANNELS:JSON.stringify({[accounts.inboxId]:'website'})});
  Object.assign(native,{AKE_INBOX_ACCOUNT_ID:accounts.accountId,AKE_INBOX_IDS:accounts.inboxId});
  await write('core.env',envText(core));await write('chatwoot.env',envText(native));
  await run(['run','--rm','--no-deps','core','deploy/marketing/bootstrap-local.mjs','seed-core'],'Registering the local site and publishing a fictional form');
  execFileSync(process.execPath,['deploy/marketing/prepare-frame.mjs',root],{cwd:source,stdio:'ignore'});
  await run(['up','-d','--no-build'],'Starting isolated Inbox, website, queues and cross-origin form fixture');
  for(const port of [base,base+1,base+2]){
    let healthy=false;for(let n=0;n<90;n++){try {const r=await fetch(`http://127.0.0.1:${port}`+(port===base?'/':'/health'),{signal:AbortSignal.timeout(2000)});if(r.ok){healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,2000));}
    if(!healthy)throw Error('Health check failed on local port '+port);
  }
  const result={status:'ready',project,basePort:base,images,accountId:accounts.accountId,inboxId:accounts.inboxId,startedAt:new Date().toISOString(),sourceCommit:execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),profiles:['marketing'],credentialImport:false,customerDataImport:false,providerSessionImport:false,googleUpload:false,crmWrite:false};
  await write('local-install.json',JSON.stringify(result,null,2));await fs.writeFile(path.join(root,'qa/bootstrap.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:'ready',inbox:`http://localhost:${base}`,testSite:`http://localhost:${base+1}`,credentials:'private/accounts.json',providers:'disabled'}));
}
try{if(process.argv[2]==='seed-core')await seedCore();else await bootstrap();}catch(error){console.error(error.message);process.exitCode=1;}
