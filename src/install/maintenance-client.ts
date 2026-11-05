import { join } from 'node:path';
import { readPrivateFileAsync, readVaultSecretAsync } from '../service/config.ts';
import { ensure } from '../storage/database.ts';

export type MaintenanceResult = {state:'engine_stopped'|'admission_closed';blocked:{kind:string;identity:string}[]};
async function request(root:string,path:'/maintenance'|'/cleanup'|'/cleanup-status',body:object):Promise<unknown>{
 const control=JSON.parse((await readPrivateFileAsync(join(root,'control.json'))).toString());ensure(control.schemaVersion===1&&typeof control.url==='string','maintenance_client','Invalid private controller address');
 const url=new URL(control.url);ensure(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'maintenance_client','Invalid private controller address');
 const key=await readVaultSecretAsync(root,'private-control');ensure(key.length>=32,'maintenance_client','Private controller key unavailable');
 const response=await fetch(new URL(path,url),{method:path==='/cleanup-status'?'GET':'POST',headers:{authorization:'Bearer '+key.toString('base64url'),'content-type':'application/json'},...(path==='/cleanup-status'?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(120_000)});
 ensure(response.ok,'maintenance_client','Maintenance result is unknown; retain original installation');return response.json();
}
/** Authenticated private controller call; unknown responses remain unknown, never retry blindly. */
export async function requestMaintenance(root:string,purpose:'reconfigure'|'uninstall'):Promise<MaintenanceResult>{
 const value=await request(root,'/maintenance',{purpose}) as MaintenanceResult;
 ensure(value&&['engine_stopped','admission_closed'].includes(value.state)&&Array.isArray(value.blocked)&&value.blocked.every(x=>x&&typeof x.kind==='string'&&typeof x.identity==='string')&&(value.state!=='engine_stopped'||value.blocked.length===0),'maintenance_client','Invalid maintenance result');return value;
}

export async function requestOwnedCleanup(root:string):Promise<{state:'resources_removed';removed:string[];blocked:[]}>{
 const value=await request(root,'/cleanup',{}) as {state:'resources_removed';removed:string[];blocked:[]};ensure(value?.state==='resources_removed'&&Array.isArray(value.removed)&&value.removed.every(x=>typeof x==='string'&&/^(container|network):[a-f0-9]{64}$/.test(x))&&Array.isArray(value.blocked)&&value.blocked.length===0,'maintenance_client','Owned cleanup outcome is unknown');return value;
}

export async function requestCleanupStatus(root:string):Promise<{removed:string[];blocked:{kind:string;identity:string}[]}>{
 const value=await request(root,'/cleanup-status',{}) as {removed:string[];blocked:{kind:string;identity:string}[]};ensure(Array.isArray(value?.removed)&&value.removed.every(x=>typeof x==='string'&&/^(container|network):[a-f0-9]{64}$/.test(x))&&Array.isArray(value.blocked)&&value.blocked.every(x=>x&&['effect','retained'].includes(x.kind)&&typeof x.identity==='string'&&(/^(container|network):[a-f0-9]{64}$/.test(x.identity)||x.identity==='cleanup-outcome-unconfirmed')),'maintenance_client','Cleanup status is unknown');return value;
}
