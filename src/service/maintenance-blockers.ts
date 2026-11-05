import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryStore } from '../storage/store.ts';
import { inspectExecutionIntents } from '../kestra/maintenance-journal.ts';
import { fingerprint } from '../storage/database.ts';
export interface MaintenanceBlocker {kind:'git'|'api'|'native'|'engine'|'lease'|'effect'|'action';identity:string}
/** Conservative observation only; never releases a lease or reconciles/replays an effect. */
export async function inspectMaintenanceBlockers(root:string,store:FactoryStore):Promise<MaintenanceBlocker[]> {
  const blocked:MaintenanceBlocker[]=[];
  try{lstatSync(join(root,'.workspace-manager.lock'));blocked.push({kind:'git',identity:'workspace-manager'})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const effects=store.pendingExternalEffects();
  for(const key of effects.apiKeys)blocked.push({kind:'api',identity:fingerprint(key)});
  for(const write of effects.nativeWrites)blocked.push({kind:'native',identity:write.attemptId+':'+write.fence});
  for(const r of store.getReservations()){
    if(r.lease.active)blocked.push({kind:'lease',identity:r.attempt.id});
    const state=store.getLifecycle(r.attempt.id).state;
    if(state.effect&&state.effect.phase!=='accepted'||state.closeout?.phase==='metadata')blocked.push({kind:'effect',identity:r.attempt.id});
  }
  // These rows are local audit/queue records; every other pending action is retained
  // until its actual effect is reconciled, including unfamiliar future action kinds.
  const localOnly=new Set(['maintenance.intent','dispatch.request','dispatch.selection','dispatch.reservation','dispatch.continuation']);
  for(const action of store.pendingActions())if(!localOnly.has(action.kind))blocked.push({kind:'action',identity:action.id});
  try{for(const intent of (await inspectExecutionIntents(join(root,'kestra','journal'))).blocked)blocked.push({kind:'engine',identity:intent.attemptId})}
  catch{blocked.push({kind:'engine',identity:'journal-unavailable'})}
  return blocked;
}
