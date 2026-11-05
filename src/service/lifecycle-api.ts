import type { FactoryStore } from '../storage/store.ts';
import type { Lifecycle } from '../scheduling/lifecycle.ts';
import type { NativeIdentity } from '../contracts/domain.ts';
import type { PendingRequest, Reconciliation, RequestContext } from './api.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';

/** Private receipts bridge C5 caller keys to C4 outcomes. Reconciliation only reads original
 * receipts; current entity state or a quiescence receipt cannot prove a navigation result. */
export function createLifecycleApi(store: FactoryStore, lifecycle: Lifecycle) {
  const intentKey = (key: string) => 'runtime:api-lifecycle:'+key;
  const resultKey = (key: string) => 'runtime:api-lifecycle-result:'+key;
  const pathFor = (kind: string, id: string) => kind === 'return-control' ? `/v1/repositories/${encodeURIComponent(id)}/return-control`
    : kind === 'input' ? `/v1/attention/${encodeURIComponent(id)}/respond` : `/v1/tasks/${encodeURIComponent(id)}/${kind}`;
  const normalized = (path: string) => path.split('/').map(part=>encodeURIComponent(decodeURIComponent(part))).join('/');
  function binding(taskId?: string, repositoryId?: string) {
    const task = taskId ? store.getTask(taskId) : undefined;
    const repo = store.getRepository(repositoryId ?? task?.spec.repositoryId ?? '');
    ensure(repo, 'not_found', 'Original repository is missing');
    const reservations = store.getReservations().filter(r=>r.lease.repositoryId===repo.id && (!task || r.attempt.id===task.attemptIds.at(-1)));
    return { repositoryId:repo.id, repositoryRevision:repo.revision, controlMode:repo.controlMode,
      ...(task ? {taskId:task.spec.id,taskRevision:task.revision} : {}),
      attempts:reservations.map(r=>({attemptId:r.attempt.id,fence:r.lease.fence,native:r.attempt.native??null})) };
  }
  async function invoke<T>(key: string | undefined, kind: string, id: string, input: unknown, capture: ()=>object, effect: ()=>Promise<T>): Promise<T> {
    ensure(key, 'api_key', 'Original API caller key is required');
    const path=pathFor(kind,id); const inputHash=fingerprint(input);
    const old=store.getActionByKey(intentKey(key));
    if(old) {
      ensure(old.payload.path===path && old.payload.inputHash===inputHash,'idempotency_conflict','Original lifecycle API request changed');
      const saved=store.getActionByKey(resultKey(key));
      ensure(saved?.payload.intentId===old.id,'effect_unresolved','Original lifecycle API effect is pending or unknown; never repeat it');
      return structuredClone(saved.payload.body) as T;
    }
    // Synchronous durable linkage precedes any await/native operation/control mutation.
    const intent=store.enqueueAction({key:intentKey(key),kind:'runtime.api_lifecycle',payload:{method:'POST',path,inputHash,binding:capture()}});
    const body=await effect();
    // This known-completion receipt is immutable, including the exact response snapshot.
    const receipt=store.enqueueAction({key:resultKey(key),kind:'runtime.api_lifecycle_result',payload:{intentId:intent.id,body}});
    store.completeAction(receipt.id);store.completeAction(intent.id);
    return body;
  }
  async function reconcile(request: PendingRequest): Promise<Reconciliation> {
    const intent=store.getActionByKey(intentKey(request.key));
    let path:string;try{path=normalized(request.path)}catch{return{state:'pending'}}
    if(!intent || intent.payload.method!==request.method || intent.payload.path!==path)return{state:'pending'};
    const result=store.getActionByKey(resultKey(request.key));
    return result?.payload.intentId===intent.id ? {state:'complete',body:structuredClone(result.payload.body)} : {state:'pending'};
  }
  return { reconcile,
    lifecycle: {
      async requestTakeover(taskId: string,key?: string) { await invoke(key,'takeover',taskId,{},()=>binding(taskId),async()=>{await lifecycle.requestTakeover(taskId);return store.getTask(taskId)!}) },
      async returnControl(repositoryId: string,key?: string) { await invoke(key,'return-control',repositoryId,{},()=>binding(undefined,repositoryId),async()=>{await lifecycle.returnControl(repositoryId);return store.getRepository(repositoryId)!}) },
      async resumeInput(requestId: string,value: unknown,key: string) {
        ensure(key.startsWith('api:'),'api_key','Original API input key required');
        await invoke(key.slice(4),'input',requestId,value,()=>{const request=store.snapshot().attention.find(a=>a.id===requestId);ensure(request,'not_found','Original attention missing');return{...binding(request.taskId),attentionId:request.id,attentionRevision:request.revision,nativeInputId:request.nativeInputId}},async()=>{await lifecycle.resumeInput(requestId,value,key);return store.snapshot().attention.find(a=>a.id===requestId)!});
      },
    },
    owner: { async open(identity: NativeIdentity,context: RequestContext) {
      const matches=store.getReservations().filter(r=>canonical(r.attempt.native)===canonical(identity)&&store.getTask(r.attempt.taskId)?.attemptIds.at(-1)===r.attempt.id);
      ensure(matches.length===1,'identity_missing','Original native task identity required');
      const taskId=matches[0]!.attempt.taskId;
      return invoke(context.key,'open-native',taskId,identity,()=>binding(taskId),()=>lifecycle.openNative(identity,context.key));
    } },
  };
}
