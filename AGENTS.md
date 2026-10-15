# Setting up AgentOps

You are a coding agent and someone has handed you this repository. This file is
everything you need to get it running and to report into it. Follow it in order.

## 1. Requirements

- Node.js **24 or newer** (`node --version`). The server uses the built-in
  `node:sqlite`, which does not exist on older releases.
- npm, and a POSIX shell. macOS or Linux.

Nothing else. There is no database to provision, no API key, no account, and no
network call at any point.

## 2. Install and run

```bash
npm install
npm run build     # builds the browser client into dist/ui
npm start         # serves http://127.0.0.1:4317
```

`npm start` must print a line containing `http://127.0.0.1:4317`. If it exits
instead, read the error — the two likely causes are a Node version below 24 and
port 4317 already being in use (set `AGENTOPS_PORT` to something else).

## 3. Verify it works

```bash
curl -s localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"setup-check","action":"verify","status":"ok","summary":"Install verified"}'
```

A healthy server answers `{"accepted":1,...}` with status `202`. Open
<http://127.0.0.1:4317> and a star labelled `setup-check` is on the field.

If you cannot open a browser, this is an equivalent check:

```bash
curl -s localhost:4317/api/bootstrap | head -c 200
```

It returns JSON containing your event.

## 4. Report your own work into it

Pick a stable `session` id for the conversation you are in, and a short `actor`
name for yourself. Then post as you work:

```bash
curl -s -m 2 localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"<you>","action":"<what>","session":"<session>","provider":"<claude|openai|google|opencode|openrouter>","status":"running","summary":"<one line>"}'
```

Report when you **start** a task (`status: "running"`), when you **finish** one
(`"ok"` plus a `summary`), when you **fail** (`"error"`), and — most importantly
— when you **need the human** (`"blocked"`, with a `summary` stating the
decision you need). Blocked is the one that gets their attention.

Add `parent: "<actor>"` when you are a subagent, `target: "<actor>"` when you
hand work off, and `verdict` plus `issues` when you judge something.

**Rules:** never block on it (short timeout, ignore failures — it is never a
dependency of your real work), one event per meaningful step rather than per
token, and never send secrets.

Read human replies back from your own session:

```bash
curl -N "localhost:4317/api/events?session=<session>"
```

A reply arrives as an event with `actor: "operator"` and `action: "reply"`.

## 5. Working on the code

```bash
npm run dev       # server, watched
npm run dev:ui    # vite on :5173, proxies /api and /ingest to the server
npm test          # node:test
npm run check     # typecheck + test + build — run this before you commit
npm run format    # prettier
```

`npm run check` is the gate. CI runs exactly it, plus `npm run format:check`.

**Where things are**

| Path                          | What it owns                                   |
| ----------------------------- | ---------------------------------------------- |
| `src/core/events.ts`          | the event model and all validation             |
| `src/db/store.ts`             | one append-only SQLite table                   |
| `src/server/app.ts`           | `/ingest`, SSE, the static client              |
| `src/ui/constellation.ts`     | stream → stars, edges, cards (pure, tested)    |
| `src/ui/components/Field.tsx` | the canvas                                     |
| `src/ui/App.tsx`              | the one screen                                 |
| `src/ui/theme.css`            | greyscale chrome; the field has its own colour |

**Conventions that matter here**

- `src/ui/constellation.ts` is pure and stays that way — no React, no DOM, no
  network. It is how the whole picture is testable in Node.
- Never invent data the stream did not report. An absent field renders as an
  absence. Derived relationships are labelled as derived (see the `sequence`
  edge kind).
- The root `tsconfig.json` is the Node side and excludes `src/ui`, which is a
  DOM project with its own config. Keep them separate.
- There is no `alert()`/`confirm()`/`prompt()` in this UI, and errors render in
  place.

## 6. The full reference

[README.md](README.md) documents every field of the ingest contract, what each
one draws on screen, the response codes, and the security model. The running
server also serves it at <http://127.0.0.1:4317/README.md>.
