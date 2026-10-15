# AgentOps

**See every agent you are running, from every provider, in one live field.**

AgentOps is a local-first viewer. Agents report what they are doing to a server
on your own machine, and each one becomes a star in a constellation — lit while
it works, joined by lines when it hands work to another, flaring when it reaches
a verdict. Claude Code, Codex, OpenCode, a Gemini script, an OpenRouter job, a
bash loop: anything that can make an HTTP request can appear.

It orchestrates nothing and launches nothing. It receives, and it draws.

```
                    ·  researcher
      planner ●──────────→ ● implementer
                 ⋯⋯⋯⋯          │
                               ↓
                          ● reviewer   ◉ ← verdict flare
```

**[▶ Watch a 53-second demo](docs/demo.mp4)** — six agents across four
providers, spawning, handing off, reaching verdicts and asking for a decision.

> **Handing this to a coding agent?** Point it at **[AGENTS.md](AGENTS.md)**.
> It gets the thing installed, running, verified, and reporting on its own.

---

## Quickstart

Needs **Node 24+** (the server uses the built-in `node:sqlite`).

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The field is empty until something reports.

Make yourself a star:

```bash
curl -s localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"me","action":"hello","status":"running"}'
```

That is the whole setup. No account, no key, no registration step — an actor
exists the moment it reports.

---

## Point your agent at it

**Say this to your agent:**

> Read http://127.0.0.1:4317/README.md and report your session to AgentOps as
> you work.

Or paste the [Agent instructions](#agent-instructions) below into its context.

---

## The contract

`POST /ingest` with a JSON object. **Two fields are required.**

```json
{ "actor": "claude-code", "action": "tool_call" }
```

| Field      | Required | What it means                                                       |
| ---------- | -------- | ------------------------------------------------------------------- |
| `actor`    | **yes**  | Who acted. One star in the field.                                   |
| `action`   | **yes**  | What it did. Free-form: `tool_call`, `review`, `spawn`, `reply`.    |
| `session`  | no       | The conversation this belongs to. Groups the field and the filters. |
| `provider` | no       | `claude`, `openai`, `google`, `opencode`, `openrouter`, …           |
| `target`   | no       | Another actor you handed work to. **Draws a handoff edge.**         |
| `parent`   | no       | The actor that spawned you. **Draws a spawn edge.**                 |
| `summary`  | no       | The one line a human should read. This is what the column shows.    |
| `status`   | no       | `running`, `ok`, `error`, `blocked`.                                |
| `verdict`  | no       | Free-form: `approve`, `reject`, `needs-fixes`, `pass`, …            |
| `issues`   | no       | `[{ description, severity?, path?, line? }]`                        |
| `detail`   | no       | Anything else. Unknown top-level keys land here too.                |

Send several at once with `{"events": [ … ]}` (up to 100).

**Responses**

- `202` — all accepted.
- `207` — some accepted; the body names each rejected entry and why.
- `400` / `413` — nothing was stored.

A partial batch is never silently dropped. The body tells you exactly which
index failed and what was wrong with it.

---

## What shows up where

- **A star** appears for every `actor`. It is lit by recent events, and stays
  fully lit while its latest `status` is `running`. It leaves the field 30
  minutes after its last event.
- **An edge** is drawn from `parent` → actor (spawn) and from actor → `target`
  (handoff). If you send neither, consecutive actors in one `session` are joined
  by a fainter dashed line — that one is derived from ordering, not reported, so
  it is drawn as weaker evidence.
- **A card** in the right-hand column appears for anything with a `verdict`, or
  a `status` of `blocked` or `error`. It shows your `summary` line, your
  `issues`, and your `detail`. Ordinary steps stay in the field and do not
  clutter the column.
- **Waiting** is marked on a blocked card until some later event in the same
  session moves on.

## Replying

A card with a `session` has a **Reply** button. It posts back into the same
session:

```json
{
  "actor": "operator",
  "action": "reply",
  "session": "…",
  "target": "…",
  "summary": "…"
}
```

Your agent sees it by reading its own session stream, which makes the viewer
two-way without AgentOps ever driving your agent:

```bash
curl -N "localhost:4317/api/events?session=my-session"
```

---

## Agent instructions

Paste this into your agent's context or project instructions.

````markdown
You have a local AgentOps viewer at http://127.0.0.1:4317. Report your work to
it so your human can watch what you are doing.

Pick a stable `session` id for this conversation and a short `actor` name for
yourself, then POST to `/ingest` as you go:

```bash
curl -s -m 2 localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"<you>","action":"<what>","session":"<session>","provider":"<claude|openai|google|…>","status":"running","summary":"<one line>"}'
```

Report:

- when you start a task — `status: "running"`
- when you finish one — `status: "ok"`, with a `summary`
- when you fail — `status: "error"`, with a `summary` saying what broke
- when you need the human — `status: "blocked"`, with a `summary` that states
  the decision you need. This is the one that gets their attention.
- when you spawn a subagent — the subagent sends `parent: "<you>"`
- when you hand off — `target: "<the other actor>"`
- when you judge something — `verdict` plus a `summary`, and `issues` if you
  have specifics

Rules:

- Never block on it. Use a short timeout and ignore failures — the viewer is
  never a dependency of your real work.
- One event per meaningful step, not per token. Batch with
  `{"events":[…]}` if you are chatty.
- Never send secrets. Credentials are stripped on arrival, but do not rely on
  that.
- Check for human replies by reading `/api/events?session=<session>`; a reply
  arrives as an event with `actor: "operator"` and `action: "reply"`.
````

---

## Configuration

| Variable            | Default       | Meaning                      |
| ------------------- | ------------- | ---------------------------- |
| `AGENTOPS_PORT`     | `4317`        | Port on 127.0.0.1.           |
| `AGENTOPS_DATA_DIR` | `~/.agentops` | Where the SQLite file lives. |

## Security

The server binds to `127.0.0.1` only, and every request must carry a `Host` of
this loopback port — that is what stops DNS rebinding. Cross-origin and
cross-site requests are refused, so a web page in your browser cannot post
events even though your own shell can.

`/ingest` deliberately needs no token: any process already running as you could
read one from `/api/bootstrap` anyway, so requiring it would buy nothing and
cost every agent a handshake. Everything else that writes still requires it.

Obvious credential shapes are stripped from strings before they are stored.
That is storage hygiene, not a security boundary — do not send secrets.

## Development

```bash
npm run dev      # server, watched
npm run dev:ui   # vite on :5173, proxying /api and /ingest
npm test         # node:test
npm run check    # typecheck + test + build — the gate CI runs
npm run format   # prettier
```

**Layout**

```
src/core/events.ts   the event model and its validation
src/db/store.ts      one append-only SQLite table
src/server/app.ts    ingest, SSE, static client
src/ui/constellation.ts  stream -> stars, edges, cards  (pure)
src/ui/components/Field.tsx  the canvas
```

Reduced motion is respected: the field renders as a still frame with arrowheads
instead of travelling particles, and loses nothing but the movement.

## License

MIT — see [LICENSE](LICENSE).
