import { Plugin } from "@opencode/plugin"

/* ------------------------------------------------------------------ *
 * advisor — a passive, tiered second-opinion reviewer for OpenCode.
 *
 * It watches what the agent does (via tool hooks) and, at specific
 * moments, runs a read-only review with a separate model and injects
 * the findings back into the session — tiered by severity.
 *
 * Design notes (why it's built this way):
 *  - The review pass uses ctx.generate.text(), which has NO session and
 *    NO tools. The advisor physically cannot read files, run commands,
 *    or recurse into another session. It reviews from a bounded context
 *    bundle (activity ledger + transcript + diff) that WE hand it. This
 *    is a stronger safety guarantee than a "read-only child session".
 *  - Triggers are guarded by per-session cooldown + budget + dedupe so
 *    the advisor can never loop or spam the host agent.
 *  - Delivery is tiered: nits are always passive notes; concerns and
 *    blockers only "steer" a *running* agent (stuck trigger). Findings
 *    on an already-idle agent are surfaced as passive notes, never by
 *    forcing a new turn.
 *
 * Nothing here mutates project state. It is an observer + advisor.
 * ------------------------------------------------------------------ */

type Severity = "blocker" | "concern" | "nit"
type Category = "block" | "security" | "practice" | "improvement"
type Trigger = "stuck" | "turn" | "manual"

// Result of a review attempt — lets callers (e.g. /advisor-review) report why
// nothing happened instead of failing silently.
type ReviewOutcome =
  | { status: "delivered"; count: number } // findings injected
  | { status: "clean" } // reviewed, nothing found
  | { status: "duplicate" } // same findings as last review, suppressed
  | { status: "skipped"; reason: string } // guard rejected (disabled, cooldown, …)
  | { status: "error"; message: string } // advisor call failed

interface Finding {
  severity: Severity
  category: Category
  summary: string
  advice: string
}

interface Activity {
  tool: string
  ok: boolean
  summary: string
  error?: string
  ms?: number
  at: number
}

interface SessionState {
  ledger: Activity[]
  consecutiveErrors: number
  lastReviewAt: number
  reviews: number
  lastHash: string
  dirty: boolean // has meaningful activity since last review
  inflight: boolean
  // Automatic (stuck/turn) review failures: announce at most once per session
  // so a broken model config is visible without spamming every stuck episode.
  errorAnnounced: boolean
}

interface Options {
  enabled: boolean
  model?: string | { providerID: string; id: string } | null
  triggerOnStuck: boolean
  stuckThreshold: number
  triggerOnTurn: boolean
  cooldownMs: number
  maxReviewsPerSession: number
  maxFindings: number
  ledgerSize: number
  contextChars: number
  includeDiff: boolean
  passiveOnly: boolean
  agents?: string[]
  debug: boolean
}

const DEFAULTS: Options = {
  enabled: true,
  triggerOnStuck: true,
  stuckThreshold: 3,
  triggerOnTurn: false, // proactive review is opt-in (costs a review call per turn)
  cooldownMs: 45_000,
  maxReviewsPerSession: 8,
  maxFindings: 3,
  ledgerSize: 40,
  contextChars: 6_000,
  includeDiff: true,
  passiveOnly: false,
  debug: false,
}

// Safety ceiling for forced (/advisor-review) calls: they skip the cooldown and
// the normal budget, but never exceed maxReviewsPerSession * this per session.
const MANUAL_BUDGET_MULTIPLE = 3

