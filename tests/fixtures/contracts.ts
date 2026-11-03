import type { TaskSpec } from '../../src/contracts/domain.ts';

export function validTask(): TaskSpec {
  return {
    id: 'task-1', repositoryId: 'repo-1', recipeId: 'recipe-1',
    recipeRevision: 'sha256:revision-1', tagId: 'features', source: 'manual',
    title: 'Add a feature', description: 'Implement the requested feature.',
    goal: 'Deliver a working feature', acceptanceCriteria: ['The feature works'],
    skills: [], tools: [], context: { paths: ['src/'] }, finishPolicy: 'pr',
    ownerId: 'vscode', providerId: 'copilot',
    required: { paths: [{ root: '/workspace', mode: 'write' }], tools: [],
      networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['pr'] },
  };
}
