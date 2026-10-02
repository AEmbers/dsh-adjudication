/**
 * dsh-adjudication — the P4 bounded inference loop.
 *
 * WHAT WAS MISSING
 * ----------------
 * v1 produced a bounded work order (P0–P3) and then handed the loop to whatever
 * called it. There was no P4 per domain: the "bounded reasoning pass" was an
 * instruction in a prompt, not a component.
 *
 * This module IS the component. It takes an admitted plan (bundles + injected
 * rules) plus that domain's P4 prompt and runs exactly one bounded pass per
 * bundle, under a ledger it may not overrun, cancellable at any point.
 *
 * WHY `ctx.subagents` AND NOT `ctx.llm`
 * -------------------------------------
 * P4 needs four things, and three of them are `SubagentStartRequest` fields:
 *
 *   independent context  -> a child session, not the caller's history
 *   a tool whitelist     -> `toolFilter` (evidence tools only)
 *   structured output    -> `outputSchema` -> `result.structured`
 *   cancellation         -> `signal`
 *
 * `ctx.llm.stream()` gives cancellation and nothing else: no tool loop, no
 * context isolation, no schema. Rebuilding those on top of a raw completion is
 * exactly the "hand the loop to the caller" shape this module exists to remove.
 *
 * `ctx.llm` is still used, deliberately, in two places:
 *   1. the C-family domains (`market-research`, `reverse-engineering`), whose
 *      candidate-finding round has no honest upper bound and needs no tools;
 *   2. as the degraded path when `ctx.subagents` is absent — one-shot, no
 *      tools, flagged `degraded: true` and reported as such.
 *
 * Nothing here is a static import and nothing here touches a model directly:
 * both services arrive as plain objects, which is what makes this module
 * testable with fakes and what lets a host simply not mount them.
 *
 * DEGRADATION IS NEVER SILENT
 * ---------------------------
 * With neither service available the executor returns
 * `{ available: false, mode: 'none', reason: … }` — it never throws, and the
 * caller is expected to surface that reason instead of pretending a pass ran.
 */

/** Executor modes, best to worst. */
export const REASONER_MODES = Object.freeze(['subagents', 'llm', 'none'])

/** Stable outcome codes. Callers branch on these, never on message text. */
export const REASONER_CODES = Object.freeze({
  /** The pass completed; `findings` is what came back. */
  OK: 'OK',
  /** No reasoning service is mounted — the caller must run the loop itself. */
  E_NO_REASONER: 'E_NO_REASONER',
  /** The ledger was already spent, so no pass was started. */
  E_BUDGET_EXHAUSTED: 'E_BUDGET_EXHAUSTED',
  /** The caller's AbortSignal fired (before or during the pass). */
  E_ABORTED: 'E_ABORTED',
  /** The child stopped for a reason other than `completed`. */
  E_STOP_REASON: 'E_STOP_REASON',
  /** A provider could not honour a requested capability. */
  E_CAPABILITY: 'E_CAPABILITY',
  /** No provider/model route is configured for the LLM fallback. */
  E_NO_ROUTE: 'E_NO_ROUTE',
  /**
   * CHANGED (t46): the pass RAN and the model ANSWERED, but no verdict list could
   * be recovered from that answer (`structured` was null/verdict-less and the
   * text yielded no parseable `verdicts`).
   *
   * Why this needs its own code rather than `verdicts: []` with `ok: true`:
   * before t46 an unparseable answer and an honest "I have nothing to overturn"
   * answer produced byte-identical reports (`ok: true`, `code: 'OK'`,
   * `verdicts: []`, `errors: []`, reason `…0 verdict(s)`), so a reviewer that
   * answered the wrong question was folded into "nothing was rejected". That is
   * the same family as `E_NO_REASONER` / `E_BUDGET_EXHAUSTED` / `E_ABORTED`,
   * which this module already refuses to present as a clean pass.
   *
   * `ran` stays TRUE (a child really did run and the budget was really spent —
   * "it did not run" must remain a different state), `ok` becomes FALSE (the
   * stage did not succeed), and `verdicts` stays EMPTY: an unparseable answer
   * yields no verdicts, never a fabricated `keep`, and never a rejection. The
   * keep/drop decision is untouched — P6's verdicts never gated admission.
   */
  E_VERDICT_UNPARSED: 'E_VERDICT_UNPARSED',
  /**
   * CHANGED (t49): the P6 document renders BYTE-IDENTICAL to the P4 document, so
   * the "independent" re-check would be the same reviewer answering the same
   * question in the same words. P6 is NOT started.
   *
   * Why a refusal rather than a warning: an independent re-check whose text is
   * P4's text is worse than no re-check, because its verdicts would be reported
   * under a name ("independent") that the text does not support. The stage is
   * marked FAILED (`ok: false`) and named, exactly like the other four states
   * this module refuses to present as a clean pass.
   *
   * Why `ran` stays FALSE here and is TRUE for `E_VERDICT_UNPARSED`: nothing was
   * started and no budget was spent — this is a text-layer refusal, so pretending
   * a child ran would be the same lie in the other direction.
   *
   * The gate has two layers, and both are load-bearing for different inputs
   * (`lib/contracts.js:validateReviewPrompts` catches one function serving both
   * roles at LOAD time, where no context exists; this one catches two different
   * functions whose rendered text agrees, which no load-time check can see).
   */
  E_P6_NOT_INDEPENDENT: 'E_P6_NOT_INDEPENDENT',
})

