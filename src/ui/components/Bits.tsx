/**
 * Shared presentational primitives.
 *
 * These are intentionally dumb: no data fetching, no business rules beyond
 * presentation. All state decisions live in `../view-model.ts` or the
 * feature components.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import type { DiffLine } from "../view-model.js";
import {
  classNames,
  statusIcon,
  statusLabel,
  statusTone,
  type Tone,
} from "../view-model.js";

export function Pill({
  tone = "neutral",
  children,
  dot = true,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      className={classNames("pill", `pill--${tone}`, dot && "pill--dot")}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * A status is an icon plus a word, in the system sans at metadata scale.
 *
 * Both parts come from the payload: the glyph encodes the tone, the word is
 * the persisted state, and the raw enum stays reachable as the `title` so the
 * display copy never replaces the recorded value.
 */
export function StatusMark({
  status,
  label,
  size = "sm",
  className,
  title,
}: {
  status: string | null | undefined;
  /** Sentence-case word to show instead of the status's own label. */
  label?: string;
  size?: "sm" | "lg";
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={classNames(
        "status",
        `status--${statusTone(status)}`,
        size === "lg" && "status--lg",
        className,
      )}
      title={title ?? status ?? undefined}
    >
      <span className="status__icon" aria-hidden="true">
        {statusIcon(status)}
      </span>
      <span className="status__word">{label ?? statusLabel(status)}</span>
    </span>
  );
}

/**
 * Configured state, never liveness.
 *
 * Used where the underlying fact is "this is how the record is configured", not
 * "this succeeded". A configured or installed agent renders the neutral `○`
 * glyph and stays grey: only a *recorded problem* turns it into `!`, because
 * nothing in the UI has verified that a provider will answer.
 */
export function ReadinessMark({
  label,
  tone,
  title,
}: {
  label: string;
  tone: Tone;
  title?: string;
}) {
  return (
    <span className={classNames("status", `status--${tone}`)} title={title}>
      <span className="status__icon" aria-hidden="true">
        {tone === "danger" ? "!" : "○"}
      </span>
      <span className="status__word">{label}</span>
    </span>
  );
}

export function StatusPill({
  status,
  title,
}: {
  status: string | null | undefined;
  title?: string;
}) {
  return (
    <span
      className={classNames(
        "pill",
        "pill--status",
        `pill--${statusTone(status)}`,
      )}
      title={title ?? status ?? undefined}
    >
      <span className="status__icon" aria-hidden="true">
        {statusIcon(status)}
      </span>
      <span className="status__word">{statusLabel(status)}</span>
    </span>
  );
}

/**
 * The one consistent expander for long or technical content.
 *
 * Everything that is long (review prose, raw payloads, provenance, constraints)
 * lives behind one of these so the default view of a screen stays readable. The
 * body is rendered by the caller, so native `details` still holds the content.
 */
export function Disclosure({
  summary,
  children,
  className,
  open = false,
  onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  /** Lets a parent drive the disclosure (used when a stage click must open it). */
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className={classNames("disclosure", className)}
      open={open}
      onToggle={
        onToggle ? (event) => onToggle(event.currentTarget.open) : undefined
      }
    >
      <summary>{summary}</summary>
      <div className="disclosure__body">{children}</div>
    </details>
  );
}

