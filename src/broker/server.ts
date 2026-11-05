import { randomUUID } from 'node:crypto';
import type { WorkerRequest } from '../contracts/domain.ts';
import { decodeWorkerRequest, encodeWorkerResponse, WORKER_TRANSPORT_MAX_WIRE_BYTES, WorkerTransportError } from '../contracts/worker-transport.ts';
import { ensure, StoreError } from '../storage/database.ts';
import type { AttemptBroker } from './operations.ts';
export const workerRoutes = [
  ['POST','/worker/v1/tasks','task.create'], ['GET','/worker/v1/tasks/{id}','task.read'],
  ['PATCH','/worker/v1/tasks/{id}','task.update'], ['DELETE','/worker/v1/tasks/{id}','task.cancel'],
  ['POST','/worker/v1/findings','finding.upsert'], ['POST','/worker/v1/native/start','native.start'],
  ['POST','/worker/v1/native/continue','native.continue'], ['POST','/worker/v1/results','result.submit'],
  ['POST','/worker/v1/artifacts','artifact.register'], ['GET','/worker/v1/artifacts/{id}','artifact.read'],
  ['POST','/worker/v1/attention','attention.create'],
] as const;
export interface BrokerHttpRequest { method: string; path: string; authorization: string; body: string }
export interface BrokerHttpResponse { status: number; body: string }
export interface WorkerBroker { handle(input: BrokerHttpRequest): Promise<BrokerHttpResponse> }
/** Private dispatch only. E3's stdio relay supplies HTTP; never mount on browser/admin server. */
export async function startWorkerBroker(deps: { broker: AttemptBroker }): Promise<WorkerBroker> {
  return { async handle(input) {
    let requestId = 'invalid-request';
    try {
      ensure(input.path.length <= 2048 && !/[?#\r\n]/.test(input.path), 'route_missing', 'Unknown broker route');
      const route = workerRoutes.find(([method,path]) => method === input.method && new RegExp('^'+path.replace('{id}','([^/]+)')+'$').test(input.path));
      ensure(route, 'route_missing', 'Unknown broker route');
      ensure(/^Bearer [A-Za-z0-9_-]{86}$/.test(input.authorization), 'invalid_capability', 'Attempt authentication required');
      const token = input.authorization.slice(7); const operation = route[2];
      const id = route[1].includes('{id}') ? decodeURIComponent(input.path.split('/').at(-1)!) : undefined;
      ensure(!id || !/[/\x00-\x1f]/.test(id), 'route_missing', 'Invalid route target');
      let request: WorkerRequest;
      if (input.method === 'GET') {
        ensure(input.body === '', 'invalid_body', 'GET does not accept a body');
        const scope = deps.broker.authorizeAttempt(token, operation, operation === 'task.read' ? { taskId: id! } : {});
        request = { requestId: randomUUID(), idempotencyKey: randomUUID(), scope,
          ...(operation === 'task.read' ? { operation, payload: { taskId: id! } } : { operation: 'artifact.read', payload: { artifactId: id! } }) };
      } else {
        ensure(Buffer.byteLength(input.body) <= WORKER_TRANSPORT_MAX_WIRE_BYTES, 'invalid_body', 'Body exceeds transport bound');
        request = decodeWorkerRequest(input.body); requestId = request.requestId;
        ensure(request.operation === operation, 'operation_denied', 'Operation does not match route');
        if (id) ensure('taskId' in request.payload && request.payload.taskId === id, 'operation_denied', 'Route target does not match operation');
      }
      return { status: 200, body: encodeWorkerResponse(await deps.broker.execute(token, request)) };
    } catch (error) {
      const code = error instanceof WorkerTransportError ? 'invalid_body' : error instanceof StoreError ? error.code : 'broker_unavailable';
      const status = code === 'route_missing' ? 404 : code === 'invalid_body' ? 400 : code === 'invalid_capability' ? 401 : code === 'broker_unavailable' || code.includes('unsupported') || code === 'native_unknown' ? 503 : 403;
      return { status, body: encodeWorkerResponse({ requestId, ok: false, error: { code, message: 'Broker request was not authorized or could not be confirmed', recovery: code === 'attention_input_unsupported' ? 'Open the actual native owner input; trusted pending-input correlation is unavailable' : 'Use current attempt authority; reconcile uncertain native effects through the trusted runtime', retryable: false } }) };
    }
  } };
}
