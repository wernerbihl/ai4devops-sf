import type { Attempt, AttentionRequest, Grant, NativeIdentity, RecipeSummary, Repository, Settings, Tag, TaskRecord, TaskSpec, WorkflowIdentity } from '../contracts/domain.ts';
import type { RotationCursor, WeightSnapshot } from './rotation-types.ts';

export interface RecipeReadiness { recipeId: string; recipeRevision: string; hash: string; ready: boolean; reasons: string[] }
export interface RotationState { weights: WeightSnapshot; cursor: RotationCursor | null }
export interface QuotaState { dayKey: string; confirmed: number; pending: number }
export interface PreparedStart { ready: true; baseSha: string; workspacePath: string; profileId: string }
export interface UnavailableStart { ready: false; code: string; recovery: string }
export interface ExternalStartIdentity { workflow: WorkflowIdentity; native?: NativeIdentity }
export interface AdmissionCandidate {
  task: TaskSpec;
  taskRevision: number | null;
  repositoryRevision: number;
  recipeSummaryRevision: number;
  settingsRevision: number;
  stateToken: string;
  prepared: PreparedStart;
  proposedRotation: RotationCursor | null;
}
export interface AdmissionLease { repositoryId: string; taskId: string; attemptId: string; fence: number; active: boolean }
export interface Reservation {
  id: string;
  status: 'pending' | 'confirmed' | 'released';
  task: TaskRecord;
  attempt: Attempt;
  quota: { dayKey: string; confirmedDayKey?: string };
  lease: AdmissionLease;
  proposedRotation: RotationCursor | null;
  externalIdentity?: ExternalStartIdentity;
}
export interface AdmissionState {
  token: string;
  settings: Settings;
  repositories: Repository[];
  tags: Tag[];
  recipes: RecipeSummary[];
  recipeReadiness: RecipeReadiness[];
  tasks: TaskRecord[];
  grants: Grant[];
  rotations: Record<string, RotationState>;
  repositoryService: Record<string, number>;
  recipeService: Record<string, number>;
  activeLeases: AdmissionLease[];
  quota: QuotaState;
}
export interface AdmissionRecords { attempts: Attempt[]; attention: AttentionRequest[] }
