/**
 * New workflow: a guided five-step flow.
 *
 *   1 Project & goal → 2 Team → 3 Plan → 4 Policy & approvals → 5 Review and start
 *
 * Each step validates on its own terms, and Back keeps everything already
 * entered (one state object, no per-step copies). Step 4's policy and security
 * acknowledgements are mandatory and never pre-checked: the flow cannot reach
 * step 5 without them.
 *
 * Creating a run still never starts it. Step 5 creates a persisted DRAFT, and
 * the draft screen's Start button is the only path that begins execution.
 */
import { useEffect, useMemo, useState } from "react";
import type { RunRecord } from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction } from "../hooks.js";
import {
  POLICY_ACKNOWLEDGEMENTS,
  WIZARD_LAST_STEP,
  WIZARD_STEPS,
  firstIncompleteStep,
  planSummary,
  roleDisplayName,
  wizardStepErrors,
  type WizardInput,
} from "../management.js";
import {
  agentStateLabel,
  formatTimestamp,
  parseConstraints,
  planRoleOptions,
  planRows,
  validateNewRunForm,
} from "../view-model.js";
import {
  Button,
  Card,
  Checkbox,
  Disclosure,
  EmptyState,
  ErrorBox,
  Field,
  KeyValue,
  Notice,
  Pill,
  Select,
  StatusMark,
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
  const [input, setInput] = useState<WizardInput>({
    projectId: initialProjectId ?? bootstrap.projects[0]?.id ?? "",
    goal: "",
    constraintsText: "",
    templateId: bootstrap.templates[0]?.id ?? "",
    roleMapping: {},
    acknowledgements: [],
  });
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<RunRecord | null>(null);
  const action = useAction(client, refreshBootstrap);

  useEffect(() => {
    setInput((current) => ({
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
        (candidate) => candidate.id === input.templateId,
      ) ?? null,
    [bootstrap.templates, input.templateId],
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
    bootstrap.projects.find((candidate) => candidate.id === input.projectId) ??
    null;
  /** The template's plan in plain words, for the Plan step's summary line. */
  const templatePlan = useMemo(
    () =>
      template
        ? planSummary(template.plan)
        : { names: [], branchCount: 0, humanGate: null },
    [template],
  );
  const templatePlanNames = templatePlan.names;
  /** Roles the current template needs that have no agent mapped yet. */
  const unmappedRoles = requiredRoles.filter(
    (role) => !input.roleMapping[role],
  );

  // Changing the template (or the enabled agents) re-derives the role list, and
  // keeps any mapping that is still valid instead of clearing the step.
  useEffect(() => {
    setInput((current) => {
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

  const context = {
    requiredRoles,
    availableAgentIds: enabledAgents.map((agent) => agent.id),
  };
  const currentStep = WIZARD_STEPS[step] ?? WIZARD_STEPS[0];

  const validateStep = (index: number): boolean => {
    const definition = WIZARD_STEPS[index];
    if (!definition) return true;
    const found = wizardStepErrors(definition.id, input, context);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const goNext = () => {
    if (!validateStep(step)) return;
    setStep((current) => Math.min(current + 1, WIZARD_LAST_STEP));
  };

  const goBack = () => {
    setErrors({});
    setStep((current) => Math.max(current - 1, 0));
  };

  const goTo = (index: number) => {
    // Forward jumps are allowed only when every step up to the target passes,
    // so the mandatory acknowledgements can never be skipped.
    if (index > step) {
      for (let cursor = step; cursor < index; cursor += 1) {
        if (!validateStep(cursor)) {
          setStep(cursor);
          return;
        }
      }
    }
    setErrors({});
    setStep(index);
  };

  const create = async () => {
    const result = validateNewRunForm(
      {
        projectId: input.projectId,
        templateId: input.templateId,
        goal: input.goal,
        constraintsText: input.constraintsText,
        roleMapping: input.roleMapping,
      },
      requiredRoles,
      context.availableAgentIds,
      agentsById,
    );
    if (!result.ok) {
      setErrors(result.errors);
      const incomplete = firstIncompleteStep(input, context);
      const index = WIZARD_STEPS.findIndex((entry) => entry.id === incomplete);
      if (index >= 0) setStep(index);
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
                Back to the flow
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
                    <span className="faint small">
                      {roleDisplayName(row.role)}
                    </span>
                    {row.branching ? (
                      <>
                        {" "}
                        <Pill tone="info" dot={false}>
                          only if review asks for changes
                        </Pill>
                      </>
                    ) : null}
                    <div className="faint small">{row.instructions}</div>
                  </li>
                ))}
              </ol>
              <Disclosure summary="Technical details">
                <KeyValue
                  rows={[
                    [
                      "Template",
                      <span className="mono">
                        {draft.templateId} v{draft.templateVersion}
                      </span>,
                    ],
                    [
                      "Stage keys",
                      <span className="mono wrap-anywhere">
                        {rows.map((row) => row.key).join(", ")}
                      </span>,
                    ],
                    [
                      "Entry stage",
                      <span className="mono">{draft.plan.entryStageKey}</span>,
                    ],
                    [
                      "Final stage",
                      <span className="mono">
                        {draft.plan.finalStageKey ?? "none"}
                      </span>,
                    ],
                  ]}
                />
              </Disclosure>
            </div>

            <div>
              <h3>Policy</h3>
              <ul className="policy-list">
                <li>
                  <b>Verification is required.</b> The project's commands run
                  and their result is recorded.
                </li>
                <li>
                  <b>Your final approval is required.</b> No agent can close
                  this run.
                </li>
                <li>
                  <b>The run stops on failure.</b>
                </li>
                <li>
                  <b>AgentOps performs read-only git actions</b> for this run.
                </li>
                <li>
                  <b>
                    Up to {draft.policy.maxReviewCycles} review cycle
                    {draft.policy.maxReviewCycles === 1 ? "" : "s"}.
                  </b>
                </li>
              </ul>
              {draft.policy.verificationCommands.length === 0 ? (
                <Notice tone="warn">
                  This run has no verification commands. Verification stages
                  will record an unavailable outcome rather than a pass.
                </Notice>
              ) : null}
              <Disclosure summary="Technical details">
                <div className="stack">
                  <KeyValue
                    rows={[
                      [
                        "Require verification",
                        <span className="mono">
                          {String(draft.policy.requireVerification)}
                        </span>,
                      ],
                      [
                        "Final approval required",
                        <span className="mono">
                          {String(draft.policy.finalApprovalRequired)}
                        </span>,
                      ],
                      [
                        "Stop on failure",
                        <span className="mono">
                          {String(draft.policy.stopOnFailure)}
                        </span>,
                      ],
                      [
                        "Git policy",
                        <span className="mono">{draft.policy.gitPolicy}</span>,
                      ],
                      [
                        "Max review cycles",
                        <span className="mono">
                          {draft.policy.maxReviewCycles}
                        </span>,
                      ],
                      ["Stopping rule", draft.policy.stoppingRule],
                    ]}
                  />
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
                  ) : null}
                </div>
              </Disclosure>
            </div>

            <div>
              <h3>Team</h3>
              <div className="statline">
                {Object.entries(draft.roleMapping).map(([role, agentId]) => (
                  <span key={role}>
                    {roleDisplayName(role)}:{" "}
                    <b>{agentsById[agentId] ?? agentId}</b>
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
    <div className="view view--wide wizard">
      <ol className="wizard__steps" aria-label="Workflow steps">
        {WIZARD_STEPS.map((entry, index) => (
          <li key={entry.id}>
            <button
              type="button"
              className="wizard__step"
              data-state={
                index === step ? "current" : index < step ? "done" : "todo"
              }
              aria-current={index === step ? "step" : undefined}
              onClick={() => goTo(index)}
            >
              <b aria-hidden="true">{index + 1}</b>
              {entry.label}
            </button>
          </li>
        ))}
      </ol>

      <Card
        title={`${step + 1} · ${currentStep.label}`}
        hint={currentStep.hint}
      >
        <div className="stack">
          {currentStep.id === "project" ? (
            <>
              <div className="grid grid--forms">
                <Field
                  label="Registered project"
                  htmlFor="newrun-project"
                  error={errors["projectId"]}
                >
                  <Select
                    id="newrun-project"
                    value={input.projectId}
                    onChange={(value) =>
                      setInput({ ...input, projectId: value })
                    }
                    options={bootstrap.projects.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.name,
                    }))}
                  />
                </Field>
              </div>
              <Field
                label="Goal"
                htmlFor="newrun-goal"
                error={errors["goal"]}
                help="What should the run accomplish in this repository?"
              >
                <TextArea
                  id="newrun-goal"
                  rows={3}
                  value={input.goal}
                  onChange={(value) => setInput({ ...input, goal: value })}
                  placeholder="e.g. Add a deterministic fixture workflow test for the review loop"
                />
              </Field>
              <Field
                label="Add any limits the agents should follow"
                htmlFor="newrun-constraints"
                help="One per line. Leave this empty if there are none."
              >
                <TextArea
                  id="newrun-constraints"
                  rows={4}
                  value={input.constraintsText}
                  onChange={(value) =>
                    setInput({ ...input, constraintsText: value })
                  }
                  placeholder={
                    "Do not modify files outside src/ui\nDo not add dependencies"
                  }
                />
              </Field>
            </>
          ) : null}

          {currentStep.id === "team" ? (
            <>
              <p className="faint small">
                Choose who builds and who reviews. The workflow template decides
                which roles exist; you can change it on the next step.
              </p>
              {requiredRoles.length === 0 ? (
                <p className="faint small">
                  Select a workflow template to see the roles that need an
                  agent.
                </p>
              ) : (
                <div className="grid grid--forms">
                  {requiredRoles.map((role) => (
                    <Field
                      key={role}
                      label={roleDisplayName(role)}
                      htmlFor={`newrun-role-${role}`}
                      error={errors[`roleMapping.${role}`]}
                    >
                      <Select
                        id={`newrun-role-${role}`}
                        value={input.roleMapping[role] ?? ""}
                        onChange={(value) =>
                          setInput({
                            ...input,
                            roleMapping: {
                              ...input.roleMapping,
                              [role]: value,
                            },
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
                  ))}
                </div>
              )}
              {enabledAgents.length === 0 ? (
                <Notice tone="warn">
                  No enabled agents are configured. Add one (a mock agent is
                  enough to exercise the workflow offline) before creating a
                  run.
                </Notice>
              ) : null}
              {errors["roleMapping"] ? (
                <Notice tone="warn">{errors["roleMapping"]}</Notice>
              ) : null}
            </>
          ) : null}

          {currentStep.id === "plan" ? (
            <>
              <Field
                label="Workflow template"
                htmlFor="newrun-template"
                error={errors["templateId"]}
                help={
                  template
                    ? template.description
                    : "The template decides the stages this run will follow."
                }
              >
                <Select
                  id="newrun-template"
                  value={input.templateId}
                  onChange={(value) =>
                    setInput({ ...input, templateId: value })
                  }
                  options={bootstrap.templates.map((candidate) => ({
                    value: candidate.id,
                    label: `${candidate.name} (v${candidate.version})`,
                  }))}
                />
              </Field>
              {template ? (
                <div className="stack--tight">
                  <div className="plan-flow">
                    {templatePlanNames.map((name, index) => (
                      <span key={`${name}-${index}`}>
                        {name}
                        {index < templatePlanNames.length - 1 ? " → " : ""}
                      </span>
                    ))}
                  </div>
                  <p className="faint small">
                    {templatePlan.branchCount > 0
                      ? "Fix and re-verification stages stay dormant unless a review asks for changes, and are bounded by the review cycle limit."
                      : "No branching stages: this plan runs straight through."}
                    {templatePlan.humanGate
                      ? ` The run ends at ${templatePlan.humanGate.toLowerCase()}, which only you can pass.`
                      : ""}
                  </p>
                  {unmappedRoles.length > 0 ? (
                    <p className="faint small">
                      This template also needs{" "}
                      {unmappedRoles.map(roleDisplayName).join(", ")} — the Team
                      step will ask for{" "}
                      {unmappedRoles.length === 1 ? "it" : "them"}.
                    </p>
                  ) : null}
                  <Disclosure summary="Technical details">
                    <div className="stack">
                      <KeyValue
                        rows={[
                          [
                            "Template ID",
                            <span className="mono">{template.id}</span>,
                          ],
                          [
                            "Version",
                            <span className="mono">{template.version}</span>,
                          ],
                          [
                            "Entry stage",
                            <span className="mono">
                              {template.plan.entryStageKey}
                            </span>,
                          ],
                          [
                            "Final stage",
                            <span className="mono">
                              {template.plan.finalStageKey ?? "none"}
                            </span>,
                          ],
                        ]}
                      />
                      <ol
                        className="stack--tight"
                        style={{ margin: 0, paddingLeft: 18 }}
                      >
                        {planRows(template.plan).map((row) => (
                          <li key={row.key}>
                            <b>{row.name}</b>{" "}
                            <span className="faint small mono">
                              {row.key} · {row.kind} · role {row.role}
                            </span>
                            {row.branching ? (
                              <>
                                {" "}
                                <Pill tone="info" dot={false}>
                                  branch
                                </Pill>
                              </>
                            ) : null}
                            <div className="faint small">
                              {row.instructions}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </Disclosure>
                </div>
              ) : null}
            </>
          ) : null}

          {currentStep.id === "policy" ? (
            <>
              <ul className="policy-list">
                <li>
                  <b>Verification is required.</b> This project's verification
                  commands run and their result is recorded.
                </li>
                <li>
                  <b>You approve the final result.</b> No agent can close this
                  run; the last gate is always human.
                </li>
                <li>
                  <b>The run stops on failure</b> instead of continuing past a
                  failed stage.
                </li>
                <li>
                  <b>AgentOps only performs read-only git actions</b> for this
                  run. It never commits or pushes on its own.
                </li>
                {template ? (
                  <li>
                    <b>
                      Up to {template.defaultMaxReviewCycles} review cycle
                      {template.defaultMaxReviewCycles === 1 ? "" : "s"}.
                    </b>{" "}
                    Fix attempts are bounded by that budget.
                  </li>
                ) : null}
              </ul>
              <div className="wizard__ack">
                {POLICY_ACKNOWLEDGEMENTS.map((entry) => (
                  <Checkbox
                    key={entry.id}
                    id={`newrun-ack-${entry.id}`}
                    checked={input.acknowledgements.includes(entry.id)}
                    onChange={(checked) =>
                      setInput({
                        ...input,
                        acknowledgements: checked
                          ? [...input.acknowledgements, entry.id]
                          : input.acknowledgements.filter(
                              (value) => value !== entry.id,
                            ),
                      })
                    }
                    label={entry.label}
                    help={entry.detail}
                  />
                ))}
              </div>
              {errors["acknowledgements"] ? (
                <Notice tone="warn">{errors["acknowledgements"]}</Notice>
              ) : null}
              <Disclosure summary="Technical details">
                <KeyValue
                  rows={[
                    [
                      "Max review cycles",
                      <span className="mono">
                        {template ? template.defaultMaxReviewCycles : "UNKNOWN"}
                      </span>,
                    ],
                    [
                      "Require verification",
                      <span className="mono">true</span>,
                    ],
                    [
                      "Final approval required",
                      <span className="mono">true</span>,
                    ],
                    ["Stop on failure", <span className="mono">true</span>],
                    ["Git policy", <span className="mono">read-only</span>],
                    [
                      "Verification commands",
                      <span className="mono">
                        {project
                          ? `${project.verificationCommands.length} from the project`
                          : "UNKNOWN"}
                      </span>,
                    ],
                  ]}
                />
              </Disclosure>
            </>
          ) : null}

          {currentStep.id === "review" ? (
            <>
              <KeyValue
                rows={[
                  ["Project", project?.name ?? input.projectId],
                  ["Goal", input.goal.trim() || "not entered"],
                  [
                    "Limits",
                    parseConstraints(input.constraintsText).length === 0
                      ? "No additional constraints"
                      : parseConstraints(input.constraintsText).join(" · "),
                  ],
                  ["Plan", template ? template.name : "not selected"],
                  [
                    "Team",
                    requiredRoles
                      .map((role) => {
                        const agentId = input.roleMapping[role] ?? "";
                        const agent =
                          agentsById[agentId] ?? (agentId || "unassigned");
                        if (role === "implementer") return `${agent} builds`;
                        if (role === "reviewer") return `${agent} reviews`;
                        return `${roleDisplayName(role)}: ${agent}`;
                      })
                      .join(" · ") || "no roles mapped",
                  ],
                  [
                    "Policy",
                    `${input.acknowledgements.length} of ${POLICY_ACKNOWLEDGEMENTS.length} confirmations given`,
                  ],
                ]}
              />
              <p className="faint small">
                Creating the draft writes the run record with this plan and
                policy frozen. It does not start anything: the next screen shows
                the draft and its own Start button.
              </p>
            </>
          ) : null}

          {action.error ? <ErrorBox error={action.error} /> : null}

          <div className="wizard__nav">
            <Button variant="ghost" onClick={goBack} disabled={step === 0}>
              Back
            </Button>
            {step < WIZARD_LAST_STEP ? (
              <Button variant="primary" onClick={goNext}>
                Continue
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={create}
                disabled={action.pending || !template}
              >
                {action.pending ? "Creating draft…" : "Create draft run"}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
