/**
 * Settings — device-local display preferences and an honest report of the local
 * service.
 *
 * This screen owns nothing the server owns. There are no accounts, no cloud
 * sync, no billing and no remote configuration: the preferences here are stored
 * in this browser's `localStorage` and applied to the document immediately, and
 * the service card reports what this page's own location actually is.
 *
 * Two things it deliberately does *not* do: it never invents a data directory
 * (the local API has no endpoint that reports one) and it never implies that
 * log retention is configurable here (it is not — the log display preferences
 * change rendering only).
 */
import type { Bootstrap } from "../api.js";
import { useDisplayPreferences } from "../hooks.js";
import { localServiceView, type LocalServiceView } from "../management.js";
import {
  DEFAULT_PREFERENCES,
  resolveReducedMotion,
  type DisplayPreferences,
  type ReducedMotionMode,
} from "../preferences.js";
import { Button, Card, Checkbox, KeyValue, Notice, Pill } from "./Bits.js";

const MOTION_OPTIONS: {
  value: ReducedMotionMode;
  label: string;
  help: string;
}[] = [
  {
    value: "system",
    label: "Follow the operating system",
    help: "Uses your OS reduced-motion setting. This is the default.",
  },
  {
    value: "reduce",
    label: "Reduce motion on this device",
    help: "No smooth scrolling or transitions, even if the OS allows them.",
  },
  {
    value: "full",
    label: "Allow motion on this device",
    help: "Smooth scrolling and transitions, even if the OS reduces motion.",
  },
];

function locationLike(): {
  protocol: string;
  hostname: string;
  port: string;
  origin?: string;
} {
  if (typeof window === "undefined")
    return { protocol: "http:", hostname: "localhost", port: "" };
  const { protocol, hostname, port, origin } = window.location;
  return { protocol, hostname, port, origin };
}

export function SettingsView({
  bootstrap,
  error,
}: {
  /** The bootstrap payload, or `null` when the server could not be reached. */
  bootstrap: Bootstrap | null;
  error?: string | null;
}) {
  const { preferences, update, persisted } = useDisplayPreferences();
  const service: LocalServiceView = localServiceView({
    location: locationLike(),
    version: bootstrap?.version ?? null,
    reachable: bootstrap !== null,
    error: error ?? null,
  });
  const systemReduced = resolveReducedMotion({
    ...DEFAULT_PREFERENCES,
    reducedMotion: "system",
  });
  const motionApplied = resolveReducedMotion(preferences);

  const set = (patch: Partial<DisplayPreferences>) => update(patch);

  return (
    <div className="view settings-view">
      <div className="settings-intro">
        <p className="page-head__meta">
          These preferences are stored in this browser on this machine, and
          apply immediately.
        </p>
      </div>

      <Card
        title="Display"
        hint="Applied to this browser immediately and remembered here. Your operating system's own preference is respected unless you override it below."
      >
        <div className="settings-group">
          <fieldset className="settings-fieldset">
            <legend>Motion</legend>
            <div className="settings-choices">
              {MOTION_OPTIONS.map((option) => (
                <label className="settings-choice" key={option.value}>
                  <input
                    type="radio"
                    name="agentops-motion"
                    value={option.value}
                    checked={preferences.reducedMotion === option.value}
                    onChange={() => set({ reducedMotion: option.value })}
                  />
                  <span>
                    <b>{option.label}</b>
                    <span className="field__help">{option.help}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="field__help" role="status">
              {motionApplied
                ? "Motion is currently reduced: scrolling jumps straight to its target and transitions are off."
                : "Motion is currently allowed: scrolling animates and transitions run."}
              {preferences.reducedMotion === "system"
                ? ` Your operating system ${systemReduced ? "asks for reduced motion" : "does not ask for reduced motion"}.`
                : ""}
            </p>
          </fieldset>

          <fieldset className="settings-fieldset">
            <legend>Density</legend>
            <div className="settings-choices">
              {[
                {
                  value: "comfortable" as const,
                  label: "Comfortable",
                  help: "The default spacing for rows, lists and cards.",
                },
                {
                  value: "compact" as const,
                  label: "Compact",
                  help: "Tighter rows and lists, for smaller windows and long pages.",
                },
              ].map((option) => (
                <label className="settings-choice" key={option.value}>
                  <input
                    type="radio"
                    name="agentops-density"
                    value={option.value}
                    checked={preferences.density === option.value}
                    onChange={() => set({ density: option.value })}
                  />
                  <span>
                    <b>{option.label}</b>
                    <span className="field__help">{option.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Card>

      <Card
        title="Raw log display"
        hint="These change how the raw log is drawn on this device. They do not change what is recorded, and they do not configure how long records are kept."
      >
        <div className="settings-group">
          <Checkbox
            id="settings-log-wrap"
            checked={preferences.logWrap}
            onChange={(value) => set({ logWrap: value })}
            label="Wrap long log lines"
            help="Off keeps each event on one line and lets the log scroll sideways instead."
          />
          <Checkbox
            id="settings-log-timestamps"
            checked={preferences.logTimestamps}
            onChange={(value) => set({ logTimestamps: value })}
            label="Show the time of each line"
            help="The full timestamp stays available on the line either way."
          />
          <Checkbox
            id="settings-log-follow"
            checked={preferences.logFollow}
            onChange={(value) => set({ logFollow: value })}
            label="Start the log in follow mode"
            help="The default the raw log opens with. Following still pauses as soon as you scroll up."
          />
        </div>
        <p className="field__help">
          Every persisted event stays recorded in full; these are display
          preferences only.
        </p>
      </Card>

      <Card
        title="Local service"
        hint="Read from the page you are on — the server that served this client. No remote or configured address is used."
      >
        <div className="stack">
          <KeyValue
            rows={[
              ["Address", <span className="mono">{service.origin}</span>],
              ["Host", <span className="mono">{service.host}</span>],
              ["Port", <span className="mono">{service.port}</span>],
              [
                "Status",
                <Pill tone={service.statusTone} dot={false}>
                  {service.status}
                </Pill>,
              ],
              [
                "Server version",
                <span className="mono">{service.version}</span>,
              ],
            ]}
          />
          <p className="field__help">{service.statusDetail}</p>
          <Notice tone="info">
            <b>Data directory: {service.dataDirectory.label}.</b>{" "}
            {service.dataDirectory.detail}
          </Notice>
          {error ? <Notice tone="warn">{error}</Notice> : null}
        </div>
      </Card>

      <Card title="What is not here">
        <div className="stack">
          <KeyValue
            rows={[
              [
                "Accounts and sign-in",
                "none — AgentOps runs as your local user",
              ],
              ["Cloud sync", "none — records stay in the local database"],
              ["Billing", "none — there is no paid tier or usage meter"],
              [
                "Remote configuration",
                "none — the client talks only to the server that served it",
              ],
              [
                "Where these preferences live",
                "this browser's local storage, on this machine only",
              ],
            ]}
          />
          <div className="row">
            <Button
              size="sm"
              onClick={() => set({ ...DEFAULT_PREFERENCES })}
              disabled={!persisted}
            >
              Reset display preferences
            </Button>
            <span className="faint small" role="status">
              {persisted
                ? "Preferences are saved on this device."
                : "This browser refused to store preferences, so they apply to this session only."}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
