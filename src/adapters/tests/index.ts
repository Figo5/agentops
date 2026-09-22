import {
  execute,
  type ProcessOptions,
  type ProcessResult,
} from "../shell/process.js";
export interface TestSummary {
  passed: number | null;
  failed: number | null;
  total: number | null;
  skipped?: number;
  source: string | null;
}
export function parseTestSummary(output: string): TestSummary {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const pass = clean.match(/^(?:#|ℹ) pass (\d+)\s*$/m),
    fail = clean.match(/^(?:#|ℹ) fail (\d+)\s*$/m);
  if (pass && fail) {
    const total = clean.match(/^(?:#|ℹ) tests (\d+)\s*$/m),
      skipped = clean.match(/^(?:#|ℹ) skipped (\d+)\s*$/m);
    return {
      passed: Number(pass[1]),
      failed: Number(fail[1]),
      total: total
        ? Number(total[1])
        : Number(pass[1]) +
          Number(fail[1]) +
          (skipped ? Number(skipped[1]) : 0),
      ...(skipped ? { skipped: Number(skipped[1]) } : {}),
      source: "node:test",
    };
  }
  const line = clean
    .split("\n")
    .find(
      (l) =>
        /^\s*Tests:\s/.test(l) || /^\s*Tests\s+\d+ (?:passed|failed)/.test(l),
    );
  if (line) {
    const p = line.match(/(\d+) passed/),
      f = line.match(/(\d+) failed/),
      t = line.match(/(\d+) total/) ?? line.match(/\((\d+)\)/),
      s = line.match(/(\d+) skipped/);
    if (p || f)
      return {
        passed: p ? Number(p[1]) : 0,
        failed: f ? Number(f[1]) : 0,
        total: t ? Number(t[1]) : null,
        ...(s ? { skipped: Number(s[1]) } : {}),
        source: "test summary",
      };
  }
  return { passed: null, failed: null, total: null, source: null };
}
export async function verify(
  options: ProcessOptions,
): Promise<ProcessResult & { summary: TestSummary }> {
  const result = await execute(options);
  return {
    ...result,
    summary: parseTestSummary(result.stdout + "\n" + result.stderr),
  };
}
