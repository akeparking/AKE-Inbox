// Only this fixed-target localhost gateway has an external Docker interface.
// Application containers stay on an internal network with no Internet route.
import net from 'node:net';
for(const [port,host,target] of [[14620,'web',3000],[14621,'test-site',14621],[14622,'core',4100],[14623,'postgres',5432],[14624,'redis',6379],[14626,'wordpress',80]]){
  net.createServer(client=>{const upstream=net.connect({host,port:target});client.pipe(upstream);upstream.pipe(client);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());}).listen(port,'0.0.0.0');
}
