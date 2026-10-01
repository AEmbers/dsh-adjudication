/**
 * dsh-adjudication — domain contract v2 (the shared kernel).
 *
 * WHAT THIS FILE IS
 * -----------------
 * v1 of this plugin shipped nineteen domain *declarations*: a pack was a data
 * object answering seven questions, but five of those answers were prose. The
 * engine could gate, bundle and anchor code diffs; for the other eighteen
 * domains the pack described what should happen and nothing implemented it.
 *
 * v2 turns those five prose answers into five **extension points** with exact
 * JavaScript signatures, and this module is their single source of truth:
 * constants, factories, parsers and validators. Nothing here runs a pipeline,
 * touches the filesystem or imports a package — it is the vocabulary the
 * loader, the engine and every `domains/<id>/` directory agree on.
 *
 *   candidateSource  P0  documented input      -> deterministic candidate set
 *   anchorVerifier   P5  claim + subject       -> engine-recomputable anchor
 *   evidenceTools    P7  bounded domain tools  -> loaded on demand, never eager
 *   reviewPrompts    P4/P6 bounded review + independent re-check prompt text
 *   ruleLibrary      P3  >=20 written rules, each needing expert review
 *
 * HONESTY CLAUSE
 * --------------
 * Rule libraries are DRAFTED BY AGENTS and flagged `needs-expert-review: true`.
 * `RULE_PROVENANCE` below states this in code, `validateRuleDocument` refuses a
 * document that claims otherwise, and no deliverable may describe a draft rule
 * library as expert-validated. That is a capability boundary, not a formality.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * The nineteen v1 packs in `lib/domains.js` keep working unchanged. Every
 * validator here is ADDITIVE: `validateDomainPackV2` is a separate, stricter
 * gate that only v2 directories must pass. See `keep/legacy` notes on each
 * validator and `docs/domain-contract-v2.md` §2 for the migration path.
 *
 * ORIGINALITY
 * -----------
 * This module is original work. It ports no code from open-code-review, so
 * `NOTICE` needs no new attribution line; the engine constants it references
 * (`lib/engine.js`) carry their own upstream annotations.
 */

/** Version stamped onto every object this module produces. */
export const CONTRACT_VERSION = 2

/** Where the human-readable contract lives, relative to the package root. */
export const CONTRACT_DOC = 'docs/domain-contract-v2.md'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable machine-routing codes. A caller branches on `error.code`; the message
 * is for a human. Never invent a new code at a call site.
 */
export const ERROR_CODES = Object.freeze({
  /** A pack or extension point does not satisfy this contract. */
  E_CONTRACT: 'E_CONTRACT',
  /** The documented input format could not be parsed. Never guess. */
  E_INPUT_FORMAT: 'E_INPUT_FORMAT',
  /** An anchor claim is malformed (missing kind/path, wrong shape). */
  E_ANCHOR_CONTRACT: 'E_ANCHOR_CONTRACT',
  /** A tool call asked for more than its declared bound allows. */
  E_EVIDENCE_LIMIT: 'E_EVIDENCE_LIMIT',
  /** The run's budget is spent; the work must not start. */
  E_BUDGET_EXHAUSTED: 'E_BUDGET_EXHAUSTED',
  /** The caller's AbortSignal fired. */
  E_ABORTED: 'E_ABORTED',
})

/** The error name every contract failure carries. */
export const CONTRACT_ERROR_NAME = 'DomainContractError'

/**
 * Build a contract error. Stack-originated so it reads like any other failure.
 * @param {string} code one of {@link ERROR_CODES}
 * @param {string} message human-readable, no code prefix required
 * @param {unknown} [detail] structured diagnostic attached as `error.detail`
 */
export function contractError(code, message, detail) {
  const error = new Error(`[${code}] ${message}`)
  error.name = CONTRACT_ERROR_NAME
  error.code = code
  if (detail !== undefined) error.detail = detail
  return error
}

// ---------------------------------------------------------------------------
// §1 — the five extension points
// ---------------------------------------------------------------------------

/**
 * The five extension points, in pipeline order. `field` is the property name on
 * the v2 pack object; `file` is the conventional file inside `domains/<id>/`.
 * `signature` / `returns` / `failure` / `minimalAssertion` are mirrored from
 * `docs/domain-contract-v2.md` §1 so a validator message can quote the contract
 * instead of paraphrasing it.
 */
export const EXTENSION_POINTS = Object.freeze({
  candidateSource: Object.freeze({
    name: 'candidateSource',
    phase: 'P0',
    field: 'candidateSource',
    file: 'source.js',
    signature: 'enumerate(input, context) => CandidateSetResult',
    returns: '{ candidates: Candidate[], excluded: Exclusion[], notes: string[], bounded: boolean, truncated: boolean }',
    failure: 'throws contractError(E_INPUT_FORMAT) on malformed input; never returns a partial set silently',
    minimalAssertion: "assert.deepEqual(out.candidates.map(c => c.path), ['src/a.ts', 'src/b.ts'])",
    required: true,
  }),
  anchorVerifier: Object.freeze({
    name: 'anchorVerifier',
    phase: 'P5',
    field: 'anchorVerifier',
    file: 'anchor.js',
    signature: 'verify(claim, subject, context) => AnchorVerdict',
    returns: "{ status: 'anchored'|'unanchored', tier, path, start, end, ambiguousIn?, detail? }",
    failure: 'throws contractError(E_ANCHOR_CONTRACT) on a malformed claim; ambiguity is UNANCHORED, never a guess',
    minimalAssertion: "assert.equal(v.verify({ kind, path, locator, excerpt: good }, subject).status, 'anchored')",
    required: true,
  }),
  evidenceTools: Object.freeze({
    name: 'evidenceTools',
    phase: 'P7',
    field: 'evidenceTools',
    file: 'evidence.js',
    signature: '{ tools: EvidenceToolSpec[] }',
    returns: 'EvidenceToolSpec = { name, description, parameters, output, limits, execute(args, ctx) }',
    failure: 'throws contractError(E_EVIDENCE_LIMIT) when a request exceeds `limits`; truncates RESULTS and sets truncated:true',
    minimalAssertion: 'assert.ok(result.items.length <= spec.limits.maxItems)',
    required: true,
  }),
  reviewPrompts: Object.freeze({
    name: 'reviewPrompts',
    phase: 'P4+P6',
    field: 'reviewPrompts',
    file: 'prompts.js',
    signature: 'review(context) => { system, rules, budget } ; verify(context) => { system, instructions }',
    returns: 'plain strings only — no functions, no messages array, no side effects',
    failure: 'throwing falls back to the v1 `pack.prompt`; the pipeline never fails because a prompt is missing',
    minimalAssertion: "assert.match(prompts.review(ctx).system, /precision-first|recall-first/)",
    required: true,
  }),
  ruleLibrary: Object.freeze({
    name: 'ruleLibrary',
    phase: 'P3',
    field: 'ruleLibrary',
    file: 'rules/*.md',
    signature: "{ dir: 'rules', load?: (io) => Rule[] } | { rules: Rule[] }",
    returns: 'Rule = { name, match: string[], text, needsExpertReview: true, source }',
    failure: 'throws contractError(E_CONTRACT) when fewer than MIN_RULES valid documents load',
    minimalAssertion: 'assert.ok(rules.length >= 20 && rules.every(r => r.needsExpertReview === true))',
    required: true,
  }),
})

/** Point names in declaration order. Iterate this, never `Object.keys` ad hoc. */
export const EXTENSION_POINT_NAMES = Object.freeze(Object.keys(EXTENSION_POINTS))

/** The points a v2 pack MUST carry. All five are required for a v2 directory. */
export const REQUIRED_EXTENSION_POINTS = Object.freeze([...EXTENSION_POINT_NAMES])

/** Pipeline stages a domain `test.mjs` must exercise, in order. */
export const REQUIRED_TEST_STAGES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])

// ---------------------------------------------------------------------------
// §1.1 — candidateSource (P0)
// ---------------------------------------------------------------------------

/** Required / optional fields of one candidate. `path` is what the gate globs. */
export const CANDIDATE_FIELDS = Object.freeze({
  required: Object.freeze(['id', 'path', 'locator', 'text']),
  optional: Object.freeze(['key', 'additions', 'deletions', 'bytes', 'binary', 'deleted', 'title', 'meta']),
  /** Fields the gate predicates actually read. */
  gateReads: Object.freeze(['path', 'bytes', 'binary', 'deleted', 'secretMatch']),
})

/**
 * How a domain's own exclusion signal must be expressed. This is the rule that
 * makes the "all candidates gated out" fixture writable for every domain,
 * including the ones whose candidates are not files.
 */
export const GATE_FIELD_MAPPING = Object.freeze({
  path: 'the candidate\'s identity; globs match against this (synthetic ids like "surface/data-flow-3" are fine)',
  bytes: 'size in bytes of the material the candidate would put in context',
  binary: 'true when the candidate is not reviewable as text (redacted, encoded, opaque)',
  deleted: 'true when the candidate was withdrawn/archived/superseded',
  secretMatch: 'set by markSecrets(); a source MUST NOT set it itself',
})

/** A result set is `bounded` iff enumeration is a total function of the input. */
export const SOURCE_BOUNDED = Object.freeze({
  true: 'A/B/D domains: every candidate is derivable from the input alone',
  false: 'C explore domains: the input is a SEED, enumeration has no prior upper bound; must be declared and reported',
})

const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/u

/**
 * Validate a candidateSource. Additive: a v1 pack without one is simply
 * reported as "missing" by {@link validateDomainPackV2}, not here.
 * @returns {string[]} problems, empty when registrable
 */
