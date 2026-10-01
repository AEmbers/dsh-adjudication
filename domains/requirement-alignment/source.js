/**
 * requirement-alignment — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `trace-graph`
 * --------------------------------------
 * The contract table (`lib/contracts.js` `DOMAIN_INPUT_FORMATS`) declares this
 * domain's shape exactly, and this file implements it rather than inventing one:
 *
 *   { nodes: [{ id, type, ref }], edges: [{ from, to, kind }] }
 *   type ∈ requirement | plan | design | implementation | case | feedback
 *
 * Spelled out, with the optional parts a real traceability export carries:
 *
 *   {
 *     graphPath?: string,                 // default 'trace/graph.json'
 *     nodes: [{
 *       id,                               // required, the vertex identity
 *       type,                             // one of NODE_TYPES above
 *       ref,                              // an anchor id produced BY ANOTHER DOMAIN
 *       title?, refDeleted?, refOpaque?, archived?, attachmentOnly?, body?,
 *     }],
 *     edges: [{ from, to, kind }],        // kind ∈ EDGE_KINDS
 *     idSpace?: string[],                 // ids allowed to be edge endpoints without
 *                                         // a node record (external artefacts)
 *     upstream?: [{ domain, ref, path? }],// the anchor ids other domains ACTUALLY
 *                                         // produced — see `upstreamSet()` below
 *     documents?: [{ path, type, payload, meta }],   // one document per chain
 *   }
 *
 * WHAT MAKES THIS A META-DOMAIN
 * -----------------------------
 * This domain's subject is not a document. It is the CONSISTENCY of a chain that
 * crosses domains: a requirement (whose anchor is an utterance id produced by
 * `requirement-research`), the plan item that serves it (`product-planning`), the
 * design, the implementation and the case (`code-review`'s diff-line anchors), and
 * the feedback that started it (`user-feedback`).
 *
 * So a node's `ref` is deliberately NOT part of this domain's own id space. It is
 * an anchor id owned by a sibling domain, and this domain must be able to CONSUME
 * it. `refShape()` below recognises the shapes those domains actually emit; a
 * `cross-domain-ref` anchor claim can then be confirmed against them, and a link
 * whose ref no longer appears in `upstream[]` is the stale-link case this domain
 * exists to report.
 *
 * The rule that keeps this honest: the shape check is a SHAPE check. "It looks
 * like a diff-line anchor" is not evidence that the upstream domain ever emitted
 * it — only `upstream[]` answers that. Both are reported separately, and the
 * verifier keeps them apart, because collapsing them would turn a stale link into
 * a confirmed one.
 *
 * WHAT A CANDIDATE IS
 * -------------------
 * The contract table declares: "one per edge, plus one per node side (missing
 * upstream / missing downstream)". Both halves are implemented literally, because
 * each answers a question the other cannot:
 *
 *   trace-edge        R1 → I1  — the relationship exists and has a direction.
 *   trace-node-side   R1/upstream   — nothing leads INTO R1 (a requirement with no
 *                                     originating feedback).
 *                     I1/downstream — nothing leads OUT of I1 (an implementation with
 *                                     no case and no feedback loop).
 *
 * Without the node-side candidates a node with no edges is invisible: it appears in
 * no edge, so no candidate mentions it, so no finding can be anchored to it. A
 * traceability domain that cannot report an unlinked node cannot report a gap.
 *
 * PATHS ARE DOCUMENT-REFERENCE PATHS, NOT FILE PATHS
 * -------------------------------------------------
 * Three engine facts force the scheme (`_lib/graph.js` `derivedPath` is the one
 * implementation of it):
 *
 *   • `validateCandidateSetResult` requires `path` to match
 *     `^[a-z0-9][a-z0-9._:/-]*$` — `>` and uppercase are rejected outright;
 *   • `gate()` reports exclusions as `{ path, predicate }` only, so two candidates
 *     sharing a path are indistinguishable in `plan.gate.excluded`;
 *   • the gate's extension predicate takes `path.slice(path.lastIndexOf('.'))`, so
 *     any dot after the extension turns the candidate's type into garbage.
 *
 * The raw ids (`R1`, `R1->I1`, `chain/checkout#R1#L4`) live in `locator` and in
 * `text`, never in `path`. Nothing ever parses an id back out of a path — a slug is
 * lossy, so the verifier compares the LOCATOR.
 *
 * HONESTY: this module only ENUMERATES. It does not decide what is reviewable —
 * the P1 gate does, and the boundary fixtures prove that. Its own `excluded` list is
 * a separate, reported thing: "this input declared something I refuse to turn into
 * a candidate", with a reason, distinct from gate reasons.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'
import { byteLength, clipLines, derivedPath, documentsOf, looksLikeGraph, slash } from '../_lib/graph.js'

/** Node types. The contract table's vocabulary, in its order. */
export const NODE_TYPES = Object.freeze([
  'requirement', 'plan', 'design', 'implementation', 'case', 'feedback',
])

