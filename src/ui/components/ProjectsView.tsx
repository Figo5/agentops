/**
 * Projects view: registration (with the absolute-path helper), per-project
 * verification commands, the detected snapshot and the real diff, plus PATCH
 * editing of the mutable fields.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { ProjectRecord } from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction, useResource } from "../hooks.js";
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
  relativeTime,
  text,
  validateProjectForm,
  type ProjectForm,
} from "../view-model.js";
import {
  Button,
  Card,
  Checkbox,
  CodeBlock,
  DiffView,
  Disclosure,
  EmptyState,
  ErrorBox,
  Field,
  KeyValue,
  Loading,
  Notice,
  Pill,
  Select,
  StatusPill,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
} from "./Bits.js";

const PROJECT_TABS_ID = "project-sections";

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
      title={editing ? `Edit ${editing.name}` : "Register a project"}
      hint={
        editing
          ? "PATCH updates the name, verification commands, notes and allowed adapters. The canonical root and VCS kind are immutable."
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
          <Field
            label="Absolute repository path"
            htmlFor={`${idPrefix}-path`}
            error={errors["path"]}
            help={hint ?? "Absolute path to the repository root."}
          >
            <TextInput
              id={`${idPrefix}-path`}
              value={form.path}
              onChange={(value) => setForm({ ...form, path: value })}
              placeholder="/Users/you/code/project"
              invalid={Boolean(errors["path"]) || Boolean(duplicate)}
            />
          </Field>
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
                label={<span className="mono">{kind}</span>}
                help={ADAPTER_NOTES[kind]}
              />
            ))}
          </div>
        </fieldset>

        <VerificationCommandEditor
          form={form}
          setForm={setForm}
          errors={errors}
        />

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

function SnapshotPanel({
  client,
  project,
}: {
  client: AgentOpsClient;
  project: ProjectRecord;
}) {
  const snapshot = useResource(
    project.vcs === "git" ? () => client.projectSnapshot(project.id) : null,
    [project.id, project.vcs],
  );
  const [staged, setStaged] = useState(false);
  const diff = useResource(
    project.vcs === "git" ? () => client.projectDiff(project.id, staged) : null,
    [project.id, staged, project.vcs],
  );

  if (project.vcs !== "git") {
    return (
      <Card title="Repository snapshot">
        <Notice tone="warn">
          This project is registered with{" "}
          <span className="mono">vcs: none</span>, so AgentOps records no git
          checkpoints, diffs or branch policy for it.
        </Notice>
      </Card>
    );
  }

  const data = snapshot.data;
  return (
    <Card
      title="Repository snapshot"
      actions={
        <Button
          size="sm"
          onClick={() => void snapshot.reload()}
          disabled={snapshot.loading}
        >
          {snapshot.loading ? "Refreshing…" : "Refresh snapshot"}
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
          <KeyValue
            rows={[
              ["Branch", <span className="mono">{text(data.branch)}</span>],
              [
                "HEAD",
                <span className="mono">
                  {data.head ? data.head.slice(0, 12) : "UNKNOWN"}
                </span>,
              ],
              [
                "Working tree",
                <Pill tone={data.dirty ? "warn" : "success"}>
                  {data.dirty ? "dirty" : "clean"}
                </Pill>,
              ],
              ["Changed files", data.changed ? data.changed.length : "UNKNOWN"],
              [
                "Untracked files",
                data.untracked ? data.untracked.length : "UNKNOWN",
              ],
              [
                "Insertions",
                data.insertions === null || data.insertions === undefined
                  ? "UNKNOWN"
                  : data.insertions,
              ],
              [
                "Deletions",
                data.deletions === null || data.deletions === undefined
                  ? "UNKNOWN"
                  : data.deletions,
              ],
            ]}
          />
        ) : null}
        {data?.changed && data.changed.length > 0 ? (
          <CodeBlock label="changed paths" text={data.changed.join("\n")} />
        ) : null}
        {data?.untracked && data.untracked.length > 0 ? (
          <CodeBlock label="untracked paths" text={data.untracked.join("\n")} />
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
  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const [tab, setTab] = useState("overview");
  const runs = useMemo(
    () => bootstrap.runs.filter((run) => run.projectId === selected?.id),
    [bootstrap.runs, selected?.id],
  );

  useEffect(() => {
    setTab("overview");
  }, [selectedId]);

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

  return (
    <div className="view view--wide grid" style={{ gap: 18 }}>
      <div className="grid grid--split">
        <Card
          title="Registered projects"
          hint="Select a project to inspect or edit it."
        >
          <div className="list">
            {projects.map((project) => (
              <a
                key={project.id}
                className="list__row"
                href={`#/projects/${project.id}`}
                aria-current={project.id === selectedId ? "true" : undefined}
              >
                <div className="list__goal">
                  <b>{project.name}</b>
                  <span className="list__meta">
                    <span className="mono wrap-anywhere">
                      {project.canonicalRoot}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="mono">{project.vcs}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {project.verificationCommands.length} verification
                      commands
                    </span>
                  </span>
                </div>
                <div className="list__right">
                  {project.archived ? <Pill tone="muted">archived</Pill> : null}
                  <Pill tone="info" dot={false}>
                    {project.defaultBranch
                      ? `default ${project.defaultBranch}`
                      : "branch UNKNOWN"}
                  </Pill>
                </div>
              </a>
            ))}
          </div>
        </Card>

        {selected ? (
          <Card
            title={
              <>
                {selected.name}{" "}
                {selected.archived ? <Pill tone="muted">archived</Pill> : null}
              </>
            }
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => (window.location.hash = "#/runs")}
              >
                View runs
              </Button>
            }
          >
            <Tabs
              idBase={PROJECT_TABS_ID}
              label="Project sections"
              active={tab}
              onChange={setTab}
              tabs={[
                { id: "overview", label: "Overview" },
                {
                  id: "verification",
                  label: "Verification",
                  count: selected.verificationCommands.length,
                },
                { id: "runs", label: "Runs", count: runs.length },
                { id: "edit", label: "Edit" },
              ]}
            />
            <TabPanel
              idBase={PROJECT_TABS_ID}
              id="overview"
              selected={tab === "overview"}
            >
              <div className="stack">
                <KeyValue
                  rows={[
                    ["Id", <span className="mono">{selected.id}</span>],
                    [
                      "Canonical root",
                      <span className="mono wrap-anywhere">
                        {selected.canonicalRoot}
                      </span>,
                    ],
                    ["VCS", <span className="mono">{selected.vcs}</span>],
                    [
                      "Default branch",
                      <span className="mono">
                        {text(selected.defaultBranch)}
                      </span>,
                    ],
                    [
                      "Allowed adapters",
                      projectAllowedAdapters(selected).join(", ") ||
                        "none recorded",
                    ],
                    ["Notes", projectNotes(selected) ?? "none"],
                    ["Created", formatTimestamp(selected.createdAt)],
                    [
                      "Updated",
                      `${formatTimestamp(selected.updatedAt)} (${relativeTime(selected.updatedAt)})`,
                    ],
                  ]}
                />
                <Notice tone="info">
                  Workflow git policy governs AgentOps-issued git operations. It
                  is not a sandbox around the agents you configure: those
                  processes inherit your OS privileges.
                </Notice>
              </div>
            </TabPanel>
            <TabPanel
              idBase={PROJECT_TABS_ID}
              id="verification"
              selected={tab === "verification"}
            >
              <div className="stack">
                {selected.verificationCommands.length === 0 ? (
                  <Notice tone="warn">
                    No verification commands are configured. The verification
                    stage will record an unavailable outcome rather than a pass.
                  </Notice>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Kind</th>
                        <th scope="col">Executable</th>
                        <th scope="col">Arguments</th>
                        <th scope="col">Invocation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.verificationCommands.map((command) => (
                        <tr key={`${command.name}-${command.executable}`}>
                          <td>
                            <Pill tone="info" dot={false}>
                              {command.name}
                            </Pill>
                          </td>
                          <td className="mono">{command.executable}</td>
                          <td className="mono wrap-anywhere">
                            {JSON.stringify(command.args)}
                          </td>
                          <td className="mono wrap-anywhere">
                            {commandLine(command)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="faint small">
                  Commands are configured per project. Runs snapshot this list
                  when they are created, so later edits do not change an
                  existing run's policy.
                </p>
              </div>
            </TabPanel>
            <TabPanel
              idBase={PROJECT_TABS_ID}
              id="runs"
              selected={tab === "runs"}
            >
              <div className="stack">
                {runs.length === 0 ? (
                  <p className="faint small">
                    No runs recorded for this project.
                  </p>
                ) : (
                  <div className="list">
                    {runs.map((run) => (
                      <div
                        className="list__row"
                        key={run.id}
                        style={{ cursor: "default" }}
                      >
                        <div className="list__goal">
                          <b>
                            <a href={`#/run/${run.id}`}>{run.goal}</a>
                          </b>
                          <span className="list__meta">
                            <span>{run.templateId}</span>
                            <span aria-hidden="true">·</span>
                            <span>updated {relativeTime(run.updatedAt)}</span>
                          </span>
                        </div>
                        <div className="list__right">
                          <StatusPill status={run.status} />
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() =>
                              (window.location.hash = `#/new-run/${run.projectId}`)
                            }
                          >
                            New workflow
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabPanel>
            <TabPanel
              idBase={PROJECT_TABS_ID}
              id="edit"
              selected={tab === "edit"}
            >
              <ProjectEditor
                client={client}
                projects={projects}
                refreshBootstrap={refreshBootstrap}
                editing={selected}
              />
            </TabPanel>
          </Card>
        ) : (
          <EmptyState title="No project selected">
            <p>
              Pick a project on the left, or register a new repository root.
            </p>
          </EmptyState>
        )}
      </div>

      {selected ? <SnapshotPanel client={client} project={selected} /> : null}
      {selected ? (
        <Card
          title={`Recent runs for ${selected.name}`}
          hint="Runs are unique executions; this list is persisted history, not a mock."
        >
          {runs.length === 0 ? (
            <p className="faint small">
              Nothing has run against this project yet.
            </p>
          ) : (
            <div className="list">
              {runs.slice(0, 8).map((run) => (
                <a className="list__row" key={run.id} href={`#/run/${run.id}`}>
                  <div className="list__goal">
                    <b>{run.goal}</b>
                    <span className="list__meta">
                      <span>{run.status}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatTimestamp(run.createdAt)}</span>
                    </span>
                  </div>
                  <div className="list__right">
                    <Pill tone="muted">{run.plan.stages.length} stages</Pill>
                  </div>
                </a>
              ))}
            </div>
          )}
        </Card>
      ) : null}
      {projects.length > 0 ? (
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
      ) : null}
    </div>
  );
}