export function validateCandidateSource(source) {
  const problems = []
  if (source === null || typeof source !== 'object') return ['candidateSource is not an object']
  if (typeof source.kind !== 'string' || source.kind === '') problems.push('candidateSource.kind must be a non-empty string')
  if (typeof source.enumerate !== 'function') problems.push('candidateSource.enumerate must be a function')
  if (source.bounded !== undefined && typeof source.bounded !== 'boolean') problems.push('candidateSource.bounded must be a boolean when declared')
  if (source.inputFormat !== undefined && (typeof source.inputFormat !== 'string' || source.inputFormat === '')) {
    problems.push('candidateSource.inputFormat must be a non-empty string when declared')
  }
  return problems
}

/**
 * Validate one enumerate() result. Used by `test.mjs` and by the loader's
 * `--check` path; the engine trusts the source at runtime and relies on this
 * being run in tests.
 */
export function validateCandidateSetResult(result, limits = {}) {
  const problems = []
  if (result === null || typeof result !== 'object') return ['enumerate() must return an object']
  if (!Array.isArray(result.candidates)) problems.push('candidates must be an array')
  if (!Array.isArray(result.excluded)) problems.push('excluded must be an array')
  if (result.notes !== undefined && !Array.isArray(result.notes)) problems.push('notes must be an array of strings when declared')
  if (result.truncated !== undefined && typeof result.truncated !== 'boolean') problems.push('truncated must be a boolean when declared')

  const maxCandidates = limits.maxCandidates ?? 400
  if (Array.isArray(result.candidates)) {
    if (result.candidates.length > maxCandidates) {
      problems.push(`candidates length ${result.candidates.length} exceeds maxCandidates ${maxCandidates} — truncate and set truncated:true`)
    }
    const seen = new Set()
    for (const [index, candidate] of result.candidates.entries()) {
      const where = `candidates[${index}]`
      for (const field of CANDIDATE_FIELDS.required) {
        if (candidate?.[field] === undefined || candidate?.[field] === null || candidate?.[field] === '') {
          problems.push(`${where}.${field} is required`)
        }
      }
      if (typeof candidate?.path === 'string' && !ID_PATTERN.test(candidate.path)) {
        problems.push(`${where}.path "${candidate.path}" contains characters the gate cannot glob (use a synthetic id)`)
      }
      if (candidate?.locator !== undefined && (candidate.locator === null || typeof candidate.locator !== 'object')) {
        problems.push(`${where}.locator must be an object`)
      }
      if (typeof candidate?.text === 'string' && limits.maxExcerptLines && candidate.text.split(/\r?\n/u).length > limits.maxExcerptLines) {
        problems.push(`${where}.text exceeds maxExcerptLines ${limits.maxExcerptLines}`)
      }
      if (candidate?.id !== undefined) {
        if (seen.has(candidate.id)) problems.push(`${where}.id "${candidate.id}" is not unique — ids must be stable and unique per run`)
        seen.add(candidate.id)
      }
    }
  }
  if (Array.isArray(result.excluded)) {
    for (const [index, item] of result.excluded.entries()) {
      if (item === null || typeof item !== 'object') problems.push(`excluded[${index}] must be an object`)
      else if (typeof item.id !== 'string' || typeof item.reason !== 'string') problems.push(`excluded[${index}] must carry { id, reason }`)
    }
  }
  return problems
}

/** Typed factory. Validates eagerly so a malformed domain fails at load time. */
export function defineCandidateSource(spec) {
  const problems = validateCandidateSource(spec)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid candidateSource: ${problems.join('; ')}`, problems)
  return Object.freeze({
    __contract: CONTRACT_VERSION,
    kind: spec.kind,
    inputFormat: spec.inputFormat,
    bounded: spec.bounded !== false,
    enumerate: spec.enumerate,
    describe: spec.describe,
  })
}

// ---------------------------------------------------------------------------
// §1.2 — anchorVerifier (P5)
// ---------------------------------------------------------------------------

export const ANCHOR_STATUSES = Object.freeze(['anchored', 'unanchored'])

/**
 * Anchor tiers. The engine may only accept a verdict whose tier is in
 * {@link TRUSTED_ANCHOR_TIERS}; everything else is a downgrade.
 */
export const ANCHOR_TIERS = Object.freeze({
  'declared-locator': 'the claim\'s locator was independently confirmed against the subject',
  // ADDED (t49, second pass): the gap in the OTHER direction. This tier was
  // already being RETURNED — `lib/engine.js:resolveAnchor` tier 1, i.e. every
  // `via: 'engine-resolveAnchor'` anchor for a pack that declares no
  // `anchorVerifier` — but it was not declared, so a caller could not even
  // downgrade it by name. Declared TRUSTED because that is what it always was:
  // the engine accepts it as an anchor (`smoke-test.mjs` asserts exactly this
  // path). Relationship to `declared-locator`: that one confirms the claim's
  // LOCATOR; this one confirms the claim's DOCUMENT — the excerpt was found
  // verbatim in the document the claim named, and the locator is not consulted.
  'declared-document': 'the excerpt was found in the document the claim named — the claim\'s document is confirmed, its locator is not consulted',
  'recomputed-unique': 'the locator was absent or wrong, but the excerpt resolved to exactly one place',
  'relocated-unique': 'the excerpt was found in exactly one other document; the finding moved there',
  // ADDED (t49, second pass): `anchorInDocument`'s internal hit marker. It is
  // NOT an anchored tier a verifier may claim: the marker exists inside one
  // document's matcher with no uniqueness check, and `resolveAnchor` re-tiers
  // every hit as `declared-document` / `relocated-unique` before it can escape.
  // Declared so the vocabulary covers what real producers name, left UNTRUSTED
  // because a raw sliding-window hit is weaker than any accepted anchor, and
  // pinned by `lib/kernel-test.mjs` §16 (the marker must never reach a finding).
  'sliding-window': 'the consecutive-line matcher\'s INTERNAL hit marker (`anchorInDocument`) — re-tiered by the ladder before it can escape; never acceptable as an anchored tier',
  'locator-mismatch': 'the claim\'s locator contradicts the subject — UNANCHORED, the model is not trusted over the input',
  // ADDED (t49, second pass): the engine\'s own P5 entry points in `index.js`
  // produce these two, and neither was declared — so the engine could emit a
  // verdict the vocabulary could not describe. Both are unanchored outcomes.
  'no-excerpt': 'the finding supplied no verbatim excerpt at all — there was nothing for the engine to recompute, so self-reported positions are not trusted',
  'invalid-verdict': 'the returned verdict violated the anchor contract and was downgraded — reported with the violations, never silently accepted',
  'relocation-ambiguous': 'two or more equally valid locations — UNANCHORED, never guessed',
  'no-match': 'nothing matched — UNANCHORED',
  'empty-excerpt': 'the excerpt normalised to nothing — UNANCHORED',
  'kind-mismatch': 'claim.kind does not equal verifier.kind — UNANCHORED',
  'no-documents': 'no subject material was supplied — UNANCHORED',
})

/**
 * Tiers that count as a real anchor. `tier` outside this set is a downgrade.
 *
 * REMOVED (t49): `domain-locator`. It was added in t17's second pass as a
 * "domain-defined locator" trusted tier, so the ID/graph families
 * (`{clauseId, surfaceId}`, `{taskId, from, to}`, `{nodeId, table, column}`, …)
 * could report an anchored verdict for a locator that has no line number.
 *
 * Why it is gone: the measurement, not the argument. Every `domains/<id>/anchor.js`
 * was scanned in full and NOTHING returns it — the nineteen shipped verifiers,
 * including every ID/graph family the comment above names, report
 * `declared-locator` for exactly those locators. The generic ladder in
 * `lib/engine.js` cannot return it either. Its only producers were kernel-test
 * fixtures, i.e. the tier was exercised by tests and by nothing a user can run,
 * and this document's own §1.2 already said its semantics *equal*
 * `declared-locator` ("语义等于 declared-locator，只是确认的不是行号").
 *
 * The obligation the tier was meant to carry is carried by the SHAPE rule
 * instead, and always was: `validateAnchorVerdict` accepts an anchored verdict
 * with either an integer range or a non-empty `locator` object, so a non-line
 * family anchors legally with `declared-locator`. A second name for the same
 * thing added no capability and one lie ("this is supported").
 *
 * Its guard: `lib/kernel-test.mjs` §16 asserts, IN BOTH DIRECTIONS, that this
 * vocabulary and the producers agree — (a) every DECLARED tier is returned by a
 * real producer (the engine ladder and `anchorInDocument`, executed; `index.js`
 * and every shipped `domains/<id>/anchor.js`, scanned), and (b) every tier a
 * real producer RETURNS is declared. Direction (a) is what caught
 * `domain-locator`; direction (b) is what caught `declared-document`,
 * `sliding-window`, `no-excerpt` and `invalid-verdict` in the same pass — four
 * tiers that were being produced with nothing to name them with. Both directions
 * were red before their fix and are green now; a check with only one of them
 * would have closed half the defect.
 *
 * ADDED (t49, second pass): `declared-document` is trusted, because it always
 * was — see its entry in ANCHOR_TIERS above. The other three new names
 * (`sliding-window`, `no-excerpt`, `invalid-verdict`) are declared and
 * deliberately NOT trusted: they can only appear on an `unanchored` verdict.
 */
export const TRUSTED_ANCHOR_TIERS = Object.freeze(['declared-locator', 'declared-document', 'recomputed-unique', 'relocated-unique'])

/** How independently a human can re-check the anchor. */
export const ANCHOR_VERIFY_LEVELS = Object.freeze(['engine-recomputable', 'externally-recheckable'])

/** Required fields of an anchor claim as the model submits it. */
export const ANCHOR_CLAIM_FIELDS = Object.freeze({
  required: Object.freeze(['kind', 'path', 'locator']),
  optional: Object.freeze(['excerpt', 'start', 'end']),
})

/** Validate an anchorVerifier object. */
export function validateAnchorVerifier(verifier) {
  const problems = []
  if (verifier === null || typeof verifier !== 'object') return ['anchorVerifier is not an object']
  if (typeof verifier.kind !== 'string' || verifier.kind === '') problems.push('anchorVerifier.kind must be a non-empty string')
  if (typeof verifier.verify !== 'function') problems.push('anchorVerifier.verify must be a function')
  if (verifier.verifyLevel !== undefined && !ANCHOR_VERIFY_LEVELS.includes(verifier.verifyLevel)) {
    problems.push(`anchorVerifier.verifyLevel must be one of ${ANCHOR_VERIFY_LEVELS.join('/')}`)
  }
  return problems
}

/** The declared default claim envelope for a domain, used by tool schemas. */
export function createAnchorClaim(kind, path, locator, excerpt = '') {
  return { kind, path, locator: locator ?? {}, excerpt }
}

/** Validate a verdict a verifier returned. Cheap, so call it in tests. */
export function validateAnchorVerdict(verdict) {
  const problems = []
  if (verdict === null || typeof verdict !== 'object') return ['verify() must return an object']
  if (!ANCHOR_STATUSES.includes(verdict.status)) problems.push(`status must be one of ${ANCHOR_STATUSES.join('/')}`)
  if (typeof verdict.tier !== 'string' || verdict.tier === '') problems.push('tier must be a non-empty string')
  if (verdict.status === 'anchored') {
    if (typeof verdict.path !== 'string' || verdict.path === '') problems.push('an anchored verdict must name a path')
    if (!TRUSTED_ANCHOR_TIERS.includes(verdict.tier)) problems.push(`anchored with untrusted tier "${verdict.tier}"`)
    // CHANGED (t17): an anchored verdict must say WHERE, and "where" is not
    // always a line number. `DOMAIN_ANCHOR_KINDS` declares nineteen shapes, and
    // the ID/graph families (`{clauseId, surfaceId}`, `{taskId, from, to}`,
    // `{nodeId, table, column}`) have no line at all. Demanding an integer range
    // from them made those domains unanchorable BY CONSTRUCTION: every honest
    // anchored verdict would have been downgraded to `invalid-verdict` by the
    // caller in index.js. The range stays mandatory for line-shaped verdicts —
    // a verdict that supplies neither is still rejected.
    const hasRange = Number.isInteger(verdict.start) && verdict.start >= 1
    const hasLocator = verdict.locator !== null
      && typeof verdict.locator === 'object'
      && Object.keys(verdict.locator).length > 0
    if (!hasRange && !hasLocator) {
      problems.push('an anchored verdict must carry a 1-based integer start, or a non-empty domain locator')
    }
    if (Number.isInteger(verdict.start) && (!Number.isInteger(verdict.end) || verdict.end < verdict.start)) {
      problems.push('an anchored verdict must carry end >= start')
    }
  } else {
    if (!Object.hasOwn(ANCHOR_TIERS, verdict.tier)) problems.push(`unanchored tier "${verdict.tier}" is not a declared tier`)
    if (verdict.tier === 'relocation-ambiguous' && !Array.isArray(verdict.ambiguousIn)) {
      problems.push('relocation-ambiguous must list the competing locations in ambiguousIn')
    }
  }
  return problems
}

/** Typed factory for an anchorVerifier. */
export function defineAnchorVerifier(spec) {
  const problems = validateAnchorVerifier(spec)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid anchorVerifier: ${problems.join('; ')}`, problems)
  return Object.freeze({
    __contract: CONTRACT_VERSION,
    kind: spec.kind,
    verifyLevel: spec.verifyLevel ?? 'engine-recomputable',
    verify: spec.verify,
    describe: spec.describe,
  })
}