/**
 * Edge kinds. Deliberately small, and deliberately DIRECTIONAL.
 *
 * `derives`     requirement → plan        the plan item was derived from the requirement
 * `specifies`   plan → design             the design specifies how the plan item is built
 * `implements`  design|plan → implementation   the code implements it
 * `verifies`    implementation → case     the case verifies the implementation
 * `informs`     feedback → requirement    the feedback is what the requirement answers
 *
 * `informs` points feedback → requirement, i.e. BACKWARDS with respect to the
 * reading order, and that is the whole traceability loop: a chain that runs
 * requirement → … → implementation → … → feedback is the forward direction visible
 * in a report, while the causal edges of a trace graph close the loop from the
 * feedback back to the requirement it justifies. The verifier reads direction
 * literally (`from → to`), so a model that reverses it gets `locator-mismatch`.
 */
export const EDGE_KINDS = Object.freeze([
  'derives', 'specifies', 'implements', 'verifies', 'informs',
])

/** Candidate kinds. `candidateSet.kind` in `index.js` uses the same vocabulary. */
export const CANDIDATE_KINDS = Object.freeze({
  edge: 'trace-edge',
  nodeSide: 'trace-node-side',
})

/** The two sides of a node. See the header: each is a separate candidate. */
export const SIDES = Object.freeze(['upstream', 'downstream'])

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The anchor-id shapes the sibling domains actually emit.
 *
 * This table is the domain's answer to "can you consume ANOTHER domain's anchor
 * id?" — and it is a table, not a guess, because each entry is the form that
 * producer's own `source.js` builds its candidate paths from:
 *
 *   sessions/<sid>/u<n>          requirement-research, one verbatim utterance row
 *   requirements/<rid>           product-planning, a registry entry
 *   plans/<pid>/serves/<rid>     product-planning, a plan→requirement edge
 *   <path>.<code ext>[#L<a>[-L<b>]]
 *                                code-review / backend-engineering /
 *                                frontend-engineering — the candidate path IS the
 *                                changed file, optionally pinned to a diff-line span
 *   <path>.json                  project-management, a task or dependency node/edge
 *   feedback/<row>[.json]        user-feedback, a feedback ledger row — both the
 *                                derived ledger document its enumerator actually
 *                                emits (`feedback/ledger-fb-1001-dec-20.json`) and
 *                                the bare row id a fixture may hand-write
 *                                (`feedback/fb-1`)
 *
 * The extension list in the diff-domain form is the union of those domains' gate
 * extensions, on purpose: it is closed, so "any string that looks like a filename"
 * does NOT pass. A ref this table cannot place is reported as OPAQUE rather than
 * waved through.
 *
 * ORDER IS PART OF THE TABLE, NOT FORMATTING
 * ------------------------------------------
 * `refShape` returns the FIRST match, so a SPECIFIC prefix row must sit BEFORE the
 * catch-all `<path>.json` row. That row is deliberately broad — project-management's
 * id space really is `<path>.json` — which means it swallows every other domain's
 * `.json` ids too. Put `feedback/...` after it and 42/42 of user-feedback's real
 * anchors are attributed to project-management while the user-feedback row scores
 * zero hits: a `refDomain` that reads correctly in prose and wrongly in the report.
 * (Found in review of t19/t25 — the row was there, in the wrong place.) Any future
 * prefixed row that can end in `.json` goes ABOVE the catch-all as well.
 *
 * WHAT THIS TABLE IS NOT
 * ----------------------
 * A match means "the FORM is consumable and this is the family that emits it" — it
 * is NOT proof that the upstream domain still produces that specific id, and for the
 * diff-extension family it cannot even tell WHICH member emitted it (code-review,
 * backend-engineering, frontend-engineering, tech-doc and others emit the identical
 * form). `upstream[]` answers the producer question; the shape only answers "can this
 * be read at all". Ids this table cannot place are OPAQUE: marked `binary`, moved out
 * of the review scope, and listed in `notes` one by one — never silently dropped and
 * never guessed at.
 *
 * HOW MUCH THE TABLE ACTUALLY KNOWS: `basis`
 * ------------------------------------------
 * Every row carries `basis`, and `refShape()` reports it on the attribution itself:
 *
 *   'exact'  the shape points at ONE domain. `sessions/<sid>/u<n>` is only ever
 *            requirement-research, `requirements/<id>` only ever product-planning, …
 *   'form'   the shape identifies a FORM and a FAMILY of producers, not a member:
 *            several domains emit byte-identical ids, so naming one of them would be
 *            a guess dressed as an answer.
 *
 * THE PRINCIPLE, so the next person adding a row does not have to guess:
 *
 *   `exact` requires the judgement to be DOMAIN-SPECIFIC — a shape that can only have
 *   come from one domain. The moment the judgement is GENERIC (any path with a diff
 *   extension, any path ending in `.json`, any path at all), the row is `form`, even
 *   if the row's `domain` field names a real domain: that name is then only the
 *   family's reference producer.
 *
 * Two rows are `form` for exactly this reason, and neither can be fixed by reordering:
 * the diff-extension row (its judgement is "a path with a diff extension") and the
 * `<path>.json` row (its judgement is "a path ending in .json" — which also claims
 * algo-model's `experiments/<run>/*.json` exports and this domain's own
 * `chains/*.json` exports, not just project-management's graph ids).
 *
 * This exists because of the shape this whole program is trying to eliminate: a tool
 * reporting something MORE certain than what it knows. `src/core/engine.ts` (a
 * rollup's id, or architecture's) and `src/app.ts` (code-review's) are literally the
 * same string shape, so first-match-wins ordering cannot separate them — yet
 * `refDomain: 'code-review'` on its own reads like a fact. With `basis: 'form'` the
 * consumer is told the attribution is FAMILY-level, and `upstream[]` remains the only
 * thing that can answer "which domain, and is it still producing it".
 *
 * The list is finite and versioned by this file, which is a limit worth stating: a
 * new sibling domain with a new id shape is NOT consumable until a row is added
 * here. `test.mjs` PINS the resulting set (which producer is consumable, which is
 * not, and at what basis) so that a producer turning OPAQUE — i.e. quietly falling
 * out of the review scope — or an attribution silently graduating from `form` to
 * `exact`, fails the suite instead of degrading in silence.
 */
const DIFF_EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|cs|rb|php|sql|proto|yaml|yml|sh|css|scss|less|vue|svelte|html|md'

/**
 * The two attribution bases. `form` is the honest one when several domains share a shape.
 *
 * `exact`  — the judgement is DOMAIN-SPECIFIC: the shape can only have come from one
 *            domain (`sessions/<sid>/u<n>`, `requirements/<id>`, `plans/<sid>/serves/<id>`,
 *            `feedback/<row>`).
 * `form`   — the judgement is GENERIC: "any path with a diff extension", "any path ending
 *            in `.json`", … Several domains emit byte-identical ids, so the row names the
 *            FAMILY's reference producer and nothing more. Reordering rows cannot change
 *            this; only `upstream[]` can answer the membership question.
 */
export const ATTRIBUTION_BASES = Object.freeze(['exact', 'form'])

export const REF_SHAPES = Object.freeze([
  { domain: 'requirement-research', form: 'utterance', basis: 'exact', pattern: /^sessions\/[a-z0-9][a-z0-9._-]*\/u\d+$/u },
  { domain: 'product-planning', form: 'requirement-entry', basis: 'exact', pattern: /^requirements\/[a-z0-9][a-z0-9._-]*$/u },
  { domain: 'product-planning', form: 'plan-edge', basis: 'exact', pattern: /^plans\/[a-z0-9][a-z0-9._-]*\/serves\/[a-z0-9][a-z0-9._-]*$/u },
  // FAMILY-LEVEL ATTRIBUTION — this is the row that made `basis` necessary.
  //
  // The judgement here is "a path with a diff extension", with NO domain-specific
  // prefix. `src/core/engine.ts` (architecture, or tech-test, or a rollup's artefact)
  // and `src/app.ts` (code-review) are therefore the SAME shape to this row, and since
  // `refShape` is first-match-wins, NO ORDERING OF ROWS CAN TELL THEM APART. Naming
  // one of them would be an answer the shape does not contain, so the attribution is
  // reported with `basis: 'form'`: it identifies the diff-extension FAMILY.
  //
  // Which member actually emitted the id — and whether it still does — is a question
  // of MEMBERSHIP, not of shape, and only `upstream[]` (declared by the corpus) can
  // answer it. `anchor.js` keeps those two strengths apart: `scope: 'shape-only'` vs
  // `scope: 'declared-upstream'`.
  {
    domain: 'code-review',
    form: 'diff-line-span',
    basis: 'form',
    basisDetail: 'diff 扩展名路径：code-review / backend-engineering / frontend-engineering / tech-doc / tech-test / architecture / risk-compliance / market-research / reverse-engineering / data-engineering 等产出同一形状，本行只能判形状、判不出成员',
    pattern: new RegExp(`^[a-z0-9][a-z0-9._:/-]*\\.(?:${DIFF_EXTENSIONS})(?:#L\\d+(?:-L\\d+)?)?$`, 'u'),
  },
  // SPECIFIC PREFIX ROWS GO BEFORE THE `<path>.json` CATCH-ALL BELOW.
  //
  // user-feedback's own enumerator emits `<ledgerPath>`-derived documents:
  // `feedback/ledger-fb-1001-dec-20.json`. Every one of them ends in `.json`, so with
  // this row below the catch-all it matched ZERO of the producer's real anchors and
  // each of them was reported as project-management. Both spellings are accepted
  // because the bare row id (`feedback/fb-1`) is what the corpus fixtures bind to —
  // the form is the same id space, only the derived document path adds the extension.
  { domain: 'user-feedback', form: 'feedback-row', basis: 'exact', pattern: /^feedback\/[a-z0-9][a-z0-9._-]*(?:\.json)?$/u },
  // ALSO FAMILY-LEVEL, even though it names a domain. The judgement is `<path>.json`
  // and nothing else, so it claims any JSON id — project-management's own graph ids,
  // but equally algo-model's `experiments/<...>/metrics.json` exports and this
  // domain's own `chains/<id>/trace-*.json` exports. Marking it `exact` would repeat
  // the very defect `basis` exists to expose: a certain-sounding answer the shape does
  // not support. Membership still comes from `upstream[]`.
  {
    domain: 'project-management',
    form: 'graph-path',
    basis: 'form',
    basisDetail: '通配 `<path>.json`：任何域的 JSON 导出都命中（本域自己的 chains/*.json、algo-model 的 experiments/**/*.json 也被本行认领），只能判形状、判不出成员',
    pattern: /^[a-z0-9][a-z0-9._:/-]*\.json$/u,
  },
])

/**
 * Recognise a `ref` as a consumable anchor id from another domain.
 *
 * `basis` is part of the answer, not decoration: `'exact'` means the shape identifies
 * exactly one producing domain, `'form'` means it identifies the FORM and a family of
 * producers. Callers must not report a `form` attribution as `refDomain` alone.
 *
 * @returns {{domain:string, form:string, basis:'exact'|'form', basisDetail?:string}|null}
 *   null means OPAQUE: present, but not a shape any sibling domain emits. Opaque is
 *   reported, never guessed at.
 */
export function refShape(ref) {
  if (!isNonEmpty(ref)) return null
  const text = String(ref)
  for (const shape of REF_SHAPES) {
    if (!shape.pattern.test(text)) continue
    const out = { domain: shape.domain, form: shape.form, basis: shape.basis }
    if (isNonEmpty(shape.basisDetail)) out.basisDetail = shape.basisDetail
    return out
  }
  return null
}

/** Is this ref consumable at all? */
export const isConsumableRef = (ref) => refShape(ref) !== null

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Turn the input into the list of trace-graph documents.
 *
 * `documents[]` exists because a real traceability store is one document per CHAIN
 * (`chains/<chainId>/trace.json`), and the gate's exclusion predicates are
 * DOCUMENT-level. Without it, "this whole chain was archived" could not be
 * expressed as a P1 exclusion, and the `all-gated-out` boundary the contract
 * requires would have to be faked by abusing a candidate's fields.
 *
 * @returns {{ documents: object[], problems: string[] }}
 */
export function corpus(input) {
  const problems = []
  const documents = []

  if (Array.isArray(input?.documents) && input.documents.length > 0) {
    for (const document of documentsOf(input.documents)) {
      if (!looksLikeGraph(document.payload)) {
        problems.push(`${document.path}: 文档 payload 既没有 nodes 也没有 edges/idSpace，无法当作追踪图读取`)
        continue
      }
      documents.push(document)
    }
    if (documents.length === 0) problems.push('documents[] 里没有可读的追踪图文档')
    return { documents, problems }
  }

  const graphPath = isNonEmpty(input?.graphPath) ? slash(input.graphPath) : 'trace/graph.json'
  documents.push({
    path: graphPath,
    type: 'trace-graph',
    payload: {
      nodes: Array.isArray(input?.nodes) ? input.nodes : [],
      edges: Array.isArray(input?.edges) ? input.edges : [],
      idSpace: Array.isArray(input?.idSpace) ? input.idSpace : [],
      upstream: Array.isArray(input?.upstream) ? input.upstream : [],
    },
    meta: input?.meta !== null && typeof input?.meta === 'object' ? input.meta : {},
  })
  return { documents, problems }
}

/** `[{ id, ... }]` -> `Map<id, item>`, first declaration wins. */
export function byId(list) {
  const out = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item !== null && typeof item === 'object' && isNonEmpty(item.id)) {
      if (!out.has(item.id)) out.set(item.id, item)
    }
  }
  return out
}

/** Every `(from, to)` pair of one document, in declaration order, with its kind. */
export function edgeTriples(document) {
  const out = []
  for (const edge of Array.isArray(document?.payload?.edges) ? document.payload.edges : []) {
    if (edge === null || typeof edge !== 'object') continue
    const from = isNonEmpty(edge.from) ? String(edge.from) : ''
    const to = isNonEmpty(edge.to) ? String(edge.to) : ''
    if (from === '' || to === '') continue
    out.push([from, to, isNonEmpty(edge.kind) ? String(edge.kind) : 'unspecified'])
  }
  return out
}

/** Node ids a document declares, in declaration order. */
export function declaredIds(document) {
  const nodes = Array.isArray(document?.payload?.nodes) ? document.payload.nodes : []
  return nodes.map((node) => node?.id).filter(isNonEmpty)
}

/**
 * The set of anchor ids other domains actually produced, as far as the corpus
 * declares it.
 *
 * This is the ONLY source of "is this link stale?". A shape check cannot answer it:
 * an id can look exactly like a diff-line anchor and still be one that no domain
 * ever emitted. When the corpus declares no `upstream[]` at all, the returned set
 * is `null` — meaning "not declared" — and every consumer must report the stale
 * question as UNANSWERED rather than as passed.
 *
 * @returns {{ refs: Set<string>, declared: boolean, domains: Set<string> }}
 */
export function upstreamSet(documents) {
  const refs = new Set()
  const domains = new Set()
  let declared = false
  for (const document of documents ?? []) {
    const list = document?.payload?.upstream
    if (!Array.isArray(list)) continue
    declared = true
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      if (isNonEmpty(entry.ref)) refs.add(String(entry.ref))
      if (isNonEmpty(entry.domain)) domains.add(String(entry.domain))
    }
  }
  return { refs, declared, domains }
}

