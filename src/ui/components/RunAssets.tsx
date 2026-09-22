/**
 * Run-level assets: every artifact reference the run holds, and the measured
 * usage of every attempt.
 *
 * These are run-level (an artifact may belong to no attempt at all), so they
 * cannot live inside one stage's evidence. Listing and registration are the same
 * capabilities the run screen always had — validation included — and both stay
 * one disclosure down so the Overview stays short.
 */
import { useId, useState } from "react";
import type { ArtifactRecord } from "../../core/types.js";
import type { AgentOpsClient } from "../api.js";
import { useAction } from "../hooks.js";
import {
  EMPTY_ARTIFACT_FORM,
  artifactView,
  formatBytes,
  formatTimestamp,
  relativeTime,
  usageView,
  validateArtifactForm,
  type ArtifactForm,
} from "../view-model.js";
import { Button, ErrorBox, Field, KeyValue, Pill, TextInput } from "./Bits.js";

export function ArtifactList({ artifacts }: { artifacts: readonly ArtifactRecord[] }) {
  if (artifacts.length === 0)
    return <p className="faint small">This run has no artifacts yet.</p>;
  return (
    <div className="stack--tight">
      {artifacts.map((artifact) => {
        const view = artifactView(artifact);
        return (
          <div key={artifact.id} className="attempt">
            <div className="row row--between">
              <b className="mono wrap-anywhere">{artifact.path}</b>
              <Pill tone={artifact.exists ? "success" : "danger"}>
                {view.exists}
              </Pill>
            </div>
            <div className="faint small wrap-anywhere">
              kind {artifact.kind} · size {formatBytes(artifact.sizeBytes)} ·{" "}
              {formatTimestamp(artifact.createdAt)} (
              {relativeTime(artifact.createdAt)})
            </div>
            {artifact.note ? <p className="small">{artifact.note}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

export function ArtifactRegistration({
  client,
  runId,
  refresh,
}: {
  client: AgentOpsClient;
  runId: string;
  refresh: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<ArtifactForm>(EMPTY_ARTIFACT_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idPrefix = useId();
  const action = useAction(client, refresh);

  const submit = async () => {
    const result = validateArtifactForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const created = await action.run((c) => c.registerArtifact(runId, result.value));
    if (created) setForm(EMPTY_ARTIFACT_FORM);
  };

  return (
    <div className="stack">
      <h4>Register an artifact</h4>
      <div className="grid grid--forms">
        <Field
          label="Repository-relative path"
          htmlFor={`${idPrefix}-path`}
          error={errors["path"]}
          help="Must stay inside the project root."
        >
          <TextInput
            id={`${idPrefix}-path`}
            value={form.path}
            onChange={(value) => setForm({ ...form, path: value })}
            placeholder="reports/run.md"
          />
        </Field>
        <Field
          label="Kind"
          htmlFor={`${idPrefix}-kind`}
          error={errors["kind"]}
          help="e.g. report, patch, log"
        >
          <TextInput
            id={`${idPrefix}-kind`}
            value={form.kind}
            onChange={(value) => setForm({ ...form, kind: value })}
          />
        </Field>
      </div>
      {action.error ? <ErrorBox error={action.error} /> : null}
      <div>
        <Button size="sm" onClick={submit} disabled={action.pending}>
          {action.pending ? "Registering…" : "Register artifact"}
        </Button>
      </div>
    </div>
  );
}

export function MeasuredUsage({
  attempts,
  agents,
}: {
  attempts: {
    id: string;
    attemptNumber: number;
    stageKey: string;
    agentId: string | null;
    usage: Parameters<typeof usageView>[0];
    usageKnown: boolean;
  }[];
  agents: readonly { id: string; name: string }[];
}) {
  const rows = attempts.map((attempt) => ({
    id: attempt.id,
    label: `Attempt ${attempt.attemptNumber} · ${
      agents.find((agent) => agent.id === attempt.agentId)?.name ??
      attempt.stageKey
    }`,
    usage: usageView(attempt.usage, attempt.usageKnown),
  }));
  const known = rows.filter((row) => row.usage.known).length;
  if (rows.length === 0)
    return <p className="faint small">No attempts yet.</p>;
  return (
    <div className="stack">
      <p className="faint small">
        {known} of {rows.length} attempt
        {rows.length === 1 ? "" : "s"} report measured usage. Unknown is never
        shown as zero.
      </p>
      <div className="stack--tight">
        {rows.map((row) => (
          <KeyValue
            key={row.id}
            rows={[
              [
                row.label,
                <span className="mono">
                  {row.usage.known
                    ? `${row.usage.input} in / ${row.usage.output} out / ${row.usage.total} total`
                    : "UNKNOWN"}
                </span>,
              ],
              ["Cost", <span className="mono">{row.usage.cost}</span>],
            ]}
          />
        ))}
      </div>
    </div>
  );
}
