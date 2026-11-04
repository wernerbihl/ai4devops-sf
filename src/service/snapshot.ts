import type { FactorySnapshot } from '../contracts/domain.ts';
import type { ApiDeps } from './api.ts';
import { validateContract } from '../contracts/schemas.ts';
/** Defense in depth: adapters return DTOs, never raw credential/error/process objects. */
export function sanitize<T>(value: T, secrets: readonly string[] = []): T {
  const clean = (item: unknown, key = ''): unknown => {
    if (/^(access_?token|refresh_?token|authorization|password|secret|client_?secret|cookie|csrfToken|deviceCode)$/i.test(key)) return '[redacted]';
    if (typeof item === 'string') {
      let result = item.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
      for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
      return result;
    }
    if (Array.isArray(item)) return item.map(child => clean(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [String(clean(k)), clean(v, k)]));
    return item;
  };
  return clean(value) as T;
}
export async function factorySnapshot(deps: ApiDeps): Promise<FactorySnapshot> {
  // Read external readiness first: the SQLite snapshot and cursor are captured together afterwards.
  const health = deps.health ? await deps.health() : { schemaVersion: 1 as const, ready: false, reasons: ['Connect the factory runtime readiness adapter'], version: '0.1.0' };
  const auth = deps.auth ? await deps.auth.state() : { status: 'unavailable' as const, reasons: ['Connect the GitHub authentication adapter'] };
  return validateContract('FactorySnapshot', sanitize({ ...deps.store.snapshot(), health: validateContract('Health', health), auth: validateContract('AuthState', auth) }, deps.secrets?.()));
}