// ---------------------------------------------------------------------------
// §1.3 — evidenceTools (bounded, on demand)
// ---------------------------------------------------------------------------

/**
 * Hard ceilings. A tool may declare lower limits; never higher.
 *
 * CHANGED (t37): `maxCalls` is no longer a decorative number. It used to be
 * checked against `maxCallsPerRun` here and clamped by
 * `normaliseEvidenceLimits` — and then never read by anything, so a tool
 * declaring `maxCalls: 4` could be called until the run's global ledger ran out.
 * `index.js` now REALLY counts calls per tool, per domain activation, and
 * refuses the call past the declared cap with `E_BUDGET_EXHAUSTED`. The
 * declaration a domain author writes is therefore the bound that is executed:
 *
 *   maxLines / maxItems  — enforced by the tool's own slicing (and validated on
 *                          the result by `validateEvidenceResult`)
 *   maxCalls             — enforced by the ENGINE, per activation  ← t37
 *   maxBytes             — declared, validated, and bounded by the result cap
 *
 * Re-activating the domain starts a fresh per-tool budget; the per-run total is
 * still the ledger's `maxToolCalls`.
 */
export const EVIDENCE_LIMITS = Object.freeze({
  maxToolsPerDomain: 8,
  maxCallsPerRun: 20,
  defaultMaxLines: 200,
  hardMaxLines: 2000,
  defaultMaxItems: 100,
  hardMaxItems: 1000,
  hardMaxBytes: 262_144,
})

/** Every result object an evidence tool returns must carry these. */
export const EVIDENCE_RESULT_FIELDS = Object.freeze(['items', 'truncated', 'provenance'])

/** Tool name suffix; the registered name is `adjudicate_<domain>_evidence_<name>`. */
export function evidenceToolName(domainId, toolName) {
  return `adjudicate_${String(domainId).replace(/-/gu, '_')}_evidence_${toolName}`
}

/** Normalise and clamp a declared limits object. Unknown keys are dropped. */
export function normaliseEvidenceLimits(limits = {}) {
  const pick = (value, fallback, hard) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback
    return Math.min(Math.floor(numeric), hard)
  }
  return Object.freeze({
    maxLines: pick(limits.maxLines, EVIDENCE_LIMITS.defaultMaxLines, EVIDENCE_LIMITS.hardMaxLines),
    maxItems: pick(limits.maxItems, EVIDENCE_LIMITS.defaultMaxItems, EVIDENCE_LIMITS.hardMaxItems),
    maxBytes: pick(limits.maxBytes, EVIDENCE_LIMITS.hardMaxBytes, EVIDENCE_LIMITS.hardMaxBytes),
    maxCalls: pick(limits.maxCalls, EVIDENCE_LIMITS.maxCallsPerRun, EVIDENCE_LIMITS.maxCallsPerRun),
  })
}

/** Validate one evidence tool spec. */
export function validateEvidenceTool(spec) {
  const problems = []
  if (spec === null || typeof spec !== 'object') return ['evidence tool is not an object']
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(spec.name)) {
    problems.push('tool.name must be lowercase snake_case (it becomes a tool-name segment)')
  }
  if (typeof spec.description !== 'string' || spec.description === '') problems.push('tool.description must be a non-empty string')
  if (spec.parameters === null || typeof spec.parameters !== 'object') problems.push('tool.parameters must be an object (JSON Schema root)')
  if (spec.output === null || typeof spec.output !== 'object' || spec.output.schema === undefined) problems.push('tool.output must be { schema }')
  if (typeof spec.execute !== 'function') problems.push('tool.execute must be a function')
  if (spec.limits === undefined) {
    problems.push(`tool.limits is required — an unbounded evidence tool is not admissible (declare <= ${JSON.stringify(EVIDENCE_LIMITS)})`)
  } else {
    const limits = normaliseEvidenceLimits(spec.limits)
    if (Number(spec.limits.maxLines) > EVIDENCE_LIMITS.hardMaxLines) problems.push(`tool.limits.maxLines exceeds the hard ceiling ${EVIDENCE_LIMITS.hardMaxLines}`)
    if (Number(spec.limits.maxItems) > EVIDENCE_LIMITS.hardMaxItems) problems.push(`tool.limits.maxItems exceeds the hard ceiling ${EVIDENCE_LIMITS.hardMaxItems}`)
    if (Number(spec.limits.maxBytes) > EVIDENCE_LIMITS.hardMaxBytes) problems.push(`tool.limits.maxBytes exceeds the hard ceiling ${EVIDENCE_LIMITS.hardMaxBytes}`)
    if (Number(spec.limits.maxCalls) > EVIDENCE_LIMITS.maxCallsPerRun) problems.push(`tool.limits.maxCalls exceeds the hard ceiling ${EVIDENCE_LIMITS.maxCallsPerRun}`)
    // t37: this ceiling is a real bound, not advice — `index.js` counts calls per
    // tool per activation and refuses the call past `limits.maxCalls`.
    if (limits.maxItems <= 0) problems.push('tool.limits.maxItems must be a positive integer')
  }
  return problems
}

/** Validate an evidence toolkit. An empty `{ tools: [] }` is valid and honest. */
export function validateEvidenceToolkit(toolkit) {
  const problems = []
  if (toolkit === null || typeof toolkit !== 'object') return ['evidenceTools is not an object']
  if (!Array.isArray(toolkit.tools)) return ['evidenceTools.tools must be an array (use { tools: [] } when the domain needs none)']
  if (toolkit.tools.length > EVIDENCE_LIMITS.maxToolsPerDomain) {
    problems.push(`evidenceTools.tools has ${toolkit.tools.length} entries; at most ${EVIDENCE_LIMITS.maxToolsPerDomain} are admissible`)
  }
  const seen = new Set()
  for (const [index, spec] of toolkit.tools.entries()) {
    for (const problem of validateEvidenceTool(spec)) problems.push(`tools[${index}]: ${problem}`)
    if (typeof spec?.name === 'string') {
      if (seen.has(spec.name)) problems.push(`tools[${index}]: duplicate tool name "${spec.name}"`)
      seen.add(spec.name)
    }
  }
  return problems
}

