import { randomUUID } from 'node:crypto';
import type { DeviceFlow } from '../contracts/domain.ts';
import type { AppCredential, AuthRecord } from './store.ts';
import { fetchJson, GitHubFailure, jsonObject } from './gh.ts';
import type { HttpPort } from './gh.ts';
export interface AppConfiguration {
  /** Publisher's public GitHub App client ID; never an OAuth app ID or client secret. */ clientId: string;
}
export interface DeviceDependencies {
  app: AppConfiguration;
  fetch: HttpPort;
  now: () => number;
  timeoutMs: number;
  maxBytes: number;
  registerSecret(value: string): void;
}
export function createDeviceFlow(deps: DeviceDependencies) {
  const post = async (path: string, fields: Record<string, string>) =>
    jsonObject(
      (
        await fetchJson(
          deps.fetch,
          `https://github.com${path}`,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: deps.app.clientId, ...fields }).toString(),
          },
          deps,
        )
      ).data,
    );
  const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  function credential(value: Record<string, unknown>): AppCredential {
    if (
      typeof value.access_token !== 'string' ||
      !/^ghu_[\w-]+$/.test(value.access_token) ||
      typeof value.refresh_token !== 'string' ||
      !/^ghr_[\w-]+$/.test(value.refresh_token) ||
      !positive(value.expires_in) ||
      !positive(value.refresh_token_expires_in) ||
      value.token_type !== 'bearer'
    )
      throw new GitHubFailure('unavailable', 'GitHub App returned invalid expiring credentials');
    deps.registerSecret(value.access_token);
    deps.registerSecret(value.refresh_token);
    return {
      clientId: deps.app.clientId,
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: deps.now() + (value.expires_in as number) * 1000,
      refreshExpiresAt: deps.now() + (value.refresh_token_expires_in as number) * 1000,
    };
  }
  return {
    async start(): Promise<{ public: DeviceFlow; deviceCode: string; nextPollAt: number }> {
      const data = await post('/login/device/code', { scope: 'offline_access' });
      if (
        typeof data.device_code !== 'string' ||
        !data.device_code ||
        typeof data.user_code !== 'string' ||
        !/^[A-Z\d]{4}-[A-Z\d]{4}$/.test(data.user_code) ||
        data.verification_uri !== 'https://github.com/login/device' ||
        !positive(data.expires_in) ||
        !positive(data.interval)
      )
        throw new GitHubFailure(
          'unavailable',
          'GitHub App device authorization failed; check publisher client configuration and device-flow enablement',
        );
      deps.registerSecret(data.device_code);
      return {
        public: {
          id: randomUUID(),
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          expiresAt: new Date(deps.now() + (data.expires_in as number) * 1000).toISOString(),
          pollIntervalMs: (data.interval as number) * 1000,
          status: 'pending',
        },
        deviceCode: data.device_code,
        nextPollAt: deps.now() + (data.interval as number) * 1000,
      };
    },
    async poll(record: AuthRecord, id: string, save: () => void): Promise<AppCredential | undefined> {
      const flow = record.flows[id];
      if (!flow)
        throw new GitHubFailure(
          'denied',
          'GitHub device flow was not found; start a new explicit authorization',
        );
      if (deps.now() >= Date.parse(flow.public.expiresAt)) {
        flow.public.status = 'expired';
        return undefined;
      }
      if (flow.public.status !== 'pending' || deps.now() < flow.nextPollAt) return undefined;
      if (flow.exchangePending)
        throw new GitHubFailure(
          'unavailable',
          'GitHub device token exchange outcome is unknown; intentionally start a new authorization',
        );
      flow.exchangePending = true;
      save();
      const data = await post('/login/oauth/access_token', {
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      flow.exchangePending = false;
      flow.nextPollAt = deps.now() + flow.public.pollIntervalMs;
      if (data.error === 'authorization_pending') return undefined;
      if (data.error === 'slow_down') {
        flow.public.pollIntervalMs = Math.max(
          flow.public.pollIntervalMs + 5000,
          typeof data.interval === 'number' ? data.interval * 1000 : 0,
        );
        flow.nextPollAt = deps.now() + flow.public.pollIntervalMs;
        return undefined;
      }
      if (data.error === 'access_denied') {
        flow.public.status = 'denied';
        return undefined;
      }
      if (data.error === 'expired_token' || data.error === 'token_expired') {
        flow.public.status = 'expired';
        return undefined;
      }
      if (data.error)
        throw new GitHubFailure(
          'expired',
          'GitHub App authorization needs repair; start a new explicit device flow',
        );
      return credential(data);
    },
    async refresh(value: AppCredential): Promise<AppCredential> {
      if (value.refreshPending)
        throw new GitHubFailure(
          'unavailable',
          'GitHub token refresh outcome is unknown; reauthorize the GitHub App intentionally',
        );
      if (deps.now() >= value.refreshExpiresAt)
        throw new GitHubFailure(
          'expired',
          'GitHub App refresh credential expired; start a new explicit device flow',
        );
      const data = await post('/login/oauth/access_token', {
        grant_type: 'refresh_token',
        refresh_token: value.refreshToken,
      });
      if (data.error === 'bad_refresh_token' || data.error === 'invalid_grant')
        throw new GitHubFailure(
          'expired',
          'GitHub App refresh credential was revoked; start a new explicit device flow',
        );
      if (data.error)
        throw new GitHubFailure(
          'unavailable',
          'GitHub App refresh failed; check publisher configuration and connectivity',
        );
      return credential(data);
    },
  };
}
