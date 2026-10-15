/**
 * The field: a canvas of stars, edges and flowing handoffs.
 *
 * Everything drawn here is a projection of `foldConstellation`. The canvas adds
 * only time: particle phase, the breath on an idle star, and the easing that
 * carries a star from its old position to its new one when the layout changes.
 * It never adds a fact.
 *
 * With reduced motion the same field renders as a still frame — arrowheads
 * instead of travelling particles, no breath, no easing — so nothing is lost
 * but the movement.
 */
import { useEffect, useRef, useState } from "react";
import type { EventRecord } from "../../core/events.js";
import {
  foldConstellation,
  hash,
  type ConstellationState,
  type Star,
} from "../constellation.js";
import { reducedMotionNow, subscribeSystemMotion } from "../preferences.js";

/** How often the canvas re-folds the stream. Drawing runs every frame. */
const FOLD_INTERVAL_MS = 120;
/** Still-frame cadence when the operator has reduced motion. */
const STILL_INTERVAL_MS = 1_000;
/** How fast a star eases toward a new layout position, per frame. */
const EASE = 0.08;
/** Pointer distance, in CSS pixels, that counts as hovering a star. */
const HOVER_RADIUS = 26;

export interface Palette {
  bg: string;
  well: string;
  text: string;
  text2: string;
  providers: string[];
  ok: string;
  warn: string;
  danger: string;
  info: string;
}

/**
 * The field has its own colour system, and it is the only coloured surface in
 * the app.
 *
 * These are deliberately NOT the CSS status tokens. The chrome around the
 * canvas is greyscale, so those tokens are a luminance ramp — the wrong thing
 * to paint a star with. The field is a dark sky with room for hue, so it
 * spends hue on identity (which provider) and on verdict (what happened),
 * while luminance stays free to mean activity.
 *
 * Tuned for pure black: saturated enough to separate at a glance, light
 * enough that a dim star is still legibly its own colour.
 */
const FIELD_COLORS = {
  providers: [
    "#e8955c", // warm
    "#4fd1a5", // teal
    "#6ea8ff", // blue
    "#c98bff", // violet
    "#ff7a85", // coral
  ],
  ok: "#4fd1a5",
  warn: "#f4c15d",
  danger: "#ff7a85",
  info: "#6ea8ff",
} as const;

/** Each known provider keeps one hue, so a star's colour is stable. */
const PROVIDER_SLOTS: Record<string, number> = {
  claude: 0,
  anthropic: 0,
  openai: 1,
  chatgpt: 1,
  codex: 1,
  google: 2,
  gemini: 2,
  opencode: 3,
  hermes: 3,
  openrouter: 4,
  deepseek: 4,
};

/**
 * The backdrop and type colours come from the theme — that is what keeps the
 * canvas sitting in the same black as the chrome around it. The hues do not.
 */
export function readPalette(element: Element | null): Palette {
  const fallback: Palette = {
    bg: "#0b0b0b",
    well: "#000000",
    text: "#f5f5f5",
    text2: "#9e9e9e",
    providers: [...FIELD_COLORS.providers],
    ok: FIELD_COLORS.ok,
    warn: FIELD_COLORS.warn,
    danger: FIELD_COLORS.danger,
    info: FIELD_COLORS.info,
  };
  if (!element || typeof getComputedStyle !== "function") return fallback;
  const style = getComputedStyle(element);
  const token = (name: string, fromFallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value.length > 0 ? value : fromFallback;
  };
  return {
    ...fallback,
    bg: token("--bg", fallback.bg),
    well: token("--well", fallback.well),
    text: token("--text", fallback.text),
    text2: token("--text-2", fallback.text2),
  };
}

export function providerColor(
  provider: string | null,
  actor: string,
  palette: Palette,
): string {
  const key = (provider ?? "").toLowerCase();
  const slot = PROVIDER_SLOTS[key];
  if (slot !== undefined) return palette.providers[slot]!;
  const seed = provider ? hash(provider) : hash(actor);
  return palette.providers[seed % palette.providers.length]!;
}

export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  return hex.startsWith("rgb")
    ? hex.replace(
        /^rgba?\(([^)]+)\)$/,
        (_match, inner: string) =>
          `rgba(${inner
            .split(/[\s,/]+/)
            .slice(0, 3)
            .join(", ")}, ${clamped})`,
      )
    : hex;
}

/** A point on the bowed curve an edge is drawn along. */
function curvePoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const midX = (from.x + to.x) / 2 + (to.y - from.y) * 0.12;
  const midY = (from.y + to.y) / 2 - (to.x - from.x) * 0.12;
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * midX + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * midY + t * t * to.y,
  };
}

