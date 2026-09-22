/**
 * UI-only type aliases.
 *
 * The persisted domain records come from `src/core/types.ts`; these aliases add
 * the derived fields the server may attach to list responses. Nothing here
 * invents data — every optional field renders as an explicit absence when the
 * server does not send it.
 */
import type { RunRecord, ReviewVerdictKind } from "../core/types.js";

export type RunListRecord = RunRecord & {
  branch?: string | null;
  lastReviewVerdict?: ReviewVerdictKind | null;
};

export type { ReviewVerdictKind };
