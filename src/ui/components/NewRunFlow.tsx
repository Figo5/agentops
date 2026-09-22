/**
 * New workflow flow: choose project -> choose template -> enter goal and
 * constraints -> map roles to agents -> create a DRAFT -> review the frozen plan
 * -> start explicitly.
 *
 * Creating a run never starts it. The draft is a persisted record, and the
 * Start button is the only path that begins execution.
 */
import { useEffect, useMemo, useState } from "react";
import type { RunRecord } from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction } from "../hooks.js";
import {
  agentStateLabel,
  formatTimestamp,
  parseConstraints,
  planRoleOptions,
  planRows,
  validateNewRunForm,
  type NewRunForm,
} from "../view-model.js";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Notice,
  Pill,
  Select,
  TextArea,
} from "./Bits.js";

export function NewRunFlow({
  client,
  bootstrap,
  initialProjectId,
  refreshBootstrap,
}: {
  client: AgentOpsClient;
  bootstrap: Bootstrap;
  initialProjectId: string | null;
  refreshBootstrap: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<NewRunForm>({
    projectId: initialProjectId ?? bootstrap.projects[0]?.id ?? "",
    templateId: bootstrap.templates[0]?.id ?? "",
    goal: "",
    constraintsText: "",
    roleMapping: {},
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<RunRecord | null>(null);
  const action = useAction(client, refreshBootstrap);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      projectId:
        current.projectId ||
        initialProjectId ||
        bootstrap.projects[0]?.id ||
        "",
      templateId: current.templateId || bootstrap.templates[0]?.id || "",
    }));
  }, [bootstrap.projects, bootstrap.templates, initialProjectId]);

  const template = useMemo(
    () =>
      bootstrap.templates.find(
        (candidate) => candidate.id === form.templateId,
      ) ?? null,
    [bootstrap.templates, form.templateId],
  );
  const requiredRoles = useMemo(
    () =>
      template ? planRoleOptions(template.plan).map((entry) => entry.role) : [],
    [template],
  );
  const enabledAgents = useMemo(
    () => bootstrap.agents.filter((agent) => agent.enabled),
    [bootstrap.agents],
  );
  const agentsById = useMemo(
    () =>
      Object.fromEntries(
        bootstrap.agents.map((agent) => [agent.id, agent.name]),
      ),
    [bootstrap.agents],
  );
  const project =
    bootstrap.projects.find((candidate) => candidate.id === form.projectId) ??
    null;

  useEffect(() => {
    setForm((current) => {
      const next: Record<string, string> = {};
      for (const role of requiredRoles) {
        const existing = current.roleMapping[role];
        next[role] =
          existing && enabledAgents.some((agent) => agent.id === existing)
            ? existing
            : "";
      }
      return { ...current, roleMapping: next };
    });
    setErrors({});
  }, [
    requiredRoles.join("|"),
    enabledAgents.map((agent) => agent.id).join("|"),
  ]);

  if (bootstrap.projects.length === 0) {
    return (
      <div className="view view--wide">
        <EmptyState
          title="Register a project first"
          steps={[
            { label: "Add a project", done: false },
            { label: "Configure agents", done: bootstrap.agents.length > 0 },
            { label: "Start a workflow", done: false },
          ]}
          action={
            <Button
              variant="primary"
              onClick={() => (window.location.hash = "#/projects")}
            >
              Go to projects
            </Button>
          }
        >
          <p>
            A run is always bound to one registered repository root.
            Registration also validates the verification commands.
          </p>
        </EmptyState>
      </div>
    );
  }

  const create = async () => {
    const result = validateNewRunForm(
      form,
      requiredRoles,
      enabledAgents.map((agent) => agent.id),
      agentsById,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const created = await action.run((c) => c.createRun(result.value));
    if (created) setDraft(created);
  };

  const start = async () => {
    if (!draft) return;
    const started = await action.run((c) => c.startRun(draft.id));
    if (started) window.location.hash = `#/run/${draft.id}`;
  };

  if (draft) {
    const rows = planRows(draft.plan);
    return (
      <div className="view view--wide">
        <Card
          title={
            <>
              Draft created <Pill tone="muted">{draft.status}</Pill>
            </>
          }
          hint="The plan and policy below were frozen into the run record. Editing the template or the project later will not change this run."
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Discard draft view
              </Button>
              <Button
                size="sm"
                onClick={() => (window.location.hash = `#/run/${draft.id}`)}
              >
                Open run view
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="statline">
              <span>
                goal: <b>{draft.goal}</b>
              </span>
              <span>
                project: <b>{project?.name ?? draft.projectId}</b>
              </span>
              <span>
                root: <b className="mono">{draft.projectRoot}</b>
              </span>
              <span>
                created: <b>{formatTimestamp(draft.createdAt)}</b>
              </span>
            </div>
            {draft.constraints.length > 0 ? (
              <ul
                className="stack--tight"
                style={{ margin: 0, paddingLeft: 18 }}
              >
                {draft.constraints.map((constraint) => (
                  <li key={constraint}>{constraint}</li>
                ))}
              </ul>
            ) : (
              <p className="faint small">
                No constraints were recorded for this run.
              </p>
            )}

            <div>
              <h3>Frozen plan</h3>
              <ol
                className="stack--tight"
                style={{ margin: "8px 0 0", paddingLeft: 18 }}
              >
                {rows.map((row) => (
                  <li key={row.key}>
                    <b>{row.name}</b>{" "}
                    <span className="faint small mono">
                      {row.kind} · role {row.role}
                    </span>
                    {row.branching ? (
                      <>
                        {" "}
                        <Pill tone="info" dot={false}>
                          branch · activated by review
                        </Pill>
                      </>
                    ) : null}
                    <div className="faint small">{row.instructions}</div>
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <h3>Policy snapshot</h3>
              <div className="statline">
                <span>
                  max review cycles: <b>{draft.policy.maxReviewCycles}</b>
                </span>
                <span>
                  require verification:{" "}
                  <b>{String(draft.policy.requireVerification)}</b>
                </span>
                <span>
                  final approval required:{" "}
                  <b>{String(draft.policy.finalApprovalRequired)}</b>
                </span>
                <span>
                  stop on failure: <b>{String(draft.policy.stopOnFailure)}</b>
                </span>
                <span>
                  git policy: <b>{draft.policy.gitPolicy}</b>
                </span>
              </div>
              <p className="faint small">{draft.policy.stoppingRule}</p>
              {draft.policy.verificationCommands.length > 0 ? (
                <ul
                  className="stack--tight"
                  style={{ margin: 0, paddingLeft: 18 }}
                >
                  {draft.policy.verificationCommands.map((command) => (
                    <li key={command.name} className="mono small">
                      {command.name}: {command.executable}{" "}
                      {JSON.stringify(command.args)}
                    </li>
                  ))}
                </ul>
              ) : (
                <Notice tone="warn">
                  This run has no verification commands. Verification stages
                  will record an unavailable outcome rather than a pass.
                </Notice>
              )}
            </div>

            <div>
              <h3>Role mapping</h3>
              <div className="statline">
                {Object.entries(draft.roleMapping).map(([role, agentId]) => (
                  <span key={role}>
                    {role}: <b>{agentsById[agentId] ?? agentId}</b>
                  </span>
                ))}
              </div>
            </div>

            {action.error ? <ErrorBox error={action.error} /> : null}

            <div className="row">
              <Button
                variant="primary"
                onClick={start}
                disabled={action.pending}
              >
                {action.pending ? "Starting…" : "Start run"}
              </Button>
              <span className="faint small">
                Starting launches the first agent-backed stage. The run still
                stops at every human gate.
              </span>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="view view--wide grid" style={{ gap: 18 }}>
      <div className="grid grid--split">
        <Card title="1 · Project">
          <Field
            label="Registered project"
            htmlFor="newrun-project"
            error={errors["projectId"]}
          >
            <Select
              id="newrun-project"
              value={form.projectId}
              onChange={(value) => setForm({ ...form, projectId: value })}
              options={bootstrap.projects.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
              }))}
            />
          </Field>
          {project ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <span className="faint small mono wrap-anywhere">
                {project.canonicalRoot}
              </span>
              <div className="row row--tight">
                <Pill tone="info" dot={false}>
                  vcs {project.vcs}
                </Pill>
                <Pill tone="muted" dot={false}>
                  {project.verificationCommands.length} verification commands
                </Pill>
                {project.verificationCommands.length === 0 ? (
                  <Pill tone="warn">no verification configured</Pill>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>

        <Card
          title="2 · Template"
          hint="Templates are seeded by the server. The plan below is what gets frozen into the run."
        >
          <Field
            label="Workflow template"
            htmlFor="newrun-template"
            error={errors["templateId"]}
          >
            <Select
              id="newrun-template"
              value={form.templateId}
              onChange={(value) => setForm({ ...form, templateId: value })}
              options={bootstrap.templates.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.name} (v${candidate.version})`,
              }))}
            />
          </Field>
          {template ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <p className="card__hint">{template.description}</p>
              <ol
                className="stack--tight"
                style={{ margin: 0, paddingLeft: 18 }}
              >
                {planRows(template.plan).map((row) => (
                  <li key={row.key}>
                    <span>{row.name}</span>{" "}
                    <span className="faint small mono">
                      {row.kind} · {row.role}
                    </span>
                    {row.branching ? (
                      <>
                        {" "}
                        <Pill tone="info" dot={false}>
                          branch
                        </Pill>
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
              <p className="faint small">
                Branch stages (fix / re-verification) are dormant until a review
                verdict asks for fixes, and are bounded by the review cycle
                limit.
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      <Card title="3 · Goal and constraints">
        <div className="stack">
          <Field
            label="Goal"
            htmlFor="newrun-goal"
            error={errors["goal"]}
            help="What should the run accomplish in this repository?"
          >
            <TextArea
              id="newrun-goal"
              rows={3}
              value={form.goal}
              onChange={(value) => setForm({ ...form, goal: value })}
              placeholder="e.g. Add a deterministic fixture workflow test for the review loop"
            />
          </Field>
          <Field
            label="Constraints (one per line)"
            htmlFor="newrun-constraints"
            help="Sent verbatim in every prompt packet. Empty lines are dropped."
          >
            <TextArea
              id="newrun-constraints"
              rows={4}
              value={form.constraintsText}
              onChange={(value) => setForm({ ...form, constraintsText: value })}
              placeholder={
                "Do not modify files outside src/ui\nDo not add dependencies"
              }
            />
          </Field>
          <p className="faint small">
            {parseConstraints(form.constraintsText).length} constraint(s)
            recorded.
          </p>
        </div>
      </Card>

      <Card
        title="4 · Role assignment"
        hint="Roles come from the template plan (task and review stages). Verification runs the project commands and the final acceptance gate is always human."
      >
        {requiredRoles.length === 0 ? (
          <p className="faint small">
            Select a template to see the roles that need an agent.
          </p>
        ) : (
          <div className="grid grid--forms">
            {requiredRoles.map((role) => {
              const roleStages = template
                ? planRoleOptions(template.plan).find(
                    (entry) => entry.role === role,
                  )
                : undefined;
              return (
                <Field
                  key={role}
                  label={`${role} (${roleStages?.kinds.join(", ") ?? "stage"})`}
                  htmlFor={`newrun-role-${role}`}
                  error={errors[`roleMapping.${role}`]}
                  help={
                    roleStages
                      ? `stages: ${roleStages.stageKeys.join(", ")}`
                      : undefined
                  }
                >
                  <Select
                    id={`newrun-role-${role}`}
                    value={form.roleMapping[role] ?? ""}
                    onChange={(value) =>
                      setForm({
                        ...form,
                        roleMapping: { ...form.roleMapping, [role]: value },
                      })
                    }
                    placeholder={
                      enabledAgents.length === 0
                        ? "No enabled agents"
                        : "Select an agent"
                    }
                    options={enabledAgents.map((agent) => ({
                      value: agent.id,
                      label: `${agent.name} · ${agent.adapterKind} · ${agentStateLabel(agent)}`,
                    }))}
                  />
                </Field>
              );
            })}
          </div>
        )}
        {enabledAgents.length === 0 ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">
              No enabled agents are configured. Add one (a mock agent is enough
              to exercise the workflow offline) before creating a run.
            </Notice>
          </div>
        ) : null}
      </Card>

      {action.error ? <ErrorBox error={action.error} /> : null}

      <div className="row">
        <Button
          variant="primary"
          onClick={create}
          disabled={action.pending || !template}
        >
          {action.pending ? "Creating draft…" : "Create draft run"}
        </Button>
        <span className="faint small">
          A draft is persisted but idle. Nothing is launched until you press
          Start on the draft review screen.
        </span>
      </div>

      {bootstrap.runs.length > 0 ? (
        <p className="faint small">
          Existing runs: {bootstrap.runs.length}. One executing run per project
          root — a second start on the same root is rejected by the lease.
        </p>
      ) : null}
    </div>
  );
}
