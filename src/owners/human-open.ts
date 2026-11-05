import type { Attempt } from '../contracts/domain.ts';
import type { HumanOpenContext } from '../scheduling/lifecycle.ts';
import { canonical, ensure } from '../storage/database.ts';
import type { VsCodeOwner } from './vscode.ts';
import type { createManagedVsCodeLauncher } from './managed.ts';
import type { createVsCodeNativeToolBoundary } from './boundary.ts';
/** Trusted E6 composition; no route, worker token, model turn or new native allocation. */
export function createManagedHumanOpen(options: {
    owner: VsCodeOwner;
    launcher: ReturnType<typeof createManagedVsCodeLauncher>;
    boundary: ReturnType<typeof createVsCodeNativeToolBoundary>;
    authenticate(start: HumanOpenContext['start']): Promise<void>;
}) {
    return { async prepare(attempt: Attempt, _key: string, context: HumanOpenContext): Promise<void> {
            const { owner, launcher, boundary } = options;
            const { start, assertCurrent } = context;
            assertCurrent();
            ensure(attempt.native && attempt.taskId === start.task.id && attempt.id === start.attemptId, 'owner_identity', 'Human preparation must retain actual task/native identity');
            try {
                if (await owner.stoppedReceipt(attempt.native)) {
                    assertCurrent();
                    await launcher.resumeHuman(start, assertCurrent);
                    assertCurrent();
                    await owner.ensureStarted();
                    assertCurrent();
                    await boundary.prepareHumanOpen(start, attempt.native, assertCurrent, () => options.authenticate(start));
                    assertCurrent();
                    const recovered = await owner.reconcile(start);
                    assertCurrent();
                    ensure(recovered.state === 'done' && canonical(recovered.identity) === canonical(attempt.native), 'owner_history_lost', 'Original native history is missing after human restart; no replacement allowed');
                }
                else {
                    // Already-human focus must not restart, reconfigure or interrupt ongoing human work.
                    await launcher.inspect();
                    assertCurrent();
                    await owner.nativeSession(attempt.native);
                    assertCurrent();
                }
                owner.admitHumanOpen(attempt.native, assertCurrent);
            }
            catch (error) {
                try {
                    await owner.quiesce(attempt.native);
                }
                catch { }
                throw error;
            }
        } };
}
