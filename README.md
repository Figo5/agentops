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

> **Handing this to a coding agent?** Say:
> _"Set up AgentOps from https://github.com/Figo5/agentops — read AGENTS.md and
> follow it."_ [AGENTS.md](AGENTS.md) takes it from clone to running to
> reporting, on its own.

---

## Install

Needs **Node 24 or newer** (`node --version`) — the server uses the built-in
`node:sqlite`, which older releases do not have. Plus git, npm, and macOS or
Linux. Nothing else: no account, no API key, no database to provision, and no
network call at any point.

```bash
git clone https://github.com/Figo5/agentops.git
cd agentops
npm install
npm run build
npm start
```

The last command prints `AgentOps http://127.0.0.1:4317`. Open it — the field is
empty until something reports.

### Check it works

```bash
curl -s localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"me","action":"hello","status":"running"}'
```

Expect `{"accepted":1,"rejected":[],"latestId":1}`. A star labelled `me` is now
on the field. That is the whole setup — an actor exists the moment it reports,
with no registration step.

> The `content-type: application/json` header is **required**. Without it the
> server answers `415`.

---

## Point your agent at it

Say this to any agent, in any tool:

> Report your session to AgentOps at http://127.0.0.1:4317 as you work — read
> http://127.0.0.1:4317/README.md for the contract.