function drawBackdrop(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: Palette,
  time: number,
): void {
  const vignette = context.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.8,
  );
  vignette.addColorStop(0, palette.bg);
  vignette.addColorStop(1, palette.well);
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  // Nebula: three slow, very low-alpha washes. They drift only when motion is
  // allowed, and at this alpha they read as depth rather than as content.
  // Nebula: three slow, very low-alpha washes in the field's own hues. At this
  // alpha they read as depth, never as content.
  const clouds = [
    { hue: palette.info, x: 0.26, y: 0.3, r: 0.55 },
    { hue: palette.providers[3]!, x: 0.74, y: 0.64, r: 0.6 },
    { hue: palette.ok, x: 0.56, y: 0.2, r: 0.42 },
  ];
  clouds.forEach((cloud, index) => {
    const drift = time === 0 ? 0 : Math.sin(time * 0.06 + index * 2.1) * 0.02;
    const cx = (cloud.x + drift) * width;
    const cy = (cloud.y - drift * 0.6) * height;
    const radius = cloud.r * Math.max(width, height) * 0.5;
    const wash = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    wash.addColorStop(0, withAlpha(cloud.hue, 0.07));
    wash.addColorStop(1, withAlpha(cloud.hue, 0));
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
  });

  // Two dust layers at different depths; the nearer one drifts twice as fast,
  // which is what reads as parallax.
  for (const layer of [
    { count: 130, alpha: 0.1, size: 0.6, speed: 0.4 },
    { count: 70, alpha: 0.2, size: 1.1, speed: 1 },
  ]) {
    context.fillStyle = withAlpha(palette.text2, layer.alpha);
    for (let index = 0; index < layer.count; index += 1) {
      const seed = hash(`dust-${layer.count}-${index}`);
      const baseX = (seed % 1000) / 1000;
      const baseY = ((seed >>> 10) % 1000) / 1000;
      const shift = time === 0 ? 0 : (time * 0.004 * layer.speed) % 1;
      const x = ((baseX + shift) % 1) * width;
      const y = baseY * height;
      context.beginPath();
      context.arc(x, y, layer.size, 0, Math.PI * 2);
      context.fill();
    }
  }
}

