import { GitHubFailure, jsonObject } from './gh.ts';
import type { HttpResult } from './gh.ts';
export type GitHubOperation = 'read' | 'contents_write' | 'pull_requests_write' | 'merge';
export interface RepositoryAccess {
  id: string;
  owner: string;
  name: string;
  operations: readonly GitHubOperation[];
}
export interface RepositoryCapabilities {
  repositoryId: string;
  accountId: string;
  operations: Record<GitHubOperation, boolean>;
  reasons: string[];
  /** Not proof of denial: C8 may explicitly request server-authorized bypass; ordinary policies must not. */ bypass: 'unproven';
}
export interface GitHubPort {
  request<T>(method: string, path: string, body?: unknown, key?: string): Promise<T>;
}
export function validateRepositories(repositories: readonly RepositoryAccess[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const repository of repositories) {
    const path = `${repository.owner}/${repository.name}`.toLowerCase();
    if (
      !repository.id ||
      ids.has(repository.id) ||
      paths.has(path) ||
      !/^[\w.-]+$/.test(repository.owner) ||
      !/^[\w.-]+$/.test(repository.name) ||
      repository.owner === '.' ||
      repository.owner === '..' ||
      repository.name === '.' ||
      repository.name === '..' ||
      repository.operations.some(
        (op) => !['read', 'contents_write', 'pull_requests_write', 'merge'].includes(op),
      )
    )
      throw new TypeError('Explicit unique GitHub repository allowlist required');
    ids.add(repository.id);
    paths.add(path);
  }
}
/** Only the C7/C8 API families are brokerable. No arbitrary endpoints, redirects, credentials or GraphQL. */
export function authorizePath(
  repositories: readonly RepositoryAccess[],
  method: string,
  path: string,
): { repository: RepositoryAccess; operation: GitHubOperation } {
  if (
    !/^\/(?:repos)\/[\w.-]+\/[\w.-]+(?:\/[A-Za-z\d_./-]+)?(?:\?[A-Za-z\d_%=&.,-]*)?$/.test(path) ||
    /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(path) ||
    /%|\\|\/\//.test(path.split('?')[0]!)
  )
    throw new GitHubFailure('denied', 'GitHub request path is outside the repository capability');
  const match = /^\/repos\/([^/]+)\/([^/?]+)([^?]*)/.exec(path)!;
  const repository = repositories.find(
    (r) =>
      r.owner.toLowerCase() === match[1]!.toLowerCase() && r.name.toLowerCase() === match[2]!.toLowerCase(),
  );
  if (!repository) throw new GitHubFailure('denied', 'Explicitly allow this repository before using GitHub');
  const suffix = match[3] ?? '';
  let operation: GitHubOperation;
  if (
    method === 'GET' &&
    (suffix === '' ||
      /^\/(?:pulls|commits|branches|compare|contents|git\/(?:ref|refs|matching-refs|trees|commits|blobs)|rules|rulesets|check-runs|statuses)(?:\/|$)/.test(
        suffix,
      ))
  )
    operation = 'read';
  else if (method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(suffix)) operation = 'merge';
  else if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && /^\/pulls(?:\/\d+)?$/.test(suffix))
    operation = 'pull_requests_write';
  else if (
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
    /^\/(?:contents\/|git\/(?:refs|trees|commits|blobs)(?:\/|$))/.test(suffix)
  )
    operation = 'contents_write';
  else throw new GitHubFailure('denied', 'GitHub endpoint or method is outside supported operations');
  if (!repository.operations.includes(operation))
    throw new GitHubFailure('denied', 'Grant this repository operation explicitly before using GitHub');
  return { repository, operation };
}
export function repositoryFacts(
  repository: RepositoryAccess,
  accountId: string,
  result: HttpResult,
  appPermissions?: Record<string, unknown>,
): RepositoryCapabilities {
  const data = jsonObject(result.data);
  if (
    typeof data.full_name !== 'string' ||
    data.full_name.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()
  )
    throw new GitHubFailure('denied', 'GitHub repository identity changed; review the repository allowlist');
  const permissions = jsonObject(data.permissions);
  const scopes = (result.headers.get('x-oauth-scopes') ?? '').split(/,\s*/);
  const broad = scopes.includes('repo') || (data.private === false && scopes.includes('public_repo'));
  const read = permissions.pull === true;
  const push = permissions.push === true && data.archived !== true && data.disabled !== true;
  const contents = push && (broad || appPermissions?.contents === 'write');
  const pulls = push && (broad || appPermissions?.pull_requests === 'write');
  const operations = {
    read: read && repository.operations.includes('read'),
    contents_write: contents && repository.operations.includes('contents_write'),
    pull_requests_write: pulls && repository.operations.includes('pull_requests_write'),
    merge: contents && pulls && repository.operations.includes('merge'),
  };
  return {
    repositoryId: repository.id,
    accountId,
    operations,
    reasons:
      !broad && !appPermissions
        ? [
            'Fine-grained token write permissions cannot be proven from repository metadata; writes remain blocked',
          ]
        : [],
    bypass: 'unproven',
  };
}