The running server serves this file, so an agent that cannot reach GitHub can
still learn the contract from the thing it is reporting to. Or paste the
[Agent instructions](#agent-instructions) block below straight into its context.

---

## The contract

`POST /ingest` with a JSON object and a `content-type: application/json` header.
**Two fields are required.**

```json
{ "actor": "claude-code", "action": "tool_call" }
```

| Field      | Required | What it means                                                       | Limit      |
| ---------- | -------- | ------------------------------------------------------------------- | ---------- |
| `actor`    | **yes**  | Who acted. One star in the field.                                   | 200 chars  |
| `action`   | **yes**  | What it did. Free-form: `tool_call`, `review`, `spawn`, `reply`.    | 200 chars  |
| `session`  | no       | The conversation this belongs to. Groups the field and the filters. | 200 chars  |
| `provider` | no       | `claude`, `openai`, `google`, `opencode`, `openrouter`, …           | 80 chars   |
| `target`   | no       | Another actor you handed work to. **Draws a handoff edge.**         | 200 chars  |
| `parent`   | no       | The actor that spawned you. **Draws a spawn edge.**                 | 200 chars  |
| `summary`  | no       | The one line a human should read. This is what the column shows.    | 2000 chars |
| `status`   | no       | One of `running`, `ok`, `error`, `blocked`.                         | —          |
| `verdict`  | no       | Free-form: `approve`, `reject`, `needs-fixes`, `pass`, …            | 100 chars  |
| `issues`   | no       | `[{ description, severity?, path?, line? }]`                        | 50 entries |
| `detail`   | no       | Anything else. Unknown top-level keys land here too.                | 16 KB      |

Three things that make this forgiving:

- **Unknown keys are kept, not rejected.** Send `{"tokens": 1200}` and it comes
  back under the card's Detail. Your sender can be richer than this schema.
- **Over-long strings are truncated**, not refused. Only an oversized `detail`
  fails, because silently cutting a payload would misrepresent it.
- **`provider` accepts any string.** The names above get a fixed colour in the
  field; anything else gets a stable colour derived from its name.

### Batching

```json
{
  "events": [
    { "actor": "a", "action": "one" },
    { "actor": "b", "action": "two" }
  ]
}
```

Up to **100** events per request.

### Responses

| Code  | Meaning                                                               |
| ----- | --------------------------------------------------------------------- |
| `202` | All accepted.                                                         |
| `207` | Some accepted. The body names each rejected entry by index, with why. |
| `400` | Not a JSON object, or an empty batch. Nothing stored.                 |
| `413` | Batch over 100, or a body over 256 KB. Nothing stored.                |
| `415` | Missing `content-type: application/json`.                             |
| `403` | Blocked by the guard — see [Security](#security).                     |

A partial batch is never silently dropped:

```json
{
  "accepted": 1,
  "rejected": [
    { "index": 1, "errors": ["actor is required: name the agent that acted"] }
  ],
  "latestId": 7
}
```

### How a verdict is coloured

`verdict` is free text, matched against word families — so you do not have to
learn an enum:

| Reads as      | Words                                                       |
| ------------- | ----------------------------------------------------------- |
| **pass**      | approve, approved, accept, pass, passed, ok, success, lgtm  |
| **attention** | fix, fixes, changes, warn, warning, minor, partial, nit     |
| **failure**   | reject, rejected, fail, failed, block, blocked, error, deny |

Anything unrecognised stays neutral — never reported as a failure you did not
claim. With no `verdict`, a `status` of `error` reads as a failure and `blocked`
as attention.

---

## What shows up where

- **A star** appears for every `actor`, with no registration. It is lit by
  recent events, fading over **25 seconds**, and stays fully lit for as long as
  its latest `status` is `running`. It leaves the field **30 minutes** after its
  last event.
- **An edge** is drawn from `parent` → actor (spawn) and actor → `target`
  (handoff), fading over **30 seconds**. If you send neither, consecutive actors
  in one `session` are joined by a fainter dashed line — derived from ordering
  rather than reported, so it is drawn as weaker evidence and a reported edge
  always replaces it.
- **A card** in the right-hand column appears for anything with a `verdict`, or
  a `status` of `blocked` or `error`. It shows your `summary`, your `issues` and
  your `detail`. Ordinary steps stay in the field and never clutter the column.
  The column keeps the **14** most recent.
- **Waiting** is marked on a card that is blocked or reads as a failure, while
  it is the newest such card in its session and nothing later in that session
  has reported a status. Your agent clears it simply by reporting progress.

---

## Replying

A card with a `session` has a **Reply** button, which posts an ordinary event
back into that session — there is no special API:

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

## Endpoints

| Endpoint         | Method | What it does                                                         |
| ---------------- | ------ | -------------------------------------------------------------------- |
| `/ingest`        | POST   | One event or a batch. No token needed.                               |
| `/api/events`    | GET    | SSE stream of every event. `?session=` filters; `?afterId=` resumes. |
| `/api/bootstrap` | GET    | The 400 most recent events, the latest id, and the action token.     |
| `/README.md`     | GET    | This file, so agents can read the contract from the server.          |
| `/`              | GET    | The viewer.                                                          |

`/api/events` honours the `Last-Event-ID` header, so a dropped connection
resumes from its cursor without a gap. Each frame carries its event id.

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
  -d '{"actor":"<you>","action":"<what>","session":"<session>","provider":"<claude|openai|google|opencode|openrouter>","status":"running","summary":"<one line>"}'
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
- One event per meaningful step, not per token. Batch up to 100 with
  `{"events":[…]}` if you are chatty.
- The `content-type: application/json` header is required, or you get a 415.
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

Events persist across restarts. To start clean, stop the server and delete the
data directory.

---

## Troubleshooting

| Symptom                                      | Cause and fix                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm start` exits immediately                | Node below 24, or port 4317 already in use. Check `node --version`; set `AGENTOPS_PORT` to something free. |
| `415` from `/ingest`                         | Missing `-H 'content-type: application/json'`.                                                             |
| `403 Untrusted Host`                         | Reached by something other than `localhost`/`127.0.0.1` on its own port. Use the exact URL it printed.     |
| `503 The client is not built yet`            | `npm run build` has not run.                                                                               |
| Page loads but stays empty                   | Nothing has reported yet. Run the check curl above.                                                        |
| `400 actor is required`                      | `actor` and `action` are both mandatory, and neither may be blank.                                         |
| An agent appears, then vanishes              | Stars leave 30 minutes after their last event. Keep reporting, or send `status: "running"` to hold it lit. |
| `Another AgentOps server owns this database` | One server per data directory. Stop the other, or set a different `AGENTOPS_DATA_DIR`.                     |

---

## Security

The server binds to `127.0.0.1` only, and every request must carry a `Host` of
this loopback port — that is what stops DNS rebinding. Cross-origin and
cross-site requests are refused, so a web page open in your browser cannot post
events even though your own shell can. Request bodies are capped at 256 KB.

`/ingest` deliberately needs no token: any process already running as you could
read one from `/api/bootstrap` anyway, so requiring it would buy nothing and
cost every agent a handshake. `/ingest` is the only write route today; the token
still guards any other non-GET request.

Obvious credential shapes are stripped from strings before they are stored. That
is storage hygiene, not a security boundary — do not send secrets.

There is no authentication and no multi-user story. This is a tool for watching
your own machine; do not expose the port to a network.

---

## Development

```bash
npm run dev      # server, watched
npm run dev:ui   # vite on :5173, proxying /api and /ingest to the server
npm test         # node:test
npm run check    # typecheck + test + build — the gate CI runs
npm run format   # prettier
```

**Layout**

```
src/core/events.ts           the event model and all validation
src/db/store.ts              one append-only SQLite table
src/server/app.ts            ingest, SSE, the static client
src/ui/constellation.ts      stream -> stars, edges, cards  (pure, tested)
src/ui/components/Field.tsx  the canvas
src/ui/App.tsx               the one screen
src/ui/theme.css             greyscale chrome; the field has its own colour
```

`src/ui/constellation.ts` is pure — no React, no DOM, no network — which is how
the whole picture is asserted in Node without a browser.

Reduced motion is respected: the field renders as a still frame with arrowheads
instead of travelling particles, and loses nothing but the movement.

See [AGENTS.md](AGENTS.md) for the conventions that matter when changing this
code.

---

## License

MIT — see [LICENSE](LICENSE).
