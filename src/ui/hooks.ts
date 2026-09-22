/**
 * React data hooks. All data comes from the local API through `../api.js`;
 * there is no sample-data fallback anywhere in this module.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord } from "../core/types.js";
import type { AgentOpsClient, Bootstrap, RunDetailResponse } from "./api.js";
import { describeError, parseSseEventFrame } from "./api.js";
import {
  attentionStateLabel,
  mergeEvents,
  runEvidenceLine,
} from "./view-model.js";

export interface AsyncResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useBootstrap(
  client: AgentOpsClient,
): AsyncResource<Bootstrap> & { reload: () => Promise<void> } {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const payload = await client.bootstrap();
      setData(payload);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export function useRunDetail(
  client: AgentOpsClient,
  runId: string | null,
  version: number,
): AsyncResource<RunDetailResponse> & { reload: () => Promise<void> } {
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    if (!runId) {
      setData(null);
      return;
    }
    const current = ++requestId.current;
    setLoading(true);
    try {
      const payload = await client.runDetail(runId);
      if (requestId.current !== current) return;
      setData(payload);
      setError(null);
    } catch (caught) {
      if (requestId.current !== current) return;
      setError(describeError(caught));
    } finally {
      if (requestId.current === current) setLoading(false);
    }
  }, [client, runId]);

  useEffect(() => {
    setData(null);
  }, [runId]);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  return { data, error, loading, reload };
}

export interface SseState {
  status: "idle" | "connecting" | "live" | "reconnecting" | "unsupported";
  events: EventRecord[];
  clear: () => void;
}

/**
 * Subscribes to `GET /api/events?runId=&afterId=`.
 *
 * Events are merged by id, so a reconnect that replays history cannot
 * double-count. `onEvent` is debounced by the caller (see `useDebouncedCallback`).
 */
export function useRunEvents(options: {
  client: AgentOpsClient;
  runId: string | null;
  afterId: number;
  enabled: boolean;
  onEvent?: (event: EventRecord) => void;
  seed?: readonly EventRecord[];
}): SseState {
  const { client, runId, afterId, enabled, onEvent, seed } = options;
  const [status, setStatus] = useState<SseState["status"]>("idle");
  const [events, setEvents] = useState<EventRecord[]>([]);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // The buffer belongs to one run: switching runs must not leak events across.
  useEffect(() => {
    setEvents([]);
  }, [runId]);

  useEffect(() => {
    if (seed && seed.length > 0)
      setEvents((current) => mergeEvents(current, seed));
  }, [seed]);

  useEffect(() => {
    if (!enabled || !runId) {
      setStatus("idle");
      return;
    }
    if (typeof EventSource === "undefined") {
      setStatus("unsupported");
      return;
    }
    setStatus("connecting");
    const source = new EventSource(client.eventsUrl(runId, afterId));
    source.onopen = () => setStatus("live");
    source.onerror = () =>
      setStatus((current) => (current === "idle" ? "idle" : "reconnecting"));
    const receive = (message: MessageEvent) => {
      const parsed = parseSseEventFrame(
        typeof message.data === "string" ? `data: ${message.data}` : "",
      );
      if (!parsed) return;
      setEvents((current) => mergeEvents(current, [parsed]).slice(-5000));
      handler.current?.(parsed);
    };
    source.addEventListener("event", receive);
    return () => {
      source.removeEventListener("event", receive);
      source.close();
      setStatus("idle");
    };
  }, [client, runId, afterId, enabled]);

  const clear = useCallback(() => setEvents([]), []);
  return { status, events, clear };
}

/** Trailing-edge debounce for refresh bursts (SSE streams arrive in floods). */
export function useDebouncedCallback(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  }, [delayMs]);
}

export interface ActionState {
  pending: boolean;
  error: string | null;
  notice: string | null;
  clear: () => void;
}

