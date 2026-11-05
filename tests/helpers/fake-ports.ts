import type { ApiDeps } from '../../src/service/api.ts';
import type { FactoryStore } from '../../src/storage/store.ts';
import type { NativeIdentity, NativeSnapshot } from '../../src/contracts/domain.ts';
import type { NativeOwner } from '../../src/contracts/owner.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import { createLifecycle } from '../../src/scheduling/lifecycle.ts';
import { systemClock } from '../../src/storage/database.ts';
import { materializeFixture } from './fixtures.ts';
import { createFixture } from './store.ts';
export function fakePorts(store: FactoryStore) {
  let dispatches = 0;
  const scheduler = createScheduler({ store, clock: systemClock, materialize: materializeFixture,
    readiness: async () => ({ ready: false, code: 'fake_owner_unavailable', recovery: 'Fake external port is offline' }),
    start: async () => { throw new Error('Offline owner must not start'); },
  });
  const deps: ApiDeps = { store,
    scheduler: { async dispatch(trigger) { dispatches++; return scheduler.dispatch(trigger); } },
    session: { allowedOrigins: ['http://127.0.0.1:5173'], ttlMs: 60000 },
    health: async () => ({ schemaVersion: 1, ready: false, reasons: ['Fake external ports'], version: 'test' }),
    secrets: () => ['fake-credential-secret'],
  };
  return { deps, get dispatches() { return dispatches; } };
}
/** Real SQLite/admission/lifecycle; all native/workflow external ports are explicit fakes. */
export function fakeRuntime() {
  const fixture = createFixture(); const { clock } = fixture; const store = fixture.store;
  const recipe = store.snapshot().recipes[0]!;
  store.setRecipeReadiness(recipe.id, recipe.currentRevision, { hash: fixture.recipe.hash, ready: true, reasons: [] }, recipe.revision);
  const native: NativeIdentity = { ownerId: 'vscode', providerId: 'copilot', sessionId: 'original', chatId: 'chat' };
  let state: NativeSnapshot['state'] = 'active';
  const opened: NativeIdentity[] = []; const sent: { identity: NativeIdentity; input: object; key: string }[] = [];
  const owner: NativeOwner = {
    capabilities: async () => ({ ready: true, reasons: [], supportedProviders: ['copilot'], verifiedProfileIds: ['fake-profile'], version: 'test' }),
    ensureStarted: async () => { throw new Error('No host launch in API'); }, ensureSession: async () => { throw new Error('No replacement session in API'); },
    snapshot: async identity => ({ identity, state, inputs: [] }), send: async (identity, input, key) => { sent.push({ identity, input, key }); state = 'active'; },
    quiesce: async () => { state = 'waiting'; return 'waiting'; }, open: async identity => { opened.push(identity); return {}; }, subscribe: () => () => {},
  };
  const readiness = async () => ({ ready: true as const, baseSha: 'base', workspacePath: '/fake/original', profileId: 'fake-profile' });
  const lifecycle = createLifecycle({ store, clock, owner: () => owner, readiness, workspace: async () => true,
    workflow: { snapshot: async () => 'present', quiesce: async () => 'waiting', resume: async () => {} },
  });
  const scheduler = createScheduler({ store, clock, materialize: materializeFixture, readiness, continuations: () => lifecycle.dispatchPending(),
    start: async () => ({ kind: 'started', identity: { native, workflow: { executionId: 'original-workflow', namespace: 'sf', flowId: 'quality', revision: '1' } } }),
  });
  return { fixture, native, opened, sent, lifecycle, scheduler,
    deps: { ...fakePorts(store).deps, scheduler, lifecycle, owner: { open: (identity: NativeIdentity) => owner.open(identity) } } satisfies ApiDeps,
  };
}
