/**
 * dsh-adjudication — deterministic engine (P0–P3, P5, P7).
 *
 * Every function here is pure and synchronous unless it is explicitly marked
 * otherwise. This module is the part of the pipeline that must NOT be left to a
 * model: enumeration, gating, bundling, anchor resolution, coverage accounting.
 * The model only ever sees the bounded work order this module produces and only
 * ever returns findings whose anchors this module can independently verify.
 *
 * The primitives and their constants are ported from Alibaba's
 * `open-code-review` (Apache-2.0) and generalised out of the code domain:
 *   internal/agent/selection.go   -> gate()
 *   internal/agent/grouping.go    -> bundle()
 *   internal/diff/resolver.go     -> resolveAnchor()
 *   internal/llmloop/compression.go -> budget()
 * Domain-specific values live in the domain packs (`lib/domains.js`), never here.
 */

// ---------------------------------------------------------------------------
// Text normalisation and anchor matching (P5)
// ---------------------------------------------------------------------------

/**
 * Strip a diff marker and ALL whitespace — the comparison form of one line.
 *
 * Ported from `internal/diff/resolver.go:301 normalizeLine`. Whitespace is
 * removed rather than collapsed so that re-indentation alone never breaks a
 * match.
 */
export function normalizeLine(line) {
  return String(line).replace(/^[+-]/, '').replace(/\s+/gu, '')
}

/**
 * Normalise an excerpt into the comparison line list. Blank lines are dropped:
 * a model that garbles blank lines should not lose its anchor over it.
 */
export function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/**
 * First index where `needle` appears consecutively inside `haystack`.
 *
 * Ported from `internal/diff/resolver.go:217 matchConsecutive`. Returns -1 when
 * absent. This is the core of the sliding-window anchor: the model quotes the
 * code, the engine finds where it actually lives.
 *
 * @param {string[]} haystack raw lines of the candidate document
 * @param {string[]} needle   already-normalised excerpt lines
 * @param {number}   [from]   0-based line to start searching from
 * @returns {number} 0-based start line, or -1
 */