/** Wraps a write call so components get pending/error/notice without try/catch noise. */
export function useAction(
  client: AgentOpsClient,
  refresh: () => void | Promise<void>,
  successNotice?: string,
): ActionState & {
  run: <T>(
    operation: (client: AgentOpsClient) => Promise<T>,
  ) => Promise<T | null>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async <T>(
      operation: (c: AgentOpsClient) => Promise<T>,
    ): Promise<T | null> => {
      setPending(true);
      setError(null);
      try {
        const result = await operation(client);
        if (successNotice) setNotice(successNotice);
        await refresh();
        return result;
      } catch (caught) {
        setNotice(null);
        setError(describeError(caught));
        return null;
      } finally {
        setPending(false);
      }
    },
    [client, refresh, successNotice],
  );

  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { pending, error, notice, clear, run };
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Generic single-shot GET resource (project snapshot, project diff, run list). */
export function useResource<T>(
  loader: (() => Promise<T>) | null,
  deps: unknown[],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(loader));
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const current = ++requestId.current;
    const active = loaderRef.current;
    if (!active) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const payload = await active();
      if (requestId.current !== current) return;
      setData(payload);
      setError(null);
    } catch (caught) {
      if (requestId.current !== current) return;
      setError(describeError(caught));
    } finally {
      if (requestId.current === current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return useMemo(
    () => ({ data, error, loading, reload }),
    [data, error, loading, reload],
  );
}

/** What the dashboard may say about one row's evidence. Never a guess. */
export interface RunEvidenceState {
  status: "loading" | "ready" | "unavailable";
  /** The persisted evidence line, or `null` when nothing was recorded. */
  line: string | null;
  /** Row state word from the persisted gate; `null` falls back to the status. */
  state?: string | null;
}

/** How many rows the dashboard will fetch evidence for, per render. */
export const EVIDENCE_FETCH_LIMIT = 3;

/**
 * Bounded per-run evidence for the rows that need the operator.
 *
 * At most `limit` runs are fetched, one detail request each, in parallel; the
 * fetch is cancelled when the set of runs changes or the view unmounts. Every
 * outcome is reported: a row shows `loading` while its request is in flight and
 * `unavailable` when the request failed, so the dashboard never implies that a
 * missing evidence line means a clean run.
 */
export function useRunEvidence(
  client: AgentOpsClient | null,
  runIds: readonly string[],
  limit = EVIDENCE_FETCH_LIMIT,
): Record<string, RunEvidenceState> {
  const ids = runIds.slice(0, Math.max(0, limit));
  const key = ids.join("|");
  const [state, setState] = useState<Record<string, RunEvidenceState>>({});

  useEffect(() => {
    const targets = key.length === 0 ? [] : key.split("|");
    if (!client || targets.length === 0) {
      setState((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }
    let cancelled = false;
    setState(
      Object.fromEntries(
        targets.map((id) => [id, { status: "loading", line: null }]),
      ) as Record<string, RunEvidenceState>,
    );
    void Promise.all(
      targets.map(async (id): Promise<[string, RunEvidenceState]> => {
        try {
          const detail = await client.runDetail(id);
          return [
            id,
            {
              status: "ready",
              line: runEvidenceLine({
                status: detail.run.status,
                reviewCycle: detail.run.reviewCycle,
                policy: detail.run.policy,
                failureReason: detail.run.failureReason,
                interruptReason: detail.run.interruptReason,
                pendingApproval: detail.pendingApproval,
                reviewVerdicts: detail.reviewVerdicts,
                attempts: detail.attempts,
                tests: detail.tests,
                agents: detail.agents,
                events: detail.events,
              }),
              state: attentionStateLabel({
                status: detail.run.status,
                gate: detail.pendingApproval?.gate ?? null,
              }),
            },
          ];
        } catch {
          return [id, { status: "unavailable", line: null, state: null }];
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setState(Object.fromEntries(entries) as Record<string, RunEvidenceState>);
    });
    return () => {
      cancelled = true;
    };
  }, [client, key]);

  return state;
}
