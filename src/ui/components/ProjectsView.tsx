/**
 * Projects: one project at a time, read the way an operator reads it.
 *
 * The page leads with the project itself — its name, its branch and
 * working-tree state (only when those were recorded or actually fetched) and
 * what it is doing now: the active or latest run's outcome. Recent runs and the
 * working-tree changes follow. Project settings and every storage-shaped fact
 * (canonical root, id, timestamps, command arrays) are secondary: a disclosure
 * apiece, never the first thing on the screen.
 *
 * Capabilities preserved from the previous layout: registration with the
 * absolute-path helper and duplicate detection, per-project verification
 * commands (add / remove / validate), allowed adapters, notes, the fetched
 * repository snapshot, the staged/working-tree diff, PATCH editing of the
 * mutable fields, the project's run list and the per-run "New workflow" entry.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { ProjectRecord, RunRecord } from "../../core/types.js";
import type {
  AgentOpsClient,
  Bootstrap,
  ProjectSnapshotResponse,
} from "../api.js";
import { useAction, useResource } from "../hooks.js";
import {
  projectBranchState,
  projectRunSummary,
  projectTechnicalRows,
  runOutcomeLabel,
} from "../management.js";
import {
  ADAPTER_KINDS,
  ADAPTER_LABELS,
  ADAPTER_NOTES,
  EMPTY_PROJECT_FORM,
  VERIFICATION_COMMAND_NAMES,
  classifyDiff,
  commandLine,
  emptyVerificationCommand,
  formatTimestamp,
  projectAllowedAdapters,
  projectNotes,
  projectPathHint,
  validateProjectForm,
  type ProjectForm,
} from "../view-model.js";
import {
  Button,
  Card,
  Checkbox,
  DiffView,
  Disclosure,
  ErrorBox,
  Field,
  KeyValue,
  Loading,
  Notice,
  Pill,
  Select,
  StatusMark,
  TextArea,
  TextInput,
} from "./Bits.js";

/** The resource shape the project header shares with the changes panel. */
type SnapshotResource = ReturnType<typeof useResource<ProjectSnapshotResponse>>;

function formFromProject(project: ProjectRecord): ProjectForm {
  return {
    name: project.name,
    path: project.canonicalRoot,
    vcs: project.vcs,
    notes: projectNotes(project) ?? "",
    allowedAdapters: projectAllowedAdapters(project),
    verificationCommands: project.verificationCommands.map((command) => ({
      name: command.name,
      executable: command.executable,
      argsJson: JSON.stringify(command.args),
    })),
  };
}

