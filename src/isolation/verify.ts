import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { verifyNativeStateMount } from './native-state.ts';
import { resolveNativeMounts, pathContains } from './mounts.ts';
import type { NativeStart, ProfileEvidence } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import { resolveProtectedPaths } from './paths.ts';
import { builtinProfiles, denialChecks } from './profiles.ts';
import type { EffectiveBoundary, RuntimeProfile } from './profiles.ts';
export function createProfileVerifier(options: { profiles?: readonly RuntimeProfile[]; now?: () => Date } = {}) {
  const profiles = options.profiles ?? builtinProfiles;
  ensure(new Set(profiles.map(p => p.id)).size === profiles.length, 'profile_invalid', 'Profile identities must be unique');
  async function requireVerifiedProfile(start: NativeStart): Promise<ProfileEvidence> {
    validateContract('NativeStart', start);
    const profile = profiles.find(p => p.id === start.profileId && p.ownerId === start.task.ownerId && p.providerId === start.task.providerId);
    ensure(profile, 'profile_unsupported', 'No effective native/tool isolation adapter for this owner/provider');
    ensure(isAbsolute(start.workspacePath) && resolve(start.workspacePath) === start.workspacePath && await realpath(start.workspacePath) === start.workspacePath, 'profile_path', 'Canonical non-symlink workspace required');
    const verify = async (value: EffectiveBoundary) => {
      const required = start.task.required;
      ensure(value.runtimeId && value.processIdentity && value.ownerId === profile.ownerId && value.providerId === profile.providerId
        && value.image === profile.image && canonical([...value.networks].sort()) === canonical([...profile.networks].sort()), 'profile_changed', 'Effective runtime image/identity/network changed');
      ensure(value.unapprovedToolsDenied && value.alternateEgressDenied && value.metadataProtected, 'profile_unsupported', 'Native tools, alternate egress and metadata protection must be enforced');
      for (const key of ['tools','credentialRefs','networkDestinations'] as const)
        ensure(canonical([...value[key]].sort()) === canonical([...required[key]].sort()), 'profile_authority', `Effective ${key} exceed or omit approved authority`);
      ensure(profile.protectedPaths.length >= 3 && profile.protectedPaths.every(p => isAbsolute(p) && resolve(p) === p) && canonical([...value.protectedPaths].sort()) === canonical([...profile.protectedPaths].sort()), 'profile_protection', 'Host credentials, factory state and Docker access require explicit protection');
      const protectedTargets = await resolveProtectedPaths(profile.protectedPaths);
      const expected = await resolveNativeMounts(start,profile.mountTargets);
      if(profile.nativeState){ensure(profile.nativeStateOwnership,'profile_state','Trusted installation native-state root required');const state=await verifyNativeStateMount(profile.nativeState,start.task.id,profile.nativeStateOwnership);ensure(protectedTargets.some(p=>pathContains(p,profile.nativeState!.markerPath)),'profile_state','Native state ownership marker must be protected');for(const mount of expected)ensure(!pathContains(mount.source,state.source)&&!pathContains(state.source,mount.source)&&!pathContains(mount.target,state.target)&&!pathContains(state.target,mount.target)&&!pathContains(mount.source,profile.nativeState.markerPath),'profile_state','Native state/ownership marker overlaps a recipe mount');expected.push(state);}
      ensure(canonical(value.mounts) === canonical(expected), 'profile_mount', 'Effective mounts differ from approved paths');
      for (const mount of value.mounts) {
        ensure(isAbsolute(mount.source) && resolve(mount.source) === mount.source && await realpath(mount.source) === mount.source, 'profile_path', 'Mount source escapes through an alias');
        for (const protectedPath of protectedTargets) {
          ensure(!pathContains(mount.source, protectedPath) && !pathContains(protectedPath, mount.source) && !pathContains(mount.target, protectedPath) && !pathContains(protectedPath, mount.target), 'profile_path', 'A mount intersects protected host state');
        }
      }
      return protectedTargets;
    };
    const before = await profile.boundary.inspect(start); const protectedTargets = await verify(before);
    const nonce = randomBytes(24).toString('base64url'); const challenge = await profile.boundary.challenge(start, nonce, protectedTargets);
    ensure(challenge.nonce === nonce && challenge.denied && challenge.runtimeId === before.runtimeId && challenge.processIdentity === before.processIdentity
      && denialChecks.every(name => challenge.checks.includes(name)), 'profile_canary', 'Native/client-tool denial canaries failed or incomplete');
    const after = await profile.boundary.inspect(start); const afterTargets = await verify(after);
    ensure(canonical(before) === canonical(after) && canonical(protectedTargets) === canonical(afterTargets), 'profile_changed', 'Boundary changed during verification');
    return validateContract('ProfileEvidence', { profileId: profile.id, ownerId: profile.ownerId, providerId: profile.providerId,
      verifiedAt: (options.now?.() ?? new Date()).toISOString(), required: start.task.required,
      probes: [{ name: 'effective-native-boundary', mode: 'live', status: 'passed', versions: { image: before.image, runtime: before.runtimeId, process: before.processIdentity },
        assertions: denialChecks.map(name => ({ name, passed: true })), artifacts: [`sha256:${fingerprint({ start, before, protectedTargets, nonce })}`] }] });
  }
  return { requireVerifiedProfile };
}
export const requireVerifiedProfile = createProfileVerifier().requireVerifiedProfile;
