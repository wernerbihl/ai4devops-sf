import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
export interface SessionPolicy {
  /** Exact UI origins approved by trusted startup. Wildcards and opaque origins are prohibited. */
  allowedOrigins: readonly string[];
  ttlMs?: number;
  pairingTtlMs?: number;
}
export interface PairingToken { token: string; expiresAt: string }
export interface ProvisionedSession { cookie: string; csrfToken: string; expiresAt: string }
interface Session { csrfToken: string; origin: string; expires: number }
export class SessionError extends Error { status: number; constructor(status: number) { super('Session denied'); this.status = status; } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
/** This object is returned only to trusted startup/OS-user code, never mounted as an HTTP endpoint. */
export class Sessions {
  private policy: SessionPolicy;
  private values = new Map<string, Session>();
  private pairings = new Map<string, { origin: string; expires: number }>();
  constructor(policy: SessionPolicy) {
    if (!policy.allowedOrigins.length || policy.allowedOrigins.some(origin => {
      try { const u = new URL(origin); return u.origin !== origin || !['http:', 'https:'].includes(u.protocol); } catch { return true; }
    })) throw new TypeError('Exact HTTP origins are required');
    if (policy.ttlMs !== undefined && (!Number.isFinite(policy.ttlMs) || policy.ttlMs <= 0 || policy.ttlMs > 86400000)) throw new TypeError('Session TTL must be at most one day');
    if (policy.pairingTtlMs !== undefined && (!Number.isFinite(policy.pairingTtlMs) || policy.pairingTtlMs <= 0 || policy.pairingTtlMs > 60000)) throw new TypeError('Pairing TTL must be at most one minute');
    this.policy = { ...policy, allowedOrigins: [...policy.allowedOrigins] };
  }
  issuePairing(origin: string): PairingToken {
    if (!this.policy.allowedOrigins.includes(origin)) throw new SessionError(403);
    this.prune(); const token = randomBytes(32).toString('base64url'); const expires = Date.now() + (this.policy.pairingTtlMs ?? 60000);
    this.pairings.set(hash(token), { origin, expires }); return { token, expiresAt: new Date(expires).toISOString() };
  }
  exchangePairing(origin: string, token: string): ProvisionedSession {
    this.prune(); const key = hash(token); const pairing = this.pairings.get(key);
    if (!pairing) throw new SessionError(401);
    if (origin !== pairing.origin) throw new SessionError(403);
    this.pairings.delete(key); return this.provision(origin);
  }
  provision(origin: string): ProvisionedSession {
    if (!this.policy.allowedOrigins.includes(origin)) throw new SessionError(403);
    this.prune(); const token = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url');
    const expires = Date.now() + (this.policy.ttlMs ?? 3600000);
    this.values.set(hash(token), { csrfToken, origin, expires });
    // Literal loopback HTTP cannot rely on Secure cookies across browsers. Host-only + HttpOnly + Strict;
    // origin and CSRF are independently mandatory. No Domain attribute; never send over a remote listener.
    return { cookie: `sf_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil((expires - Date.now()) / 1000)}`, csrfToken, expiresAt: new Date(expires).toISOString() };
  }
  authenticate(req: IncomingMessage, mutation: boolean): void {
    this.prune();
    const pairs = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('sf_session='));
    const session = pairs.length === 1 ? this.values.get(hash(pairs[0]!.slice(11))) : undefined;
    if (!session) throw new SessionError(401);
    const sameOriginRead = !mutation && req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin' && session.origin === `http://${req.headers.host}`;
    if (!sameOriginRead && (req.headers.origin !== session.origin || !this.policy.allowedOrigins.includes(req.headers.origin))) throw new SessionError(403);
    if (mutation && !equal(String(req.headers['x-sf-csrf'] ?? ''), session.csrfToken)) throw new SessionError(403);
  }
  revokeAll(): void { this.values.clear(); this.pairings.clear(); }
  private prune(): void { for (const [key, value] of this.pairings) if (value.expires <= Date.now()) this.pairings.delete(key); for (const [key, value] of this.values) if (value.expires <= Date.now()) this.values.delete(key); }
}