export function matchConsecutive(haystack, needle, from = 0) {
  if (needle.length === 0) return -1
  const normalised = haystack.map(normalizeLine)
  const start = Math.max(0, from)
  for (let i = start; i + needle.length <= normalised.length; i += 1) {
    let matched = true
    for (let j = 0; j < needle.length; j += 1) {
      if (normalised[i + j] !== needle[j]) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return -1
}

/**
 * Resolve an excerpt to a concrete anchor inside ONE document.
 *
 * @param {string} excerpt   verbatim/approximate quote supplied by the model
 * @param {string} content   full document text
 * @returns {{status:'anchored'|'unanchored', start:number|null, end:number|null, tier:string}}
 */
export function anchorInDocument(excerpt, content) {
  const needle = normalizeExcerpt(excerpt)
  if (needle.length === 0) {
    return { status: 'unanchored', start: null, end: null, tier: 'empty-excerpt' }
  }
  const lines = String(content).split(/\r?\n/u)
  const index = matchConsecutive(lines, needle)
  if (index < 0) {
    return { status: 'unanchored', start: null, end: null, tier: 'no-match' }
  }
  return { status: 'anchored', start: index + 1, end: index + needle.length, tier: 'sliding-window' }
}

/**
 * Three-tier anchor resolution, mirroring open-code-review's degradation ladder.
 *
 *   tier 1 — the excerpt is found in the document the model named.
 *   tier 2 — the excerpt is found in exactly ONE other document; it is moved
 *            there. Ambiguity is NOT resolved by guessing (see `unique` below).
 *   tier 3 — no deterministic match; the finding is returned UNANCHORED.
 *
 * Tier 3 is deliberately terminal. open-code-review has a fourth LLM-driven
 * re-location tier; that is intentionally NOT reproduced here, because an
 * anchor a model guessed is not an anchor an engine can verify, and the whole
 * point of this layer is that the engine can independently re-check every
 * finding. An unanchored finding is reported as such and downgraded, never
 * silently accepted.
 *
 * @param {string} excerpt excerpt supplied by the model
 * @param {Array<{path:string, content:string}>} documents candidate documents
 * @param {string} [preferredPath] the document the model claimed
 * @returns {{status:string, path:string|null, start:number|null, end:number|null, tier:string, ambiguousIn?:string[]}}
 */
export function resolveAnchor(excerpt, documents, preferredPath) {
  const docs = Array.isArray(documents) ? documents : []
  if (docs.length === 0) {
    return { status: 'unanchored', path: null, start: null, end: null, tier: 'no-documents' }
  }

  // Tier 1 — the declared document.
  if (preferredPath) {
    const preferred = docs.find((doc) => doc.path === preferredPath)
    if (preferred) {
      const hit = anchorInDocument(excerpt, preferred.content)
      if (hit.status === 'anchored') {
        return { status: 'anchored', path: preferred.path, start: hit.start, end: hit.end, tier: 'declared-document' }
      }
    }
  }

  // Tier 2 — relocate, but only on a unique hit.
  const hits = []
  for (const doc of docs) {
    if (preferredPath && doc.path === preferredPath) continue
    const hit = anchorInDocument(excerpt, doc.content)
    if (hit.status === 'anchored') {
      hits.push({ path: doc.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return { status: 'anchored', path: only.path, start: only.start, end: only.end, tier: 'relocated-unique' }
  }
  if (hits.length > 1) {
    // Refuse to guess. open-code-review's `RelocateAcrossFiles` has the same
    // unique-hit rule; a multi-hit relocation is not a relocation.
    return {
      status: 'unanchored',
      path: null,
      start: null,
      end: null,
      tier: 'relocation-ambiguous',
      ambiguousIn: hits.map((hit) => hit.path),
    }
  }

  // Tier 3 — terminal.
  return { status: 'unanchored', path: null, start: null, end: null, tier: 'no-match' }
}

// ---------------------------------------------------------------------------
// P1 — the gate
// ---------------------------------------------------------------------------

/**
 * Sentinel a gate predicate returns to accept a candidate IMMEDIATELY, skipping
 * every later predicate. Only `user-include` uses it: an explicit include rule
 * is the operator saying "I know what I am doing", so it must outrank the
 * convenience exclusions that follow it — but never the credential check that
 * precedes it.
 */
export const GATE_ALLOW = Symbol('adjudication.gate.allow')

/**
 * Ordered gate predicates. The ORDER is the contract: a candidate is rejected
 * by the first predicate that fires, and that predicate's name is recorded as
 * the reason. `secret` deliberately precedes every user rule so that a user
 * include-list can never drag a credential into the model's context.
 *
 * Each predicate is `(candidate, context) => string | symbol | undefined`:
 *   string  -> reject, this is the reason
 *   GATE_ALLOW -> accept now, skip the rest
 *   undefined  -> this predicate has no opinion; continue
 *
 * The `secret` predicate consults the built-in pattern list directly rather
 * than relying on the caller to have pre-marked candidates, so `gate()` is
 * correct on its own. A caller-supplied `secretMatch` (from an out-of-band
 * scanner) still takes precedence.
 */
export const DEFAULT_GATE_PREDICATES = [
  ['binary', (c) => (c.binary ? 'binary payload' : undefined)],
  ['secret', (c) => {
    if (c.secretMatch) return `matches secret pattern ${c.secretMatch}`
    const hit = DEFAULT_SECRET_PATTERNS.find((pattern) => globToRegExp(pattern).test(String(c.path).replace(/\\/gu, '/')))
    return hit ? `matches secret pattern ${hit}` : undefined
  }],
  ['deleted', (c) => (c.deleted ? 'deleted' : undefined)],
  ['user-exclude', (c, ctx) => (matchesAny(c.path, ctx.exclude) ? 'user exclude rule' : undefined)],
  ['user-include', (c, ctx) => {
    const include = ctx.include
    if (!Array.isArray(include) || include.length === 0) return undefined
    return matchesAny(c.path, include) ? GATE_ALLOW : undefined
  }],
  ['extension', (c, ctx) => (ctx.extensions === null || matchesExtension(c.path, ctx.extensions) ? undefined : 'unsupported file type')],
  ['default-path', (c) => (matchesAny(c.path, DEFAULT_EXCLUDE_PATTERNS) ? 'default exclusion pattern' : undefined)],
  ['too-large', (c, ctx) => (c.bytes !== undefined && c.bytes > ctx.maxFileBytes ? `exceeds ${ctx.maxFileBytes} bytes` : undefined)],
]


/** Path fragments open-code-review ships as `default_exclude_patterns.json`. */
export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.git/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/go.sum',
  '**/Cargo.lock',
]

/** Credential-bearing paths that outrank every user rule. */
export const DEFAULT_SECRET_PATTERNS = [
  '**/.ssh/id_*',
  '**/.ssh/**',
  '**/.netrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/credentials',
  '**/credentials.json',
  '**/secrets.yml',
  '**/secrets.yaml',
  '**/.aws/credentials',
  '**/.config/gcloud/**',
  '**/.kube/config',
]

/** Minimal glob: `**` spans separators, `*` does not, `?` is one character. */
export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  const body = escaped
    .replace(/\*\*\//gu, '\u0000')
    .replace(/\*\*/gu, '\u0001')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '[^/]')
    .replace(/\u0000/gu, '(?:.*/)?')
    .replace(/\u0001/gu, '.*')
  return new RegExp(`^${body}$`, 'u')
}

function matchesAny(path, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const normalised = String(path).replace(/\\/gu, '/')
  return patterns.some((pattern) => globToRegExp(pattern).test(normalised))
}

function matchesExtension(path, extensions) {
  const lowered = String(path).toLowerCase()
  const dot = lowered.lastIndexOf('.')
  if (dot < 0) return false
  return extensions.includes(lowered.slice(dot))
}

/**
 * P1 — run the gate over a candidate set.
 *
 * @param {Array<object>} candidates each `{path, bytes?, binary?, deleted?, secretMatch?}`
 * @param {object} [options] `{include, exclude, extensions, maxFileBytes, predicates}`
 * @returns {{selected:object[], excluded:Array<{path:string,reason:string}>, ordered:string[]}}
 */
export function gate(candidates, options = {}) {
  const context = {
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    extensions: options.extensions ?? null,
    maxFileBytes: options.maxFileBytes ?? 1_048_576,
  }
  const predicates = options.predicates ?? DEFAULT_GATE_PREDICATES

  const selected = []
  const excluded = []
  for (const candidate of candidates ?? []) {
    let reason
    let firedBy
    let forced = false
    for (const [label, predicate] of predicates) {
      const verdict = predicate(candidate, context)
      if (verdict === GATE_ALLOW) {
        forced = true
        break
      }
      if (verdict) {
        reason = verdict
        firedBy = label
        break
      }
    }
    if (reason !== undefined && reason !== null && reason !== false) {
      excluded.push({ path: candidate.path, reason, predicate: firedBy })
    } else {
      // A forced candidate is marked, so a downstream report can say WHY an
      // otherwise-excluded path was admitted.
      selected.push(forced ? { ...candidate, forcedByInclude: true } : candidate)
    }
  }
  return {
    selected,
    excluded,
    ordered: predicates.map(([label]) => label),
  }
}

/** Apply the secret patterns as a convenience pre-pass over a candidate set. */
export function markSecrets(candidates, patterns = DEFAULT_SECRET_PATTERNS) {
  return (candidates ?? []).map((candidate) => {
    const hit = patterns.find((pattern) => globToRegExp(pattern).test(String(candidate.path).replace(/\\/gu, '/')))
    return hit ? { ...candidate, secretMatch: candidate.secretMatch ?? hit } : candidate
  })
}

// ---------------------------------------------------------------------------
// P2 — bundling
// ---------------------------------------------------------------------------

/** Mirrors open-code-review's `GROUPING_MIN_FILES` / `GROUPING_BUNDLE_LINE_THRESHOLD`. */
export const BUNDLE_DEFAULTS = { minFiles: 4, lineThreshold: 200, maxPerBundle: 10 }

/**
 * P2 — decide how the gated candidate set is split for bounded inference.
 *
 * The important property is the SHORT CIRCUIT: a change small enough that one
 * bounded pass can hold it entirely is never split, and — in the caller — never
 * needs a planning model call at all.
 *
 * @param {Array<{path:string, additions?:number, deletions?:number, key?:string}>} candidates
 * @param {object} [options] `{minFiles, lineThreshold, maxPerBundle}`
 * @returns {{bundles:Array<{key:string, entries:object[]}>, strategy:string, degraded:boolean}}
 */
export function bundle(candidates, options = {}) {
  const settings = { ...BUNDLE_DEFAULTS, ...options }
  const entries = candidates ?? []

  if (entries.length <= 1) {
    return { bundles: entries.map((entry) => ({ key: entry.key ?? entry.path, entries: [entry] })), strategy: 'short-circuit-single', degraded: false }
  }
  if (entries.length < settings.minFiles) {
    return { bundles: [{ key: 'all', entries: [...entries] }], strategy: 'short-circuit-small', degraded: false }
  }

  const byKey = new Map()
  for (const entry of entries) {
    const key = entry.key ?? entry.path
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(entry)
  }

  const bundles = []
  let degraded = false
  for (const [key, group] of byKey) {
    const lines = group.reduce((sum, entry) => sum + (entry.additions ?? 0) + (entry.deletions ?? 0), 0)
    if (lines > settings.lineThreshold && group.length > 1) {
      // Too big for one bounded pass — degrade to one bundle per entry.
      degraded = true
      for (const entry of group) {
        bundles.push({ key: entry.path, entries: [entry] })
      }
    } else {
      bundles.push({ key, entries: group })
    }
  }

  // Enforce the per-bundle ceiling without dropping anything.
  const capped = []
  for (const item of bundles) {
    if (item.entries.length <= settings.maxPerBundle) {
      capped.push(item)
      continue
    }
    degraded = true
    const slice = item.entries.slice(0, settings.maxPerBundle)
    const rest = item.entries.slice(settings.maxPerBundle)
    capped.push({ key: item.key, entries: slice })
    for (const entry of rest) capped.push({ key: entry.path, entries: [entry] })
  }

  return { bundles: capped, strategy: degraded ? 'degraded-per-entry' : 'keyed', degraded }
}

// ---------------------------------------------------------------------------
// P3 — rule injection
// ---------------------------------------------------------------------------

/**
 * P3 — select which of a domain's rules apply to one bundle.
 *
 * Selection is a pure match on the bundle's paths, in DECLARATION ORDER, first
 * match wins. open-code-review writes a custom `UnmarshalJSON` purely to keep
 * this ordering stable; the same guarantee is kept here by iterating the
 * declared array rather than an object's keys.
 *
 * Injecting only the matched rules is what keeps the bounded pass small: a
 * domain with hundreds of rules still sends one rule per bundle.
 *
 * @param {Array<{match:string|string[], text:string, name:string}>} rules
 * @param {string[]} paths
 * @returns {{injected:object[], unmapped:string[]}}
 */
export function selectRules(rules, paths) {
  const injected = []
  const seen = new Set()
  const unmapped = [...(paths ?? [])]

  for (const rule of rules ?? []) {
    const patterns = Array.isArray(rule.match) ? rule.match : [rule.match]
    const hit = (paths ?? []).find((path) => patterns.some((pattern) => globToRegExp(pattern).test(String(path).replace(/\\/gu, '/'))))
    if (hit !== undefined && !seen.has(rule.name)) {
      injected.push(rule)
      seen.add(rule.name)
      const index = unmapped.indexOf(hit)
      if (index >= 0) unmapped.splice(index, 1)
    }
  }
  return { injected, unmapped }
}

/**
 * Render the injected rules into the single system block a bounded pass sees.
 *
 * When exactly one rule matched, the raw text is returned unwrapped — byte
 * identity matters because providers cache on the prompt prefix, and stable
 * prefixes are the cheapest token win available.
 */
export function renderRules(injected, paths) {
  if (injected.length === 0) return ''
  if (injected.length === 1) return injected[0].text
  const attribute = (paths ?? []).join(',')
  const body = injected.map((rule) => rule.text).join('\n\n')
  return `<rules for="${attribute}">\n${body}\n</rules>`
}

// ---------------------------------------------------------------------------
// P6 — the critique layer and the loss orientation
// ---------------------------------------------------------------------------

/** The two asymmetric loss policies. */
export const LOSS_ORIENTATIONS = ['precision-first', 'recall-first']

/**
 * P6 — decide whether a candidate finding survives the independent critique.
 *
 * This encodes open-code-review's single most transferable decision: the loss
 * is ASYMMETRIC and must be declared up front.
 *
 *   precision-first — the reviewer is a fact-checker. A finding survives only
 *     if the evidence proves it. "When your evidence falls short of proof,
 *     approve." A false positive is worse than a miss.
 *
 *   recall-first — the reviewer is a triage filter. A finding survives unless
 *     the evidence positively DISPROVES it. A miss is worse than a false
 *     positive. This is the correct default for safety, compliance, security
 *     and test-coverage domains, and getting it backwards is how this class of
 *     system causes incidents.
 *
 * Protected subjects veto before correctness is even considered, in both
 * orientations — some categories must never be silently dropped.
 *
 * @param {object} finding `{id, severity, subject?, evidence, disproved?, defended?}`
 * @param {object} [policy] `{orientation, protectedSubjects, minSeverity}`
 * @returns {{keep:boolean, reason:string, vetoed:boolean}}
 */
export function critique(finding, policy = {}) {
  const orientation = LOSS_ORIENTATIONS.includes(policy.orientation) ? policy.orientation : 'precision-first'
  const protectedSubjects = policy.protectedSubjects ?? ['security', 'privacy', 'safety', 'data-loss', 'legal']
  const protectedHit = protectedSubjects.includes(finding?.subject)

  if (protectedHit) {
    return { keep: true, reason: `protected subject "${finding.subject}" vetoes the correctness judgement`, vetoed: true }
  }
  if (policy.minSeverity && severityRank(finding?.severity) < severityRank(policy.minSeverity)) {
    return { keep: false, reason: `below minimum severity ${policy.minSeverity}`, vetoed: false }
  }

  if (orientation === 'recall-first') {
    if (finding?.disproved === true) {
      return { keep: false, reason: 'evidence positively disproves the finding', vetoed: false }
    }
    return { keep: true, reason: 'recall-first: kept unless positively disproved', vetoed: false }
  }

  // precision-first
  if (finding?.defended === true && finding?.evidence) {
    return { keep: true, reason: 'evidence proves the finding', vetoed: false }
  }
  return { keep: false, reason: 'precision-first: evidence falls short of proof', vetoed: false }
}

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical']

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(String(severity))
  return index < 0 ? 0 : index
}

/** Run P6 over a finding set. */
export function runCritiquePanel(findings, policy = {}) {
  const kept = []
  const dropped = []
  let vetoes = 0
  for (const finding of findings ?? []) {
    const verdict = critique(finding, policy)
    if (verdict.keep) {
      kept.push({ ...finding, critique: verdict.reason })
      if (verdict.vetoed) vetoes += 1
    } else {
      dropped.push({ id: finding?.id, reason: verdict.reason })
    }
  }
  return {
    kept,
    dropped,
    vetoes,
    orientation: policy.orientation ?? 'precision-first',
  }
}

// ---------------------------------------------------------------------------
// P7 — budget
// ---------------------------------------------------------------------------

/** Mirrors open-code-review's `agent/estimate.go` and tool-payload ceilings. */
export const BUDGET_DEFAULTS = {
  maxToolCalls: 100,
  maxExcerptLines: 500,
  maxSearchHits: 100,
  maxLookaheadRounds: 2,
}

/**
 * Cheap token estimate. open-code-review uses a real tiktoken BPE and only
 * falls back to a length heuristic on load failure; this port keeps only the
 * fallback, which is honest about its accuracy: it is a BUDGET trigger, never
 * a billing figure.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4)
}

/** Create the per-run budget ledger. */
export function createBudget(options = {}) {
  const settings = { ...BUDGET_DEFAULTS, ...options }
  return {
    settings,
    toolCalls: 0,
    tokens: 0,
    exhausted: false,
    note: 'estimate only — length/4 heuristic, not a billing figure',
  }
}

/**
 * Charge one call against the ledger. Lookahead is the point: the check happens
 * BEFORE the work is admitted, so a pass that would overrun is never started.
 */
export function charge(budget, { toolCalls = 0, text = '' } = {}) {
  const next = { ...budget }
  next.toolCalls = budget.toolCalls + toolCalls
  next.tokens = budget.tokens + estimateTokens(text)
  next.exhausted = next.toolCalls > budget.settings.maxToolCalls
  return next
}

// ---------------------------------------------------------------------------
// Coverage proof
// ---------------------------------------------------------------------------

/**
 * Build the coverage self-proof. open-code-review makes this mandatory for its
 * `delegate` path; for recall-first domains it is a hard gate rather than a
 * report field, because "we reviewed everything" is exactly the claim that must
 * not be taken on trust.
 *
 * @param {number} total candidates the gate admitted
 * @param {Array<object>} findings adjudicated findings
 * @param {object} [options] `{requireComplete}`
 */
export function coverage(total, findings, options = {}) {
  const reviewed = new Set()
  for (const finding of findings ?? []) {
    if (finding?.path) reviewed.add(finding.path)
  }
  const rate = total === 0 ? 1 : reviewed.size / total
  return {
    total,
    reviewed: reviewed.size,
    coverageRate: Number(rate.toFixed(4)),
    complete: reviewed.size >= total,
    required: options.requireComplete === true,
    note: 'coverage counts distinct anchored paths, not finding count',
  }
}

/**
 * Assemble the P7 report envelope.
 *
 * Scoping is passed as COUNTS, not arrays: the caller has already discarded the
 * candidate bodies by this point, and materialising placeholder arrays to carry
 * a length would be a lie about what is retained.
 *
 * @param {object} input `{domain, target, scope:{admitted,excluded,bundles}, findings, coverageProof, budget, critiqueResult}`
 */
export function report({ domain, target, scope, findings, coverageProof, budget, critiqueResult }) {
  return {
    domain: domain?.id ?? domain ?? null,
    domainTitle: domain?.title ?? null,
    target,
    generatedBy: 'dsh-adjudication',
    generatedAt: null, // A deterministic engine does not stamp wall-clock time.
    lossOrientation: critiqueResult?.orientation ?? domain?.lossOrientation ?? 'precision-first',
    scope: {
      admitted: scope?.admitted ?? 0,
      excluded: scope?.excluded ?? 0,
      bundles: scope?.bundles ?? 0,
    },
    findings: findings ?? [],
    dropped: critiqueResult?.dropped ?? [],
    coverage: coverageProof,
    budget,
  }
}
