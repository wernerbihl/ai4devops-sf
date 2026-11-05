import { randomUUID } from 'node:crypto';
import type { FactoryStore, OutboxAction } from '../storage/store.ts';
import { ensure } from '../storage/database.ts';
export type NativeMutation = 'network-create'|'container-create'|'container-start'|'network-connect';
/** A durable intent precedes each native provisioning mutation; unknown actions retain exclusion. */
export function beginNativeMutation(store:FactoryStore,operation:NativeMutation,identity:string):OutboxAction {
  ensure(!store.pendingActions().some(a=>a.kind==='runtime.native_mutation'||a.kind==='runtime.container'),'native_unknown','Original native resource mutation remains unresolved');
  return store.enqueueAction({key:'runtime:native-mutation:'+randomUUID(),kind:'runtime.native_mutation',payload:{operation,identity}});
}