/**
 * Every fact about one node that a candidate or a verifier needs.
 * Exported so `anchor.js` and `evidence.js` cannot drift from the enumerator.
 */
export function nodeFacts(node) {
  const ref = isNonEmpty(node?.ref) ? String(node.ref) : null
  const shape = refShape(ref)
  return {
    ref,
    shape,
    /** Present but unrecognised — the contract's `binary` mapping territory. */
    opaque: ref !== null && shape === null,
    /** No ref at all: not opaque, a MISSING binding, which is reviewable. */
    missingRef: ref === null,
    refDeleted: node?.refDeleted === true || node?.artifact?.deleted === true,
    archived: node?.archived === true,
    attachmentOnly: node?.attachmentOnly === true,
  }
}

// ---------------------------------------------------------------------------
// enumerate()
// ---------------------------------------------------------------------------

/** The candidate path for an edge. `->` becomes `-`; the raw pair stays in locator. */
export function edgePath(documentPath, from, to, kind = 'derives') {
  return derivedPath(documentPath, `${kind}-${from}-${to}`)
}

/** The candidate path for one SIDE of a node. */
export function nodeSidePath(documentPath, nodeId, side) {
  return derivedPath(documentPath, `node-${nodeId}-${side}`)
}

/**
 * render the one-sided question a node-side candidate asks, plus the record.
 *
 * Kept as one function so both sides carry the SAME facts about the node. A
 * candidate that showed the upstream neighbours only would make the
 * `downstream`-side finding impossible to check from the candidate itself.
 */
