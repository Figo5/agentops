/**
 * Agents: the roster and the editor.
 *
 * Honesty rules enforced here:
 *  - The roster shows *configured* state only. An installed CLI reads "CLI
 *    installed · access unchecked" and is painted neutral, never green: nothing
 *    on this screen has verified that a provider will answer.
 *  - Presets pre-fill the form; the model ID stays editable and the caveat is
 *    rendered next to the preset.
 *  - Manual handoff mode is explicit, and the Hermes one-shot switch is a
 *    separate opt-in with a warning that it bypasses the CLI's own approvals.
 *  - Adapter plumbing (executable, argument array, provider, raw config) lives
 *    behind one collapsed disclosure; the id and record timestamps are
 *    read-only, because they are not editable.
 *
 * Every control the previous layout exposed is still present: presets, name,
 * role hint, adapter kind, model, effort, mock scenario, executable, arguments,
 * provider, one-shot opt-in, enabled, manual handoff, save and revert.
 */
import { useEffect, useId, useState } from "react";
import type { AgentRecord } from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction } from "../hooks.js";
import {
  adapterDisplayName,
  agentRowView,
  agentTechnicalRows,
} from "../management.js";
import {
  ADAPTER_KINDS,
  ADAPTER_LABELS,
  ADAPTER_NOTES,
  AGENT_PRESETS,
  EMPTY_AGENT_FORM,
  MOCK_SCENARIO_VALUES,
  agentToForm,
  formatTimestamp,
  isManualAgent,
  validateAgentForm,
  type AgentForm,
  type AdapterKind,
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
  ReadinessMark,
  Select,
  TextArea,
  TextInput,
} from "./Bits.js";

