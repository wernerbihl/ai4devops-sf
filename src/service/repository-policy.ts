import type { FactoryStore } from '../storage/store.ts';
import { StoreError } from '../storage/store.ts';
import type { GitHubBackend, GitHubBackendOptions } from '../github/auth.ts';
import type { RuntimeConfig } from './config.ts';
import { validateRepositories } from '../github/capabilities.ts';
import { ensure } from '../storage/database.ts';
import { DefinitiveNoEffect } from './api.ts';

/** Only the session-owned selection port can add durable repository authority. */
export function createRepositoryPolicy(store: FactoryStore, config: Pick<RuntimeConfig, 'repositories' | 'selectedIdentity'>, backend: Pick<GitHubBackend, 'listRepositories' | 'resolveGitHubAuth'>, backendOptions?: GitHubBackendOptions) {
  const restore = () => {
    const selections = store.repositorySelections();
    const actor = selections[0] && { accountId: selections[0].accountId, login: selections[0].login };
    ensure(!actor || selections.every(item => item.accountId === actor.accountId), 'repository_identity', 'Selected repositories belong to different GitHub accounts');
    ensure(!actor || !config.selectedIdentity || config.selectedIdentity.accountId === actor.accountId, 'repository_identity', 'Configured account differs from repository selections');
    if (actor && backendOptions) backendOptions.selectedIdentity = actor;
    for (const selected of selections) {
      const id = `github:${selected.githubId}`;
      const entry = { id, owner: selected.owner, name: selected.name, baseRef: selected.baseRef, operations: ['read', 'contents_write', 'pull_requests_write', 'merge'] as const };
      const existing = config.repositories.find(item => item.id === id);
      ensure(!existing || existing.owner === entry.owner && existing.name === entry.name && existing.baseRef === entry.baseRef, 'repository_identity', 'Selected repository identity differs from configured policy');
      if (!existing) config.repositories.push(entry);
    }
    validateRepositories(config.repositories);
  };
  restore();
  return {
    restore,
    allows: (id: string) => config.repositories.some(item => item.id === id),
    list: () => backend.listRepositories(),
    async select(githubId: string, key: string) {
      let item: Awaited<ReturnType<typeof backend.listRepositories>>[number];
      let auth: Awaited<ReturnType<typeof backend.resolveGitHubAuth>>;
      try {
        const entries = await backend.listRepositories();
        auth = await backend.resolveGitHubAuth({});
        ensure(auth.status === 'ready' && auth.accountId && auth.login, 'repository_identity', 'Restore the selected GitHub account before selecting a repository');
        const existing = store.repositorySelections();
        ensure(existing.every(entry => entry.accountId === auth.accountId) && (!config.selectedIdentity || config.selectedIdentity.accountId === auth.accountId), 'repository_identity', 'Repository selection belongs to another account');
        const candidate = entries.find(entry => entry.githubId === githubId);
        ensure(candidate?.defaultBranch, 'repository_identity', 'Select an available repository with a default branch');
        item = candidate;
        ensure(/^\d+$/.test(githubId) && /^refs\/heads\/[\w./-]+$/.test(`refs/heads/${item.defaultBranch}`) && !item.defaultBranch!.includes('..'), 'repository_identity', 'The selected repository requires a safe immutable identity and branch');
        const previous = existing.find(entry => entry.githubId === githubId || entry.url.toLowerCase() === item.url.toLowerCase());
        ensure(!previous || previous.githubId === githubId && previous.accountId === auth.accountId && previous.owner === item.owner && previous.name === item.name && previous.url === item.url && previous.baseRef === `refs/heads/${item.defaultBranch}`, 'repository_identity', 'Repository identity changed; review the selection');
        const id = `github:${githubId}`;
        if (!config.repositories.some(entry => entry.id === id)) validateRepositories([...config.repositories, { id, owner: item.owner, name: item.name, operations: ['read'] }]);
      } catch {
        // Catalog reads and preconditions cannot have selected a repository.
        throw new DefinitiveNoEffect(503, { code: 'CATALOG_UNAVAILABLE', message: 'Repository selection could not be verified', recovery: 'Restore the selected GitHub identity and catalog access, then retry the selection.', retryable: true });
      }
      ensure(auth.accountId && auth.login && item.defaultBranch, 'repository_identity', 'Verified account and default branch required');
      let repository;
      try { repository = store.selectRepository({ githubId, accountId: auth.accountId, login: auth.login, owner: item.owner, name: item.name, url: item.url, baseRef: `refs/heads/${item.defaultBranch}` }, key); }
      catch (error) {
        if (error instanceof StoreError) throw new DefinitiveNoEffect(409, { code: 'REPOSITORY_IDENTITY_CONFLICT', message: 'Repository selection conflicts with existing state', recovery: 'Review the existing repository identity and activation before selecting it.', retryable: false });
        throw error;
      }
      restore();
      return repository;
    },
    resolve(id: string) {
      const repository = store.getRepository(id); const allowed = config.repositories.find(item => item.id === id);
      return repository && allowed ? { id, url: repository.url, baseRef: allowed.baseRef } : undefined;
    },
    reconcile(key: string) { const receipt = store.repositorySelectionReceipt(key); if (receipt) { restore(); return receipt.repository; } },
  };
}