function VerificationCommandEditor({
  form,
  setForm,
  errors,
}: {
  form: ProjectForm;
  setForm: (form: ProjectForm) => void;
  errors: Record<string, string>;
}) {
  const idPrefix = useId();
  const update = (
    index: number,
    patch: Partial<ProjectForm["verificationCommands"][number]>,
  ) => {
    const next = form.verificationCommands.map((command, position) =>
      position === index ? { ...command, ...patch } : command,
    );
    setForm({ ...form, verificationCommands: next });
  };
  return (
    <div className="stack">
      <div className="row row--between">
        <h3>Verification commands</h3>
        <Button
          size="sm"
          onClick={() =>
            setForm({
              ...form,
              verificationCommands: [
                ...form.verificationCommands,
                emptyVerificationCommand(),
              ],
            })
          }
        >
          Add command
        </Button>
      </div>
      <p className="faint small">
        Commands run as an executable plus an argument array — never as a
        concatenated shell string. Leave the array empty for no arguments.
      </p>
      {form.verificationCommands.length === 0 ? (
        <p className="faint small">No verification commands configured.</p>
      ) : null}
      {form.verificationCommands.map((command, index) => (
        <div className="attempt" key={`${idPrefix}-${index}`}>
          <div className="grid grid--forms">
            <Field
              label="Kind"
              htmlFor={`${idPrefix}-name-${index}`}
              error={errors[`verificationCommands.${index}.name`]}
            >
              <Select
                id={`${idPrefix}-name-${index}`}
                value={command.name}
                onChange={(value) => update(index, { name: value })}
                options={VERIFICATION_COMMAND_NAMES.map((name) => ({
                  value: name,
                  label: name,
                }))}
              />
            </Field>
            <Field
              label="Executable"
              htmlFor={`${idPrefix}-exe-${index}`}
              error={errors[`verificationCommands.${index}.executable`]}
              help="e.g. npm, pnpm, make, node"
            >
              <TextInput
                id={`${idPrefix}-exe-${index}`}
                value={command.executable}
                onChange={(value) => update(index, { executable: value })}
                placeholder="npm"
              />
            </Field>
            <Field
              label="Arguments (JSON array)"
              htmlFor={`${idPrefix}-args-${index}`}
              error={errors[`verificationCommands.${index}.args`]}
              help='e.g. ["test", "--runInBand"]'
            >
              <TextInput
                id={`${idPrefix}-args-${index}`}
                value={command.argsJson}
                onChange={(value) => update(index, { argsJson: value })}
                placeholder='["test"]'
              />
            </Field>
          </div>
          <div className="row row--between" style={{ marginTop: 10 }}>
            <span className="faint small mono">
              {command.executable
                ? `${command.executable} ${command.argsJson}`
                : "—"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setForm({
                  ...form,
                  verificationCommands: form.verificationCommands.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Registration and editing.
 *
 * The path is an input only while a project is being registered: once the
 * server has canonicalised it, the root is immutable, so the edit form shows it
 * as read-only text instead of offering a field that cannot be saved.
 */
export function ProjectEditor({
  client,
  onCreated,
  refreshBootstrap,
  projects,
  editing,
}: {
  client: AgentOpsClient;
  onCreated?: (project: ProjectRecord) => void;
  refreshBootstrap: () => void | Promise<void>;
  projects: readonly ProjectRecord[];
  editing?: ProjectRecord;
}) {
  const [form, setForm] = useState<ProjectForm>(
    editing ? formFromProject(editing) : EMPTY_PROJECT_FORM,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const action = useAction(client, async () => {
    await refreshBootstrap();
  });
  const idPrefix = useId();

  useEffect(() => {
    setForm(editing ? formFromProject(editing) : EMPTY_PROJECT_FORM);
    setErrors({});
  }, [editing?.id, editing?.updatedAt]);

  const hint = projectPathHint(projects, form.path);
  const duplicate = projects.find(
    (project) =>
      project.canonicalRoot === form.path.trim() && project.id !== editing?.id,
  );

  const submit = async () => {
    const result = validateProjectForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (editing) {
      const updated = await action.run((c) =>
        c.updateProject(editing.id, result.value),
      );
      if (updated) setForm(formFromProject(updated));
      return;
    }
    const created = await action.run((c) => c.createProject(result.value));
    if (created) {
      setForm(EMPTY_PROJECT_FORM);
      onCreated?.(created);
    }
  };

  return (
    <Card
      title={
        editing ? `Project settings · ${editing.name}` : "Register a project"
      }
      hint={
        editing
          ? "Saving updates the name, verification commands, notes and allowed adapters. The canonical root and VCS kind cannot be changed."
          : "The server canonicalises the path, detects the repository and rejects an invalid root. Nothing is written outside the database."
      }
    >
      <div className="stack">
        <div className="grid grid--forms">
          <Field
            label="Project name"
            htmlFor={`${idPrefix}-name`}
            error={errors["name"]}
          >
            <TextInput
              id={`${idPrefix}-name`}
              value={form.name}
              onChange={(value) => setForm({ ...form, name: value })}
            />
          </Field>
          {editing ? (
            <Field
              label="Repository root (cannot be changed)"
              help="Immutable: the server canonicalised this path when the project was registered."
            >
              <p className="mono wrap-anywhere project-head__path">
                {editing.canonicalRoot}
              </p>
            </Field>
          ) : (
            <Field
              label="Repository path"
              htmlFor={`${idPrefix}-path`}
              error={errors["path"]}
              help={hint ?? "The absolute path to the repository root."}
            >
              <TextInput
                id={`${idPrefix}-path`}
                value={form.path}
                onChange={(value) => setForm({ ...form, path: value })}
                placeholder="/Users/you/code/project"
                invalid={Boolean(errors["path"]) || Boolean(duplicate)}
              />
            </Field>
          )}
          <Field
            label="Version control"
            htmlFor={`${idPrefix}-vcs`}
            help="Choose none for a directory that is not a repository."
          >
            <Select
              id={`${idPrefix}-vcs`}
              value={form.vcs}
              onChange={(value) =>
                setForm({ ...form, vcs: value === "none" ? "none" : "git" })
              }
              disabled={Boolean(editing)}
              options={[
                { value: "git", label: "git" },
                { value: "none", label: "none" },
              ]}
            />
          </Field>
        </div>

        {duplicate ? (
          <Notice tone="warn">
            That canonical path is already registered as <b>{duplicate.name}</b>
            . Registration would be rejected.
          </Notice>
        ) : null}

        <Field
          label="Notes"
          htmlFor={`${idPrefix}-notes`}
          help="Free text for operators. Stored with the project record."
        >
          <TextArea
            id={`${idPrefix}-notes`}
            rows={3}
            value={form.notes}
            onChange={(value) => setForm({ ...form, notes: value })}
          />
        </Field>

        <fieldset
          style={{
            border: "1px solid var(--hairline-2)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 12px",
          }}
        >
          <legend className="faint small">Allowed adapters</legend>
          <div className="grid grid--forms">
            {ADAPTER_KINDS.map((kind) => (
              <Checkbox
                key={kind}
                id={`${idPrefix}-adapter-${kind}`}
                checked={form.allowedAdapters.includes(kind)}
                onChange={(checked) =>
                  setForm({
                    ...form,
                    allowedAdapters: checked
                      ? [...form.allowedAdapters, kind]
                      : form.allowedAdapters.filter((value) => value !== kind),
                  })
                }
                label={<span className="mono">{ADAPTER_LABELS[kind]}</span>}
                help={ADAPTER_NOTES[kind]}
              />
            ))}
          </div>
        </fieldset>

        <Disclosure
          summary={
            form.verificationCommands.length > 0
              ? `Verification commands (${form.verificationCommands.length})`
              : "Verification commands (none yet)"
          }
        >
          <VerificationCommandEditor
            form={form}
            setForm={setForm}
            errors={errors}
          />
        </Disclosure>

        {action.error ? <ErrorBox error={action.error} /> : null}
        {action.notice ? <Notice tone="success">{action.notice}</Notice> : null}

        <div className="row">
          <Button variant="primary" onClick={submit} disabled={action.pending}>
            {action.pending
              ? "Saving…"
              : editing
                ? "Save project"
                : "Register project"}
          </Button>
          {editing ? (
            <Button
              variant="ghost"
              onClick={() => setForm(formFromProject(editing))}
              disabled={action.pending}
            >
              Revert changes
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** The fetched repository state: cleanliness and the real diff. */
function ChangesPanel({
  client,
  project,
  snapshot,
}: {
  client: AgentOpsClient;
  project: ProjectRecord;
  /** The snapshot the project header already fetched, reused instead of re-requesting. */
  snapshot: SnapshotResource;
}) {
  const [staged, setStaged] = useState(false);
  const diff = useResource(
    project.vcs === "git" ? () => client.projectDiff(project.id, staged) : null,
    [project.id, staged, project.vcs],
  );

  if (project.vcs !== "git") {
    return (
      <Card title="Changes">
        <Notice tone="warn">
          This project is registered without version control, so AgentOps
          records no git checkpoints, diffs or branch policy for it.
        </Notice>
      </Card>
    );
  }

  const data = snapshot.data;
  return (
    <Card
      title="Changes"
      actions={
        <Button
          size="sm"
          onClick={() => void snapshot.reload()}
          disabled={snapshot.loading}
        >
          {snapshot.loading ? "Refreshing…" : "Refresh"}
        </Button>
      }
      hint="Read from the working tree on request. Nothing is cleaned, reset or stashed."
    >
      <div className="stack">
        <ErrorBox
          error={snapshot.error}
          onRetry={() => void snapshot.reload()}
        />
        {snapshot.loading && !data ? (
          <Loading label="Reading repository state…" />
        ) : null}
        {data ? (
          <div className="project-head__state">
            <Pill tone={data.dirty ? "warn" : "success"}>
              {data.dirty ? "working tree dirty" : "working tree clean"}
            </Pill>
            <span className="faint small">
              {data.changed ? data.changed.length : "UNKNOWN"} changed ·{" "}
              {data.untracked ? data.untracked.length : "UNKNOWN"} untracked
            </span>
          </div>
        ) : null}

        <div className="row">
          <Checkbox
            checked={staged}
            onChange={setStaged}
            id="project-diff-staged"
            label="Show the staged diff (index) instead of the working tree"
          />
          <Button
            size="sm"
            onClick={() => void diff.reload()}
            disabled={diff.loading}
          >
            {diff.loading ? "Loading diff…" : "Reload diff"}
          </Button>
        </div>
        <ErrorBox error={diff.error} onRetry={() => void diff.reload()} />
        {diff.data ? (
          diff.data.diff.trim() ? (
            <DiffView lines={classifyDiff(diff.data.diff)} />
          ) : (
            <p className="faint small">
              The diff is empty — there is nothing to show for this selection.
            </p>
          )
        ) : null}
      </div>
    </Card>
  );
}

function ProjectDetail({
  client,
  project,
  runs,
  refreshBootstrap,
  projects,
}: {
  client: AgentOpsClient;
  project: ProjectRecord;
  runs: readonly RunRecord[];
  refreshBootstrap: () => void | Promise<void>;
  projects: readonly ProjectRecord[];
}) {
  const snapshot = useResource(
    project.vcs === "git" ? () => client.projectSnapshot(project.id) : null,
    [project.id, project.vcs],
  );
  const branch = projectBranchState(project, snapshot.data ?? null);
  const summary = useMemo(() => projectRunSummary(runs), [runs]);
  const idPrefix = useId();

  return (
    <div className="stack project-detail">
      <header className="page-head">
        <div className="page-head__title">
          <h2>{project.name}</h2>
          {project.archived ? <Pill tone="muted">archived</Pill> : null}
          <Pill tone="info" dot={false}>
            {branch.label}
          </Pill>
        </div>
        <p className="page-head__meta">{summary.outcome}</p>
        <div className="page-head__actions">
          <Button
            size="sm"
            onClick={() => (window.location.hash = `#/new-run/${project.id}`)}
          >
            New workflow
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (window.location.hash = "#/runs")}
          >
            All run history
          </Button>
        </div>
      </header>

      {/*
        Switching, not an inventory: a compact selector, shown only when there
        is another project to switch to. The project itself owns the width.
      */}
      {projects.length > 1 ? (
        <div className="project-switch">
          <label htmlFor={`${idPrefix}-switch`}>Switch project</label>
          <Select
            id={`${idPrefix}-switch`}
            value={project.id}
            onChange={(value) => {
              if (value && value !== project.id)
                window.location.hash = `#/projects/${value}`;
            }}
            options={projects.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            }))}
          />
        </div>
      ) : null}

      <Card
        title="Recent runs"
        hint={
          runs.length > 0
            ? undefined
            : "Nothing has run against this project yet."
        }
        actions={
          runs.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (window.location.hash = "#/runs")}
            >
              See all {runs.length}
            </Button>
          ) : undefined
        }
      >
        {runs.length > 0 ? (
          <div className="list">
            {runs.slice(0, 6).map((run) => (
              <a className="list__row" key={run.id} href={`#/run/${run.id}`}>
                <div className="list__goal">
                  <b title={run.goal}>{run.goal}</b>
                  <span className="list__meta">
                    <span>{runOutcomeLabel(run)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatTimestamp(run.createdAt)}</span>
                  </span>
                </div>
                <div className="list__right">
                  <StatusMark status={run.status} />
                </div>
              </a>
            ))}
          </div>
        ) : null}
      </Card>

      <ChangesPanel client={client} project={project} snapshot={snapshot} />

      <Disclosure className="card disclosure--card" summary="Project settings">
        <ProjectEditor
          client={client}
          projects={projects}
          refreshBootstrap={refreshBootstrap}
          editing={project}
        />
      </Disclosure>

      <Disclosure className="card disclosure--card" summary="Technical details">
        <div className="stack">
          <KeyValue
            rows={projectTechnicalRows(project, snapshot.data ?? null).map(
              ([key, value]) => [
                key,
                <span className="mono wrap-anywhere">{value}</span>,
              ],
            )}
          />
          <KeyValue
            rows={[
              [
                "Allowed adapters",
                projectAllowedAdapters(project).join(", ") || "none recorded",
              ],
              ["Notes", projectNotes(project) ?? "none"],
              [
                "Verification commands",
                project.verificationCommands.length === 0
                  ? "none configured — verification records an unavailable outcome"
                  : project.verificationCommands
                      .map(
                        (command) => `${command.name}: ${commandLine(command)}`,
                      )
                      .join(" · "),
              ],
            ]}
          />
          <p className="faint small">
            Workflow git policy governs AgentOps-issued git operations. It is
            not a sandbox around the agents you configure: those processes
            inherit your OS privileges.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

export function ProjectsView({
  client,
  bootstrap,
  selectedId,
  refreshBootstrap,
}: {
  client: AgentOpsClient;
  bootstrap: Bootstrap;
  selectedId: string | null;
  refreshBootstrap: () => void | Promise<void>;
}) {
  const projects = bootstrap.projects;
  /**
   * The selected project, or the one an operator would open first: the project
   * they asked for, otherwise the most recently updated one. `#/projects` never
   * shows an empty pane next to a single project.
   */
  const selected = useMemo(() => {
    const explicit = projects.find((project) => project.id === selectedId);
    if (explicit) return explicit;
    return (
      [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
      null
    );
  }, [projects, selectedId]);
  const runsFor = (projectId: string) =>
    [...bootstrap.runs]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (projects.length === 0) {
    return (
      <div className="view view--wide">
        <ProjectEditor
          client={client}
          projects={projects}
          refreshBootstrap={refreshBootstrap}
          onCreated={(project) => {
            window.location.hash = `#/projects/${project.id}`;
          }}
        />
      </div>
    );
  }

  const runs = selected ? runsFor(selected.id) : [];

  /*
   * One project owns the full width: its outcome, its runs and its diff are
   * what an operator came for. Switching lives in a compact selector on the
   * project itself (above), and registration stays one disclosure away.
   */
  return (
    <div className="view view--wide">
      {selected ? (
        <ProjectDetail
          client={client}
          project={selected}
          runs={runs}
          refreshBootstrap={refreshBootstrap}
          projects={projects}
        />
      ) : null}

      <Disclosure
        className="card disclosure--card"
        summary="Register another project"
      >
        <ProjectEditor
          client={client}
          projects={projects}
          refreshBootstrap={refreshBootstrap}
          onCreated={(project) => {
            window.location.hash = `#/projects/${project.id}`;
          }}
        />
      </Disclosure>
    </div>
  );
}