export function AgentEditor({
  client,
  refreshBootstrap,
  editing,
  defaultRole,
}: {
  client: AgentOpsClient;
  refreshBootstrap: () => void | Promise<void>;
  editing?: AgentRecord;
  defaultRole?: string;
}) {
  const [form, setForm] = useState<AgentForm>(
    editing
      ? agentToForm(editing)
      : { ...EMPTY_AGENT_FORM, roleHint: defaultRole ?? "" },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idPrefix = useId();
  const action = useAction(client, refreshBootstrap);

  useEffect(() => {
    setForm(
      editing
        ? agentToForm(editing)
        : { ...EMPTY_AGENT_FORM, roleHint: defaultRole ?? "" },
    );
    setErrors({});
  }, [editing?.id, editing?.updatedAt, defaultRole]);

  const submit = async () => {
    const result = validateAgentForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (editing) {
      const updated = await action.run((c) =>
        c.updateAgent(editing.id, result.value),
      );
      if (updated) setForm(agentToForm(updated));
      return;
    }
    const created = await action.run((c) => c.createAgent(result.value));
    if (created) setForm({ ...EMPTY_AGENT_FORM, roleHint: defaultRole ?? "" });
  };

  return (
    <Card
      title={editing ? `Edit ${editing.name}` : "Configure an agent"}
      hint="An agent record is configuration: adapter kind, model string and adapter-specific config. It contains no credentials."
    >
      <div className="stack">
        <div className="field">
          <span className="field__label">Presets</span>
          <div className="row row--tight">
            {AGENT_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                size="sm"
                onClick={() =>
                  setForm({
                    ...preset.form,
                    roleHint: preset.form.roleHint || defaultRole || "",
                  })
                }
                title={preset.description}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <span className="field__help">
            Presets only fill this form. The model ID is editable and must be
            verified by you — no preset proves a CLI is installed or signed in.
          </span>
        </div>

        <div className="grid grid--forms">
          <Field
            label="Name"
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
            label="Role hint"
            htmlFor={`${idPrefix}-role`}
            help="Free text; the run maps plan roles to agent ids explicitly."
          >
            <TextInput
              id={`${idPrefix}-role`}
              value={form.roleHint}
              onChange={(value) => setForm({ ...form, roleHint: value })}
            />
          </Field>
          <Field
            label="Adapter kind"
            htmlFor={`${idPrefix}-kind`}
            error={errors["adapterKind"]}
            help={ADAPTER_NOTES[form.adapterKind]}
          >
            <Select
              id={`${idPrefix}-kind`}
              value={form.adapterKind}
              onChange={(value) =>
                setForm({ ...form, adapterKind: value as AdapterKind })
              }
              options={ADAPTER_KINDS.map((kind) => ({
                value: kind,
                label: ADAPTER_LABELS[kind],
              }))}
            />
          </Field>
          <Field
            label="Model ID"
            htmlFor={`${idPrefix}-model`}
            help="Sent to the adapter as configured. Verify it against the provider yourself."
          >
            <TextInput
              id={`${idPrefix}-model`}
              value={form.model}
              onChange={(value) => setForm({ ...form, model: value })}
            />
          </Field>
          <Field
            label="Effort"
            htmlFor={`${idPrefix}-effort`}
            help="Optional adapter hint (e.g. low, medium, high)."
          >
            <TextInput
              id={`${idPrefix}-effort`}
              value={form.effort}
              onChange={(value) => setForm({ ...form, effort: value })}
            />
          </Field>
          {form.adapterKind === "mock" ? (
            <Field
              label="Mock scenario"
              htmlFor={`${idPrefix}-scenario`}
              error={errors["scenario"]}
              help="Deterministic and local."
            >
              <Select
                id={`${idPrefix}-scenario`}
                value={form.scenario}
                onChange={(value) => setForm({ ...form, scenario: value })}
                options={MOCK_SCENARIO_VALUES.map((scenario) => ({
                  value: scenario,
                  label: scenario,
                }))}
              />
            </Field>
          ) : null}
        </div>

        <Checkbox
          id={`${idPrefix}-enabled`}
          checked={form.enabled}
          onChange={(checked) => setForm({ ...form, enabled: checked })}
          label="Enabled"
          help="Disabled agents keep their configuration but are not selectable when a run is created."
        />

        <Checkbox
          id={`${idPrefix}-manual`}
          checked={form.manual}
          onChange={(checked) => setForm({ ...form, manual: checked })}
          label="Manual handoff mode"
          help="No process is launched. The run enters an honest waiting state and a human performs the step outside AgentOps."
        />

        {/*
          Adapter plumbing is real configuration but it is not what an operator
          is usually here for, so it stays folded. Nothing is removed: the same
          fields, validation and warnings are inside.
        */}
        {form.adapterKind !== "mock" ? (
          <Disclosure summary="Advanced adapter configuration">
            <div className="stack">
              <div className="grid grid--forms">
                <Field
                  label="Executable"
                  htmlFor={`${idPrefix}-exe`}
                  error={errors["executable"]}
                  help="Launched by path lookup on your PATH. No shell interpolation."
                >
                  <TextInput
                    id={`${idPrefix}-exe`}
                    value={form.executable}
                    onChange={(value) =>
                      setForm({ ...form, executable: value })
                    }
                    placeholder={
                      form.adapterKind === "codex"
                        ? "codex"
                        : form.adapterKind === "claude-code"
                          ? "claude"
                          : "hermes"
                    }
                  />
                </Field>
                <Field
                  label="Arguments (JSON array)"
                  htmlFor={`${idPrefix}-args`}
                  error={errors["args"]}
                  help='e.g. ["--print"]'
                >
                  <TextInput
                    id={`${idPrefix}-args`}
                    value={form.argsJson}
                    onChange={(value) => setForm({ ...form, argsJson: value })}
                  />
                </Field>
                {form.adapterKind === "hermes-opencode" ? (
                  <Field
                    label="Provider"
                    htmlFor={`${idPrefix}-provider`}
                    help="Recorded in config, e.g. opencode-go."
                  >
                    <TextInput
                      id={`${idPrefix}-provider`}
                      value={form.provider}
                      onChange={(value) =>
                        setForm({ ...form, provider: value })
                      }
                    />
                  </Field>
                ) : null}
              </div>

              {form.adapterKind === "hermes-opencode" ? (
                <Checkbox
                  id={`${idPrefix}-oneshot`}
                  checked={form.allowHermesOneshot}
                  onChange={(checked) =>
                    setForm({ ...form, allowHermesOneshot: checked })
                  }
                  label={
                    <span>
                      Allow Hermes one-shot mode{" "}
                      <span className="mono">(allowHermesOneshot)</span>
                    </span>
                  }
                  help="One-shot mode makes the CLI auto-bypass its own approval prompts. AgentOps then cannot see or block those decisions. Enable this deliberately."
                />
              ) : null}

              {form.manual ? (
                <Notice tone="warn">
                  Manual handoff is selected: the executable and argument fields
                  above are ignored while this stays enabled.
                </Notice>
              ) : null}
              {form.allowHermesOneshot ? (
                <Notice tone="warn">
                  One-shot enabled. This is recorded in the agent config and is
                  visible on the agent record.
                </Notice>
              ) : null}
            </div>
          </Disclosure>
        ) : null}

        {editing ? (
          <Disclosure summary="Technical details">
            <div className="stack">
              <KeyValue
                rows={[
                  [
                    "Agent ID",
                    <span className="mono wrap-anywhere">{editing.id}</span>,
                  ],
                  [
                    "Updated",
                    <span className="mono">
                      {formatTimestamp(editing.updatedAt)}
                    </span>,
                  ],
                ]}
              />
              <h3>Raw configuration · {editing.name}</h3>
              <TextArea
                value={JSON.stringify(editing.config, null, 2)}
                onChange={() => undefined}
                ariaLabel="Agent configuration (read-only)"
                readOnly
              />
              <p className="faint small">
                Read-only. Credentials are never stored in this record and never
                rendered here.
              </p>
            </div>
          </Disclosure>
        ) : null}

        {action.error ? <ErrorBox error={action.error} /> : null}

        <div className="row">
          <Button variant="primary" onClick={submit} disabled={action.pending}>
            {action.pending
              ? "Saving…"
              : editing
                ? "Save agent"
                : "Create agent"}
          </Button>
          {editing ? (
            <Button
              variant="ghost"
              onClick={() => setForm(agentToForm(editing))}
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

export function AgentsView({
  client,
  bootstrap,
  refreshBootstrap,
}: {
  client: AgentOpsClient;
  bootstrap: Bootstrap;
  refreshBootstrap: () => void | Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = bootstrap.agents;
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !agents.some((agent) => agent.id === selectedId))
      setSelectedId(null);
  }, [agents, selectedId]);

  return (
    <div className="view view--wide">
      <Card hint="Tools the agents may use. Access is unchecked until a task actually runs.">
        {agents.length === 0 ? (
          <EmptyState title="No agents configured">
            <p>
              Create an agent below. The server seeds deterministic mock agents
              for offline workflow tests; real CLI adapters need an executable
              you have verified yourself.
            </p>
          </EmptyState>
        ) : (
          <div className="agent-list">
            {agents.map((agent) => {
              const row = agentRowView(agent);
              return (
                <div className="agent-row" key={agent.id}>
                  <span className="agent-row__glyph" aria-hidden="true">
                    {row.initial}
                  </span>
                  <div className="agent-row__text">
                    <span className="agent-row__name">
                      {row.name}
                      {isManualAgent(agent) ? (
                        <>
                          {" "}
                          <Pill tone="warn" dot={false}>
                            manual
                          </Pill>
                        </>
                      ) : null}
                    </span>
                    <span className="agent-row__meta">
                      <span>{row.role}</span>
                      <span aria-hidden="true">·</span>
                      <span>{row.secondary}</span>
                    </span>
                  </div>
                  <div className="agent-row__right">
                    <ReadinessMark
                      label={row.readiness}
                      tone={row.readinessTone}
                      title={`${adapterDisplayName(agent.adapterKind)} · configured state, access not verified`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      ariaLabel={row.editLabel}
                      onClick={() => setSelectedId(agent.id)}
                    >
                      {selectedId === agent.id ? "Editing" : "Edit"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Disclosure className="card disclosure--card" summary="How agents run">
          <div className="stack">
            <Notice tone="info">
              Configured agents run with your OS privileges. AgentOps records
              what it launches and what came back; it does not sandbox
              third-party CLIs.
            </Notice>
            {agents.some(
              (agent) => agent.config["allowHermesOneshot"] === true,
            ) ? (
              <Notice tone="warn">
                At least one agent has Hermes one-shot mode enabled. Those runs
                bypass the CLI's own approval prompts — the AgentOps approval
                gate still applies.
              </Notice>
            ) : null}
          </div>
        </Disclosure>
      </Card>

      <div className="grid grid--split">
        <AgentEditor
          client={client}
          refreshBootstrap={refreshBootstrap}
          editing={selected ?? undefined}
        />
        <Card
          title="How a run uses these records"
          hint="Roles come from the selected template plan; you map each role to one agent when the run is created."
        >
          <KeyValue
            rows={[
              [
                "Selection",
                "One enabled agent per agent-backed role (task and review stages).",
              ],
              [
                "Verification",
                "Verification stages run the project commands, not an agent.",
              ],
              [
                "Final acceptance",
                "Always a human gate; no agent can close a run.",
              ],
              [
                "Model and effort",
                "Optional strings; adapters decide how to pass them.",
              ],
              [
                "Mock agents",
                "Deterministic in-process scenarios for exercising the workflow offline.",
              ],
            ]}
          />
          {selected ? (
            <Disclosure summary={`Technical details · ${selected.name}`}>
              <KeyValue
                rows={agentTechnicalRows(selected).map(([key, value]) => [
                  key,
                  <span className="mono wrap-anywhere">{value}</span>,
                ])}
              />
            </Disclosure>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
