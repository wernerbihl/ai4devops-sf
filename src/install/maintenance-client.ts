import { join } from 'node:path';
import { readPrivateFileAsync, readVaultSecretAsync } from '../service/config.ts';
import { ensure } from '../storage/database.ts';

export type MaintenanceResult = {state:'engine_stopped'|'admission_closed';blocked:{kind:string;identity:string}[]};
/** Authenticated private controller call; unknown responses remain unknown, never retry blindly. */
export async function requestMaintenance(root:string,purpose:'reconfigure'|'uninstall'):Promise<MaintenanceResult>{
 const control=JSON.parse((await readPrivateFileAsync(join(root,'control.json'))).toString());ensure(control.schemaVersion===1&&typeof control.url==='string','maintenance_client','Invalid private controller address');
 const url=new URL(control.url);ensure(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'maintenance_client','Invalid private controller address');
 const key=await readVaultSecretAsync(root,'private-control');ensure(key.length>=32,'maintenance_client','Private controller key unavailable');
 const response=await fetch(new URL('/maintenance',url),{method:'POST',headers:{authorization:'Bearer '+key.toString('base64url'),'content-type':'application/json'},body:JSON.stringify({purpose}),redirect:'error',signal:AbortSignal.timeout(120_000)});
 ensure(response.ok,'maintenance_client','Maintenance result is unknown; retain original installation');const value=await response.json() as MaintenanceResult;
 ensure(value&&['engine_stopped','admission_closed'].includes(value.state)&&Array.isArray(value.blocked)&&value.blocked.every(x=>x&&typeof x.kind==='string'&&typeof x.identity==='string')&&(value.state!=='engine_stopped'||value.blocked.length===0),'maintenance_client','Invalid maintenance result');return value;
}
