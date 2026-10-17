# opencode-auditor

A **passive, tiered second-opinion reviewer** for [OpenCode](https://opencode.ai). It watches what
the agent is doing and, at specific moments, runs a read-only review with a separate model and
injects the findings back into the session — tiered by severity.

It is an **observer + advisor**. Nothing here mutates project state.

- **Stuck-detection is the primary trigger** (on by default): three consecutive tool errors → the
  advisor reviews the ledger + transcript + diff and steers the running agent.
- **Proactive turn-review exists but is off by default** (it costs a model call per turn).
- **`/advisor-review`** forces an immediate review on demand.

---

## Design notes (why it's built this way)

**The review pass is physically sandboxed.** It uses `ctx.generate.text()`, which has **no session
and no tools**. The advisor cannot read files, run commands, or recurse into another session. It
reviews only from a bounded context bundle (activity ledger + transcript + working diff) that the
plugin hands it. That is a stronger safety guarantee than a "read-only child session".

**Triggers are guarded.** Per-session cooldown, a review budget, and finding-dedupe mean the
advisor can never loop or spam the host agent. A hard ceiling caps even forced manual calls.

**Delivery is tiered.** Nits are always passive notes. Concerns and blockers only *steer* a
**running** agent (the stuck trigger). Findings on an already-idle agent are surfaced as passive
notes — never by forcing a new turn. A manual review never steers, regardless of severity.

**Automatic failures announce themselves.** If an automatic (stuck/turn) review call fails — bad
model ID, provider auth, provider down — the plugin posts a passive note **once per session** and
pauses further automatic reviews, instead of silently logging. A successful review (including a
manual one) clears the pause, so a transient outage recovers on its own.

---

## Delivery tiers

| Severity | Automatic (stuck) | Turn review | Manual (`/advisor-review`) |
|----------|-------------------|-------------|----------------------------|
| `nit`        | passive note | passive note | passive note |
| `concern`    | **steer**    | passive note | passive note |
| `blocker`    | **steer**    | passive note | passive note |

"Steer" = `ctx.session.prompt({ delivery: "steer" })`. "Passive note" = `ctx.session.synthetic()`
(injects a message without triggering an agent response). `passiveOnly: true` forces everything to
passive notes.

---

## Install

The plugin is a single TypeScript file. Copy it into your OpenCode config and register it:

```bash
mkdir -p ~/.config/opencode/plugins/advisor
cp plugins/advisor/index.ts ~/.config/opencode/plugins/advisor/index.ts
```

Then register it in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/Users/you/.config/opencode/plugins/advisor",
      "options": {
        "enabled": true,
        "triggerOnStuck": true,
        "stuckThreshold": 3,
        "triggerOnTurn": false,
        "cooldownMs": 45000,
        "maxReviewsPerSession": 8,
        "maxFindings": 3,
        "includeDiff": true,
        "passiveOnly": false,
        "debug": false
      }
    }
  ]
}
```

Restart OpenCode after changing plugin code: `opencode service restart`.

---

## Configuration

Settings resolve in layers: **built-in defaults < `opencode.json` plugin options < chat overrides**
(chat overrides persist across restarts).

### Options

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `enabled` | bool | `true` | Master switch. |
| `model` | string / `null` | `null` | Advisor model, `providerID/modelID`. `null` = follow session default. |
| `triggerOnStuck` | bool | `true` | Review after N consecutive tool errors. |
| `triggerOnTurn` | bool | `false` | Review at each turn end. **Opt-in** (costs a call per turn). |
| `stuckThreshold` | 1–20 | `3` | Consecutive failures that count as "stuck". |
| `cooldownMs` | 0–600000 | `45000` | Minimum gap between automatic reviews (per session). |
| `maxReviewsPerSession` | 1–100 | `8` | Automatic review budget per session. |
| `maxFindings` | 1–10 | `3` | Max findings injected per review. |
| `ledgerSize` | number | `40` | Activity entries kept in the bounded ledger. |
| `contextChars` | number | `6000` | Char budget for the review context bundle. |
| `includeDiff` | bool | `true` | Include the working git diff in the review context. |
| `passiveOnly` | bool | `false` | Never steer; all findings become passive notes. |
| `agents` | string[] | unset | If set, only track these agent names. |
| `debug` | bool | `false` | Log advisor internals to the console. |

### Model resolution

The advisor model resolves in this order:

1. **chat override** (`/advisor-setup model …`) — highest
2. **`model` option** in `opencode.json`
3. **`OPENCODE_ADVISOR_MODEL`** env var
4. **session default model** (fallback)

The string form is `providerID/modelID`; the **first** `/` splits it, so OpenRouter's
`openrouter/vendor/model` works. Setting `model` to `default` clears the override and falls back to
the session model. IDs are validated against the live model registry at set time (unknown IDs are
rejected with ranked suggestions).

---

## Chat commands

| Command | What it does |
|---------|--------------|
| `/advisor-review` | Force a review of the current session **now**. Bypasses cooldown and the normal budget (hard-capped at 3× `maxReviewsPerSession`), reports its outcome (findings / nothing found / duplicate / skipped / failed). Never steers. |
| `/advisor-status` | Show effective settings, resolved model, and per-session activity (including the auto-paused marker). |
| `/advisor-setup <setting> <value>` | Set a setting from chat. `<setting>` alone shows the current value; no args lists all settings. Persists across restarts. |

Examples:

```
/advisor-setup model openrouter/anthropic/claude-haiku-5.5
/advisor-setup triggerOnTurn true
/advisor-setup debug true
/advisor-status
/advisor-review
```

---

## Safety guards

- **45s cooldown** between automatic reviews (per session).
- **8 reviews/session budget** for automatic triggers.
- **Manual hard cap**: forced reviews bypass cooldown/budget but never exceed
  `maxReviewsPerSession × 3` per session.
- **Finding dedupe**: an identical finding set is not re-injected.
- **Concurrency guard**: never two reviews in flight at once.
- **Error announcement + pause**: an automatic review failure is announced once per session, then
  automatic reviews pause until a review succeeds again.
- **Stuck-streak reset**: a successful tool call resets the consecutive-error streak, so a lone
  failure never triggers a review.

---

## Review context

Each review gets a bounded bundle (~6KB by default):

- **Activity ledger** — the last N tool calls (`ok`/`FAIL`, tool name, duration, one-line input
  summary, error text).
- **Recent transcript** — the last 12 messages, text-only, truncated.
- **Working diff** — the current git diff, truncated (if `includeDiff`).

The advisor is instructed to return **strict JSON only**:

```json
{"findings":[{"severity":"blocker|concern|nit","category":"block|security|practice|improvement","summary":"<=120 chars","advice":"<=400 chars"}]}
```

with categories `block`, `security`, `practice`, `improvement`, and to return `{"findings":[]}` when
the work looks sound. Parsing is defensive (tolerates markdown fences, salvages truncated JSON).

---

## Development

```
plugins/advisor/index.ts   the plugin (single file)
tests/advisor.test.ts      behavioral suite (drives the real plugin.setup with a mock Context)
tests/run.sh               typecheck + run the suite
```

The plugin targets the **OpenCode V2 plugin SDK**, `@opencode/plugin` (v2.0.32 verified). Note this
is *not* the older V1 package `@opencode-ai/plugin`.

### Running the tests

```bash
cd tests
./run.sh        # typecheck against the real SDK, then run the behavioral suite
./run.sh -t     # typecheck only
```

`run.sh` copies `../plugins/advisor/index.ts` to `tests/advisor.test.ts`'s import path
(`advisor.index.ts`) so the suite always exercises the real, current plugin. The suite needs
`@opencode/plugin` installed locally — `run.sh` installs it if `tests/node_modules` is missing.

The suite verifies behavior a typecheck cannot: stuck detection + streak reset, cooldown bypass and
the manual spend cap, manual-never-steers, failure announcement + pause + recovery, the concurrency
guard, and that turn review is opt-in and stays passive.

### What the tests cover

- **Stuck detection** (3 failures → concern steers; a success resets the streak).
- **Manual review** bypasses cooldown but is hard-capped on spend; never steers, even for blockers.
- **Automatic failure** announces once per session and pauses automatic reviews; a successful
  review clears the pause; a manual review never double-posts the announcement.
- **Concurrency guard** holds (no two reviews in flight).
- **Turn review** is opt-in; when enabled, findings stay passive.

---

## Provenance

This project grew out of a survey of existing OpenCode advisor/second-opinion plugins. Most
candidates were low-quality — tiny download counts, stale, unlicensed, or deprecated (one had a
404'd repo) — so this is a from-scratch implementation combining the useful ideas, built and
verified against the real V2 SDK (`@opencode/plugin@2.0.32`).

## License

See repository for license details.