/** Validate a result an evidence tool returned. */
export function validateEvidenceResult(result, limits = {}) {
  const problems = []
  if (result === null || typeof result !== 'object') return ['an evidence tool must return an object']
  for (const field of EVIDENCE_RESULT_FIELDS) {
    if (result[field] === undefined) problems.push(`result.${field} is required (${EVIDENCE_RESULT_FIELDS.join(', ')})`)
  }
  if (!Array.isArray(result.items)) problems.push('result.items must be an array')
  if (typeof result.truncated !== 'boolean') problems.push('result.truncated must be a boolean')
  const maxItems = limits.maxItems ?? EVIDENCE_LIMITS.defaultMaxItems
  if (Array.isArray(result.items) && result.items.length > maxItems) {
    problems.push(`result.items length ${result.items.length} exceeds maxItems ${maxItems}`)
  }
  return problems
}

/** Typed factory for one evidence tool. */
export function defineEvidenceTool(spec) {
  const problems = validateEvidenceTool(spec)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid evidence tool "${spec?.name ?? '(anonymous)'}": ${problems.join('; ')}`, problems)
  return Object.freeze({
    __contract: CONTRACT_VERSION,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: spec.output,
    limits: normaliseEvidenceLimits(spec.limits),
    execute: spec.execute,
  })
}

/** Typed factory for a domain's evidence toolkit. */
export function defineEvidenceToolkit(spec) {
  const toolkit = { tools: Array.isArray(spec?.tools) ? spec.tools.map((tool) => defineEvidenceTool(tool)) : [] }
  const problems = validateEvidenceToolkit(toolkit)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid evidenceTools: ${problems.join('; ')}`, problems)
  return Object.freeze({ __contract: CONTRACT_VERSION, tools: toolkit.tools })
}

// ---------------------------------------------------------------------------
// §1.4 — reviewPrompts (P4 + P6)
// ---------------------------------------------------------------------------

/** The two prompt roles. `review` is P4, `verify` is P6, and they MUST differ. */
export const PROMPT_KINDS = Object.freeze(['review', 'verify'])

/** What the engine hands a prompt function. Frozen vocabulary. */
export const PROMPT_CONTEXT_FIELDS = Object.freeze({
  review: Object.freeze(['domain', 'pack', 'target', 'orientation', 'bundle', 'ruleText', 'budget', 'candidates']),
  verify: Object.freeze(['domain', 'pack', 'target', 'orientation', 'findings']),
})

/** Validate a reviewPrompts object. */
export function validateReviewPrompts(prompts) {
  const problems = []
  if (prompts === null || typeof prompts !== 'object') return ['reviewPrompts is not an object']
  for (const kind of PROMPT_KINDS) {
    if (typeof prompts[kind] !== 'function') problems.push(`reviewPrompts.${kind} must be a function`)
  }
  // CHANGED (t49): P6 is an INDEPENDENT re-check, so the two roles may not be
  // the same function. This is layer 1 of a two-layer gate, and it exists at
  // LOAD TIME because a validator has no context and therefore cannot render:
  // what it CAN see is identity. A pack that hands one function to both roles
  // fails here, before any run.
  //
  // Layer 2 (`lib/reasoner.js:runVerify`) compares the two RENDERED texts on the
  // same context and refuses with `E_P6_NOT_INDEPENDENT` — that catches two
  // different functions whose output agrees, which this check deliberately does
  // NOT try to guess at (it cannot see their arguments or their return values).
  // The two layers are complementary, not redundant: the probe in t49 shows a
  // pack that only layer 1 catches (one function that returns BOTH a `rules` and
  // an `instructions` string renders two different texts — so layer 2 would stay
  // silent) and a pack that only layer 2 catches (two distinct functions with
  // different source text that still render the same characters).
  if (typeof prompts.review === 'function' && typeof prompts.verify === 'function'
    && prompts.review === prompts.verify) {
    problems.push('reviewPrompts.review and reviewPrompts.verify must be two different functions: P6 is an INDEPENDENT re-check, and one function serving both roles is the same reviewer asked twice')
  }
  return problems
}

/** Validate the object a prompt function returned. Strings only. */
export function validatePromptOutput(kind, output) {
  const problems = []
  if (output === null || typeof output !== 'object') return [`${kind}() must return an object of strings`]
  if (kind === 'review') {
    if (typeof output.system !== 'string' || output.system === '') problems.push('review().system must be a non-empty string')
    if (output.rules !== undefined && typeof output.rules !== 'string') problems.push('review().rules must be a string when declared')
  } else {
    if (typeof output.system !== 'string' || output.system === '') problems.push('verify().system must be a non-empty string')
    if (typeof output.instructions !== 'string' || output.instructions === '') problems.push('verify().instructions must be a non-empty string')
  }
  return problems
}

