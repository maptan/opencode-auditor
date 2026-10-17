/**
 * Behavioral tests for the advisor plugin.
 *
 * Drives the REAL plugin (plugin.setup with a mock Context) — no OpenCode host
 * needed. Verifies the behavioral guarantees that a typecheck cannot:
 *   - stuck detection (3 consecutive failures) fires a review and STEERS for
 *     concerns; a success resets the streak so it won't fire on a lone failure
 *   - /advisor-review bypasses the 45s cooldown but is hard-capped on spend
 *   - a manual review NEVER steers (passive notes only, even for blockers)
 *   - an AUTOMATIC review failure (stuck/turn) announces itself once per
 *     session and pauses further automatic reviews; a successful review clears
 *     the pause; a manual /advisor-review never double-posts the announcement
 *   - the concurrency guard holds (no two reviews in flight at once)
 *   - triggerOnTurn is opt-in, and turn findings stay passive
 *
 * Each concern runs on its own fresh harness because automatic triggers are
 * subject to the per-session cooldown — sharing a session would cross-contaminate.
 *
 * Run: ./run.sh   (or ./run.sh -t to typecheck only)
 * `advisor.index.ts` here is a generated copy of ../plugins/advisor/index.ts (gitignored).
 */
import plugin from "./advisor.index.ts"

type Any = any // the mock Context is structural, not the full SDK shape