/** Defaults. Every one of these is a bound, not a preference. */
export const REASONER_DEFAULTS = Object.freeze({
  maxRounds: 8,
  maxPromptChars: 24_000,
  maxFindings: 200,
  /** Retry once without outputSchema/toolFilter when a provider lacks them. */
  allowCapabilityDegrade: true,
  provider: null,
  model: null,
})

/** Capability names a provider may or may not support at start time. */
const OPTIONAL_CAPABILITIES = ['outputSchema', 'toolFilter', 'maxDepth']

/**
 * What the executor can do with the services it was given.
 * @returns {{ available: boolean, mode: string, degraded: boolean, reason: string }}
 */
export function describeReasoner(services = {}) {
  // A mounted service is not automatically a USABLE one, and this is where the
  // two halves used to disagree: `runLlmPass` has always checked `llm.stream`,
  // while this function accepted any `ctx.subagents` at all. A host that mounts
  // its own subagent service — DSH mounts `subagents` with `prompt()` and
  // `interruptByParent()`, NOT the `SubagentRuntime.start()` this reasoner was
  // written against — was therefore reported as `mode: 'subagents'`, and the
  // first pass died inside `services.subagents.start is not a function`, dressed
  // up as `E_CAPABILITY: the P6 pass failed`. The check below keeps the shape
  // question in ONE place and answers it before a pass is ever attempted.
  const subagents = services?.subagents ?? null
  if (subagents !== null && typeof subagents.start === 'function') {
    return { available: true, mode: 'subagents', degraded: false, reason: 'ctx.subagents is mounted — independent context, tool whitelist, structured output, cancellable' }
  }
  const llm = services?.llm ?? null
  const llmUsable = llm !== null && typeof llm.stream === 'function'
  if (subagents !== null && !llmUsable) {
    return { available: false, mode: 'none', degraded: true, reason: 'ctx.subagents is mounted but exposes no start() — it cannot run a pass, and no usable ctx.llm fallback is mounted' }
  }
  if (llmUsable) {
    return { available: true, mode: 'llm', degraded: true, reason: 'only ctx.llm is mounted — one-shot pass with no tool loop and no schema; findings are parsed from text' }
  }
  if (llm !== null) {
    return { available: false, mode: 'none', degraded: true, reason: 'ctx.llm is mounted but exposes no stream() — it cannot run a pass' }
  }
  return { available: false, mode: 'none', degraded: true, reason: 'neither ctx.subagents nor ctx.llm is mounted — P4 stays with the calling agent (v1 behaviour)' }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render one bundle's P4 prompt, falling back to the v1 `pack.prompt`. */
export function renderReviewPrompt(pack, prompts, context) {
  if (prompts !== undefined && prompts !== null && typeof prompts.review === 'function') {
    try {
      const rendered = prompts.review(context)
      const system = typeof rendered?.system === 'string' ? rendered.system : ''
      if (system !== '') {
        const parts = [system]
        if (typeof rendered.rules === 'string' && rendered.rules !== '') parts.push(rendered.rules)
        if (typeof rendered.budget === 'string' && rendered.budget !== '') parts.push(rendered.budget)
        return { text: parts.join('\n\n'), source: 'reviewPrompts' }
      }
    } catch (error) {
      // A broken prompt is a text-layer problem, never a pipeline failure.
      return { text: renderLegacyPrompt(pack, context), source: 'pack.prompt (reviewPrompts threw)', error: error?.message ?? String(error) }
    }
  }
  return { text: renderLegacyPrompt(pack, context), source: pack?.prompt ? 'pack.prompt' : '(none)', }
}

/**
 * Render the P6 (independent re-check) prompt. The symmetric half of
 * {@link renderReviewPrompt}, and CHANGED (t41): before this function existed,
 * `reviewPrompts.verify` had NO runtime renderer at all.
 *
 * Measured facts at t41 (all with line numbers, all reproducible):
 *   • `renderReviewPrompt` had exactly one caller, `createReasoner().run()`
 *     below, which renders the **P4** role;
 *   • `index.js` never mentioned `reviewPrompts` anywhere;
 *   • `lib/engine.js:critique` / `runCritiquePanel` — the stage that runs under
 *     the name "P6" — is a deterministic LOSS POLICY (orientation + protected
 *     subjects + `defended`/`disproved` flags) and reads no prompt text;
 *   • so 19 domains' `reviewPrompts.verify` was declared, contract-validated
 *     (`lib/contracts.js:validateReviewPrompts`) and loaded by the domain loader,
 *     and then never executed. Their own "P6 text ≠ P4 text" assertions could
 *     therefore never fire on a production path.
 *
 * That is the same defect class as t17's `anchorVerifier` (a declared extension
 * point nobody called), which is why the fix is a runtime path and not a note.
 *
 * INDEPENDENCE IS THE POINT. The context this function is handed is built from
 * `PROMPT_CONTEXT_FIELDS.verify = ['domain','pack','target','orientation','findings']`
 * and nothing else: no `ruleText`, no `bundle`, no `candidates`, no budget, no
 * work order. A P6 reviewer that can see P4's assignment is not an independent
 * check — see `runVerify()` for the field-set assertion and the tool filter.
 */
export function renderVerifyPrompt(pack, prompts, context) {
  if (prompts !== undefined && prompts !== null && typeof prompts.verify === 'function') {
    try {
      const rendered = prompts.verify(context)
      const system = typeof rendered?.system === 'string' ? rendered.system : ''
      if (system !== '') {
        const parts = [system]
        if (typeof rendered.instructions === 'string' && rendered.instructions !== '') parts.push(rendered.instructions)
        return { text: parts.join('\n\n'), source: 'reviewPrompts.verify' }
      }
    } catch (error) {
      // Same rule as P4: a broken prompt is a text-layer problem, never a
      // pipeline failure — and it is reported, not swallowed.
      return { text: renderLegacyVerifyPrompt(pack, context), source: 'legacy-verify (reviewPrompts.verify threw)', error: error?.message ?? String(error) }
    }
  }
  return { text: renderLegacyVerifyPrompt(pack, context), source: 'legacy-verify' }
}

/**
 * The P6 text for a pack that ships no `reviewPrompts` (the 19 v1 packs, and any
 * v2 pack that only migrated part of the way). Deliberately weaker than a
 * domain's own text: it states the independence boundary and the counter-argument
 * duty, and carries none of P4's material.
 */
function renderLegacyVerifyPrompt(pack, context) {
  const role = pack?.prompt?.role ?? `你是 ${pack?.title ?? pack?.id ?? '本领域'} 的复核者。`
  const findings = Array.isArray(context?.findings) ? context.findings : []
  return [
    role,
    '你是独立复核者（P6）。你只看到下面这份**发现清单**：看不到评审过程、看不到规则原文、也看不到本轮的工作单。',
    '反方义务：对每条发现先尝试推翻它；只有证据能正面支持时才判通过。',
    `损失取向：${context?.orientation ?? pack?.lossOrientation ?? 'precision-first'}`,
    `被审对象：${context?.target ?? '(未指定)'}`,
    `待复核发现：${findings.length} 条`,
    '输出：每条给出 id、keep(true/false)、reason。',
  ].filter(Boolean).join('\n')
}

function renderLegacyPrompt(pack, context) {
  const role = pack?.prompt?.role ?? `你是 ${pack?.title ?? pack?.id ?? '本领域'} 的评审者。`
  const instruction = pack?.prompt?.instruction ?? '只对本次范围内、有证据支持的发现给出意见。'
  const paths = (context?.bundle?.paths ?? []).join(', ')
  return [
    role,
    instruction,
    '',
    `损失取向：${context?.orientation ?? pack?.lossOrientation ?? 'precision-first'}`,
    `本捆范围：${paths === '' ? '(空)' : paths}`,
    context?.ruleText ? `\n${context.ruleText}` : '',
    '',
    '每条发现必须给出锚点（原文逐字 + 位置），无法给出锚点的发现会被引擎判定为未锚定并降级。',
  ].filter(Boolean).join('\n')
}

/**
 * Pull findings out of an unstructured completion. Tolerant by construction:
 * a fenced ```json block, a bare `{ findings: [...] }`, or a bare array. Never
 * throws — a pass that produced unparseable text produced no findings.
 */
export function extractFindings(text) {
  const raw = String(text ?? '')
  const candidates = []
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map((match) => match[1])
  candidates.push(...fenced, raw)
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    for (const form of [trimmed, sliceBalanced(trimmed, '{', '}'), sliceBalanced(trimmed, '[', ']')]) {
      if (form === null) continue
      try {
        const parsed = JSON.parse(form)
        if (Array.isArray(parsed)) return parsed
        if (Array.isArray(parsed?.findings)) return parsed.findings
      } catch {
        /* try the next shape */
      }
    }
  }
  return []
}