/** Typed factory for reviewPrompts. */
export function defineReviewPrompts(spec) {
  const problems = validateReviewPrompts(spec)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid reviewPrompts: ${problems.join('; ')}`, problems)
  return Object.freeze({
    __contract: CONTRACT_VERSION,
    review: spec.review,
    verify: spec.verify,
  })
}

// ---------------------------------------------------------------------------
// §1.5 — ruleLibrary (P3)
// ---------------------------------------------------------------------------

/** Per-domain rule minimum. A "domain" with four seed rules is not one. */
export const MIN_RULES_PER_DOMAIN = 20

/** Front-matter keys every rule document must carry. */
export const RULE_FRONT_MATTER = Object.freeze({
  required: Object.freeze(['name', 'match', 'needs-expert-review']),
  optional: Object.freeze(['title', 'applies-to', 'severity', 'source', 'notes']),
})

/**
 * Provenance of every rule library produced under this contract. Stated in code
 * because it is the one thing a deliverable must never overstate.
 */
export const RULE_PROVENANCE = Object.freeze({
  draftedBy: 'agent',
  expertValidated: false,
  requiresExpertReview: true,
  statement: '规则库由 agent 起草、标注 needs-expert-review: true，未经领域专家审定。任何交付物不得声称已通过专家验证。',
})

/**
 * THE rule accessor. Every reader of "which written rules does this pack have"
 * must go through here — P3 injection in `index.js`, the `adjudicate_<id>_rules`
 * tool, and the `rules` count in the registry overview.
 *
 * CHANGED (t17). Before this function there were three independent readers:
 *
 *   index.js  adjudicate_<id>_rules   pack.rules ?? pack.ruleLibrary?.rules ?? []   ← correct
 *   index.js  planFor()               pack.rules                                   ← WRONG
 *   registry  overview()              Array.isArray(pack.rules) ? length : 0        ← WRONG
 *
 * Both wrong readers only knew the v1 shape. The consequence was silent and
 * total: for every contract-v2 directory pack — whose rules the loader assembles
 * into `pack.ruleLibrary.rules` from `rules/*.md` — P3 rule injection produced
 * `bundles[].rules === []` and `ruleText === ''`, and the domain listing reported
 * "规则 0 条". The eight primitives were all present and one of them was inert on
 * exactly the packs the migration produces.
 *
 * One pack shape answered by three readers is the defect; one accessor is the
 * fix. A fourth reader added later must call this too, or the same hole returns.
 *
 * Precedence: a v2 `ruleLibrary` wins when it carries rules, because that is the
 * ≥20-document library the loader assembled and validated. v1 packs have no
 * ruleLibrary and fall through to their inline `rules` array. A pack with
 * neither answers `[]` — never `undefined`, so `.length` is always safe.
 *
 * @param {object} pack a v1 or v2 domain pack
 * @returns {object[]} the pack's rules, or an empty array
 */
export function rulesOf(pack) {
  const library = pack?.ruleLibrary?.rules
  if (Array.isArray(library) && library.length > 0) return library
  return Array.isArray(pack?.rules) ? pack.rules : []
}

/** Is this pack's rule library the v2 file-backed kind? Used for reporting only. */
export function ruleLibraryKind(pack) {
  return Array.isArray(pack?.ruleLibrary?.rules) && pack.ruleLibrary.rules.length > 0 ? 'v2' : 'starter'
}

/** Validate a parsed rule object (post-front-matter). */
export function validateRule(rule, source = '(inline)') {
  const problems = []
  if (rule === null || typeof rule !== 'object') return [`${source}: rule is not an object`]
  if (typeof rule.name !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(rule.name)) {
    problems.push(`${source}: name must be lowercase kebab-case`)
  }
  const match = Array.isArray(rule.match) ? rule.match : null
  if (match === null || match.length === 0) problems.push(`${source}: match must be a non-empty array of globs`)
  else if (match.some((pattern) => typeof pattern !== 'string' || pattern === '')) problems.push(`${source}: every match entry must be a non-empty string`)
  if (typeof rule.text !== 'string' || rule.text.trim().length < 10) problems.push(`${source}: text must be at least 10 characters of real rule prose`)
  if (rule.needsExpertReview !== true) {
    problems.push(`${source}: needs-expert-review must be true — an agent-drafted library is never expert-validated`)
  }
  return problems
}

/**
 * Parse a rule document: YAML-ish front-matter + markdown body.
 *
 * Deliberately a *minimal* subset — `key: value`, `key:` + `- item`, quotes,
 * booleans and inline `[a, b]` arrays. A full YAML parser would be a runtime
 * dependency, and this package has zero of those.
 *
 * @returns {{ frontMatter: object|null, body: string, problems: string[] }}
 */
export function parseRuleDocument(text) {
  const raw = String(text ?? '')
  const problems = []
  if (!raw.startsWith('---')) {
    return { frontMatter: null, body: raw, problems: ['missing front-matter: the file must start with a "---" line'] }
  }
  const firstNewline = raw.indexOf('\n')
  if (firstNewline < 0) return { frontMatter: null, body: '', problems: ['front-matter is empty (no closing "---")'] }
  const closeAt = raw.indexOf('\n---', firstNewline)
  if (closeAt < 0) return { frontMatter: null, body: '', problems: ['unterminated front-matter: no closing "---" line'] }

  const frontMatterText = raw.slice(firstNewline + 1, closeAt)
  const bodyStart = raw.indexOf('\n', closeAt + 1)
  const body = bodyStart < 0 ? '' : raw.slice(bodyStart + 1)

  const frontMatter = {}
  let pendingKey = null
  for (const [index, line] of frontMatterText.split(/\r?\n/u).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/u.exec(line)
    if (listItem) {
      if (pendingKey === null) {
        problems.push(`front-matter line ${index + 2}: list item without a preceding key`)
        continue
      }
      if (!Array.isArray(frontMatter[pendingKey])) frontMatter[pendingKey] = []
      frontMatter[pendingKey].push(scalar(listItem[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (!pair) {
      problems.push(`front-matter line ${index + 2}: cannot parse "${line.trim()}"`)
      continue
    }
    pendingKey = pair[1]
    const value = pair[2].trim()
    frontMatter[pendingKey] = value === '' ? [] : scalar(value)
  }
  return { frontMatter, body, problems }
}

function scalar(value) {
  const trimmed = String(value).trim()
  if (/^".*"$/u.test(trimmed) || /^'.*'$/u.test(trimmed)) return trimmed.slice(1, -1)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed)
  if (/^\[.*\]$/u.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((item) => scalar(item))
  }
  return trimmed
}

/**
 * Validate one `rules/*.md` file end to end.
 * @returns {string[]} problems, each prefixed with the file name
 */
export function validateRuleDocument(text, filename = '(rule)') {
  const { frontMatter, body, problems: parseProblems } = parseRuleDocument(text)
  const problems = parseProblems.map((problem) => `${filename}: ${problem}`)
  if (frontMatter === null) return problems

  for (const key of RULE_FRONT_MATTER.required) {
    if (frontMatter[key] === undefined) problems.push(`${filename}: front-matter is missing "${key}"`)
  }
  if (typeof frontMatter.name === 'string' && !/^[a-z][a-z0-9-]*$/u.test(frontMatter.name)) {
    problems.push(`${filename}: name must be lowercase kebab-case`)
  }
  const match = frontMatter.match
  if (match !== undefined && (!Array.isArray(match) || match.length === 0)) {
    problems.push(`${filename}: match must list at least one glob`)
  }
  if (frontMatter['needs-expert-review'] !== true) {
    problems.push(`${filename}: needs-expert-review must be exactly true (rule libraries are agent-drafted, never expert-validated)`)
  }
  if (body.trim().length < 10) problems.push(`${filename}: the rule body is empty or too short to be a rule`)
  if (body.includes('<!-- needs-expert-review:')) problems.push(`${filename}: use front-matter, not an HTML comment, for provenance`)
  return problems
}

/** Turn a validated rule document into the engine's Rule shape. */
export function ruleFromDocument(text, filename = '(rule)') {
  const { frontMatter, body, problems } = parseRuleDocument(text)
  if (frontMatter === null || problems.some((problem) => problem.startsWith('unterminated') || problem.startsWith('missing front-matter'))) {
    throw contractError(ERROR_CODES.E_CONTRACT, `cannot build a rule from ${filename}: ${problems.join('; ') || 'unparseable'}`, problems)
  }
  const match = Array.isArray(frontMatter.match) ? frontMatter.match : [frontMatter.match].filter(Boolean)
  const rule = {
    name: frontMatter.name,
    match,
    text: body.trim(),
    needsExpertReview: frontMatter['needs-expert-review'] === true,
    source: filename,
  }
  const ruleProblems = validateRule(rule, filename)
  if (ruleProblems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid rule document: ${ruleProblems.join('; ')}`, ruleProblems)
  return rule
}

/** Validate a ruleLibrary declaration (either inline rules or a loader). */
export function validateRuleLibrary(library) {
  const problems = []
  if (library === null || typeof library !== 'object') return ['ruleLibrary is not an object']
  if (library.load !== undefined && typeof library.load !== 'function') problems.push('ruleLibrary.load must be a function when declared')
  if (library.dir !== undefined && typeof library.dir !== 'string') problems.push('ruleLibrary.dir must be a string when declared')
  if (library.rules === undefined && library.load === undefined) {
    problems.push("ruleLibrary must declare either `rules` (inline) or `load(io)` (rules/*.md) — an empty library is not a domain")
  }
  if (Array.isArray(library.rules)) {
    if (library.rules.length < MIN_RULES_PER_DOMAIN) {
      problems.push(`ruleLibrary.rules has ${library.rules.length} entries; at least ${MIN_RULES_PER_DOMAIN} are required`)
    }
    const seen = new Set()
    for (const rule of library.rules) {
      for (const problem of validateRule(rule)) problems.push(problem)
      if (typeof rule?.name === 'string') {
        if (seen.has(rule.name)) problems.push(`duplicate rule name "${rule.name}"`)
        seen.add(rule.name)
      }
    }
  }
  return problems
}

/** Typed factory for a ruleLibrary. */
export function defineRuleLibrary(spec) {
  const problems = validateRuleLibrary(spec)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid ruleLibrary: ${problems.join('; ')}`, problems)
  return Object.freeze({
    __contract: CONTRACT_VERSION,
    dir: spec.dir ?? 'rules',
    load: spec.load,
    rules: spec.rules,
  })
}

// ---------------------------------------------------------------------------
// §2 — the three previously-declared-only fields
// ---------------------------------------------------------------------------

/**
 * Generic bundle-key strategies. `bundle()` itself is UNCHANGED: it already
 * groups by `entry.key`. The caller derives that key from `pack.bundleKey`
 * through {@link resolveBundleKey}, which is where v2 becomes real.
 *
 * A strategy receives `(candidate, params)` and must be pure and total.
 */
export const BUNDLE_KEY_STRATEGIES = Object.freeze({
  /** Identity: one bundle per candidate path. v1 behaviour. */
  path: (candidate) => String(candidate?.path ?? ''),
  /** Same as `path`; named separately because domains say "per file". */
  file: (candidate) => String(candidate?.path ?? ''),
  /** Leading `depth` path segments of the candidate path (default 1). */
  directory: (candidate, params = {}) => directoryOf(candidate?.path, params.depth ?? 1),
  /** Lower-cased file extension, `(none)` when the path has none. */
  extension: (candidate) => {
    const path = String(candidate?.path ?? '')
    const dot = path.lastIndexOf('.')
    return dot < 0 ? '(none)' : path.slice(dot).toLowerCase()
  },
})

/** Strategy used when a pack declares nothing. */
export const BUNDLE_KEY_DEFAULT_STRATEGY = 'path'

function directoryOf(path, depth) {
  const parts = String(path ?? '').replace(/\\/gu, '/').split('/')
  parts.pop()
  if (parts.length === 0) return '.'
  const wanted = Math.max(1, Math.min(Number(depth) || 1, parts.length))
  return parts.slice(0, wanted).join('/')
}

/**
 * Resolve the bundle key for one candidate — the §2 改造点 for `bundleKey`.
 *
 * Backward-compatibility rule, and it is the whole point:
 *   • the candidate carries an explicit key      -> entry.key wins, applied:false
 *   • no bundleKey declared                     -> today's behaviour, applied:false
 *   • bundleKey is an OBJECT {strategy, ...}    -> applied (the v2 form)
 *   • bundleKey is a function                   -> applied (custom resolver)
 *   • bundleKey is a legacy STRING              -> applied ONLY when the caller
 *     opted in: `options.strategies[strategy]` exists, or
 *     `options.trustDeclaredStrategies === true`.
 *
 * So none of the nineteen v1 packs change grouping until its owner migrates,
 * which is what keeps the 43 smoke-test assertions green.
 *
 * @returns {{ key: string|null, applied: boolean, source: 'entry'|'derived'|'fallback', strategy: string|null, reason: string }}
 */
export function resolveBundleKey(pack, candidate, options = {}) {
  const declared = pack?.bundleKey
  const explicit = typeof candidate?.key === 'string' && candidate.key !== '' ? candidate.key : null
  const declaredName = declared === undefined || declared === null
    ? null
    : (typeof declared === 'function' ? '(custom)' : (typeof declared === 'object' ? (declared.strategy ?? '(custom)') : String(declared)))

  // An explicit key on the candidate always wins. `pack.bundleKey` is documented
  // as the derivation used WHEN the candidate does not carry one, so this
  // precedence is part of the contract, not an optimisation.
  if (explicit !== null) {
    return { key: explicit, applied: false, source: 'entry', strategy: declaredName, reason: 'candidate carries an explicit key — entry.key wins over pack.bundleKey' }
  }

  const fallback = candidate?.key ?? candidate?.path ?? null
  if (declared === undefined || declared === null) {
    return { key: fallback, applied: false, source: 'fallback', strategy: null, reason: 'no bundleKey declared — bundle() groups by entry.key ?? entry.path' }
  }
  if (typeof declared === 'function') {
    return { key: String(declared(candidate)), applied: true, source: 'derived', strategy: '(custom)', reason: 'pack-supplied resolver' }
  }
  if (typeof declared === 'object') {
    if (typeof declared.resolve === 'function') {
      return { key: String(declared.resolve(candidate)), applied: true, source: 'derived', strategy: declared.strategy ?? '(custom)', reason: 'bundleKey.resolve' }
    }
    const strategy = String(declared.strategy ?? '')
    const fn = BUNDLE_KEY_STRATEGIES[strategy]
    if (typeof fn !== 'function') {
      return { key: fallback, applied: false, source: 'fallback', strategy, reason: `unknown bundle-key strategy "${strategy}"` }
    }
    return { key: fn(candidate, declared), applied: true, source: 'derived', strategy, reason: 'v2 bundleKey object' }
  }

  const strategy = String(declared)
  const optIn = options.strategies ?? {}
  if (typeof optIn[strategy] === 'function') {
    const params = (options.params ?? {})[strategy] ?? {}
    return { key: String(optIn[strategy](candidate, params)), applied: true, source: 'derived', strategy, reason: 'caller-opted-in strategy' }
  }
  if (options.trustDeclaredStrategies === true && typeof BUNDLE_KEY_STRATEGIES[strategy] === 'function') {
    return { key: BUNDLE_KEY_STRATEGIES[strategy](candidate, (options.params ?? {})[strategy] ?? {}), applied: true, source: 'derived', strategy, reason: 'trustDeclaredStrategies' }
  }
  return {
    key: fallback,
    applied: false,
    source: 'fallback',
    strategy,
    reason: `legacy string bundleKey "${strategy}" is declared but not activated — opt in with options.bundleKeyStrategies or migrate to the v2 object form`,
  }
}

/** The two reviewer shapes a domain may declare in `criticism.kind`. */
export const CRITICISM_KINDS = Object.freeze(['fact-checker', 'triage'])

/**
 * The kind each loss orientation implies. This mirrors a property that already
 * holds across all nineteen v1 packs (verified: every recall-first pack declares
 * `triage`, every precision-first pack declares `fact-checker`), so it can be
 * stated as an invariant rather than invented as a new rule.
 */
export const DEFAULT_CRITICISM_KIND = Object.freeze({
  'precision-first': 'fact-checker',
  'recall-first': 'triage',
})

/** The kind a domain should declare, given its orientation. */
export function expectedCriticismKind(orientation) {
  return DEFAULT_CRITICISM_KIND[orientation] ?? 'fact-checker'
}

/**
 * Is `kind` consistent with `orientation`?
 *
 * IMPORTANT: inconsistency is a WARNING, never an error. `criticism.kind`
 * selects the reviewer's SHAPE (adversarial fact-check vs triage), while the
 * keep/drop decision stays where it already is — `lossOrientation`. Wiring the
 * kind into the loss math would change outcomes for shipped packs and break
 * verified assertions; the contract forbids that.
 */
export function criticismKindConsistent(orientation, kind) {
  return kind === expectedCriticismKind(orientation)
}

// ---------------------------------------------------------------------------
// §4 — domain package layout and auto-discovery
// ---------------------------------------------------------------------------

/**
 * The v2 layout. Each domain owns a directory; no domain owner edits a shared
 * file. `lib/domains.js` stays as the frozen v1 library and is NOT the place a
 * new domain goes.
 */
export const DOMAIN_FILE_LAYOUT = Object.freeze({
  root: 'domains',
  entry: 'index.js',
  files: Object.freeze({
    'index.js': 'export default <pack v2>; also `export const contractVersion = 2`',
    'source.js': 'export default defineCandidateSource({...})',
    'anchor.js': 'export default defineAnchorVerifier({...})',
    'evidence.js': 'export default defineEvidenceToolkit({ tools: [...] })',
    'prompts.js': 'export default defineReviewPrompts({ review, verify })',
    'rules/*.md': `>= ${MIN_RULES_PER_DOMAIN} rule documents, each with name / match / needs-expert-review front-matter`,
    'fixtures/*.json': 'input + expected P0/P1 outcome; MUST include empty, all-gated-out, happy-path',
    'test.mjs': 'P0 -> P7 assertions over the fixtures; run by `npm test`',
  }),
  /** Every domain directory must contain these. */
  required: Object.freeze(['index.js', 'source.js', 'anchor.js', 'evidence.js', 'prompts.js', 'rules', 'fixtures', 'test.mjs']),
  /** Files no domain owner writes; the loader owns them. */
  shared: Object.freeze(['domains/index.js', 'lib/domains.js']),
})

/** Fixture names every domain must ship. The first two are the required edges. */
export const MANDATORY_FIXTURES = Object.freeze(['empty', 'all-gated-out', 'happy-path'])

/** Fields a fixture's `expect` block may carry. */
export const FIXTURE_EXPECT_FIELDS = Object.freeze([
  'candidates', 'paths', 'admitted', 'excludedByPredicate', 'bounded', 'truncated', 'notes', 'throws',
])

/** Validate one fixture file against its domain's declared input format. */
export function validateFixture(fixture, format) {
  const problems = []
  if (fixture === null || typeof fixture !== 'object') return ['fixture is not an object']
  if (typeof fixture.name !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(fixture.name)) problems.push('fixture.name must be lowercase kebab-case')
  if (typeof fixture.domain !== 'string' || fixture.domain === '') problems.push('fixture.domain is required')
  if (typeof fixture.format !== 'string' || fixture.format === '') problems.push('fixture.format is required')
  if (format !== undefined && fixture.format !== format) problems.push(`fixture.format "${fixture.format}" does not match the domain input format "${format}"`)
  if (fixture.input === null || typeof fixture.input !== 'object') problems.push('fixture.input is required')
  else if (fixture.input.format !== fixture.format) problems.push('fixture.input.format must equal fixture.format')
  if (fixture.expect === null || typeof fixture.expect !== 'object') problems.push('fixture.expect is required')
  else {
    const keys = Object.keys(fixture.expect)
    if (keys.length === 0) problems.push('fixture.expect must state at least one expectation')
    for (const key of keys) {
      if (!FIXTURE_EXPECT_FIELDS.includes(key)) problems.push(`fixture.expect.${key} is not a recognised expectation`)
    }
    if (fixture.expect.throws === undefined && fixture.expect.candidates === undefined && fixture.expect.admitted === undefined) {
      problems.push('fixture.expect must declare `candidates`, `admitted` or `throws`')
    }
  }
  if (fixture.anchors !== undefined) {
    if (fixture.anchors === null || typeof fixture.anchors !== 'object') problems.push('fixture.anchors must be an object when declared')
    else {
      for (const key of ['positive', 'negative', 'ambiguous']) {
        if (fixture.anchors[key] !== undefined && !Array.isArray(fixture.anchors[key])) problems.push(`fixture.anchors.${key} must be an array`)
      }
      if (fixture.anchors.positive === undefined || fixture.anchors.positive.length === 0) {
        problems.push('fixture.anchors.positive must contain at least one positive anchor case')
      }
      if (fixture.anchors.negative === undefined || fixture.anchors.negative.length === 0) {
        problems.push('fixture.anchors.negative must contain at least one negative anchor case — a verifier without a negative case is untested')
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// §1 (cont.) — the whole-pack gate
// ---------------------------------------------------------------------------

/**
 * The completion gate. A domain directory is done when this returns `[]`.
 * Deliberately stricter than `validateDomain` (which stays as-is for v1).
 * @returns {string[]}
 */
export function validateDomainPackV2(pack, options = {}) {
  const problems = []
  if (pack === null || typeof pack !== 'object') return ['pack is not an object']

  if (pack.contractVersion !== CONTRACT_VERSION) {
    problems.push(`contractVersion must be ${CONTRACT_VERSION} (got ${JSON.stringify(pack.contractVersion)})`)
  }
  for (const field of ['id', 'title', 'category', 'lossOrientation', 'anchor', 'candidateSet', 'criticism']) {
    if (pack[field] === undefined || pack[field] === null || pack[field] === '') problems.push(`missing required field "${field}"`)
  }
  if (typeof pack.id === 'string' && !/^[a-z][a-z0-9-]*$/u.test(pack.id)) problems.push('id must be lowercase kebab-case')
  if (!['A', 'B', 'C', 'D'].includes(pack.category)) problems.push('category must be one of A/B/C/D')

  // 1. candidateSource — and its kind must match candidateSet.kind.
  for (const problem of validateCandidateSource(pack.candidateSource)) problems.push(problem)
  if (typeof pack.candidateSource?.kind === 'string' && typeof pack.candidateSet?.kind === 'string' && pack.candidateSource.kind !== pack.candidateSet.kind) {
    problems.push(`candidateSource.kind "${pack.candidateSource.kind}" must equal candidateSet.kind "${pack.candidateSet.kind}"`)
  }
  if (pack.candidateSet?.inputFormat !== undefined && pack.candidateSet.inputFormat !== pack.candidateSource?.inputFormat) {
    problems.push('candidateSet.inputFormat must equal candidateSource.inputFormat')
  }

  // 2. anchorVerifier — and its kind must match the declared anchor kind.
  for (const problem of validateAnchorVerifier(pack.anchorVerifier)) problems.push(problem)
  if (typeof pack.anchorVerifier?.kind === 'string' && pack.anchor?.kind !== pack.anchorVerifier.kind) {
    problems.push(`anchorVerifier.kind "${pack.anchorVerifier.kind}" must equal anchor.kind "${pack.anchor?.kind}"`)
  }
  if (pack.anchor?.verify !== undefined && !ANCHOR_VERIFY_LEVELS.includes(pack.anchor.verify)) {
    problems.push(`anchor.verify must be one of ${ANCHOR_VERIFY_LEVELS.join('/')}`)
  }

  // 3. evidenceTools — required, and an empty toolkit must be explicit.
  for (const problem of validateEvidenceToolkit(pack.evidenceTools)) problems.push(problem)

  // 4. reviewPrompts.
  for (const problem of validateReviewPrompts(pack.reviewPrompts)) problems.push(problem)

  // 5. ruleLibrary.
  for (const problem of validateRuleLibrary(pack.ruleLibrary)) problems.push(problem)

  // criticism.kind — wiring it is the §2 change; declaring it consistently is v2.
  if (pack.criticism?.kind === undefined) problems.push('criticism.kind is required in v2 (fact-checker | triage)')
  else if (!CRITICISM_KINDS.includes(pack.criticism.kind)) problems.push(`criticism.kind must be one of ${CRITICISM_KINDS.join('/')}`)
  else if (!criticismKindConsistent(pack.lossOrientation, pack.criticism.kind)) {
    problems.push(`criticism.kind "${pack.criticism.kind}" disagrees with lossOrientation "${pack.lossOrientation}" (expected "${expectedCriticismKind(pack.lossOrientation)}") — a mismatch means one of the two is wrong; fix the declaration, not the engine`)
  }

  // bundleKey — v2 requires the object form so the strategy is explicit.
  if (pack.bundleKey === undefined || pack.bundleKey === null) problems.push('bundleKey is required in v2')
  else if (typeof pack.bundleKey === 'string') {
    problems.push('bundleKey must use the v2 object form ({ strategy, ... }) so grouping is explicit rather than opted into')
  } else if (typeof pack.bundleKey?.strategy !== 'string' || typeof BUNDLE_KEY_STRATEGIES[pack.bundleKey.strategy] !== 'function') {
    if (typeof pack.bundleKey?.resolve !== 'function') {
      problems.push(`bundleKey.strategy must be one of ${Object.keys(BUNDLE_KEY_STRATEGIES).join('/')} (or supply bundleKey.resolve)`)
    }
  }

  // Fixtures.
  const fixtures = pack.fixtures
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    problems.push(`fixtures must list the fixture names; at least ${MANDATORY_FIXTURES.join(', ')} are mandatory`)
  } else {
    for (const mandatory of MANDATORY_FIXTURES) {
      if (!fixtures.includes(mandatory)) problems.push(`missing mandatory fixture "${mandatory}"`)
    }
  }

  // tests wired into npm test.
  if (options.requireTestWiring === true && pack.testWired !== true) {
    problems.push('test.mjs must be wired into `npm test` (pack.testWired !== true)')
  }
  return problems
}

/** Typed factory for a v2 domain pack. Throws on the first invalid pack. */
export function defineDomainPackV2(spec) {
  const pack = { __contract: CONTRACT_VERSION, contractVersion: CONTRACT_VERSION, ...spec }
  const problems = validateDomainPackV2(pack)
  if (problems.length > 0) throw contractError(ERROR_CODES.E_CONTRACT, `invalid v2 domain pack "${spec?.id ?? '(anonymous)'}": ${problems.join('; ')}`, problems)
  return Object.freeze(pack)
}

// ---------------------------------------------------------------------------
// §5 — documented input format per domain
// ---------------------------------------------------------------------------

/**
 * One entry per built-in domain. `format` is the discriminator a fixture and an
 * adapter both carry; `adapter` says how a real system produces the payload
 * (integration itself is out of scope, the shape is not); `gateMapping` names
 * the domain's natural exclusion signal and the gate field it becomes.
 */
export const DOMAIN_INPUT_FORMATS = Object.freeze({
  'code-review': Object.freeze({
    id: 'code-review',
    format: 'unified-diff',
    bounded: true,
    shape: '{ diff: string, files?: [{ path, bytes?, binary?, deleted?, additions?, deletions? }] }',
    adapter: '`git diff --unified=3 --no-color <base>...<head>`; `files[]` enriched from `git diff --numstat` + `git diff --name-status`',
    candidates: 'one per (file, hunk)',
    locator: '{ hunkIndex, startLine, endLine }',
    gateMapping: 'unchanged/binary files -> binary; deleted files -> deleted; file size -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'renamed-file'],
  }),
  'risk-compliance': Object.freeze({
    id: 'risk-compliance',
    format: 'clause-and-surface',
    bounded: true,
    shape: '{ clauses: [{ id, title, text, appliesTo?: string[] }], surface: [{ id, type, path, description, evidence? }] }',
    adapter: 'clause list from the policy repository (one JSON export per instrument); surface from the data-flow / permission / retention inventories',
    candidates: 'one per (clause, surface item) pair the clause\'s appliesTo glob admits',
    locator: '{ clauseId, surfaceId }',
    gateMapping: '`.md`-only clause dumps -> path exclusion; redacted surface items -> binary; retired surfaces -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'unmatched-clause'],
  }),
  'ux-review': Object.freeze({
    id: 'ux-review',
    format: 'flow-spec',
    bounded: true,
    shape: '{ flow: { id, name, steps: [{ id, name, type, next?, onError?, onCancel? }] }, branches: [{ id, kind, steps: string[] }], prototype?: { nodes: [{ id, name, screen }] } }',
    adapter: 'flow export from the interaction-design tool; step ids must match the prototype node map',
    candidates: 'one per (step, branch) plus one per declared branch kind',
    locator: '{ stepId, branchId, nodeId? }',
    gateMapping: 'archived steps -> deleted; image-only nodes -> binary; oversized screens -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'undeclared-branch'],
  }),
  'ui-visual': Object.freeze({
    id: 'ui-visual',
    format: 'design-tokens-and-layers',
    bounded: true,
    shape: '{ tokens: { <group>: { <name>: { value } } }, layers: [{ id, name, type, props: { <prop>: value }, tokenRefs?: {}, archived? }] }',
    adapter: 'design-system token file (JSON export) + a layer dump from the design tool with resolved property values',
    candidates: 'one per (layer, property) whose value is not a token reference',
    locator: '{ layerId, prop, tokenName? }',
    gateMapping: 'archived layers -> deleted; raster layers -> binary; large exports -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'hardcoded-value'],
  }),
  architecture: Object.freeze({
    id: 'architecture',
    format: 'module-graph-and-adr',
    bounded: true,
    shape: '{ modules: [{ id, path, dependsOn: string[] }], adrs: [{ id, title, status, decision, affects: string[] }] }',
    adapter: 'dependency extractor over the build graph; ADR directory parsed to front-matter',
    candidates: 'one per dependency edge, plus one per (ADR, affected module) pair',
    locator: '{ moduleId, targetId?, adrId? }',
    gateMapping: 'test-only modules -> path exclusion; generated modules -> binary; removed modules -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'cycle'],
  }),
  'data-engineering': Object.freeze({
    id: 'data-engineering',
    format: 'lineage-and-schema',
    bounded: true,
    shape: '{ nodes: [{ id, type, inputs: string[], outputs: string[], path?, sql?, schedule? }], schema: { "db.table": { columns: [{ name, type, nullable, default? }] } }, runs?: [{ nodeId, status, at? }] }',
    adapter: 'lineage graph export from the orchestrator (Airflow/dbt/Dagster) + the warehouse information_schema dump',
    candidates: 'one per lineage edge, plus one per (node, column) whose nullability or type is in play',
    locator: '{ nodeId, table, column }',
    gateMapping: 'test fixtures dags -> path exclusion; binary snapshots -> binary; dropped tables -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'orphan-column'],
  }),
  'algo-model': Object.freeze({
    id: 'algo-model',
    format: 'experiment-record',
    bounded: true,
    shape: '{ experiments: [{ id, name, seed, dataset: { train, valid, test, splitsHash }, metrics: [{ name, value, definition, ci? }], baseline?: { id, metrics: [] }, hyperparams: {}, budget: { steps, gpuHours } }] }',
    adapter: 'experiment tracker export (MLflow/W&B) with the metric-definition registry joined in',
    candidates: 'one per (experiment, metric)',
    locator: '{ experimentId, metricName }',
    gateMapping: 'cancelled runs -> deleted; weights/artifacts -> binary; large logs -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'missing-baseline'],
  }),
  'tech-test': Object.freeze({
    id: 'tech-test',
    format: 'test-inventory-and-coverage',
    bounded: true,
    shape: '{ cases: [{ id, file, assertions: [{ kind, target }] }], coverage: { files: { <path>: { lines: {}, branches: {} } } }, source: { <path>: { lines: string[] } } }',
    adapter: 'test-runner inventory (names + assertion kinds) + the lcov/cobertura report + the source snapshot',
    candidates: 'one per uncovered line or branch, plus one per weak-assertion case',
    locator: '{ caseId?, path, line?, branch? }',
    gateMapping: 'generated test files -> path exclusion; snapshots -> binary; deleted suites -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'zero-coverage-file'],
  }),
  'tech-doc': Object.freeze({
    id: 'tech-doc',
    format: 'doc-corpus-and-api-surface',
    bounded: true,
    shape: '{ documents: [{ path, title, sections: [{ anchor, text }] }], api: [{ name, signature, params: [{ name, required, default? }], returns }] }',
    adapter: 'Markdown/RST tree with computed heading anchors + an API surface dump (TSD/Go doc/OpenAPI)',
    candidates: 'one per (section, verifiable claim) — a claim is a signature-shaped string, a fenced example, or a link',
    locator: '{ docPath, anchor, apiName? }',
    gateMapping: 'generated docs -> path exclusion; images -> binary; deleted pages -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'broken-relative-link'],
  }),
  'operator-design': Object.freeze({
    id: 'operator-design',
    format: 'operator-registry-and-tests',
    bounded: true,
    shape: '{ operators: [{ signature, name, backends: string[], dtypes: string[], shapeBranches: string[] }], tests: [{ operator, backend, dtype, shape, tolerance: { atol, rtol } | null, asserted }] }',
    adapter: 'operator registration table + the numeric test-suite manifest parsed for tolerance assertions',
    candidates: 'one per (operator, backend, dtype, shapeBranch)',
    locator: '{ signature, backend, dtype, shapeBranch }',
    gateMapping: 'unbuilt kernels -> deleted; binary blobs -> binary; oversized generated code -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'missing-tolerance'],
  }),
  'requirement-research': Object.freeze({
    id: 'requirement-research',
    format: 'interview-corpus',
    bounded: true,
    shape: '{ sessions: [{ id, participant: { id, role }, startedAt, utterances: [{ t, speaker, text, redacted?, withdrawn? }] }], notes?: [] }',
    adapter: 'interview transcripts exported as structured JSON, one utterance per turn with its timestamp',
    candidates: 'one per utterance (the candidate is the QUOTE, never the derived requirement)',
    locator: '{ sessionId, utteranceIndex, t }',
    gateMapping: 'redacted utterances -> binary; withdrawn consent -> deleted; very long turns -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'contradictory-pair'],
  }),
  'product-planning': Object.freeze({
    id: 'product-planning',
    format: 'requirement-registry-and-plan',
    bounded: true,
    shape: '{ requirements: [{ id, title, status, sourceQuoteId? }], plans: [{ id, title, serves: string[], metric: { name, baseline, target, window } | null, deps: [], risks: [] }] }',
    adapter: 'confirmed-requirement registry + the roadmap document parsed into plan items',
    candidates: 'one per (plan, requirement) link, plus one per orphan on either side',
    locator: '{ planId, requirementId? }',
    gateMapping: 'unconfirmed requirements -> deleted; attachments -> binary; large specs -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'orphan-both-sides'],
  }),
  'backend-engineering': Object.freeze({
    id: 'backend-engineering',
    format: 'unified-diff',
    bounded: true,
    shape: '{ diff: string, files?: [{ path, bytes?, binary?, deleted? }], serviceMap?: { <path>: string } }',
    adapter: 'same as code-review, with `serviceMap` joined from the repository layout',
    candidates: 'one per (file, hunk)',
    locator: '{ hunkIndex, startLine, endLine }',
    gateMapping: 'generated protobuf output -> path exclusion; deleted handlers -> deleted; large SQL migrations -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'proto-field-removed'],
  }),
  'frontend-engineering': Object.freeze({
    id: 'frontend-engineering',
    format: 'unified-diff',
    bounded: true,
    shape: '{ diff: string, files?: [{ path, bytes?, binary?, deleted? }], bundleReport?: { <chunk>: bytes } }',
    adapter: 'same as code-review, with the build\'s bundle report joined in when available',
    candidates: 'one per (file, hunk)',
    locator: '{ hunkIndex, startLine, endLine }',
    gateMapping: 'built assets -> path exclusion; deleted components -> deleted; source maps -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'css-only-change'],
  }),
  'market-research': Object.freeze({
    id: 'market-research',
    format: 'research-seed',
    bounded: false,
    shape: '{ question: string, scope: { market, geo, horizon }, seedSources: [{ url, title, retrievedAt, snippet, withdrawn? }] }',
    adapter: 'a hand-curated seed list; the widening round is the C-family exploration step and is NOT part of P0',
    candidates: 'one per seed source — a SEED, not an enumeration; `bounded:false` and a note are mandatory',
    locator: '{ url, quote }',
    gateMapping: 'non-http(s) sources -> extension; withdrawn sources -> deleted; paywalled bodies -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'non-http-source'],
  }),
  'reverse-engineering': Object.freeze({
    id: 'reverse-engineering',
    format: 'artifact-and-observations',
    bounded: false,
    shape: '{ artifacts: [{ id, path, sha256, kind, obtainedBy, authorisation }], observations: [{ id, artifactId, steps: string[], observed, verified? }] }',
    adapter: 'an artifact manifest with provenance, plus a structured observation log; exploration widens the log',
    candidates: 'one per observation — the set grows with exploration, so `bounded:false` and a note are mandatory',
    locator: '{ artifactId, observationId }',
    gateMapping: 'artifacts under `**/.git/**` -> default-path; opaque blobs -> binary; absent artifacts -> deleted',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'unverified-observation'],
  }),
  'project-management': Object.freeze({
    id: 'project-management',
    format: 'task-graph',
    bounded: true,
    shape: '{ tasks: [{ id, title, owner, estimateDays, status, dependsOn: string[] }], milestones: [{ id, due, tasks: string[] }], risks: [{ id, trigger, impact, mitigation }] }',
    adapter: 'issue tracker export joined with the milestone plan; `dependsOn` from blocking links',
    candidates: 'one per dependency edge, plus one per task (node position in the graph)',
    locator: '{ taskId, from?, to? }',
    gateMapping: 'archived tasks -> deleted; attachment-only tasks -> binary; large task bodies -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'cycle-and-orphan'],
  }),
  'user-feedback': Object.freeze({
    id: 'user-feedback',
    format: 'feedback-ledger',
    bounded: true,
    shape: '{ feedback: [{ id, channel, receivedAt, verbatim, status, decision?: { reason, decidedAt } }] }',
    adapter: 'support/CRM export, one row per feedback item, `verbatim` preserved byte-for-byte',
    candidates: 'one per feedback item',
    locator: '{ feedbackId, quote }',
    gateMapping: 'spam/duplicate-marked items -> deleted; attachments -> binary; long threads -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'unclosed-only'],
  }),
  'requirement-alignment': Object.freeze({
    id: 'requirement-alignment',
    format: 'trace-graph',
    bounded: true,
    shape: '{ nodes: [{ id, type, ref }], edges: [{ from, to, kind }] } — type ∈ requirement|plan|design|implementation|case|feedback',
    adapter: 'the union of every other domain\'s id space, exported by whoever owns the traceability store',
    candidates: 'one per edge, plus one per node side (missing upstream / missing downstream)',
    locator: '{ fromId, toId? }',
    gateMapping: 'nodes pointing at deleted artefacts -> deleted; opaque refs -> binary; huge graphs -> bytes',
    fixtures: ['empty', 'all-gated-out', 'happy-path', 'dangling-ref'],
  }),
})

/** The declared input format for a domain id, or `null`. */
export function inputFormatFor(domainId) {
  return DOMAIN_INPUT_FORMATS[domainId] ?? null
}

/** Every domain id this contract defines a format for. */
export const DOCUMENTED_DOMAIN_IDS = Object.freeze(Object.keys(DOMAIN_INPUT_FORMATS))

// ---------------------------------------------------------------------------
// Self-check — the constants above must stay internally consistent.
// ---------------------------------------------------------------------------

/**
 * Cheap invariant check. Call it from `npm test` and from a domain's own test.
 * @returns {string[]} violations (empty is good)
 */
export function checkContractIntegrity() {
  const problems = []
  if (EXTENSION_POINT_NAMES.length !== 5) problems.push(`expected 5 extension points, got ${EXTENSION_POINT_NAMES.length}`)
  for (const name of EXTENSION_POINT_NAMES) {
    const point = EXTENSION_POINTS[name]
    if (point.field !== name) problems.push(`EXTENSION_POINTS.${name}.field must equal its key`)
    for (const key of ['phase', 'file', 'signature', 'returns', 'failure', 'minimalAssertion']) {
      if (typeof point[key] !== 'string' || point[key] === '') problems.push(`EXTENSION_POINTS.${name}.${key} must be a non-empty string`)
    }
  }
  if (DOCUMENTED_DOMAIN_IDS.length !== 19) problems.push(`expected 19 documented input formats, got ${DOCUMENTED_DOMAIN_IDS.length}`)
  for (const id of DOCUMENTED_DOMAIN_IDS) {
    const entry = DOMAIN_INPUT_FORMATS[id]
    for (const key of ['format', 'shape', 'adapter', 'candidates', 'locator', 'gateMapping']) {
      if (typeof entry[key] !== 'string' || entry[key] === '') problems.push(`DOMAIN_INPUT_FORMATS['${id}'].${key} must be a non-empty string`)
    }
    for (const mandatory of MANDATORY_FIXTURES) {
      if (!Array.isArray(entry.fixtures) || !entry.fixtures.includes(mandatory)) {
        problems.push(`DOMAIN_INPUT_FORMATS['${id}'].fixtures must include the mandatory "${mandatory}"`)
      }
    }
    if (typeof entry.bounded !== 'boolean') problems.push(`DOMAIN_INPUT_FORMATS['${id}'].bounded must be a boolean`)
    if (entry.bounded === false && !['market-research', 'reverse-engineering'].includes(id)) {
      problems.push(`only the C-family domains may declare bounded:false (${id} does)`)
    }
  }
  for (const orientation of ['precision-first', 'recall-first']) {
    if (!DEFAULT_CRITICISM_KIND[orientation]) problems.push(`DEFAULT_CRITICISM_KIND is missing ${orientation}`)
  }
  for (const name of Object.keys(BUNDLE_KEY_STRATEGIES)) {
    const probe = BUNDLE_KEY_STRATEGIES[name]({ path: 'a/b/c.ts' }, {})
    if (typeof probe !== 'string') problems.push(`BUNDLE_KEY_STRATEGIES.${name} must return a string`)
  }
  if (RULE_PROVENANCE.expertValidated !== false) problems.push('RULE_PROVENANCE.expertValidated must stay false — rule libraries are drafts')
  if (RULE_PROVENANCE.requiresExpertReview !== true) problems.push('RULE_PROVENANCE.requiresExpertReview must stay true')
  // CHANGED (t49): a trusted tier that is not even declared would let the engine
  // accept a verdict the vocabulary does not name. (The other direction — a
  // trusted tier no producer returns — cannot be checked here: it needs the
  // shipped domains, so `lib/kernel-test.mjs` §16 owns it.)
  for (const tier of TRUSTED_ANCHOR_TIERS) {
    if (!Object.hasOwn(ANCHOR_TIERS, tier)) problems.push(`TRUSTED_ANCHOR_TIERS["${tier}"] is not a declared ANCHOR_TIERS entry`)
  }
  return problems
}