let failed = 0
const check = (name: string, cond: boolean, extra = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${extra}`}`)
  if (!cond) failed++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`)
    await sleep(10)
  }
}

type Note = { sessionID: string; text: string }
type SteerNote = Note & { delivery?: string }
const findingsJson = (findings: Any[]): string => JSON.stringify({ findings })

async function makeHarness(persistedSettings: Any = {}) {
  const commands = new Map<string, { name: string; execute: (arg: Any) => Promise<void> }>()
  const synthetics: Note[] = []
  const prompts: SteerNote[] = []
  const generateCalls: Any[] = []
  const hooks = new Map<string, (e: Any) => unknown>()
  const queue: Any[] = []
  const store = { settings: persistedSettings as Any }
  let responder: (input: Any) => Promise<Any> = async () => ({ text: findingsJson([]) })
  let toolSeq = 0

  const ctx: Any = {
    options: { debug: true }, // no opencode.json overrides → plugin DEFAULTS apply; debug on so skips/errors are visible
    storage: {
      get: async (k: string) => (k === "settings" ? store.settings : undefined),
      set: async (k: string, v: Any) => {
        if (k === "settings") store.settings = v
      },
    },
    tool: {
      hook: async (type: string, cb: (e: Any) => unknown) => {
        hooks.set(type, cb)
        return { dispose: () => void hooks.delete(type) }
      },
    },
    event: {
      // Async-iterable stream; yields queued events, ends when the plugin aborts.
      subscribe: async function* ({ signal }: Any): AsyncGenerator<Any> {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift()
          await new Promise<void>((res) => setTimeout(res, 5))
        }
      },
    },
    generate: {
      text: async (input: Any): Promise<Any> => {
        generateCalls.push(input)
        return responder(input)
      },
    },
    session: {
      context: async () => [
        { role: "user", text: "build the feature" },
        { role: "assistant", parts: [{ type: "text", text: "working on it" }] },
      ],
      synthetic: async (x: Note) => {
        synthetics.push(x)
      },
      prompt: async (x: SteerNote) => {
        prompts.push(x)
      },
    },
    vcs: {
      diff: async () => ({
        data: [{ file: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }],
      }),
    },
    model: { list: async () => ({ data: [] }) },
    command: {
      transform: async (fn: (editor: Any) => unknown) => {
        await fn({ add: (spec: Any) => commands.set(spec.name, spec) })
        return { dispose: () => {} }
      },
    },
  }

  const cleanup = (await plugin.setup(ctx)) as (() => void) | void

  return {
    commands,
    synthetics,
    prompts,
    generateCalls,
    store,
    setResponder: (fn: (input: Any) => Promise<Any>) => {
      responder = fn
    },
    fireTool: (sid: string, ok: boolean): void => {
      const id = `t${++toolSeq}`
      hooks.get("execute.before")?.({ id, sessionID: sid })
      hooks.get("execute.after")?.({
        id,
        sessionID: sid,
        tool: "bash",
        status: ok ? "completed" : "error",
        input: { command: "npm run build" },
        error: ok ? undefined : new Error("command failed"),
        agent: "build",
      })
    },
    emit: (event: Any) => queue.push(event),
    manual: (sid: string): Promise<void> => commands.get("advisor-review")!.execute({ sessionID: sid }),
    setupCmd: (sid: string, text: string): Promise<void> =>
      commands.get("advisor-setup")!.execute({ sessionID: sid, prompt: { text } }),
    cleanup: () => {
      if (typeof cleanup === "function") cleanup()
    },
  }
}

async function main(): Promise<void> {
  // ---- S: stuck detection (automatic trigger) on a fresh session ----
  // Separate harness because an automatic trigger is subject to the 45s
  // cooldown — sharing A's session would collide with a prior manual review.
  const S = await makeHarness()
  try {
    // Stuck: 3 consecutive failures → concern STEERS the running agent.
    S.setResponder(async () => ({
      text: findingsJson([
        { severity: "concern", category: "practice", summary: "build keeps failing", advice: "inspect the log" },
      ]),
    }))
    S.fireTool("S1", false)
    S.fireTool("S1", false)
    S.fireTool("S1", false)
    await waitFor(() => S.prompts.length >= 1, 3000, "stuck review to steer")
    check(
      "S1 stuck (3 failures) delivers concern via steer",
      S.prompts[0]?.delivery === "steer" && S.prompts[0].text.includes("[advisor · practice · concern]"),
    )
    check("S1 exactly one review call for the stuck event", S.generateCalls.length === 1)
    check(
      "S1 steered finding not duplicated as a passive note",
      !S.synthetics.some((s) => s.text.includes("build keeps failing")),
    )

    // Recovery: a successful tool call resets the consecutive-error streak.
    S.fireTool("S1", true)
    S.setResponder(async () => ({ text: findingsJson([]) }))
    S.fireTool("S1", false) // streak was reset by the success above → 1, not 2
    await sleep(250)
    check("S1 success resets streak (no review after 1 fresh failure)", S.generateCalls.length === 1)
  } finally {
    S.cleanup()
  }

  // ---- A: manual review lifecycle, guards, delivery tiers, spend cap ----
  const A = await makeHarness()
  try {
    // T0: manual review works on a cold session (state created on demand).
    A.setResponder(async () => ({ text: findingsJson([]) }))
    await A.manual("S1")
    check(
      "T0 manual review on cold session runs and reports clean",
      A.generateCalls.length === 1 && A.synthetics.some((s) => s.text.includes("nothing worth flagging")),
    )

    // T1: manual review immediately after a prior one — cooldown (45s) would
    // block an automatic trigger, but force must not.
    A.setResponder(async () => ({ text: findingsJson([]) }))
    await A.manual("S1")
    check("T1 manual review bypasses the 45s cooldown (force)", A.generateCalls.length === 2)

    // T2: manual review NEVER steers, even for a blocker.
    A.setResponder(async () => ({
      text: findingsJson([
        { severity: "blocker", category: "block", summary: "uncommitted secrets", advice: "revert them" },
      ]),
    }))
    const promptsBefore = A.prompts.length
    await A.manual("S1")
    check(
      "T2 manual blocker lands as a passive note",
      A.synthetics.some((s) => s.text.includes("[advisor · block · blocker]")),
    )
    check("T2 manual review never calls session.prompt (no hijack)", A.prompts.length === promptsBefore)

    // T3: a failed model call announces itself instead of being swallowed.
    A.setResponder(async () => {
      throw new Error("401 unauthorized")
    })
    await A.manual("S1")
    check("T3 review failure surfaces in chat", A.synthetics.some((s) => s.text.includes("Review FAILED: 401 unauthorized")))

    // T4: concurrency guard — a second review while one is in flight is skipped.
    let release: Any = null
    A.setResponder(() => new Promise((res) => { release = res }))
    const first = A.manual("S1")
    await waitFor(() => release !== null, 2000, "first in-flight review to start")
    await A.manual("S1")
    check("T4 second concurrent review skipped", A.synthetics.some((s) => s.text.includes("already running")))
    release({ text: findingsJson([]) })
    await first

    // T5: spend is hard-capped no matter how often /advisor-review is invoked.
    A.setResponder(async () => ({ text: findingsJson([]) }))
    let callsAt30 = -1
    for (let i = 1; i <= 40; i++) {
      await A.manual("S1")
      if (i === 30) callsAt30 = A.generateCalls.length
    }
    check("T5 review spend stops growing (cap reached by call 30)", callsAt30 === A.generateCalls.length)
    check(
      "T5 capped calls report the safety ceiling",
      A.synthetics.filter((s) => s.text.includes("manual review hard cap")).length >= 15,
    )
    check("T5 total model calls stayed bounded (<=27)", A.generateCalls.length <= 27)
  } finally {
    A.cleanup()
  }

  // ---- B: turn review is opt-in; when on, findings stay passive ----
  const B = await makeHarness()
  try {
    B.setResponder(async () => ({ text: findingsJson([]) }))
    B.fireTool("S2", false) // observed session, dirty
    B.emit({ type: "session.idle", data: { sessionID: "S2" } })
    await sleep(250)
    check("T6 session.idle does NOT review while triggerOnTurn=false", B.generateCalls.length === 0)

    await B.setupCmd("S2", "triggerOnTurn true")
    B.setResponder(async () => ({
      text: findingsJson([
        { severity: "blocker", category: "security", summary: "hardcoded api key", advice: "rotate it" },
      ]),
    }))
    B.emit({ type: "session.idle", data: { sessionID: "S2" } })
    await waitFor(() => B.generateCalls.length >= 1, 3000, "turn review after enabling")
    await waitFor(
      () => B.synthetics.some((s) => s.text.includes("hardcoded api key")),
      3000,
      "turn finding to be delivered",
    )
    check(
      "T7 turn review (enabled via /advisor-setup) injects findings as passive notes, never steer",
      B.prompts.length === 0,
    )
  } finally {
    B.cleanup()
  }

  // ---- C: automatic review failures announce once, then pause ----
  // cooldownMs:0 so the 45s cooldown can't mask the pause semantics under test.
  const C = await makeHarness({ cooldownMs: 0 })
  try {
    // A broken advisor model: every review call throws.
    C.setResponder(async () => {
      throw new Error("401 unauthorized")
    })
    // Reach the stuck threshold (default 3) so an AUTOMATIC review fires.
    C.fireTool("S3", false)
    C.fireTool("S3", false)
    C.fireTool("S3", false)
    await waitFor(
      () => C.synthetics.some((n) => n.text.includes("automatic review failed")),
      3000,
      "automatic failure announcement",
    )
    check(
      "C1 automatic (stuck) review failure announces itself",
      C.synthetics.some((n) => n.text.includes("automatic review failed") && n.text.includes("401 unauthorized")),
    )
    check(
      "C1 announcement is a passive note, never a steer",
      C.prompts.length === 0,
    )

    // Keep hammering the stuck threshold — the pause must hold the line.
    const callsAfterAnnounce = C.generateCalls.length
    for (let i = 0; i < 6; i++) C.fireTool("S3", false)
    await sleep(300)
    check(
      "C2 automatic reviews are paused after a failure (no further model calls)",
      C.generateCalls.length === callsAfterAnnounce,
    )
    const notices = C.synthetics.filter((n) => n.text.includes("automatic review failed"))
    check("C2 announcement is capped at one per session", notices.length === 1)

    // A manual review still works on demand even while automatic is paused.
    const callsBeforeManual = C.generateCalls.length
    await C.manual("S3")
    check(
      "C3 /advisor-review still attempts a review while automatic is paused",
      C.generateCalls.length === callsBeforeManual + 1,
    )
    const manualNotices = C.synthetics.filter((n) => n.text.includes("automatic review failed"))
    check(
      "C3 manual failure does NOT double-post as an automatic announcement",
      manualNotices.length === 1,
    )

    // Recovery: a review that SUCCEEDS clears the pause, so a transient outage
    // doesn't disable the advisor for the rest of the session.
    C.setResponder(async () => ({ text: findingsJson([]) }))
    await C.manual("S3") // success → commit() resets errorAnnounced
    const callsBeforeStuck = C.generateCalls.length
    C.fireTool("S3", false) // reach the stuck threshold again
    C.fireTool("S3", false)
    C.fireTool("S3", false)
    await waitFor(
      () => C.generateCalls.length > callsBeforeStuck,
      3000,
      "automatic review to resume after recovery",
    )
    check(
      "C4 a successful review clears the pause (automatic reviews resume)",
      C.generateCalls.length > callsBeforeStuck,
    )
  } finally {
    C.cleanup()
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed")
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error("harness error:", e)
  process.exit(1)
})