/**
 * Pull P6 verdicts out of an unstructured completion. Same tolerance as
 * {@link extractFindings}, different payload: `{ verdicts: [{ id, keep, reason }] }`.
 * Never throws — a parse that fails yields no verdicts.
 *
 * CHANGED (t46): this wrapper keeps its old signature, but the caller that must
 * tell "an empty verdict list" apart from "an unparseable answer" uses
 * {@link extractVerdictsDetailed} — `[]` alone cannot encode the difference.
 */
export function extractVerdicts(text) {
  return extractVerdictsDetailed(text).verdicts
}

/**
 * The t46 form of {@link extractVerdicts}: returns the verdicts AND whether the
 * answer was parseable at all.
 *
 * `parsed: true` means a JSON candidate WAS accepted — an empty `verdicts: []`
 * in that case is the model honestly saying "nothing to overturn".
 * `parsed: false` means nothing in the answer could be read as a verdict list;
 * that is a FAILED stage, not a silent pass, and the caller reports it as
 * `E_VERDICT_UNPARSED` rather than as "no verdicts".
 *
 * @returns {{ verdicts: object[], parsed: boolean, shape: string|null }}
 */
export function extractVerdictsDetailed(text) {
  const raw = String(text ?? '')
  const candidates = [...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map((match) => match[1]), raw]
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    for (const form of [trimmed, sliceBalanced(trimmed, '{', '}'), sliceBalanced(trimmed, '[', ']')]) {
      if (form === null) continue
      try {
        const parsed = JSON.parse(form)
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.verdicts) ? parsed.verdicts : null)
        if (list !== null) {
          return {
            verdicts: list.filter((entry) => entry !== null && typeof entry === 'object'),
            parsed: true,
            shape: Array.isArray(parsed) ? 'array' : 'verdicts',
          }
        }
      } catch {
        /* try the next shape */
      }
    }
  }
  return { verdicts: [], parsed: false, shape: null }
}