/** A compact state line: icon + word + sentence, instead of a shouted banner. */
export function StateLine({
  status,
  tone,
  children,
  title,
}: {
  status?: string | null;
  tone: "accent" | "warn" | "danger" | "neutral";
  children: ReactNode;
  title?: string;
}) {
  return (
    <div
      className={classNames(
        "state-line",
        tone !== "neutral" && `state-line--${tone}`,
      )}
      role="status"
      title={title}
    >
      {status ? <StatusMark status={status} size="sm" /> : null}
      <span>{children}</span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  title,
  type = "button",
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "success" | "danger" | "ghost";
  size?: "md" | "sm";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      className={classNames(
        "btn",
        variant !== "default" && `btn--${variant}`,
        size === "sm" && "btn--sm",
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  hint,
  tight,
  elevated,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  tight?: boolean;
  /** Raised surface. Reserved for genuinely interactive objects and the single
   * human decision sheet — every other card is a flat, hairline-separated
   * section. */
  elevated?: boolean;
  id?: string;
}) {
  return (
    <section
      className={classNames(
        "card",
        tight && "card--tight",
        elevated && "card--elevated",
      )}
      id={id}
    >
      {(title || actions) && (
        <div className="card__head">
          {title ? <h2>{title}</h2> : null}
          {actions ? <div className="card__actions">{actions}</div> : null}
        </div>
      )}
      {hint ? <p className="card__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
  error,
  help,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  error?: string;
  help?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help ? <span className="field__help">{help}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  id,
  placeholder,
  invalid,
  ariaLabel,
  type = "text",
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
  ariaLabel?: string;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid ? "true" : undefined}
      autoFocus={autoFocus}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value)
      }
    />
  );
}