export function draw(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: ConstellationState,
  palette: Palette,
  /** Eased on-screen positions, in unit coordinates. */
  positions: Map<string, { x: number; y: number }>,
  /** Seconds since mount; 0 when motion is reduced. */
  time: number,
  hovered: string | null,
): void {
  const at = (actor: string) => {
    const point = positions.get(actor);
    return point ? { x: point.x * width, y: point.y * height } : null;
  };

  drawBackdrop(context, width, height, palette, time);

  for (const edge of state.edges) {
    const from = at(edge.from);
    const to = at(edge.to);
    if (!from || !to) continue;
    const star = state.stars.find((candidate) => candidate.actor === edge.to);
    const color = providerColor(star?.provider ?? null, edge.to, palette);
    // A `sequence` edge is derived from ordering rather than reported, so it
    // is drawn as the faintest of the three.
    const strength =
      edge.kind === "sequence" ? 0.3 : edge.kind === "spawn" ? 0.7 : 1;
    const alpha = edge.weight * strength;

    context.save();
    if (edge.kind === "sequence") context.setLineDash([3, 6]);
    const gradient = context.createLinearGradient(from.x, from.y, to.x, to.y);
    gradient.addColorStop(0, withAlpha(color, alpha * 0.18));
    gradient.addColorStop(1, withAlpha(color, alpha * 0.75));
    context.strokeStyle = gradient;
    context.lineWidth = 1.2 + edge.weight * 2;
    const mid = curvePoint(from, to, 0.5);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.quadraticCurveTo(
      mid.x * 2 - (from.x + to.x) / 2,
      mid.y * 2 - (from.y + to.y) / 2,
      to.x,
      to.y,
    );
    context.stroke();
    context.restore();

    if (time === 0) {
      // Still frame: an arrowhead carries the direction the particles would.
      const tip = curvePoint(from, to, 0.62);
      const tail = curvePoint(from, to, 0.5);
      const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
      context.fillStyle = withAlpha(color, alpha * 0.9);
      context.beginPath();
      context.moveTo(tip.x, tip.y);
      context.lineTo(
        tip.x - Math.cos(angle - 0.4) * 7,
        tip.y - Math.sin(angle - 0.4) * 7,
      );
      context.lineTo(
        tip.x - Math.cos(angle + 0.4) * 7,
        tip.y - Math.sin(angle + 0.4) * 7,
      );
      context.closePath();
      context.fill();
      continue;
    }

    // Flowing handoff: dots travel source → target. Busier edges carry more.
    const count = 1 + Math.round(edge.weight * 3);
    const phase = (hash(`${edge.from}>${edge.to}`) % 1000) / 1000;
    const speed = 0.16 + edge.weight * 0.2;
    for (let index = 0; index < count; index += 1) {
      const t = (time * speed + phase + index / count) % 1;
      const point = curvePoint(from, to, t);
      // Fade in and out at the ends so dots appear to leave and arrive rather
      // than blink into existence on top of a star.
      const ends = Math.sin(t * Math.PI);
      context.fillStyle = withAlpha(color, alpha * ends * 0.95);
      context.beginPath();
      context.arc(point.x, point.y, 1.6 + edge.weight * 1.4, 0, Math.PI * 2);
      context.fill();
    }
  }

  for (const star of state.stars) {
    const point = at(star.actor);
    if (!point) continue;
    const { x, y } = point;
    const color = providerColor(star.provider, star.actor, palette);
    const lit = star.activity;
    const breath = time === 0 ? 0 : Math.sin(time * 1.1 + hash(star.actor));
    const isHovered = hovered === star.actor;

    const glowRadius = 14 + lit * 34 + breath * 2;
    const glow = context.createRadialGradient(x, y, 0, x, y, glowRadius);
    glow.addColorStop(0, withAlpha(color, 0.34 + lit * 0.42));
    glow.addColorStop(0.5, withAlpha(color, (0.12 + lit * 0.2) * 0.6));
    glow.addColorStop(1, withAlpha(color, 0));
    context.fillStyle = glow;
    context.beginPath();
    context.arc(x, y, glowRadius, 0, Math.PI * 2);
    context.fill();

    // Bloom on the core, so an active agent genuinely glows rather than just
    // being a brighter dot.
    context.save();
    context.shadowColor = withAlpha(color, 0.9);
    context.shadowBlur = 10 + lit * 22;
    context.fillStyle = withAlpha(palette.text, 0.75 + lit * 0.25);
    context.beginPath();
    context.arc(x, y, 3 + lit * 2.4 + (isHovered ? 1.4 : 0), 0, Math.PI * 2);
    context.fill();
    context.restore();

    if (star.live) {
      const pulse = time === 0 ? 0.5 : (Math.sin(time * 2) + 1) / 2;
      context.strokeStyle = withAlpha(color, 0.2 + pulse * 0.4);
      context.lineWidth = 1.4;
      context.beginPath();
      context.arc(x, y, 14 + pulse * 6, 0, Math.PI * 2);
      context.stroke();
    }

    // Error and blocked are the two states worth interrupting for, and they
    // are told apart by the ring's pattern rather than its colour: blocked is
    // broken (waiting on something), errored is closed.
    if (star.status === "error" || star.status === "blocked") {
      context.save();
      if (star.status === "blocked") context.setLineDash([3, 4]);
      context.strokeStyle = withAlpha(
        star.status === "error" ? palette.danger : palette.warn,
        0.85,
      );
      context.lineWidth = star.status === "error" ? 2 : 1.4;
      context.beginPath();
      context.arc(x, y, 9.5, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }

    context.font =
      '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = withAlpha(
      palette.text,
      isHovered ? 1 : 0.5 + lit * 0.5,
    );
    context.fillText(star.actor, x, y + 16);
    if (star.provider) {
      context.font =
        '11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      context.fillStyle = withAlpha(color, 0.5 + lit * 0.4);
      context.fillText(star.provider, x, y + 31);
    }
  }

  for (const flare of state.flares) {
    const point = at(flare.actor);
    if (!point) continue;
    const tone =
      flare.tone === "success"
        ? palette.ok
        : flare.tone === "warn"
          ? palette.warn
          : flare.tone === "danger"
            ? palette.danger
            : palette.info;
    const fade = 1 - flare.progress;
    const radius = 12 + flare.progress * 74;
    context.save();
    // The shape of the flare is the verdict: a dashed ring asks for something,
    // a doubled ring is a failure, a single quiet ring is a pass.
    if (flare.tone === "warn") context.setLineDash([5, 5]);
    context.strokeStyle = withAlpha(tone, fade * 0.9);
    context.lineWidth = (flare.tone === "danger" ? 2 : 1) + fade * 1.8;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.stroke();
    if (flare.tone === "danger") {
      context.lineWidth = 1 + fade;
      context.beginPath();
      context.arc(point.x, point.y, radius * 0.72, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }

  if (hovered) {
    const star = state.stars.find((candidate) => candidate.actor === hovered);
    const point = at(hovered);
    if (star && point) drawTooltip(context, width, star, point, palette);
  }
}

function drawTooltip(
  context: CanvasRenderingContext2D,
  width: number,
  star: Star,
  point: { x: number; y: number },
  palette: Palette,
): void {
  const lines = [
    star.lastAction,
    star.lastSummary ?? "",
    `${star.events} event${star.events === 1 ? "" : "s"}${
      star.session ? ` · ${star.session}` : ""
    }`,
  ].filter((line) => line.length > 0);
  context.font =
    '12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
  const widest = Math.min(
    280,
    Math.max(...lines.map((line) => context.measureText(line).width)) + 20,
  );
  const boxHeight = lines.length * 16 + 12;
  // Flipped to the left near the right edge so the box never leaves the field.
  const left = Math.min(point.x + 16, width - widest - 8);
  const top = point.y - boxHeight - 12;

  context.fillStyle = withAlpha(palette.well, 0.92);
  context.strokeStyle = withAlpha(palette.text2, 0.25);
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(left, Math.max(6, top), widest, boxHeight, 8);
  context.fill();
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "top";
  lines.forEach((line, index) => {
    context.fillStyle = withAlpha(palette.text, index === 0 ? 0.95 : 0.6);
    let text = line;
    while (context.measureText(text).width > widest - 20 && text.length > 1)
      text = `${text.slice(0, -2)}…`;
    context.fillText(text, left + 10, Math.max(6, top) + 6 + index * 16);
  });
}

export function Field({
  events,
  session,
  onSelectActor,
}: {
  events: readonly EventRecord[];
  session: string | null;
  onSelectActor: (actor: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ events, session });
  latest.current = { events, session };
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hovered;
  // Turning reduced motion on or off re-runs the effect below, so the field
  // switches between the animated loop and the still frame immediately rather
  // than on the next reload.
  const [reduced, setReduced] = useState(reducedMotionNow);
  useEffect(
    () => subscribeSystemMotion(() => setReduced(reducedMotionNow())),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const palette = readPalette(document.documentElement);
    let width = 0;
    let height = 0;
    let state: ConstellationState | null = null;
    let lastFold = 0;
    const started = Date.now();
    /** Eased on-screen positions, so a layout change glides instead of jumping. */
    const positions = new Map<string, { x: number; y: number }>();
    const pointer = { x: -1, y: -1, inside: false };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const settle = (next: ConstellationState) => {
      for (const star of next.stars) {
        const current = positions.get(star.actor);
        if (!current || reduced) {
          positions.set(star.actor, { x: star.x, y: star.y });
          continue;
        }
        current.x += (star.x - current.x) * EASE;
        current.y += (star.y - current.y) * EASE;
      }
      for (const actor of [...positions.keys()])
        if (!next.stars.some((star) => star.actor === actor))
          positions.delete(actor);
    };

    const pick = (next: ConstellationState): string | null => {
      if (!pointer.inside) return null;
      let closest: string | null = null;
      let best = HOVER_RADIUS;
      for (const star of next.stars) {
        const point = positions.get(star.actor);
        if (!point) continue;
        const distance = Math.hypot(
          point.x * width - pointer.x,
          point.y * height - pointer.y,
        );
        if (distance < best) {
          best = distance;
          closest = star.actor;
        }
      }
      return closest;
    };

    const render = () => {
      const now = Date.now();
      if (!state || now - lastFold >= FOLD_INTERVAL_MS) {
        state = foldConstellation({
          events: latest.current.events,
          session: latest.current.session,
          now,
        });
        lastFold = now;
      }
      settle(state);
      const over = pick(state);
      if (over !== hoveredRef.current) {
        hoveredRef.current = over;
        setHovered(over);
        canvas.style.cursor = over ? "pointer" : "default";
      }
      draw(
        context,
        width,
        height,
        state,
        palette,
        positions,
        reduced ? 0 : (now - started) / 1000,
        over,
      );
    };

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside = true;
    };
    const onLeave = () => {
      pointer.inside = false;
    };
    const onClick = () => onSelectActor(hoveredRef.current);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);

    resize();
    render();

    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            resize();
            render();
          })
        : null;
    observer?.observe(canvas);

    const teardown = () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      observer?.disconnect();
    };

    if (reduced) {
      const timer = window.setInterval(render, STILL_INTERVAL_MS);
      return () => {
        window.clearInterval(timer);
        teardown();
      };
    }

    let frame = window.requestAnimationFrame(function loop() {
      render();
      frame = window.requestAnimationFrame(loop);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      teardown();
    };
  }, [onSelectActor, reduced]);

  return (
    <canvas
      className="field__canvas"
      ref={canvasRef}
      role="img"
      aria-label="Live field of reporting agents. The activity column lists everything they reported."
    />
  );
}
