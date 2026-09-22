/**
 * Dashboard: compact active / waiting / recent sections plus the first-run
 * guidance chain (Add project -> Configure agents -> New workflow). Every number
 * is counted from the bootstrap payload; nothing is hard-coded.
 */
import type { Bootstrap } from "../api.js";
import {
  agentStateLabel,
  agentStateTone,
  classNames,
  homeSections,
  indexById,
  planRoleOptions,
  projectAllowedAdapters,
} from "../view-model.js";
import { Button, Card, EmptyState, Pill } from "./Bits.js";
import { RunSection } from "./RunRow.js";

export function Home({ bootstrap }: { bootstrap: Bootstrap }) {
  const projectNames = Object.fromEntries(
    bootstrap.projects.map((project) => [project.id, project.name]),
  );
  const sections = homeSections(bootstrap.runs);
  const projectById = indexById(bootstrap.projects);
  const hasProjects = bootstrap.projects.length > 0;
  const enabledAgents = bootstrap.agents.filter((agent) => agent.enabled);
  const roleGaps = bootstrap.projects.map((project) => ({
    project,
    allowed: projectAllowedAdapters(project),
  }));
  const totalStages = bootstrap.templates.reduce(
    (sum, template) => sum + template.plan.stages.length,
    0,
  );

  return (
    <div className="view view--wide home-view">
      {!hasProjects ? (
        <EmptyState
          title="No projects registered yet"
          steps={[
            { label: "Add a project", done: false },
            { label: "Configure agents", done: bootstrap.agents.length > 0 },
            { label: "Start a workflow", done: false },
          ]}
        >
          <p>
            Add a local repository, choose your agents, and give them a goal.
            Every handoff and result stays here.
          </p>
        </EmptyState>
      ) : null}

      <div className="grid grid--home">
        <RunSection
          title="Waiting for you"
          tone="accent"
          runs={sections.waiting}
          projectNames={projectNames}
          emptyLabel="Nothing is blocked on a human decision."
          hint="Approval and input gates stay open until an operator decides. The run never advances on its own."
        />
        <RunSection
          title="Active"
          tone="neutral"
          runs={sections.active}
          projectNames={projectNames}
          emptyLabel="No run is executing right now."
          hint="One active workflow per repository."
        />
        <RunSection
          title="Needs attention"
          tone="danger"
          runs={sections.failed}
          projectNames={projectNames}
          emptyLabel="No failed or interrupted runs."
          hint="Failed and interrupted runs resume only through a deliberate, reasoned retry."
        />
        <RunSection
          title="Recent"
          tone="neutral"
          runs={sections.recent}
          projectNames={projectNames}
          emptyLabel="No completed or cancelled runs yet."
          hint="Terminal runs are read-only history."
        />
      </div>

      <div className="grid grid--split">
        <Card title="Workspace">
          <div className="statline">
            <span>
              <b>{hasProjects ? bootstrap.projects.length : 0}</b> projects
            </span>
            <span>
              <b>{bootstrap.agents.length}</b> agents (
              <b>{enabledAgents.length}</b> enabled)
            </span>
            <span>
              <b>{bootstrap.templates.length}</b> templates /{" "}
              <b>{totalStages}</b> plan stages
            </span>
            <span>
              <b>{bootstrap.runs.length}</b> runs
            </span>
          </div>
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="row">
              <Button
                variant="primary"
                onClick={() => (window.location.hash = "#/new-run")}
              >
                New workflow
              </Button>
              <Button onClick={() => (window.location.hash = "#/projects")}>
                Add project
              </Button>
              <Button onClick={() => (window.location.hash = "#/agents")}>
                Configure agents
              </Button>
              <Button
                variant="ghost"
                onClick={() => (window.location.hash = "#/runs")}
              >
                Run history
              </Button>
            </div>
            <p className="faint small">
              Project commands run locally. Start with mock agents to explore
              the workflow.
            </p>
          </div>
        </Card>

        <Card
          title="Agents"
          hint="Choose models and execution tools in Agents."
        >
          {bootstrap.agents.length === 0 ? (
            <p className="faint small">
              No agents configured. The server seeds mock agents for offline
              runs; add a real preset from the Agents view and verify the model
              ID yourself.
            </p>
          ) : (
            <div className="list">
              {bootstrap.agents.map((agent) => (
                <div
                  className="list__row"
                  key={agent.id}
                  style={{ cursor: "default" }}
                >
                  <div className="list__goal">
                    <b>{agent.name}</b>
                    <span className="list__meta">
                      <span className="mono">{agent.adapterKind}</span>
                      <span aria-hidden="true">·</span>
                      <span>{agent.model ?? "model UNKNOWN"}</span>
                      {agent.roleHint ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{agent.roleHint}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="list__right">
                    <Pill tone={agentStateTone(agent)}>
                      {agentStateLabel(agent)}
                    </Pill>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Templates on this server">
          {bootstrap.templates.length === 0 ? (
            <p className="faint small">No workflow templates are seeded yet.</p>
          ) : (
            <div className="stack">
              {bootstrap.templates.map((template) => {
                const roles = planRoleOptions(template.plan);
                return (
                  <div key={template.id} className="attempt">
                    <div className="row row--between">
                      <b>{template.name}</b>
                      <Pill>
                        v{template.version}
                        {template.builtin ? " · builtin" : ""}
                      </Pill>
                    </div>
                    <p className="card__hint">{template.description}</p>
                    <div className="list__meta">
                      <span>{template.plan.stages.length} stages</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        max {template.defaultMaxReviewCycles} review cycles
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="mono">
                        roles:{" "}
                        {roles.map((role) => role.role).join(", ") || "none"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {roleGaps.some((entry) => entry.allowed.length === 0) ? (
        <p className={classNames("faint", "small")}>
          {roleGaps.filter((entry) => entry.allowed.length === 0).length}{" "}
          project(s) have no allowed adapters recorded — open the project to
          confirm which adapters the workflow policy may use.
        </p>
      ) : null}

      {Object.keys(projectById).length === 0 ? null : (
        <p className="faint small">
          Registered roots:{" "}
          {bootstrap.projects
            .map((project) => project.canonicalRoot)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
