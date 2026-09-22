/**
 * Run history: persisted search over project, goal, agent, status, dates, branch
 * and verdict. The server performs the filtering (`GET /api/runs`); the UI shows
 * the exact query it issued so the result set is auditable.
 */
import { useCallback, useMemo, useState } from "react";
import type { AgentOpsClient, Bootstrap, RunSearchParams } from "../api.js";
import type { RunListRecord } from "../ui-types.js";
import { useResource } from "../hooks.js";
import {
  ALL_REVIEW_VERDICTS,
  ALL_RUN_STATUSES,
  EMPTY_RUN_SEARCH,
  buildRunSearchParams,
  formatTimestamp,
  relativeTime,
  serializeQuery,
  text,
  verdictLabel,
  verdictTone,
  type RunSearchForm,
} from "../view-model.js";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Pill,
  Select,
  StatusPill,
  TextInput,
} from "./Bits.js";

export function RunsView({
  client,
  bootstrap,
}: {
  client: AgentOpsClient;
  bootstrap: Bootstrap;
}) {
  const [form, setForm] = useState<RunSearchForm>(EMPTY_RUN_SEARCH);
  const [submitted, setSubmitted] = useState<RunSearchForm>(EMPTY_RUN_SEARCH);
  const [version, setVersion] = useState(0);

  const params: RunSearchParams = useMemo(
    () => buildRunSearchParams(submitted),
    [submitted],
  );
  const query = serializeQuery(params);

  const results = useResource(() => client.runs(params), [version, submitted]);

  const projectNames = useMemo(
    () =>
      Object.fromEntries(
        bootstrap.projects.map((project) => [project.id, project.name]),
      ),
    [bootstrap.projects],
  );
  const agentNames = useMemo(
    () =>
      Object.fromEntries(
        bootstrap.agents.map((agent) => [agent.id, agent.name]),
      ),
    [bootstrap.agents],
  );

  const submit = useCallback(() => {
    setSubmitted(form);
    setVersion((current) => current + 1);
  }, [form]);

  const reset = useCallback(() => {
    setForm(EMPTY_RUN_SEARCH);
    setSubmitted(EMPTY_RUN_SEARCH);
    setVersion((current) => current + 1);
  }, []);

  const roleAgents = (mapping: Record<string, string>) =>
    Object.entries(mapping).map(
      ([role, agentId]) => `${role}: ${agentNames[agentId] ?? agentId}`,
    );

  return (
    <div className="view view--wide">
      <Card
        title="Search persisted history"
        hint="Every filter is sent to the server. Results are durable run records, never synthetic cards."
        actions={
          <>
            <Button size="sm" onClick={submit}>
              Search
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Clear
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void results.reload()}
              disabled={results.loading}
            >
              Refresh
            </Button>
          </>
        }
      >
        <div className="grid grid--forms">
          <Field label="Goal contains" htmlFor="search-q">
            <TextInput
              id="search-q"
              value={form.q}
              onChange={(value) => setForm({ ...form, q: value })}
              placeholder="e.g. parser"
            />
          </Field>
          <Field label="Project" htmlFor="search-project">
            <Select
              id="search-project"
              value={form.projectId}
              onChange={(value) => setForm({ ...form, projectId: value })}
              placeholder="Any project"
              options={bootstrap.projects.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
            />
          </Field>
          <Field label="Agent" htmlFor="search-agent">
            <Select
              id="search-agent"
              value={form.agentId}
              onChange={(value) => setForm({ ...form, agentId: value })}
              placeholder="Any agent"
              options={bootstrap.agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              }))}
            />
          </Field>
          <Field label="Status" htmlFor="search-status">
            <Select
              id="search-status"
              value={form.status}
              onChange={(value) => setForm({ ...form, status: value })}
              placeholder="Any status"
              options={ALL_RUN_STATUSES.map((status) => ({
                value: status,
                label: status,
              }))}
            />
          </Field>
          <Field
            label="Branch"
            htmlFor="search-branch"
            help="Matched against the latest recorded git checkpoint."
          >
            <TextInput
              id="search-branch"
              value={form.branch}
              onChange={(value) => setForm({ ...form, branch: value })}
              placeholder="feature/…"
            />
          </Field>
          <Field label="Review verdict" htmlFor="search-verdict">
            <Select
              id="search-verdict"
              value={form.verdict}
              onChange={(value) => setForm({ ...form, verdict: value })}
              placeholder="Any verdict"
              options={ALL_REVIEW_VERDICTS.map((verdict) => ({
                value: verdict,
                label: verdict,
              }))}
            />
          </Field>
          <Field label="Created from" htmlFor="search-from">
            <TextInput
              id="search-from"
              type="date"
              value={form.from}
              onChange={(value) => setForm({ ...form, from: value })}
            />
          </Field>
          <Field
            label="Created to"
            htmlFor="search-to"
            help="Inclusive; the whole day is included."
          >
            <TextInput
              id="search-to"
              type="date"
              value={form.to}
              onChange={(value) => setForm({ ...form, to: value })}
            />
          </Field>
        </div>
        <p className="faint small mono wrap-anywhere" style={{ marginTop: 10 }}>
          GET /api/runs{query || " (no filters)"}
        </p>
      </Card>

      <ErrorBox error={results.error} onRetry={() => void results.reload()} />

      <Card
        title={
          <>
            Results{" "}
            <Pill
              tone={
                results.data && results.data.length > 0 ? "active" : "muted"
              }
              dot={false}
            >
              {results.data ? results.data.length : results.loading ? "…" : 0}
            </Pill>
          </>
        }
      >
        {results.loading && !results.data ? (
          <Loading label="Querying runs…" />
        ) : null}
        {results.data && results.data.length === 0 ? (
          <EmptyState title="No runs match these filters">
            <p>Relax a filter, or start a new workflow from the navigation.</p>
          </EmptyState>
        ) : null}
        {results.data && results.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Goal</th>
                <th scope="col">Project</th>
                <th scope="col">Agents</th>
                <th scope="col">Status</th>
                <th scope="col">Branch</th>
                <th scope="col">Verdict</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {results.data.map((run) => {
                const listRun = run as RunListRecord;
                return (
                  <tr key={run.id}>
                    <td className="wrap-anywhere">
                      <a href={`#/run/${run.id}`}>{run.goal}</a>
                      <div className="faint small mono">{run.id}</div>
                    </td>
                    <td>{projectNames[run.projectId] ?? run.projectId}</td>
                    <td className="small muted wrap-anywhere">
                      {roleAgents(run.roleMapping).join(" · ") || "none"}
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td className="mono">
                      {text(listRun.branch, "not recorded")}
                    </td>
                    <td>
                      {listRun.lastReviewVerdict ? (
                        <Pill
                          tone={verdictTone(listRun.lastReviewVerdict)}
                          dot={false}
                        >
                          {verdictLabel(listRun.lastReviewVerdict)}
                        </Pill>
                      ) : (
                        <span className="faint small">not recorded</span>
                      )}
                    </td>
                    <td className="small muted" title={run.createdAt}>
                      {formatTimestamp(run.createdAt)}
                    </td>
                    <td className="small muted" title={run.updatedAt}>
                      {relativeTime(run.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </Card>
    </div>
  );
}
