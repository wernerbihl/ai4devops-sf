import type { NativeOwner } from '../contracts/owner.ts';
import type { OwnerReadiness, RequiredCapabilities } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { ensure } from '../storage/database.ts';
export class OwnerRegistry {
    private readonly owners: Map<string, NativeOwner>;
    constructor(entries: Iterable<readonly [
        string,
        NativeOwner
    ]>) {
        this.owners = new Map();
        for (const [id, owner] of entries) {
            ensure(id.trim() && !this.owners.has(id), 'owner_registry', 'Owner ID missing or duplicated');
            this.owners.set(id, owner);
        }
    }
    get(ownerId: string): NativeOwner { const owner = this.owners.get(ownerId); ensure(owner, 'owner_missing', 'Native owner is not configured'); return owner; }
    async list(required: RequiredCapabilities): Promise<OwnerReadiness[]> {
        validateContract('RequiredCapabilities', required);
        return Promise.all([...this.owners].map(async ([ownerId, owner]) => {
            try {
                const detailed = owner as NativeOwner & {
                    readiness?(required: RequiredCapabilities): Promise<OwnerReadiness>;
                };
                if (detailed.readiness) {
                    const result = await detailed.readiness(required);
                    ensure(result.ownerId === ownerId, 'owner_registry', 'Readiness belongs to a different owner');
                    return validateContract('OwnerReadiness', result);
                }
                const report = await owner.capabilities(required);
                return validateContract('OwnerReadiness', { ownerId, ready: false, reasons: [...report.reasons, 'Provider-specific readiness producer is unavailable'], supportedProviders: report.supportedProviders, verifiedProfileIds: [], version: report.version, providers: report.supportedProviders.map(providerId => ({ providerId, ready: false, reasons: ['Provider-specific readiness producer is unavailable'], verifiedProfileIds: [] })) });
            }
            catch {
                return { ownerId, ready: false, reasons: ['Native owner readiness unavailable'], supportedProviders: [], verifiedProfileIds: [], version: 'unavailable', providers: [] };
            }
        }));
    }
}
