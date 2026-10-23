import fs from 'node:fs/promises';
const root=process.argv[2];if(!root?.startsWith('/home/'))throw Error('Private WSL runtime required');
const lines=(await fs.readFile(root+'/private/core.env','utf8')).split('\n'),row=lines.find(l=>l.startsWith('MARKETING_FORM_KEYS_JSON='));const key=JSON.parse(row?.slice(row.indexOf('=')+1)||'{}')['local-acceptance'];if(typeof key!=='string'||key.length<32)throw Error('Local fixture form signing key required');
await fs.mkdir(root+'/private/frame-receipts',{recursive:true,mode:0o700});await fs.writeFile(root+'/private/frame.env','MARKETING_FORM_KEYS_JSON='+JSON.stringify({'local-acceptance':key})+'\n',{mode:0o600});
