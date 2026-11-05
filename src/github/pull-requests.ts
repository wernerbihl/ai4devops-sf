import type { GitHubPort } from './capabilities.ts';
import { ensure } from '../storage/database.ts';
import { opaqueSha } from '../workspaces/revalidate.ts';

export interface PullTarget { repositoryId: string; owner: string; name: string; baseRef: string; branch: string }
export interface VerifiedPull {
  number: number; url: string; headSha: string; baseSha: string; merged: boolean; mergeSha?: string;
  state: 'open' | 'closed'; draft: boolean; mergeable: boolean | null; mergeableState: string;
}
export const repositoryPath = (target: PullTarget) => `/repos/${target.owner}/${target.name}`;
export function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'github_invalid', 'GitHub returned an invalid verification response');
  return value as Record<string, unknown>;
}
export function parsePull(value: unknown, target: PullTarget, expectedHead: string, marker: string): VerifiedPull {
  const data = object(value); const head = object(data.head); const base = object(data.base);
  const fullName = `${target.owner}/${target.name}`.toLowerCase();
  ensure(object(head.repo).full_name?.toString().toLowerCase() === fullName && object(base.repo).full_name?.toString().toLowerCase() === fullName
    && head.ref === target.branch && base.ref === target.baseRef && head.sha === expectedHead
    && typeof data.body === 'string' && data.body.includes(marker), 'pull_identity_changed', 'PR repository, branch, head or operation marker changed; revalidate the task');
  ensure(Number.isSafeInteger(data.number) && Number(data.number) > 0 && typeof base.sha === 'string' && opaqueSha.test(base.sha)
    && ['open', 'closed'].includes(String(data.state)) && typeof data.merged === 'boolean' && typeof data.draft === 'boolean', 'github_invalid', 'GitHub returned incomplete PR identity');
  ensure(!data.merged || typeof data.merge_commit_sha === 'string' && opaqueSha.test(data.merge_commit_sha), 'merge_unverified', 'Merged PR lacks a verified merge identity');
  return { number: Number(data.number), url: `https://github.com/${target.owner}/${target.name}/pull/${data.number}`,
    headSha: expectedHead, baseSha: base.sha, merged: data.merged, ...(data.merged ? { mergeSha: data.merge_commit_sha as string } : {}),
    state: data.state as 'open' | 'closed', draft: data.draft, mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : null,
    mergeableState: typeof data.mergeable_state === 'string' ? data.mergeable_state : 'unknown' };
}
export async function readPull(github: GitHubPort, target: PullTarget, number: number, head: string, marker: string): Promise<VerifiedPull> {
  return parsePull(await github.request('GET', `${repositoryPath(target)}/pulls/${number}`), target, head, marker);
}
export async function findPull(github: GitHubPort, target: PullTarget, head: string, marker: string): Promise<VerifiedPull | undefined> {
  let number: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const values = await github.request<unknown>('GET', `${repositoryPath(target)}/pulls?state=all&head=${encodeURIComponent(`${target.owner}:${target.branch}`)}&base=${encodeURIComponent(target.baseRef)}&per_page=100&page=${page}`);
    ensure(Array.isArray(values), 'github_invalid', 'GitHub PR reconciliation returned an invalid list');
    for (const value of values) {
      const pr = object(value);
      // Same task branch must not adopt an unrelated or replaced PR, even if its head happens to match.
      ensure(typeof pr.body === 'string' && pr.body.includes(marker), 'pull_identity_changed', 'Existing task branch PR has a different operation marker');
      ensure(number === undefined && Number.isSafeInteger(pr.number), 'pull_ambiguous', 'More than one PR matches the stable task operation');
      number = Number(pr.number);
    }
    if (values.length < 100) return number === undefined ? undefined : readPull(github, target, number, head, marker);
  }
  throw new Error('PR reconciliation pagination limit reached');
}
export async function remoteHead(github: GitHubPort, target: PullTarget): Promise<string | undefined> {
  const values = await github.request<unknown>('GET', `${repositoryPath(target)}/git/matching-refs/heads/${target.branch}`);
  ensure(Array.isArray(values), 'github_invalid', 'GitHub returned invalid branch refs');
  const exact = values.map(object).filter(value => value.ref === `refs/heads/${target.branch}`);
  ensure(exact.length <= 1, 'github_invalid', 'GitHub returned ambiguous branch refs');
  if (!exact.length) return undefined;
  const sha = object(exact[0]!.object).sha;
  ensure(typeof sha === 'string' && opaqueSha.test(sha), 'github_invalid', 'GitHub returned an invalid remote head'); return sha;
}
