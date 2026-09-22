import { randomUUID } from "node:crypto";

export const ID_PREFIXES = {
  project: "prj",
  agent: "agt",
  template: "tpl",
  templateStage: "wst",
  run: "run",
  runStage: "rst",
  task: "tsk",
  attempt: "att",
  session: "ses",
  approval: "apr",
  review: "rev",
  shellCommand: "shc",
  testRun: "tst",
  gitSnapshot: "gts",
  artifact: "art",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Deterministic id factory for tests (keeps generated ids readable and stable in order). */
export function sequentialIdFactory(prefix = "x"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}_${String(counter).padStart(6, "0")}`;
  };
}
