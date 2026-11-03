import type { FactoryConfig } from './domain.ts';

/** Defaults select a preference; adapter readiness must still be verified before admission. */
export function defaultConfig(factoryDir: string): FactoryConfig {
  return {
    schemaVersion: 1, factoryDir, taktSeconds: 60,
    limits: { concurrency: 1, activeMinutes: 30, startsPerDay: 100, transientRetries: 2 },
    defaultOwnerId: 'vscode', defaultProviderId: 'copilot',
  };
}

/** Every release also needs live isolation evidence for each advertised owner/provider pair. */
export const requiredEvidenceIds = [
  'vscode-copilot', 'vscode-codex', 'bb-codex-isolated', 'kestra-oss-h2',
  'dashboard-standalone', 'dashboard-vscode', 'dashboard-copilot-app', 'dashboard-bb',
] as const;
