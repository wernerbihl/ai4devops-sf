import type { GitHubPort } from './capabilities.ts';
import type { PullTarget, VerifiedPull } from './pull-requests.ts';
import { object, repositoryPath } from './pull-requests.ts';
import { ensure } from '../storage/database.ts';

export interface CheckDecision { ready: boolean; reason?: string }
/** Exact-head evidence is freshly read on every call, never reused after a head/base/rule change.
 * The non-bypassing merge endpoint remains authoritative for every repository/branch rule. */
export async function currentChecks(github: GitHubPort, target: PullTarget, pull: VerifiedPull): Promise<CheckDecision> {
  const path = repositoryPath(target);
  const rules: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const value = await github.request<unknown>('GET', `${path}/rules/branches/${target.baseRef}?per_page=100&page=${page}`);
    ensure(Array.isArray(value), 'rules_unverified', 'Current branch rules could not be verified'); rules.push(...value.map(object));
    if (value.length < 100) break;
    ensure(page < 10, 'rules_unverified', 'Current branch rules exceed the verification limit');
  }
  const required: { context: string; app?: number }[] = [];

  const add = (value: unknown, appKey: string) => {
    const check = object(value);
    ensure(typeof check.context === 'string', 'rules_unverified', 'Required check rule is malformed');
    const app = check[appKey];
    ensure(app === undefined || app === null || Number.isSafeInteger(app), 'rules_unverified', 'Required check source is malformed');
    required.push({ context: check.context, ...(typeof app === 'number' && app >= 0 ? { app } : {}) });
  };
  for (const rule of rules) {
    ensure(typeof rule.type === 'string', 'rules_unverified', 'Current branch rule is malformed');
    if (rule.type === 'required_status_checks') {
      const params = object(rule.parameters);
      ensure(Array.isArray(params.required_status_checks) && typeof params.strict_required_status_checks_policy === 'boolean', 'rules_unverified', 'Current required check rules are incomplete');
      params.required_status_checks.forEach(check => add(check, 'integration_id'));
    }
  }
  const branch = object(await github.request('GET', `${path}/branches/${target.baseRef}`));
  ensure(object(branch.commit).sha === pull.baseSha && typeof branch.protected === 'boolean', 'base_changed', 'PR base changed while checking current rules');
  if (branch.protected) {
    // Get-branch exposes the read-authorized classic check summary. The admin-only protection
    // endpoint cannot distinguish rulesets-only branches from unreadable classic protection.
    const protection = object(branch.protection);
    if (protection.required_status_checks) {
      const checks = object(protection.required_status_checks);
      ensure(Array.isArray(checks.contexts), 'rules_unverified', 'Classic required check contexts are unavailable');
      for (const context of checks.contexts) { ensure(typeof context === 'string', 'rules_unverified', 'Classic check context is malformed'); required.push({ context }); }
      if (Array.isArray(checks.checks)) checks.checks.forEach(check => add(check, 'app_id'));
    }
  }
  const runs: Record<string, unknown>[] = []; const statuses: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = object(await github.request('GET', `${path}/commits/${pull.headSha}/check-runs?filter=latest&per_page=100&page=${page}`));
    ensure(Array.isArray(data.check_runs) && Number.isSafeInteger(data.total_count), 'checks_unverified', 'Current check run evidence is incomplete');
    runs.push(...data.check_runs.map(object));
    if (runs.length >= Number(data.total_count)) break;
    ensure(data.check_runs.length > 0 && page < 10, 'checks_unverified', 'Check run pagination could not be verified');
  }
  for (let page = 1; page <= 10; page++) {
    const data = object(await github.request('GET', `${path}/commits/${pull.headSha}/status?per_page=100&page=${page}`));
    ensure(data.sha === pull.headSha && Array.isArray(data.statuses) && Number.isSafeInteger(data.total_count), 'checks_unverified', 'Status evidence belongs to a different commit');
    statuses.push(...data.statuses.map(object));
    if (statuses.length >= Number(data.total_count)) break;
    ensure(data.statuses.length > 0 && page < 10, 'checks_unverified', 'Status pagination could not be verified');
  }
  for (const run of runs) ensure(run.head_sha === pull.headSha && typeof run.name === 'string', 'checks_unverified', 'Check evidence belongs to another head');
  const passed = (run: Record<string, unknown>) => run.status === 'completed' && ['success', 'neutral', 'skipped'].includes(String(run.conclusion));
  if (runs.some(run => !passed(run)) || statuses.some(status => status.state !== 'success')) return { ready: false, reason: 'Waiting for current exact-head checks' };
  for (const check of required) {
    const matchingRuns = runs.filter(run => run.name === check.context && (check.app === undefined || object(run.app).id === check.app));
    const matchingStatuses = statuses.filter(status => status.context === check.context);
    if (!matchingRuns.length && (check.app !== undefined || !matchingStatuses.length)) return { ready: false, reason: 'Waiting for required checks from the configured source' };
  }
  if (pull.draft || pull.mergeable !== true || ['blocked', 'dirty', 'draft', 'unknown', 'behind'].includes(pull.mergeableState)) return { ready: false, reason: 'Waiting for current PR rules and mergeability' };
  return { ready: true };
}