const REVIEW_INSTRUCTIONS = `You are a senior code reviewer and security auditor observing an AI coding agent's work session. You have NO tools — review ONLY from the context provided below. Do not ask questions and do not claim you need more access.

Analyze the agent's recent activity, in priority order:
1. BLOCKS: Is the agent stuck — repeating the same error, looping, fighting a tool? Identify the root cause and the single concrete next step.
2. SECURITY: Exposed secrets/credentials, command injection, unsafe shell (rm -rf, curl|sh, sudo), path traversal, unsafe deserialization, weak crypto, missing authz checks, over-broad permissions, writes outside the intended scope.
3. BEST PRACTICES: Skipped/ignored errors, untested changes, hardcoded values that belong in config, breaking changes without updating callers, editing files unrelated to the task.
4. IMPROVEMENTS: A cleaner or safer approach the agent appears to have missed.

Return STRICT JSON only — no prose, no markdown fences, no commentary:
{"findings":[{"severity":"blocker|concern|nit","category":"block|security|practice|improvement","summary":"<=120 chars headline","advice":"<=400 chars, one concrete actionable step"}]}

Rules:
- Only report findings you can reasonably support from the given context. If the work looks sound, return {"findings":[]}.
- Prefer quality over quantity; report only what matters.
- "summary" is a short headline; "advice" is the specific fix or next action directed at the agent.`

/* ------------------------------ helpers ------------------------------ */

// Resolve advisor model: plugin option → env → undefined (= OpenCode default model).
function resolveModel(opt: Options): { providerID: string; id: string } | undefined {
  const raw: unknown = opt.model ?? process.env.OPENCODE_ADVISOR_MODEL
  if (!raw) return undefined
  if (typeof raw === "string") {
    const i = raw.indexOf("/")
    if (i > 0 && i < raw.length - 1) return { providerID: raw.slice(0, i), id: raw.slice(i + 1) }
    return undefined
  }
  if (raw && typeof raw === "object") {
    const m = raw as { providerID?: unknown; id?: unknown }
    if (typeof m.providerID === "string" && typeof m.id === "string" && m.providerID && m.id)
      return { providerID: m.providerID, id: m.id }
  }
  return undefined
}

// Small stable hash for dedupe.
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// One-line summary of a tool input, safe for any JSON value.
function summarizeInput(input: unknown): string {
  let s: string
  try {
    s = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    s = String(input)
  }
  if (!s) return ""
  s = s.replace(/\s+/g, " ").trim()
  return s.length > 160 ? s.slice(0, 157) + "…" : s
}

