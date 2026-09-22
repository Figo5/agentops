/**
 * Run history: the durable record of every run, filtered the way an operator
 * actually looks for one.
 *
 * Two layers, and they are labelled as such:
 *  - five quick filters (Needs me, Failed, Completed, Today, This week) that
 *    narrow the rows the server just returned, and
 *  - "More filters" — the full persisted search (goal, project, agent, status,
 *    branch, verdict and a created-date range) that is sent to the server.
 *
 * Every filter the previous layout exposed is still here and still server-side.
 * What is gone is the raw `GET /api/runs?…` echo: the same facts are stated in
 * words. Run ids, templates and raw timestamps live in each row's collapsed
 * technical disclosure instead of the main line.
 */
import { useCallback, useMemo, useState } from "react";
import type { AgentOpsClient, Bootstrap, RunSearchParams } from "../api.js";
import { useResource } from "../hooks.js";
import {
  QUICK_FILTERS,
  filterByQuickFilters,
  historyRowView,
  searchSummary,
  type QuickFilterId,
} from "../management.js";
import {
  ALL_REVIEW_VERDICTS,
  ALL_RUN_STATUSES,
  EMPTY_RUN_SEARCH,
  buildRunSearchParams,
  type RunSearchForm,
} from "../view-model.js";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorBox,
  Field,
  KeyValue,
  Loading,
  Pill,
  Select,
  StatusMark,
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
  const [quick, setQuick] = useState<QuickFilterId[]>([]);
  const [version, setVersion] = useState(0);

  const params: RunSearchParams = useMemo(
    () => buildRunSearchParams(submitted),
    [submitted],
  );

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
    setQuick([]);
    setVersion((current) => current + 1);
  }, []);

  const returned = results.data ?? [];
  const rows = useMemo(
    () =>
      filterByQuickFilters(returned, quick).map((run) =>
        historyRowView(run, { projectNames, agentNames }),
      ),
    [returned, quick, projectNames, agentNames],
  );

  const activeFilters = searchSummary(submitted, projectNames, agentNames);
  const advancedCount = activeFilters.length;

  const toggleQuick = (id: QuickFilterId) =>
    setQuick((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );

  return (
    <div className="view view--wide">
      <Card
        title="Filters"
        actions={
          <>
            <Button size="sm" onClick={submit}>
              Search
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Clear all
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
        hint="Start with a quick filter, or narrow the list by hand."
      >
        <div className="hist-filters">
          <div className="hist-quick" role="group" aria-label="Quick filters">
            {QUICK_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className="chip"
                title={filter.hint}
                aria-pressed={quick.includes(filter.id)}
                onClick={() => toggleQuick(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <Disclosure
            summary={
              advancedCount > 0
                ? `More filters (${advancedCount} active)`
                : "More filters"
            }
          >
            <div className="stack">
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
              <p className="faint small">
                {advancedCount === 0
                  ? "No extra filters."
                  : `Filtering by ${activeFilters.join(" · ")}.`}
              </p>
            </div>
          </Disclosure>

          {/* The Results card already carries the count; this line only adds the
              quick-filter narrowing when one is active. */}
          {quick.length > 0 ? (
            <p className="hist-count">
              {`${rows.length} of ${returned.length} runs · ${quick
                .map(
                  (id) =>
                    QUICK_FILTERS.find((filter) => filter.id === id)?.label ??
                    id,
                )
                .join(" · ")}`}
            </p>
          ) : null}
        </div>
      </Card>

      <ErrorBox error={results.error} onRetry={() => void results.reload()} />

      <Card
        title={
          <>
            Results{" "}
            <Pill tone={rows.length > 0 ? "active" : "muted"} dot={false}>
              {results.data ? rows.length : results.loading ? "…" : 0}
            </Pill>
          </>
        }
      >
        {results.loading && !results.data ? (
          <Loading label="Querying runs…" />
        ) : null}
        {results.data && rows.length === 0 ? (
          <EmptyState title="No runs match these filters">
            <p>Relax a filter, or start a new workflow from the navigation.</p>
          </EmptyState>
        ) : null}
        {results.data && rows.length > 0 ? (
          <div className="list">
            {rows.map((row) => (
              <div className="list__row hist-row" key={row.id}>
                <div className="list__goal">
                  <b>
                    <a href={`#/run/${row.id}`}>{row.goal}</a>
                  </b>
                  <span className="list__meta">
                    <span>{row.project}</span>
                    <span aria-hidden="true">·</span>
                    <span>{row.when}</span>
                    <span aria-hidden="true">·</span>
                    <span>updated {row.updated}</span>
                    <span aria-hidden="true">·</span>
                    <span>{row.duration}</span>
                    <span aria-hidden="true">·</span>
                    <span className="mono">{row.branch}</span>
                    <span aria-hidden="true">·</span>
                    <span>{row.agents}</span>
                  </span>
                  <Disclosure summary="Technical details">
                    <KeyValue
                      rows={row.technical.map(([key, value]) => [
                        key,
                        <span className="mono wrap-anywhere">{value}</span>,
                      ])}
                    />
                  </Disclosure>
                </div>
                <div className="list__right">
                  <span className="hist-row__outcome">
                    <StatusMark status={row.status} label={row.outcomeWord} />
                    {row.outcomeDetail ? (
                      <span className="faint small">{row.outcomeDetail}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {results.data && results.data.length >= 200 ? (
          <p className="faint small">
            The local API returns at most 200 runs per query; narrow the filters
            to see older records.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
