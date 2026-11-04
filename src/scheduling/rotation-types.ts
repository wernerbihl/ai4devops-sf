/** Internal independent priorities; callers bump revision for any entry change. */
export interface WeightSnapshot {
  readonly revision: number;
  readonly entries: readonly {
    readonly tagId: string;
    readonly value: number;
    readonly createdOrder: number;
  }[];
}

export interface RotationQuota {
  readonly tagId: string;
  readonly quota: number;
}

/** JSON-serializable position for the next automatic start, committed by the caller. */
export interface RotationCursor {
  readonly weightsVersion: number;
  readonly cycleQuotas: readonly RotationQuota[];
  readonly tagIndex: number;
  readonly remainingQuota: number;
}

export interface RotationChoice {
  readonly tagId: string;
  readonly cursorAfterStart: RotationCursor;
}