// Pull plain text out of a transcript message (shape-tolerant).
function messageText(msg: unknown): string {
  const m = msg as { text?: unknown; content?: unknown; parts?: unknown }
  if (typeof m?.text === "string") return m.text
  const arr = Array.isArray(m?.content) ? m.content : Array.isArray(m?.parts) ? m.parts : null
  if (!arr) return ""
  return arr
    .filter((p): p is { type: string; text: string } => !!p && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join(" ")
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s
}

/* -------------------- chat-settable settings (/advisor-setup) -------------------- */

const INVALID = Symbol("invalid")

function parseBool(v: string): boolean | typeof INVALID {
  const s = v.trim().toLowerCase()
  if (["true", "1", "on", "yes"].includes(s)) return true
  if (["false", "0", "off", "no"].includes(s)) return false
  return INVALID
}

function parseIntClamped(v: string, min: number, max: number): number | typeof INVALID {
  const n = Number(v)
  if (!Number.isFinite(n)) return INVALID
  return Math.max(min, Math.min(max, Math.round(n)))
}

// Each entry: a human label for `kind` and a coercer (returns INVALID on bad input).
const SETTABLE: Record<string, { kind: string; apply: (v: string) => unknown }> = {
  enabled: { kind: "true|false", apply: parseBool },
  model: { kind: "provider/model | 'default'", apply: (v) => (/^(default|session|)$/i.test(v.trim()) ? null : v.trim()) },
  triggerOnStuck: { kind: "true|false", apply: parseBool },
  triggerOnTurn: { kind: "true|false", apply: parseBool },
  stuckThreshold: { kind: "1-20", apply: (v) => parseIntClamped(v, 1, 20) },
  cooldownMs: { kind: "0-600000", apply: (v) => parseIntClamped(v, 0, 600_000) },
  maxReviewsPerSession: { kind: "1-100", apply: (v) => parseIntClamped(v, 1, 100) },
  maxFindings: { kind: "1-10", apply: (v) => parseIntClamped(v, 1, 10) },
  includeDiff: { kind: "true|false", apply: parseBool },
  passiveOnly: { kind: "true|false", apply: parseBool },
  debug: { kind: "true|false", apply: parseBool },
}

/* ------------------------------- plugin ------------------------------- */

export default Plugin.define({
  id: "advisor",
  async setup(ctx) {
    // Layered config: DEFAULTS < opencode.json (ctx.options) < persisted chat overrides.
    const persisted = (await ctx.storage.get("settings")) as Partial<Options> | undefined
    const opt: Options = { ...DEFAULTS, ...(ctx.options as Partial<Options> | undefined), ...(persisted ?? {}) }
    if (process.env.OPENCODE_ADVISOR_DISABLED === "1") opt.enabled = false
    if (!opt.enabled) console.log("[advisor] disabled (re-enable with /advisor-setup enabled true)")

    // Model is resolved lazily so /advisor-setup model … takes effect immediately.
    const advisorModel = () => resolveModel(opt)
    const states = new Map<string, SessionState>()
    const started = new Map<string, number>() // callID → start time (for duration)
    const log = (...a: unknown[]) => opt.debug && console.log("[advisor]", ...a)

    const state = (sessionID: string): SessionState => {
      let s = states.get(sessionID)
      if (!s) {
        s = { ledger: [], consecutiveErrors: 0, lastReviewAt: 0, reviews: 0, lastHash: "", dirty: false, inflight: false, errorAnnounced: false }
        states.set(sessionID, s)
      }
      return s
    }

    const agentAllowed = (agent: string | undefined): boolean =>
      !opt.agents || !opt.agents.length || (agent != null && opt.agents.includes(agent))

    /* ---- 1. Observe the agent via tool hooks ---- */

    const before = await ctx.tool.hook("execute.before", (event) => {
      if (!opt.enabled) return // match execute.after, avoid leaking start times when disabled
      started.set(String(event.id), Date.now())
    })

    const after = await ctx.tool.hook("execute.after", (event) => {
      try {
        if (!opt.enabled) return // checked live so /advisor-setup enabled works
        if (!agentAllowed(event.agent)) return
        const sid = String(event.sessionID)
        const s = state(sid)
        const t0 = started.get(String(event.id))
        if (t0) started.delete(String(event.id))
        const ms = t0 ? Date.now() - t0 : undefined

        const ok = event.status === "completed"
        const entry: Activity = {
          tool: event.tool,
          ok,
          summary: summarizeInput(event.input),
          error: ok ? undefined : String(event.error?.message ?? "unknown error").slice(0, 300),
          ms,
          at: Date.now(),
        }
        s.ledger.push(entry)
        while (s.ledger.length > opt.ledgerSize) s.ledger.shift()
        s.dirty = true

        // Stuck detection: count consecutive failures; reset on success.
        s.consecutiveErrors = ok ? 0 : s.consecutiveErrors + 1
        log(`${ok ? "ok" : "ERR"} ${event.tool}`, ok ? "" : entry.error)

        if (opt.triggerOnStuck && !ok && s.consecutiveErrors >= opt.stuckThreshold) {
          void maybeReview(sid, "stuck")
        }
      } catch (e) {
        // Never let the observer break the host session.
        log("execute.after hook error", e)
      }
    })

    /* ---- 2. Observe turn completion (opt-in) ---- */

    const controller = new AbortController()
    // Always subscribe (cheap) but check the flags LIVE, so /advisor-setup can
    // flip them at runtime. Subscribing only when enabled at boot would make
    // a later `triggerOnTurn true` silently do nothing.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.idle") continue
          if (!opt.enabled || !opt.triggerOnTurn) continue // live checks
          const data = (event as { data?: { sessionID?: string } }).data
          const sid = data?.sessionID
          if (!sid) continue
          const s = states.get(sid)
          if (!s || !s.dirty) continue // only review sessions we've actually observed
          void maybeReview(sid, "turn")
        }
      } catch (e) {
        if (!controller.signal.aborted) log("event stream error", e)
      }
    })()

    /* ---- 3. The review pass ---- */

    async function maybeReview(sessionID: string, trigger: Trigger, force = false): Promise<ReviewOutcome> {
      if (!opt.enabled) return { status: "skipped", reason: "advisor is disabled" }
      // Manual reviews may create state (empty ledger + transcript + diff is
      // still a valid thing to review); automatic ones only review observed sessions.
      const s = force ? state(sessionID) : states.get(sessionID)
      if (!s) return { status: "skipped", reason: "no activity tracked in this session yet" }
      const now = Date.now()

      // Guards: never concurrent. On force (explicit /advisor-review) the
      // cooldown and dirty guards are bypassed — but spend keeps a hard ceiling
      // so repeated manual calls cannot run up unbounded model cost.
      if (s.inflight) return { status: "skipped", reason: "a review is already running" }
      if (force) {
        if (s.reviews >= opt.maxReviewsPerSession * MANUAL_BUDGET_MULTIPLE) {
          log(`manual hard cap reached for ${sessionID}`)
          return { status: "skipped", reason: "manual review hard cap reached (safety ceiling)" }
        }
      } else {
        // A prior automatic failure pauses automatic reviews for the rest of the
        // session (so a broken config can't keep firing a doomed model call).
        // The user can always retry explicitly via /advisor-review.
        if (s.errorAnnounced) {
          return { status: "skipped", reason: "automatic reviews paused after a prior failure (see /advisor-review)" }
        }
        if (s.reviews >= opt.maxReviewsPerSession) {
          log(`budget reached for ${sessionID}`)
          return { status: "skipped", reason: "session review budget exhausted" }
        }
        if (now - s.lastReviewAt < opt.cooldownMs) return { status: "skipped", reason: "cooldown active" }
        // A stuck review fires mid-run (agent is working). A turn review
        // only makes sense if there's unseen activity to review.
        if (trigger === "turn" && !s.dirty) return { status: "skipped", reason: "no new activity since last review" }
      }

      s.inflight = true
      try {
        const context = await buildContext(sessionID, s)
        const prompt = `${REVIEW_INSTRUCTIONS}\n\n=== CONTEXT ===\n${context}`
        const m = advisorModel() // resolved live so `model` can change via chat
        const res = await ctx.generate.text(m ? { prompt, model: m } : { prompt })
        const findings = parseFindings(res.text)

        // Bookkeeping on any completed review. A success clears the automatic-
        // failure pause, so a transient outage recovers on its own instead of
        // disabling the advisor for the rest of the session.
        const commit = () => {
          s.reviews += 1
          s.lastReviewAt = now
          s.dirty = false
          s.errorAnnounced = false
          if (trigger === "stuck") s.consecutiveErrors = 0
        }

        // Dedupe against the last injected set.
        const sig = hash(JSON.stringify(findings.map((f) => [f.category, f.summary].join("|"))))
        if (!findings.length) {
          commit()
          log(`reviewed (${trigger}) → clean`)
          return { status: "clean" }
        }
        if (sig === s.lastHash) {
          commit()
          log(`reviewed (${trigger}) → duplicate suppressed`)
          return { status: "duplicate" }
        }
        for (const f of findings.slice(0, opt.maxFindings)) {
          await deliver(sessionID, f, trigger)
        }
        s.lastHash = sig

        commit()
        log(`reviewed (${trigger}) → ${findings.length} finding(s)`)
        return { status: "delivered", count: Math.min(findings.length, opt.maxFindings) }
      } catch (e) {
        log("review error", e)
        const message = String((e as Error)?.message ?? e).slice(0, 200)
        // Automatic triggers (stuck/turn) fire without the user asking, so a
        // failure here would otherwise vanish into the debug log. Surface it
        // once per session as a passive note (never a steer — this is system
        // status, not a reason to redirect the agent). Manual reviews skip this
        // because /advisor-review already reports its own outcome.
        if (trigger !== "manual" && !s.errorAnnounced) {
          s.errorAnnounced = true
          try {
            await ctx.session.synthetic({
              sessionID,
              text:
                `[advisor] automatic review failed: ${message}\n` +
                `→ Check the advisor model (/advisor-status) and its provider auth (/connect). ` +
                `Automatic reviews are paused for this session; /advisor-review still works on demand.`,
            })
          } catch {
            /* never let the status note break the hook chain */
          }
        }
        return { status: "error", message }
      } finally {
        s.inflight = false
      }
    }

    // Build the bounded context bundle the advisor reviews from.
    async function buildContext(sessionID: string, s: SessionState): Promise<string> {
      const budget = opt.contextChars
      const parts: string[] = []

      // Activity ledger (what the agent actually did).
      const acts = s.ledger
        .map((a) => {
          const dur = a.ms != null ? ` ${a.ms}ms` : ""
          const err = a.error ? ` ERROR: ${a.error}` : ""
          return `${a.ok ? "ok " : "FAIL"} ${a.tool}${dur} → ${a.summary}${err}`
        })
        .join("\n")
      parts.push(`[ACTIVITY — last ${acts ? s.ledger.length : 0} tool calls, newest last]\n${acts || "(none)"}`)

      // Recent transcript (text only, bounded).
      try {
        const msgs = await ctx.session.context({ sessionID })
        const recent = msgs.slice(-12).map(messageText).filter(Boolean).join("\n")
        if (recent) parts.push(`[RECENT MESSAGES]\n${truncate(recent, Math.floor(budget / 2))}`)
      } catch {
        /* transcript unavailable — skip */
      }

      // Working diff (bounded) — gives the advisor the actual changes.
      if (opt.includeDiff) {
        try {
          const diff = await ctx.vcs.diff({ mode: "working", context: 2 })
          const files = diff.data ?? []
          const text = files
            .map((f) => `--- ${f.file} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch}`)
            .join("\n\n")
          if (text) parts.push(`[WORKING DIFF]\n${truncate(text, Math.floor(budget / 2))}`)
        } catch {
          /* not a repo / no diff — skip */
        }
      }

      return truncate(parts.join("\n\n"), budget)
    }

    // Parse the advisor's strict-JSON findings, defensively.
    function parseFindings(raw: string): Finding[] {
      const cleaned = raw.replace(/```json/gi, "```").replace(/```/g, "").trim()
      const start = cleaned.indexOf("{")
      const arrStart = cleaned.indexOf("[")
      const s = start === -1 ? arrStart : arrStart === -1 ? start : Math.min(start, arrStart)
      if (s === -1) return []
      const candidate = cleaned.slice(s)
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate)
      } catch {
        // Try to salvage up to the last balanced bracket.
        const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"))
        try {
          parsed = JSON.parse(candidate.slice(0, end + 1))
        } catch {
          return []
        }
      }
      const arr = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown[] })?.findings
      if (!Array.isArray(arr)) return []
      const sev: Severity[] = ["blocker", "concern", "nit"]
      const cat: Category[] = ["block", "security", "practice", "improvement"]
      return arr
        .map((f) => f as Partial<Finding>)
        .filter((f) => f && typeof f.summary === "string")
        .map((f) => ({
          severity: sev.includes(f.severity as Severity) ? (f.severity as Severity) : "concern",
          category: cat.includes(f.category as Category) ? (f.category as Category) : "practice",
          summary: String(f.summary).slice(0, 160),
          advice: String(f.advice ?? "").slice(0, 500),
        }))
    }

    // Tiered delivery.
    async function deliver(sessionID: string, f: Finding, trigger: Trigger) {
      const label = `[advisor · ${f.category} · ${f.severity}]`
      const text = `${label} ${f.summary}${f.advice ? `\n→ ${f.advice}` : ""}`
      // Nits are always passive. Findings on an idle agent (turn) or a manual
      // review are surfaced as passive notes — never force a new turn. Concerns
      // and blockers only steer a *running* (stuck) agent.
      if (opt.passiveOnly || f.severity === "nit" || trigger !== "stuck") {
        await ctx.session.synthetic({ sessionID, text })
      } else {
        await ctx.session.prompt({ sessionID, text, delivery: "steer" })
      }
    }

    /* ---- 4. Chat commands: /advisor-setup, /advisor-status ---- */

    // Safe typed access to the flat options bag for dynamic keys.
    const getOpt = (k: string): unknown => (opt as unknown as Record<string, unknown>)[k]
    const setOpt = (k: string, v: unknown): void => {
      ;(opt as unknown as Record<string, unknown>)[k] = v
    }

    // Persist only what differs from DEFAULTS so config-file values that were
    // never touched in chat aren't frozen in by a later override.
    async function persist(): Promise<void> {
      const overrides: Record<string, boolean | number | string | null> = {}
      for (const k of Object.keys(SETTABLE)) {
        const cur = getOpt(k)
        if (JSON.stringify(cur) !== JSON.stringify(DEFAULTS[k as keyof Options])) {
          overrides[k] = cur as boolean | number | string | null
        }
      }
      try {
        await ctx.storage.set("settings", overrides)
      } catch (e) {
        log("persist failed", e)
      }
    }

    // Validate a "providerID/modelID" string against the live model registry,
    // so a typo is caught here instead of failing silently on the first review.
    type ModelCheck = { ok: true; warn?: string } | { ok: false; message: string }
    async function validateModel(raw: string): Promise<ModelCheck> {
      if (raw.includes("[")) {
        return {
          ok: false,
          message: `[advisor] Model variants ("[...]") aren't supported here — use the base ID, e.g. "${raw.replace(/\[.*?\]/, "")}".`,
        }
      }
      let data: Awaited<ReturnType<typeof ctx.model.list>>["data"] | undefined
      try {
        data = (await ctx.model.list()).data
      } catch {
        // Registry unavailable — don't block the user, but don't lie either.
        return { ok: true, warn: "could not verify against the model registry (continuing anyway)" }
      }
      const i = raw.indexOf("/")
      const provider = raw.slice(0, i)
      const want = raw.slice(i + 1)
      const exact = data.find((m) => m.providerID === provider && m.modelID === want)
      if (exact) {
        return exact.enabled
          ? { ok: true }
          : { ok: true, warn: `"${raw}" is disabled in your config — reviews will fail until it is enabled` }
      }
      // No exact match → suggest close ones: same model under another provider,
      // suffix matches, or dash/dot spelling variants.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
      const wl = want.toLowerCase()
      const nwl = norm(want)
      const scored = data
        .map((m) => {
          const ml = m.modelID.toLowerCase()
          const score =
            ml === wl || m.id.toLowerCase() === raw.toLowerCase()
              ? 3
              : ml.endsWith("/" + wl)
                ? 2
                : norm(ml) === nwl || norm(m.id) === norm(raw)
                  ? 1.5
                  : ml.includes(wl)
                    ? 1
                    : 0
          return { m, score }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
      const lines = scored.map((s) => `  ${s.m.providerID}/${s.m.modelID}`)
      const providers = [...new Set(data.map((m) => String(m.providerID)))]
      return {
        ok: false,
        message:
          `[advisor] Unknown model "${raw}".` +
          (lines.length ? `\nDid you mean:\n${lines.join("\n")}` : "") +
          `\nProviders: ${providers.join(", ")} — run /models to browse.`,
      }
    }

    const cmd = await ctx.command.transform((editor) => {
      editor.add({
        name: "advisor-setup",
        description: "Get or set an advisor setting (e.g. /advisor-setup triggerOnTurn true)",
        execute: async ({ sessionID, prompt }) => {
          // reply must return void (command handlers are Promise<void>).
          const reply = async (text: string): Promise<void> => {
            await ctx.session.synthetic({ sessionID, text })
          }
          const toks = prompt.text.trim().split(/\s+/).filter(Boolean)

          // /advisor-setup            → usage + current values
          if (!toks.length) {
            const cur = Object.keys(SETTABLE)
              .map((k) => `  ${k} = ${JSON.stringify(getOpt(k))}  (${SETTABLE[k].kind})`)
              .join("\n")
            await reply(`[advisor] /advisor-setup <setting> <value>\nSettings:\n${cur}\nUse /advisor-status for a summary.`)
            return
          }

          const key = toks[0]
          const spec = SETTABLE[key]

          // Unknown key → list valid ones.
          if (!spec) {
            await reply(`[advisor] Unknown setting "${key}". Valid: ${Object.keys(SETTABLE).join(", ")}`)
            return
          }

          // /advisor-setup <key>      → show current value
          if (toks.length === 1) {
            await reply(`[advisor] ${key} = ${JSON.stringify(getOpt(key))}  (${spec.kind})`)
            return
          }

          // /advisor-setup <key> <value> → apply
          const rawVal = toks.slice(1).join(" ")
          const val = spec.apply(rawVal)
          if (val === INVALID) {
            await reply(`[advisor] Invalid value for ${key}: "${rawVal}" (expects ${spec.kind})`)
            return
          }
          // Validate model IDs against the live registry (catches typos and
          // wrong-provider IDs before they fail silently at review time).
          let warn = ""
          if (key === "model" && typeof val === "string") {
            const check = await validateModel(val)
            if (!check.ok) {
              await reply(check.message)
              return
            }
            warn = check.warn ? ` ⚠ ${check.warn}` : ""
          }
          setOpt(key, val)
          await persist()

          // Echo effect for the toggles that change behavior.
          let note = ""
          if (key === "enabled") note = val ? " Observer re-armed." : " Observer paused."
          if (key === "triggerOnTurn") note = val ? " Proactive turn review ON." : " Proactive turn review OFF."
          if (key === "model") note = val ? " Advisor model updated." : " Advisor model reset to session default."
          await reply(`[advisor] ${key} = ${JSON.stringify(val)}.${note}${warn} (persisted across restarts)`)
        },
      })

      editor.add({
        name: "advisor-status",
        description: "Show current advisor settings and recent activity",
        execute: async ({ sessionID }) => {
          const m = advisorModel()
          const lines = Object.keys(SETTABLE).map((k) => `  ${k} = ${JSON.stringify(getOpt(k))}`)
          const tracked = [...states.entries()].map(([sid, s]) => {
            const paused = s.errorAnnounced ? " · auto-paused after failure" : ""
            return `  …${sid.slice(-6)}: ${s.ledger.length} calls, ${s.consecutiveErrors} err streak, ${s.reviews} reviews${paused}`
          })
          const text = [
            `[advisor] enabled=${opt.enabled}  model=${m ? `${m.providerID}/${m.id}` : "session default"}`,
            "Settings:" + lines.join("\n"),
            tracked.length ? "Tracked sessions:\n" + tracked.join("\n") : "Tracked sessions: (none yet)",
          ].join("\n")
          await ctx.session.synthetic({ sessionID, text })
        },
      })

      editor.add({
        name: "advisor-review",
        description: "Force an advisor review of this session right now (skips cooldown; capped at 3× session budget)",
        execute: async ({ sessionID }) => {
          const reply = async (text: string): Promise<void> => {
            await ctx.session.synthetic({ sessionID, text })
          }
          if (!opt.enabled) {
            await reply("[advisor] Disabled — /advisor-setup enabled true to re-arm first.")
            return
          }
          const m = advisorModel()
          await reply(`[advisor] Reviewing this session… (model: ${m ? `${m.providerID}/${m.id}` : "session default"})`)
          // force=true: explicit user request skips cooldown/budget/dirty guards.
          const outcome = await maybeReview(sessionID, "manual", true)
          switch (outcome.status) {
            case "delivered":
              // Findings were already injected above as passive notes.
              await reply(`[advisor] Review complete — ${outcome.count} finding(s) injected above.`)
              break
            case "clean":
              await reply("[advisor] Review complete — nothing worth flagging.")
              break
            case "duplicate":
              await reply("[advisor] Review complete — same findings as the previous review (suppressed).")
              break
            case "skipped":
              await reply(`[advisor] Review not run: ${outcome.reason}.`)
              break
            case "error":
              await reply(
                `[advisor] Review FAILED: ${outcome.message}. ` +
                  `Check the advisor model (/advisor-status) and its provider auth (/connect).`,
              )
              break
          }
        },
      })
    })

    /* ---- 5. Cleanup ---- */

    return () => {
      controller.abort()
      void cmd.dispose()
      void before.dispose()
      void after.dispose()
    }
  },
})