function nodeSideText(node, side, incoming, outgoing, facts, upstream) {
  const lines = [
    `node ${node.id}（${node.title ?? '(无标题)'}）type=${isNonEmpty(node.type) ? node.type : '(未声明类型)'}`,
    `${side === 'upstream' ? '上游侧：谁指向它' : '下游侧：它指向谁'} —— 入边 ${
      incoming.length === 0 ? '(无)' : incoming.join(', ')}；出边 ${outgoing.length === 0 ? '(无)' : outgoing.join(', ')}`,
    facts.ref === null
      ? '跨域引用：**(未给出 ref)** —— 这个节点没有绑定任何上游锚点，缺口就在这里'
      : `跨域引用：${facts.ref}（${
        facts.shape === null
          ? '**无法识别的形状** —— 本域认不出它是哪个域产出的锚点'
          : `${facts.shape.domain}/${facts.shape.form}，归因依据 basis=${facts.shape.basis}${
            facts.shape.basis === 'form'
              ? ' —— **家族级**：这个形状多个域都在产出，本域判不出具体是哪一个，只有 upstream[] 能回答'
              : ''}`}）`,
    facts.ref !== null && facts.shape !== null
      ? (upstream.declared
        ? `上游声明集合：${upstream.refs.has(facts.ref) ? '含此 ref' : '**不含此 ref** —— 上游已经不再产出它，这是失效链接' }`
        : '上游声明集合：**未声明**（无法回答这条链接是否失效，只能回答形状是否可消费）')
      : '',
    isNonEmpty(node.body) ? `说明：${node.body}` : '',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * The domain's documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source: `{ maxCandidates,
 * maxExcerptLines, include, exclude, extensions }`. The source does NOT apply the
 * gate — it only reports what it saw, so "P0 enumerated nothing" and "P1 removed
 * everything" stay distinguishable in the plan.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      'trace-graph 输入必须是对象 { nodes: [{ id, type, ref }], edges: [{ from, to, kind }] }')
  }
  for (const field of ['nodes', 'edges', 'idSpace', 'upstream', 'documents']) {
    if (input[field] !== undefined && !Array.isArray(input[field])) {
      throw contractError(ERROR_CODES.E_INPUT_FORMAT, `\`${field}\` 必须是数组（可省略）`)
    }
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 200

  const { documents, problems } = corpus(input)
  const upstream = upstreamSet(documents)
  const candidates = []
  const excluded = []
  const notes = [...problems]
  let truncated = false

  /**
   * A candidate is emitted once per semantic entity PER DOCUMENT.
   *
   * The dedupe is deliberately scoped INSIDE one document, not across the corpus:
   *
   *   • inside a document, the same node declared twice is noise — one record, one
   *     candidate per side. Emitting it twice would make the verifier's identity
   *     check see a false collision and refuse every claim about that node;
   *
   *   • ACROSS documents the same id declared by two chains is a DEFECT, not noise:
   *     it is the `node-id-collision` rule's exact subject, and it becomes
   *     unreviewable if the enumerator collapses it. So both documents emit their
   *     own candidates, and the collision is ALSO stated in `notes`.
   */
  const semanticKey = (candidate) => JSON.stringify({
    k: candidate.locator.toId !== undefined && candidate.locator.kind === CANDIDATE_KINDS.edge
      ? `e:${candidate.locator.edgeKind ?? ''}`
      : `s:${candidate.locator.side ?? ''}`,
    f: candidate.locator.fromId ?? null,
    o: candidate.locator.toId ?? null,
  })

  /** Keys already emitted for the document currently being walked. */
  let seenInDocument = new Map()
  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    const key = semanticKey(candidate)
    const existing = seenInDocument.get(key)
    if (existing !== undefined) {
      notes.push(`${candidate.path} 与 ${existing} 是同一文档内的同一个图元素，已跳过（同一 ID 出现在不同文档时不合并 —— 那正是 ID 冲突缺陷本身）`)
      return false
    }
    seenInDocument.set(key, candidate.path)
    candidates.push(candidate)
    return true
  }

  const opaqueRefs = []
  const missingRefs = []
  const unknownEdgeKinds = new Set()

  for (const document of documents) {
    seenInDocument = new Map()
    const payload = document.payload
    const path = document.path
    const meta = document.meta ?? {}
    const deletedDocument = meta.deleted === true
    const binaryDocument = meta.binary === true
    const docBytes = Number(meta.bytes) > 0 ? Number(meta.bytes) : null

    const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
    const nodesById = byId(nodes)
    const idSpace = (Array.isArray(payload.idSpace) ? payload.idSpace : []).filter(isNonEmpty)
    const triples = edgeTriples(document)
    const known = new Set([...declaredIds(document), ...idSpace])

    const incoming = new Map()
    const outgoing = new Map()
    for (const [from, to, kind] of triples) {
      if (!outgoing.has(from)) outgoing.set(from, [])
      outgoing.get(from).push(kind === 'unspecified' ? to : `${to}(${kind})`)
      if (!incoming.has(to)) incoming.set(to, [])
      incoming.get(to).push(kind === 'unspecified' ? from : `${from}(${kind})`)
      if (kind !== 'unspecified' && !EDGE_KINDS.includes(kind)) unknownEdgeKinds.add(kind)
    }

    const carried = {
      bytes: docBytes ?? undefined,
      binary: binaryDocument || undefined,
      deleted: deletedDocument || undefined,
    }

    // --- edges -------------------------------------------------------------
    for (const [from, to, kind] of triples) {
      const candidateId = edgePath(path, from, to, kind)
      // A document marked `deleted` is NOT dropped here. P0 enumerates, P1 removes —
      // and the reason a reader sees should be the gate's `deleted` predicate, which
      // is the one the contract table declares ("nodes pointing at deleted artefacts
      // -> deleted"). Moving that decision into the source would make "P1 removed it"
      // and "P0 never saw it" indistinguishable in the plan.
      const fromNode = nodesById.get(from)
      const toNode = nodesById.get(to)
      const danglingFrom = !known.has(from)
      const danglingTo = !known.has(to)
      const text = [
        `${kind} ${from} → ${to}`,
        `起点：${from}${fromNode === undefined ? '（**图里没有这个节点的记录**）' : `（type=${fromNode.type ?? '?'}）`}`,
        `终点：${to}${toNode === undefined ? '（**图里没有这个节点的记录**）' : `（type=${toNode.type ?? '?'}）`}`,
        danglingFrom || danglingTo ? '⚠️ 这条边的端点不在本图声明的 ID 空间里 —— 断链' : '',
        kind === 'unspecified' ? '⚠️ 这条边没有声明 kind —— 关系类型未知，无法判断它证明什么' : '',
        kind !== 'unspecified' && !EDGE_KINDS.includes(kind) ? `⚠️ edge kind "${kind}" 不在本域词表内` : '',
      ].filter((line) => line !== '').join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: CANDIDATE_KINDS.edge, graphPath: path, fromId: from, toId: to, edgeKind: kind },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.edge,
          chain: chainOf(path),
          from, to, edgeKind: kind,
          fromType: fromNode?.type ?? null,
          toType: toNode?.type ?? null,
          danglingFrom, danglingTo,
          dangling: danglingFrom || danglingTo,
          graphPath: path,
        },
      })
    }

    // --- node sides --------------------------------------------------------
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node === null || typeof node !== 'object' || !isNonEmpty(node.id)) {
        excluded.push({
          id: derivedPath(path, `node-${nodeIndex + 1}-upstream`),
          reason: '节点缺少非空字符串 id —— 无法在追踪图上定位',
        })
        continue
      }
      const facts = nodeFacts(node)
      if (facts.archived) {
        excluded.push({ id: nodeSidePath(path, node.id, 'upstream'), reason: `节点 ${node.id} 已归档，不在本次评审范围` })
        continue
      }
      if (facts.opaque) opaqueRefs.push(`${path}#${node.id}=${facts.ref}`)
      if (facts.missingRef) missingRefs.push(`${path}#${node.id}`)

      // The contract table's gate mapping, implemented where it belongs:
      //   nodes pointing at deleted artefacts -> deleted
      //   opaque refs                         -> binary
      //   huge graphs                         -> bytes
      // The `binary` mapping DOES remove an opaque node from the review scope, and
      // that cost is stated rather than hidden: every opaque node is also listed in
      // `notes` and re-listed by the `ref_check` evidence tool, so "excluded" never
      // silently becomes "invisible".
      //
      // A ref pointing at an artefact deleted upstream is reported as a P0 exclusion
      // rather than as a gate `deleted` flag: the DOCUMENT is still there and still
      // reviewable, it is this node's binding that points into a hole — a fact no
      // document-level predicate can express.
      const refDeleted = facts.refDeleted
      const opaque = facts.opaque

      for (const side of SIDES) {
        const candidateId = nodeSidePath(path, node.id, side)
        if (refDeleted) {
          excluded.push({ id: candidateId, reason: `节点 ${node.id} 的 ref 指向已被删除的上游产物 —— 绑定落在一个洞里，无法作为候选评审` })
          continue
        }
        const text = nodeSideText(
          node, side,
          incoming.get(node.id) ?? [], outgoing.get(node.id) ?? [],
          facts, upstream,
        )
        const clipped = clipLines(text, maxExcerptLines)
        if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
        push({
          id: candidateId,
          path: candidateId,
          locator: { kind: CANDIDATE_KINDS.nodeSide, graphPath: path, fromId: node.id, side },
          text: clipped.text,
          bytes: byteLength(clipped.text),
          ...carried,
          binary: binaryDocument || opaque || node.attachmentOnly === true || undefined,
          additions: 1,
          meta: {
            candidateKind: CANDIDATE_KINDS.nodeSide,
            chain: chainOf(path),
            nodeId: node.id,
            nodeType: isNonEmpty(node.type) ? String(node.type) : 'unknown',
            side,
            ref: facts.ref,
            refDomain: facts.shape?.domain ?? null,
            refForm: facts.shape?.form ?? null,
            // `exact` = the shape names ONE domain; `form` = it names a FAMILY of
            // producers (several domains emit byte-identical ids). Reported alongside
            // the domain so a consumer cannot mistake a family-level guess for a fact.
            refBasis: facts.shape?.basis ?? null,
            refBasisDetail: facts.shape?.basisDetail ?? null,
            opaqueRef: opaque,
            missingRef: facts.missingRef,
            refDeleted: facts.refDeleted,
            refStale: facts.ref !== null && facts.shape !== null && upstream.declared
              ? !upstream.refs.has(facts.ref)
              : null,
            inCount: (incoming.get(node.id) ?? []).length,
            outCount: (outgoing.get(node.id) ?? []).length,
            graphPath: path,
          },
        })
      }
    }
  }

  // --- the notes only a meta-domain can write ------------------------------
  //
  // Each of these is a fact the reviewer MUST have and cannot derive from a single
  // candidate. Stated here rather than left to be noticed.
  if (opaqueRefs.length > 0) {
    notes.push(`⚠️ ${opaqueRefs.length} 个节点的 ref 形状本域无法识别（已按契约表的 gate 映射标为 binary 并移出本次评审范围）：${opaqueRefs.join('、')}。`
      + '「移出范围」不等于「没有问题」—— 无法消费的上游锚点是跨域断链，请在上游域补齐形状或在本域 REF_SHAPES 里登记。')
  }
  if (missingRefs.length > 0) {
    notes.push(`${missingRefs.length} 个节点没有 ref（未绑定任何上游锚点）：${missingRefs.join('、')}。这类节点**留在评审范围内** —— 缺绑定是可评审的缺口，不是不可读的产物。`)
  }
  if (unknownEdgeKinds.size > 0) {
    notes.push(`⚠️ 出现了本域词表外的 edge kind：${[...unknownEdgeKinds].join('、')}。关系类型未知时不要按直觉归类，先确认它属于哪一种。`)
  }
  if (!upstream.declared) {
    notes.push('本语料**没有声明 upstream[]**：只能判断 ref 的形状是否可消费，**无法**判断它是否仍然有效。'
      + '凡涉及「失效链接」的结论都必须标为未回答，不得默认通过。')
  }

  const idOwners = new Map()
  for (const document of documents) {
    for (const id of declaredIds(document)) {
      if (!idOwners.has(id)) idOwners.set(id, [])
      const owners = idOwners.get(id)
      if (!owners.includes(document.path)) owners.push(document.path)
    }
  }
  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      notes.push(`⚠️ 节点 ID "${id}" 被 ${owners.length} 个文档同时声明（${owners.join('、')}）—— 关于它的任何边都无法唯一锚定，请先消除重复 ID`)
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

/**
 * The chain a document belongs to, derived from its path.
 *
 * `chains/<chainId>/trace.json` -> `<chainId>`; anything else falls back to the
 * document's own directory, then to the document stem. Exported because
 * `index.js`'s `bundleKey.resolve` must use the SAME derivation — and that resolver
 * only ever sees a candidate's `path` (the engine's `toCandidates` keeps
 * `{path, bytes, additions, deletions, binary, deleted, key}` and drops `meta`), so
 * `chainOf` must be derivable from the path alone or P2 would silently degrade.
 */
export function chainOf(documentPath) {
  const parts = slash(documentPath).split('/').filter((part) => part !== '')
  const at = parts.indexOf('chains')
  if (at >= 0 && parts.length > at + 1) return parts[at + 1]
  if (parts.length >= 3) return parts[parts.length - 2]
  return parts.length >= 2 ? parts[0] : 'root'
}

export default defineCandidateSource({
  kind: 'trace-graph-edges',
  inputFormat: 'trace-graph',
  bounded: true,
  describe: '追踪图 -> 每条边一个候选 + 每个节点的每一侧（上游/下游）一个候选；端点未登记不静默丢弃，标为 dangling 交由评审判定。',
  enumerate,
})