function sliceBalanced(text, open, close) {
  const start = text.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/** Concatenate whatever text a stream chunk carries, tolerating any shape. */
export function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk === null || typeof chunk !== 'object') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  if (Array.isArray(chunk.content)) {
    return chunk.content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('')
  }
  if (chunk.content !== null && typeof chunk.content === 'object' && typeof chunk.content.text === 'string') return chunk.content.text
  return ''
}

function abortError() {
  const error = new Error('[E_ABORTED] the P4 pass was cancelled by the caller')
  error.name = 'AbortError'
  error.code = REASONER_CODES.E_ABORTED
  return error
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === REASONER_CODES.E_ABORTED
}

async function safeDispose(handle) {
  try {
    await handle?.dispose?.()
  } catch {
    // A failed dispose must not mask the pass outcome.
  }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Build a P4 executor over injected services.
 *
 * @param {object|(() => object)} services `{ subagents?, llm? }` — plain objects,
 *   never imports. A FUNCTION is also accepted and re-read on every call, which
 *   is how the plugin handles a service that mounts after `apply()`.
 * @param {object} [options] see {@link REASONER_DEFAULTS}
 */
export function createReasoner(servicesOrGetter = {}, options = {}) {
  const settings = { ...REASONER_DEFAULTS, ...options }
  const readServices = typeof servicesOrGetter === 'function' ? servicesOrGetter : () => servicesOrGetter
  const describe = () => describeReasoner(readServices() ?? {})

  /**
   * Run one bounded pass per bundle.
   *
   * @param {object} request
   * @param {object}   request.pack          the domain pack (reviewPrompts / prompt / lossOrientation)
   * @param {string}   request.target        one-line description of what is being adjudicated
   * @param {object[]} request.bundles       P2 output: `[{ key, paths, ruleText }]`
   * @param {AbortSignal} [request.signal]   forwarded verbatim to the child / provider
   * @param {object}  [request.parent]       the calling Agent (subagents path requires it)
   * @param {object}  [request.outputSchema] structured-output schema for findings
   * @param {object}  [request.toolFilter]   evidence-tool whitelist
   * @param {number}  [request.maxDepth]
   * @param {() => object} [request.getBudget] reads the live P7 ledger
   * @param {(charge: {toolCalls?: number, text?: string}) => void} [request.onCharge]
   * @returns {Promise<object>} always resolves; failure is a code, never a throw
   */
  async function run(request = {}) {
    const services = readServices() ?? {}
    const status = describeReasoner(services)
    const outcome = {
      ok: false,
      available: status.available,
      mode: status.mode,
      degraded: status.degraded,
      code: status.available ? REASONER_CODES.OK : REASONER_CODES.E_NO_REASONER,
      reason: status.reason,
      rounds: 0,
      findings: [],
      skipped: [],
      errors: [],
      prompts: [],
    }

    const bundles = Array.isArray(request.bundles) ? request.bundles : []
    if (!status.available) {
      outcome.skipped = bundles.map((bundle) => bundle?.key ?? '(unnamed)')
      return outcome
    }
    if (bundles.length === 0) {
      outcome.ok = true
      outcome.reason = 'no bundles to adjudicate'
      return outcome
    }

    const signal = request.signal
    const getBudget = typeof request.getBudget === 'function' ? request.getBudget : () => ({ exhausted: false, settings: {} })
    const onCharge = typeof request.onCharge === 'function' ? request.onCharge : () => {}

    for (const bundle of bundles) {
      if (signal?.aborted === true) {
        outcome.code = REASONER_CODES.E_ABORTED
        outcome.reason = 'cancelled by the caller before this bundle started'
        outcome.skipped.push(bundle?.key ?? '(unnamed)')
        continue
      }
      if (outcome.rounds >= settings.maxRounds) {
        outcome.skipped.push(bundle?.key ?? '(unnamed)')
        outcome.reason = `round ceiling ${settings.maxRounds} reached`
        continue
      }
      if (getBudget()?.exhausted === true) {
        outcome.code = REASONER_CODES.E_BUDGET_EXHAUSTED
        outcome.reason = 'budget exhausted — the remaining bundles were not started and are reported as skipped, never dropped silently'
        outcome.skipped.push(bundle?.key ?? '(unnamed)')
        continue
      }

      // CHANGED (t17): the bundle is passed through, never rebuilt.
      //
      // This was the FOURTH instance of one defect class in this codebase: a
      // layer that "knows" the shape of domain-shaped data and reconstructs it
      // from a fixed key set. `bundle` used to be built as
      // `{ key, paths, rules }`, so a domain's `reviewPrompts.review(context)`
      // saw a stripped object and could not read its own bundle fields — the
      // very fields its `bundleKey.resolve` had just used to group them.
      //
      // The rule is now explicit and universal: **spread, then default**. Add
      // the convenience keys if they are missing; never discard what the caller
      // sent, because the caller knows its own shape and this layer does not.
      const context = {
        domain: request.pack?.id ?? null,
        pack: request.pack,
        target: request.target ?? null,
        orientation: request.pack?.lossOrientation ?? 'precision-first',
        bundle: bundle === null || bundle === undefined
          ? { key: null, paths: [], rules: [] }
          : { ...bundle, key: bundle.key ?? null, paths: bundle.paths ?? [], rules: bundle.rules ?? [] },
        ruleText: bundle?.ruleText ?? '',
        budget: { ...(getBudget()?.settings ?? {}) },
        // `bundle.candidates` never existed on the bundle shape produced by
        // `lib/engine.js:bundle()` (which yields `{key, entries}`), so this key
        // always resolved to `[]` — a field that was read but never populated.
        // The entries ARE the candidates, so fall back to them.
        candidates: bundle?.candidates ?? bundle?.entries ?? [],
      }
      const rendered = renderReviewPrompt(request.pack, request.pack?.reviewPrompts, context)
      const promptText = rendered.text.length > settings.maxPromptChars
        ? rendered.text.slice(0, settings.maxPromptChars)
        : rendered.text
      outcome.prompts.push({ bundle: bundle?.key ?? null, source: rendered.source, chars: promptText.length, truncated: rendered.text.length > promptText.length })

      // Lookahead, exactly like `charge()`: the ledger is debited BEFORE the
      // work is admitted, so a pass that would overrun is never started.
      onCharge({ toolCalls: 1, text: promptText })
      outcome.rounds += 1

      try {
        const found = status.mode === 'subagents'
          ? await runSubagentPass(services, { request, bundle, promptText })
          : await runLlmPass(services, { request, bundle, promptText })
        if (found.code !== undefined) {
          outcome.code = found.code
          outcome.reason = found.reason
          if (found.code === REASONER_CODES.E_ABORTED) {
            outcome.skipped.push(bundle?.key ?? '(unnamed)')
            continue
          }
          outcome.errors.push({ bundle: bundle?.key ?? null, code: found.code, detail: found.detail })
          continue
        }
        if (found.degraded === true) outcome.degraded = true
        for (const finding of found.findings.slice(0, settings.maxFindings - outcome.findings.length)) {
          outcome.findings.push({ ...finding, bundle: finding?.bundle ?? bundle?.key ?? null })
        }
      } catch (error) {
        if (isAbort(error)) {
          outcome.code = REASONER_CODES.E_ABORTED
          outcome.reason = 'cancelled by the caller during the pass'
          outcome.skipped.push(bundle?.key ?? '(unnamed)')
          continue
        }
        outcome.errors.push({ bundle: bundle?.key ?? null, code: REASONER_CODES.E_CAPABILITY, detail: error?.message ?? String(error) })
      }
    }

    outcome.ok = outcome.errors.length === 0 && outcome.code !== REASONER_CODES.E_ABORTED
    if (outcome.ok && outcome.code === REASONER_CODES.OK) {
      outcome.reason = `${outcome.rounds} bounded pass(es) completed via ${status.mode}`
    }
    return outcome
  }

  // --- P6: the independent re-check (CHANGED (t41) — it now has a runtime) ---

  /**
   * Run the P6 independent re-check exactly ONCE over a finding set.
   *
   * The symmetric half of `run()`: where P4 runs one pass per bundle with the
   * domain's `reviewPrompts.review`, P6 runs one pass over the anchored findings
   * with the domain's `reviewPrompts.verify` — text that, until t41, nothing in
   * the repository ever rendered (`renderVerifyPrompt` did not exist; `index.js`
   * never mentioned `reviewPrompts`; the stage called "P6" in `lib/engine.js`
   * is a deterministic loss policy that reads no prompt at all).
   *
   * THREE INDEPENDENCE PROPERTIES, EACH MECHANICAL RATHER THAN PROMISED:
   *
   *   1. **The context is the contract's verify field set.**
   *      `PROMPT_CONTEXT_FIELDS.verify` is `['domain','pack','target','orientation','findings']`
   *      and the object is BUILT key by key — no spread of anything a caller
   *      passes. P4's material (`ruleText`, `bundle`, `candidates`, `budget`, the
   *      work order) is therefore not merely unwritten, it is unreachable:
   *      `outcome.contextFields` reports exactly which keys the prompt saw.
   *
   *   2. **No domain evidence tools.** An independent re-check may not
   *      re-investigate with the same instruments it is checking. `runVerify`
   *      always sends a `toolFilter` (defaulting to `{ allow: [] }`, i.e. none) —
   *      omitting it would leave the default tool surface in place. If a provider
   *      declines the filter capability, `startSubagent` drops it and the outcome
   *      is reported `degraded: true` rather than silently.
   *
   *   3. **The P6 text is not the P4 text.** For a pack that ships
   *      `reviewPrompts`, P6 renders `verify()` and P4 renders `review()`; the
   *      legacy fallbacks are two different documents as well. CHANGED (t49):
   *      this is no longer a promise — the two renderers are compared on the
   *      same context and an identical pair is refused with
   *      `E_P6_NOT_INDEPENDENT` (see the gate below and the load-time half in
   *      `lib/contracts.js:validateReviewPrompts`).
   *
   * P6's output is a JUDGEMENT SET (`verdicts`), reported to the caller. It does
   * NOT take the keep/drop decision away from the loss policy: `lossOrientation`
   * (precision-first / recall-first) plus protected subjects remains the thing
   * that decides admissibility, exactly as documented at `lib/engine.js:critique`.
   * Changing that would put the same knob on the dial twice.
   *
   * @param {object} request
   * @param {object}   request.pack        the domain pack (`reviewPrompts` / `prompt`)
   * @param {string}   [request.target]    one-line description of what is being adjudicated
   * @param {object[]} request.findings    the ANCHORED findings, verdict metadata included
   * @param {AbortSignal} [request.signal]
   * @param {object}   [request.parent]    the calling Agent (subagents path requires it)
   * @param {object}   [request.outputSchema]
   * @param {object}   [request.toolFilter] defaults to `{ allow: [] }` — P6 never gets domain tools
   * @param {number}   [request.maxDepth]
   * @param {() => object} [request.getBudget]
   * @param {(charge: object) => void} [request.onCharge]
   * @returns {Promise<object>} always resolves; failure is a code, never a throw
   */
  async function runVerify(request = {}) {
    const services = readServices() ?? {}
    const status = describeReasoner(services)
    const findings = Array.isArray(request.findings) ? request.findings : []
    const outcome = {
      ok: false,
      ran: false,
      available: status.available,
      mode: status.mode,
      degraded: status.degraded,
      code: status.available ? REASONER_CODES.OK : REASONER_CODES.E_NO_REASONER,
      reason: status.reason,
      rounds: 0,
      verdicts: [],
      errors: [],
      prompt: null,
      contextFields: null,
      toolFilter: null,
      anchoredFindings: findings.length,
    }

    if (!status.available) {
      outcome.reason = `${status.reason} — P6 stays with the calling agent`
      return outcome
    }
    if (findings.length === 0) {
      outcome.ok = true
      outcome.reason = 'no anchored findings to re-check'
      return outcome
    }
    if (request.signal?.aborted === true) {
      outcome.code = REASONER_CODES.E_ABORTED
      outcome.reason = 'cancelled by the caller before P6 started'
      return outcome
    }
    const getBudget = typeof request.getBudget === 'function' ? request.getBudget : () => ({ exhausted: false, settings: {} })
    const onCharge = typeof request.onCharge === 'function' ? request.onCharge : () => {}
    if (getBudget()?.exhausted === true) {
      outcome.code = REASONER_CODES.E_BUDGET_EXHAUSTED
      outcome.reason = 'budget exhausted — P6 was not started and says so rather than reporting "nothing rejected"'
      return outcome
    }

    // (1) The context is BUILT from the contract's verify field set, key by key.
    const context = {
      domain: request.pack?.id ?? null,
      pack: request.pack,
      target: request.target ?? null,
      orientation: request.pack?.lossOrientation ?? 'precision-first',
      findings,
    }
    outcome.contextFields = Object.keys(context)

    const rendered = renderVerifyPrompt(request.pack, request.pack?.reviewPrompts, context)
    const promptText = rendered.text.length > settings.maxPromptChars
      ? rendered.text.slice(0, settings.maxPromptChars)
      : rendered.text
    outcome.prompt = {
      source: rendered.source,
      chars: promptText.length,
      truncated: rendered.text.length > promptText.length,
      error: rendered.error ?? null,
    }

    // (1b) INDEPENDENCE GATE, LAYER 2 (CHANGED (t49)): the P6 document must not
    // BE the P4 document. Both renderers are handed the SAME object here, so the
    // comparison isolates the one variable that matters — the prompt function —
    // and answers the only question a validator cannot: "given identical input,
    // do the two roles say different things?".
    //
    // Measured over the 19 shipped packs (t49 probe, same context): 19/19 render
    // different texts, 0/19 alias the two functions, 0 throw. So this never fires
    // for a domain that ships today, and it fires for exactly the two shapes that
    // would make P6 a second pass of P4: one function serving both roles, or two
    // functions whose text agrees. `lib/kernel-test.mjs` §17 drives both.
    const reviewRendered = renderReviewPrompt(request.pack, request.pack?.reviewPrompts, context)
    if (rendered.text === reviewRendered.text) {
      outcome.code = REASONER_CODES.E_P6_NOT_INDEPENDENT
      outcome.ok = false
      outcome.reason = 'the P6 prompt rendered byte-identical to the P4 prompt for the same context — an independent re-check that asks the same question in the same words is not independent, so P6 was NOT started'
      outcome.errors.push({
        code: REASONER_CODES.E_P6_NOT_INDEPENDENT,
        detail: `renderVerifyPrompt() and renderReviewPrompt() produced the same ${rendered.text.length} characters (P6 source=${rendered.source}, P4 source=${reviewRendered.source})`,
      })
      return outcome
    }

    // (2) P6 never gets the domain's evidence tools.
    const toolFilter = request.toolFilter ?? { allow: [] }
    outcome.toolFilter = toolFilter

    onCharge({ toolCalls: 1, text: promptText })
    outcome.rounds = 1

    try {
      const found = status.mode === 'subagents'
        ? await runVerifySubagent(services, { request, promptText, toolFilter })
        : await runVerifyLlm(services, { request, promptText })
      if (found.code !== undefined) {
        outcome.code = found.code
        outcome.reason = found.reason
        outcome.errors.push({ code: found.code, detail: found.detail ?? null })
        return outcome
      }
      if (found.degraded === true) outcome.degraded = true
      // CHANGED (t46): the answer was not usable. Report it as a FAILED stage:
      // `ran: true` (a child really ran and the budget was spent — "it did not
      // run" has to stay a different state), `ok: false`, a dedicated code, an
      // `errors` entry, and a reason that names the parse failure. `verdicts`
      // stays empty: no fabricated `keep`, no rejection, and admission is
      // untouched because P6's verdicts never gated it in the first place.
      if (found.parsed === false) {
        outcome.code = REASONER_CODES.E_VERDICT_UNPARSED
        outcome.reason = `the P6 answer could not be parsed into a verdict list (structured=${found.shape === null ? 'absent' : found.shape}); `
          + 'this is reported as a FAILED re-check, never as "nothing was rejected"'
        outcome.errors.push({
          code: REASONER_CODES.E_VERDICT_UNPARSED,
          detail: 'no verdict list survived parsing: the answer was neither a `verdicts` array nor a JSON array, and no fenced block contained one',
        })
        outcome.ran = true
        outcome.ok = false
        return outcome
      }
      outcome.verdicts = found.verdicts.slice(0, settings.maxFindings)
      outcome.ran = true
      outcome.ok = true
      outcome.reason = `independent re-check completed via ${status.mode}: ${outcome.verdicts.length} verdict(s)`
    } catch (error) {
      if (isAbort(error)) {
        outcome.code = REASONER_CODES.E_ABORTED
        outcome.reason = 'cancelled by the caller during P6'
        return outcome
      }
      outcome.code = REASONER_CODES.E_CAPABILITY
      outcome.reason = 'the P6 pass failed — reported, never silently treated as "nothing rejected"'
      outcome.errors.push({ code: REASONER_CODES.E_CAPABILITY, detail: error?.message ?? String(error) })
    }
    return outcome
  }

  async function runVerifySubagent(services, { request, promptText, toolFilter }) {
    const base = {
      label: `adjudicate ${request.pack?.id ?? 'domain'} · P6 独立复核`,
      parent: request.parent,
      prompt: [{ type: 'text', text: promptText }],
      signal: request.signal,
    }
    const optional = { toolFilter }
    if (request.outputSchema !== undefined) optional.outputSchema = request.outputSchema
    if (Number.isSafeInteger(request.maxDepth)) optional.maxDepth = request.maxDepth

    const handle = await startSubagent(services, base, optional)
    try {
      const result = await handle.result
      const stopReason = result?.stopReason
      if (stopReason === 'aborted') {
        return { code: REASONER_CODES.E_ABORTED, reason: 'the P6 child reported stopReason "aborted"' }
      }
      if (stopReason !== 'completed') {
        return {
          code: REASONER_CODES.E_STOP_REASON,
          reason: `the P6 child stopped with "${String(stopReason)}" — its verdicts are partial and are NOT treated as "nothing was rejected"`,
          detail: result?.diagnostic,
        }
      }
      // CHANGED (t46): `parsed` travels with the verdicts. A structured answer
      // that carries a `verdicts` ARRAY — even `[]` — is a parsed answer by
      // construction; anything else has to be recovered from the text, and when
      // that recovery fails the caller must say so (see REASONER_CODES.E_VERDICT_UNPARSED).
      if (Array.isArray(result?.structured?.verdicts)) {
        return { verdicts: result.structured.verdicts, parsed: true, shape: 'structured.verdicts', degraded: handle.__capabilityDegraded === true }
      }
      if (Array.isArray(result?.structured)) {
        return { verdicts: result.structured, parsed: true, shape: 'structured.array', degraded: handle.__capabilityDegraded === true }
      }
      const detailed = extractVerdictsDetailed(contentText(result?.output))
      return { verdicts: detailed.verdicts, parsed: detailed.parsed, shape: detailed.shape, degraded: handle.__capabilityDegraded === true }
    } finally {
      await safeDispose(handle)
    }
  }

  async function runVerifyLlm(services, { request, promptText }) {
    const llm = services.llm
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return { code: REASONER_CODES.E_NO_REASONER, reason: 'ctx.llm does not expose stream()' }
    }
    const route = resolveRoute(llm, settings)
    if (route.provider === null || route.model === null) {
      return { code: REASONER_CODES.E_NO_ROUTE, reason: 'the llm fallback needs options.reasoner.provider and .model, or a single registered route' }
    }
    const chunks = []
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: promptText,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(request.target ?? request.pack?.id ?? 'adjudicate') }] }],
      signal: request.signal,
    })
    for await (const chunk of stream) {
      if (request.signal?.aborted === true) throw abortError()
      const piece = chunkText(chunk)
      if (piece !== '') chunks.push(piece)
    }
    // CHANGED (t46): the llm fallback reports `parsed` for the same reason the
    // subagents path does — a stream that never contained a verdict list is a
    // failed stage, not an empty one.
    const detailed = extractVerdictsDetailed(chunks.join(''))
    return { verdicts: detailed.verdicts, parsed: detailed.parsed, shape: detailed.shape, degraded: true }
  }

  // --- subagents path -------------------------------------------------------

  async function runSubagentPass(services, { request, bundle, promptText }) {
    const base = {
      label: `adjudicate ${request.pack?.id ?? 'domain'} · ${bundle?.key ?? '(bundle)'}`,
      parent: request.parent,
      prompt: [{ type: 'text', text: promptText }],
      signal: request.signal,
    }
    const optional = {}
    if (request.outputSchema !== undefined) optional.outputSchema = request.outputSchema
    if (request.toolFilter !== undefined) optional.toolFilter = request.toolFilter
    if (Number.isSafeInteger(request.maxDepth)) optional.maxDepth = request.maxDepth

    const handle = await startSubagent(services, base, optional)
    try {
      const result = await handle.result
      const stopReason = result?.stopReason
      if (stopReason === 'aborted') {
        return { code: REASONER_CODES.E_ABORTED, reason: 'the child reported stopReason "aborted"', detail: result?.diagnostic }
      }
      if (stopReason !== 'completed') {
        return { code: REASONER_CODES.E_STOP_REASON, reason: `the child stopped with "${String(stopReason)}" — its output is partial and is NOT treated as "no findings"`, detail: result?.diagnostic }
      }
      const findings = Array.isArray(result?.structured?.findings)
        ? result.structured.findings
        : (Array.isArray(result?.structured) ? result.structured : extractFindings(contentText(result?.output)))
      return { findings, degraded: handle.__capabilityDegraded === true }
    } finally {
      await safeDispose(handle)
    }
  }

  async function startSubagent(services, base, optional) {
    try {
      const handle = await services.subagents.start({ ...base, ...optional })
      return handle ?? {}
    } catch (error) {
      const declined = Object.keys(optional).filter((key) => OPTIONAL_CAPABILITIES.includes(key))
      if (settings.allowCapabilityDegrade !== true || declined.length === 0 || isAbort(error)) throw error
      // A provider that cannot honour outputSchema/toolFilter rejects at start.
      // Dropping those protections is a DEGRADATION and is reported as one.
      const handle = await services.subagents.start(base)
      handle.__capabilityDegraded = true
      handle.__capabilityNote = `provider declined ${declined.join(', ')}: ${error?.message ?? String(error)}`
      return handle
    }
  }

  // --- llm path -------------------------------------------------------------

  async function runLlmPass(services, { request, bundle, promptText }) {
    const llm = services.llm
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return { code: REASONER_CODES.E_NO_REASONER, reason: 'ctx.llm does not expose stream()' }
    }
    const route = resolveRoute(llm, settings)
    if (route.provider === null || route.model === null) {
      return { code: REASONER_CODES.E_NO_ROUTE, reason: 'the llm fallback needs options.reasoner.provider and .model, or a single registered route' }
    }
    const chunks = []
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: promptText,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(request.target ?? request.pack?.id ?? 'adjudicate') }] }],
      signal: request.signal,
    })
    for await (const chunk of stream) {
      if (request.signal?.aborted === true) throw abortError()
      const piece = chunkText(chunk)
      if (piece !== '') chunks.push(piece)
    }
    return { findings: extractFindings(chunks.join('')), degraded: true }
  }

  return {
    /** Live view: a service that mounts later flips this without a re-apply. */
    describe,
    get mode() { return describe().mode },
    get available() { return describe().available },
    get degraded() { return describe().degraded },
    get reason() { return describe().reason },
    settings,
    run,
    /** CHANGED (t41): the P6 runtime path — one independent re-check pass. */
    runVerify,
  }
}

/** Resolve the provider/model route for the LLM fallback, without guessing. */
export function resolveRoute(llm, settings = {}) {
  if (typeof settings.provider === 'string' && settings.provider !== '' && typeof settings.model === 'string' && settings.model !== '') {
    return { provider: settings.provider, model: settings.model, source: 'configured' }
  }
  try {
    const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
    if (providers.length === 1) {
      const models = typeof llm?.listModels === 'function' ? llm.listModels({ provider: providers[0].id }) : []
      if (Array.isArray(models) && models.length === 1) {
        return { provider: providers[0].id, model: models[0].id ?? models[0].name ?? models[0], source: 'single-registered-route' }
      }
    }
  } catch {
    /* fall through: an unresolvable route is reported, not guessed */
  }
  return { provider: null, model: null, source: 'unresolved' }
}

/** Flatten a `ContentBlock[]` (or a string) into plain text. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('\n')
  return ''
}