export function TextArea({
  value,
  onChange,
  id,
  rows,
  placeholder,
  ariaLabel,
  invalid,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  /** Truly read-only: the browser refuses edits, not just the handler. */
  readOnly?: boolean;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid ? "true" : undefined}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Select({
  value,
  onChange,
  id,
  options,
  ariaLabel,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  options: { value: string; label: string }[];
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {placeholder !== undefined ? (
        <option value="">{placeholder}</option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  help,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  id?: string;
}) {
  return (
    <div className="stack--tight">
      <label className="checkline" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {help ? <span className="field__help">{help}</span> : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  icon,
  children,
  title,
}: {
  tone?: "info" | "warn" | "error" | "success" | "accent";
  icon?: string;
  children: ReactNode;
  title?: string;
}) {
  const glyph =
    icon ??
    (tone === "error"
      ? "!"
      : tone === "success"
        ? "✓"
        : tone === "warn"
          ? "▲"
          : "i");
  const role = tone === "error" ? "alert" : "status";
  return (
    <div
      className={classNames("notice", `notice--${tone}`)}
      role={role}
      title={title}
    >
      <span className="notice__icon" aria-hidden="true">
        {glyph}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
}: {
  error: string | null | undefined;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice notice--error" role="alert">
      <span className="notice__icon" aria-hidden="true">
        !
      </span>
      <div className="stack--tight">
        <span className="wrap-anywhere">{error}</span>
        {onRetry ? (
          <span>
            <Button size="sm" onClick={onRetry}>
              Retry request
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function EmptyState({
  title,
  children,
  steps,
  action,
}: {
  title: string;
  children?: ReactNode;
  steps?: { label: string; done: boolean; onClick?: () => void }[];
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
      {steps && steps.length > 0 ? (
        <div className="empty__steps">
          {steps.map((step, index) => (
            <span className="empty__step" key={step.label}>
              <b aria-hidden="true">{index + 1}</b>
              {step.onClick ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={step.onClick}
                >
                  {step.label}
                </button>
              ) : (
                <span style={{ color: step.done ? "var(--ok)" : undefined }}>
                  {step.label}
                </span>
              )}
              {index < steps.length - 1 ? (
                <span className="empty__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([key, value], index) => (
        <div key={index} style={{ display: "contents" }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  title,
}: {
  text: string;
  label?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2200);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }, [text]);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={copy}
      title={title ?? "Copy the exact text to the clipboard"}
      disabled={text.length === 0}
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : label}
    </Button>
  );
}

/**
 * Tab list with the ARIA tabs interaction pattern.
 *
 * `idBase` is shared with the matching `TabPanel`s, so every `aria-controls`
 * resolves to a real element and every panel points back with
 * `aria-labelledby`. Roving tabindex: only the selected tab is in the tab order
 * and the arrow/Home/End keys move the selection and the focus together.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
  idBase,
  id,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  /** Id prefix shared with the matching TabPanels (required, never ad hoc). */
  idBase: string;
  /**
   * Optional id for the tab list itself, so a caller can scroll the list (and
   * the panel under it) into view when the operator explicitly opens a tab.
   */
  id?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const current = tabs.findIndex((tab) => tab.id === active);
    const index = current >= 0 ? current : 0;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `[role="tab"][data-tab-id="${target.id}"]`,
    );
    button?.focus();
  };

  return (
    <div
      className="tabs"
      id={id}
      role="tablist"
      aria-label={label}
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idBase}-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={`${idBase}-${tab.id}-panel`}
            tabIndex={selected ? 0 : -1}
            className="tab"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="tab__count">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One tab panel, present for every tab so `aria-controls` never dangles.
 *
 * A panel that is not selected is `hidden` (removed from the accessibility
 * tree). Callers render the expensive body only for the selected panel, so the
 * DOM does not grow with hidden content.
 */
export function TabPanel({
  idBase,
  id,
  selected,
  children,
  className,
}: {
  /** Must match the `idBase` passed to the controlling Tabs. */
  idBase: string;
  id: string;
  selected: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-${id}-panel`}
      aria-labelledby={`${idBase}-${id}`}
      hidden={!selected}
      className={className}
      tabIndex={selected ? 0 : -1}
    >
      {children}
    </div>
  );
}

/**
 * Two-line clamped text with an explicit expand control.
 *
 * Long goals used to stretch the run header. The text is clamped to two lines;
 * the full value stays reachable through the toggle and the `title` attribute,
 * and the toggle only appears when the text is actually clipped.
 */
export function ClampedText({
  text,
  className,
  expandLabel = "Show full goal",
  collapseLabel = "Show less",
}: {
  text: string;
  className?: string;
  expandLabel?: string;
  collapseLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    setClipped(node.scrollHeight - node.clientHeight > 1);
  }, [text, expanded]);

  return (
    <span className={classNames("clamp", className)}>
      <span
        ref={textRef}
        className={classNames("clamp__text", !expanded && "clamp__text--two")}
        title={expanded ? undefined : text}
      >
        {text}
      </span>
      {clipped || expanded ? (
        <button
          type="button"
          className="btn btn--sm btn--ghost clamp__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </span>
  );
}

export function DiffView({
  lines,
  emptyLabel = "No diff content.",
}: {
  lines: DiffLine[];
  emptyLabel?: string;
}) {
  const numbered = useMemo(
    () => lines.map((line, index) => ({ line, index })),
    [lines],
  );
  if (lines.length === 0) return <p className="faint small">{emptyLabel}</p>;
  return (
    <div className="diff">
      {numbered.map(({ line, index }) => (
        <div
          key={`${index}-${line.kind}`}
          className={classNames("diff__line", `diff__line--${line.kind}`)}
        >
          <span className="diff__no" aria-hidden="true">
            {line.leftLine ?? ""}
          </span>
          <span className="diff__no" aria-hidden="true">
            {line.rightLine ?? ""}
          </span>
          <span className="diff__text">
            {line.kind === "add"
              ? "+ "
              : line.kind === "remove"
                ? "- "
                : line.kind === "hunk"
                  ? ""
                  : "  "}
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CodeBlock({
  text,
  label,
  tall,
  copy = true,
  emptyLabel = "Nothing recorded.",
}: {
  text: string | null | undefined;
  label?: string;
  tall?: boolean;
  copy?: boolean;
  emptyLabel?: string;
}) {
  if (!text) return <p className="faint small">{emptyLabel}</p>;
  return (
    <div className="stack--tight">
      {label || copy ? (
        <div className="row row--between">
          <span className="faint small mono">{label}</span>
          {copy ? (
            <CopyButton text={text} title={`Copy ${label ?? "text"}`} />
          ) : null}
        </div>
      ) : null}
      <pre className={classNames("code", tall && "code--tall")}>{text}</pre>
    </div>
  );
}
