import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceWindowsPrivateFileAsync, writeWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { ensure } from '../storage/database.ts';
/** Protected loopback control for the trusted CLI/host. Browser cookies are deliberately not accepted. */
export async function startPrivateControl(options:{root:string;key:Buffer;handle(method:string,path:string,input:Record<string,unknown>):Promise<unknown>}) {
  ensure(options.key.length>=32,'control_key','Protected private control key must contain at least 32 bytes');
  const expected=Buffer.from('Bearer '+options.key.toString('base64url'));
  const server=createServer(async(req,res)=>{
    const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||req.headers.origin){res.writeHead(401).end();return;}
    try {
      ensure(['GET','POST'].includes(req.method??'')&&/^\/[a-z-]+$/.test(req.url??''),'control_request','Unsupported private request');
      let raw='';for await(const data of req){raw+=data;if(Buffer.byteLength(raw)>4096)throw Error('bounded request')}
      const input=raw?JSON.parse(raw):{};ensure(input&&typeof input==='object'&&!Array.isArray(input),'control_request','Expected private request object');
      const result=await options.handle(req.method!,req.url!,input);
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(result));
    } catch {res.writeHead(409,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({code:'CONTROL_UNAVAILABLE',recovery:'Inspect the original action and retained task; private command was not confirmed'}));}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve())});
  const address=server.address();ensure(address&&typeof address!=='string','control_address','Missing private control address');
  const url=`http://127.0.0.1:${address.port}`;
  const path=join(options.root,'control.json');const data=JSON.stringify({schemaVersion:1,url});if(process.platform==='win32'){if(existsSync(path))await replaceWindowsPrivateFileAsync(path,Buffer.from(data));else await writeWindowsPrivateFileAsync(path,Buffer.from(data))}else writeFileSync(path,data,{mode:0o600});
  return{url,async close(){await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections()})}};
}
