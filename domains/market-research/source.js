/**
 * market-research — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `research-seed` (see `DOMAIN_INPUT_FORMATS` in
 * `lib/contracts.js`, which is the authority this file follows):
 *
 *   {
 *     question: string,
 *     scope?: { market?, segment?, geography?, timeframe? },
 *     sources: [{
 *       id, url?, title?, publisher?, retrievedAt?,
 *       strength?: 'primary' | 'secondary' | 'speculation',
 *       path?, binary?, deleted?,
 *       quotes?: string[],          // 逐字引文
 *     }],
 *     claims?: [{ id, text, sourceId, strength?, figure? }],
 *   }
 *
 * WHAT THIS DOMAIN REFUSES TO PRETEND
 * -----------------------------------
 * This is a C (exploration) domain and the honest statement of its cost model is
 * part of the deliverable, not a disclaimer bolted on:
 *
 * **候选集不可先验枚举、成本无上界。**
 *
 * A "research seed" is not a file tree. Whatever this function enumerates is
 * what the caller already handed over — the seed's own sources and claims — and
 * the real candidate set is *whatever an open-ended search would still turn up*:
 * further comparables, a regulator's filing, a forum thread nobody has read yet.
 * No enumerator can list those, and a domain that answered the empty seed with
 * "coverage 0/0 = 100%" would be lying about a market. So:
 *
 *   • the honest statement is emitted as a NOTE on every single run — including
 *     the empty one, which is exactly the run that would otherwise look complete;
 *   • `bounded` is `false` (the contract checks that only a C domain may say so);
 *   • the plan's summary carries the note (via `candidateSet.notes`), the P4 and
 *     P6 prompts carry it, and `test.mjs` asserts it reaches the plan;
 *   • the domain still enumerates ONLY what the seed contains — it does not
 *     invent sources to look thorough. "Unbounded" describes the cost, not a
 *     licence to fabricate.
 *
 * THE SECOND LAW: EVERY CANDIDATE CARRIES AN EVIDENCE STRENGTH
 * -----------------------------------------------------------
 * 一手 (primary) / 二手 (secondary) / 推测 (speculation). A claim is never
 * stronger than the source it rests on, and an unlabelled source is treated as
 * 推测 rather than guessed upward — `anchor.js` refuses a claim that cites a
 * 二手 source as 一手. Under-labelling is the failure mode that makes market
 * research unusable downstream: numbers keep travelling long after the sentence
 * that said "according to a vendor's own blog post" has been dropped.
 *
 * CANDIDATES: one per source (its strength label), one per verbatim quote, and
 * one per claim.
 *
 * WHY `candidate.path` IS THE SOURCE CARD
 * ---------------------------------------
 * P2's bundle key must be derivable from the candidate as the ENGINE hands it to
 * `bundleKey.resolve`, and through `adjudication_plan` the engine normalises
 * candidates to `{path, bytes, additions, deletions, binary, deleted, key}` —
 * `meta` does not survive `toCandidates()` (`lib/` is out of this domain's
 * scope). So the candidate's `path` IS the artifact the anchor can be recomputed
 * against, by the same convention a research note uses:
 *
 *     research/<question-slug>/sources/<source-slug>.md
 *
 * Every candidate of one source carries that path, which makes the bundle key
 * "one SOURCE" — not one bundle per candidate. `anchor.js` renders the very same
 * card (`renderSource`) to check a quotation, so a candidate's text is by
 * construction a line of the document it will be verified against.
 *
 * HONESTY: rules are drafted by an agent and marked `needs-expert-review`. This
 * file enumerates; it does not decide what is reviewable (the P1 gate does).
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/**
 * `candidate.path` must satisfy the contract's id pattern (`ID_PATTERN` in
 * `lib/contracts.js`) or the P1 gate cannot glob it.
 */
const PATH_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/u

/** The research-note convention this domain's candidates use. */
const CARD_ROOT = 'research'

/** 证据强度：一手 / 二手 / 推测。Anything unlabelled is treated as speculation. */
export const STRENGTH_LABELS = {
  primary: '一手',
  secondary: '二手',
  speculation: '推测',
}

/**
 * Normalise a declared strength. An unknown or missing label becomes
 * `speculation` — never `primary`. Guessing upward is the one direction that
 * cannot be corrected downstream.
 *
 * @returns {{strength:'primary'|'secondary'|'speculation', declared:boolean}}
 */
export function normalizeStrength(value) {
  const key = String(value ?? '').trim().toLowerCase()
  if (key === 'primary' || key === '一手') return { strength: 'primary', declared: true }
  if (key === 'secondary' || key === '二手') return { strength: 'secondary', declared: true }
  if (key === 'speculation' || key === 'speculative' || key === '推测') return { strength: 'speculation', declared: true }
  return { strength: 'speculation', declared: false }
}

const byteLength = (value) => new TextEncoder().encode(String(value)).length

const asText = (value, fallback = '') => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

/** `a/b c` -> `a-b-c`, always globbable. */
function slug(value, fallback = 'unknown') {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return text === '' ? fallback : text
}

/**
 * The strength line of a source card — the one line a "this source is 一手"
 * claim must quote. Exported because `anchor.js` verifies it and a second
 * spelling of it would be a second thing to get wrong.
 */
export function strengthLine(source) {
  const { strength, declared } = normalizeStrength(source?.strength)
  return `strength = ${strength} (${STRENGTH_LABELS[strength]})${declared ? '' : ' [未声明，按推测处理]'}`
}

/** `quote <n> :: <text>` — how a verbatim quote appears in the card. */
export function quoteLine(index, text) {
  return `quote ${index + 1} :: ${String(text)}`
}

/** `claim <id> = <text>` — how a claim appears in its source's card. */
export function claimLine(claim) {
  return `claim ${String(claim?.id ?? '')} = ${String(claim?.text ?? '')}`
}

/**
 * The card this domain's candidates are anchored against. Exported so the test
 * can prove that every candidate's `text` really is a line of the document the
 * verifier will receive: a domain whose evidence text is not in its own source
 * document fails every anchor by construction, and that failure looks like a
 * modelling problem instead of a bug.
 */
export function renderSource(source, claims = []) {
  const lines = [
    `# source ${asText(source?.id, 'unknown')}${asText(source?.title, '') === '' ? '' : ` (${asText(source.title)})`}`,
    strengthLine(source),
    `url = ${asText(source?.url, '(none)')}`,
    `retrieved = ${asText(source?.retrievedAt, '(unknown)')}`,
  ]
  if (asText(source?.publisher, '') !== '') lines.push(`publisher = ${asText(source.publisher)}`)
  for (const [index, quote] of (Array.isArray(source?.quotes) ? source.quotes : []).entries()) {
    lines.push(quoteLine(index, quote))
  }
  if (claims.length > 0) {
    lines.push('--- claims ---')
    for (const claim of claims) lines.push(claimLine(claim))
  }
  return `${lines.join('\n')}\n`
}

/**
 * The card path of a source: `research/<question>/sources/<id>.md`.
 *
 * A source may declare its own `path` (a snapshot location), and it is honoured
 * when it is a globbable path under `research/` — that is what lets a caller's
 * own directory layout decide which paths the P1 gate sees (see the
 * `all-gated-out` fixture, which puts one source under `archive/`).
 */
export function sourceCardPath(question, source) {
  const declared = String(source?.path ?? '').replace(/\\/gu, '/').trim()
  if (declared !== '' && PATH_PATTERN.test(declared) && declared.startsWith(`${CARD_ROOT}/`)) return declared
  const folder = slug(question, 'seed')
  const file = slug(source?.id, slug(source?.url, 'source'))
  const derived = `${CARD_ROOT}/${folder}/sources/${file}.md`
  return PATH_PATTERN.test(derived) ? derived : `${CARD_ROOT}/${folder}/sources/source.md`
}

/**
 * The bundle key a candidate path encodes: the SOURCE, not the path.
 *
 *   research/esg-eu/sources/vendor-report.md  ->  research/esg-eu/sources/vendor-report
 *   something else                            ->  the path itself
 *
 * Exported because the pack's `bundleKey.resolve` must agree with it exactly.
 */
export function sourceKeyFromPath(path) {
  const value = String(path ?? '').replace(/\\/gu, '/')
  const match = new RegExp(`^${CARD_ROOT}/.+\\.md$`, 'u').exec(value)
  return match === null ? value : value.replace(/\.md$/u, '')
}

/** Exported for the same reason as {@link sourceKeyFromPath}. */
export function sourceKey(candidate) {
  const card = candidate?.meta?.card
  if (typeof card === 'string' && card !== '') return card
  return sourceKeyFromPath(candidate?.path)
}

/** A source is retrievable when it can still be re-fetched: an http(s) URL. */
export function isRetrievable(source) {
  return /^https?:\/\/\S+$/u.test(String(source?.url ?? '').trim())
}

/**
 * Is the claim stronger than the source it rests on?
 *
 * 二手 source + 一手 claim is the classic laundering step: the number survives
 * the hop and the qualifier does not. `anchor.js` refuses such a claim; this
 * function is the single definition both files use.
 */
const STRENGTH_RANK = { speculation: 0, secondary: 1, primary: 2 }

export function overclaims(claimStrength, sourceStrength) {
  return STRENGTH_RANK[claimStrength] > STRENGTH_RANK[sourceStrength]
}

export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'research-seed 输入必须是对象 { question, sources, claims? }')
  }
  if (typeof input.question !== 'string' || input.question.trim() === '') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'research-seed 输入缺少字符串字段 `question`（研究问题）')
  }
  if (!Array.isArray(input.sources)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'research-seed 输入缺少数组字段 `sources`（已知来源表）')
  }
  if (input.claims !== undefined && !Array.isArray(input.claims)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`claims` 必须是数组 [{ id, text, sourceId, strength? }]（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const question = input.question.trim()
  const sources = input.sources.filter((source) => source !== null && typeof source === 'object')
  const claims = input.claims ?? []

  const notes = []
  const excluded = []
  const candidates = []
  let truncated = false

  // --- the honest statement of the cost model, on EVERY run ------------------
  notes.push(
    '候选集不可先验枚举、成本无上界：本域是 C 探索型，下面列出的只是 seed 里已知的来源与结论；'
    + '真正可查的来源由开放式检索决定，任何覆盖率分母都不代表市场的完整边界。',
  )
  if (sources.length === 0) {
    notes.push('seed 里没有任何来源 —— 这不是「市场没有问题」，而是「还没开始找」。空集本身不是通过。')
  }

  const byId = new Map()
  for (const source of sources) {
    const id = asText(source.id)
    if (id === '') {
      notes.push('一个来源没有 id，已跳过（结论无法归属到一个没有 id 的来源）')
      continue
    }
    if (byId.has(id)) {
      notes.push(`来源 id "${id}" 重复出现；只保留第一个（重复的来源会让归属变成猜测）`)
      continue
    }
    byId.set(id, source)
  }

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  const clipped = (text) => {
    const lines = String(text).split(/\r?\n/u)
    if (lines.length <= maxExcerptLines) return String(text)
    truncated = true
    notes.push(`一段证据文本超过 maxExcerptLines ${maxExcerptLines}，已截断`)
    return lines.slice(0, maxExcerptLines).join('\n')
  }

  const claimsBySource = new Map()
  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object') continue
    const sourceId = asText(claim.sourceId)
    if (!claimsBySource.has(sourceId)) claimsBySource.set(sourceId, [])
    claimsBySource.get(sourceId).push(claim)
  }

  let unlabeled = 0
  let overclaimed = 0
  const unreachable = []
  for (const source of byId.values()) {
    const id = asText(source.id)
    const { strength, declared } = normalizeStrength(source.strength)
    if (!declared) unlabeled += 1
    const own = claimsBySource.get(id) ?? []
    const path = sourceCardPath(question, source)
    const card = renderSource(source, own)
    // `bytes` is the CARD size, not the text length: in the engine `bytes` is a
    // file-level fact and `too-large` is a file-level predicate, so every
    // candidate of one card must report the same size or the gate would keep
    // half a document.
    const bytes = byteLength(card)
    const deleted = source.deleted === true
    const fileFacts = { bytes, deleted, binary: source.binary === true }

    if (!isRetrievable(source)) {
      excluded.push({
        id,
        reason: `来源 "${id}" 没有 http(s) URL（url=${asText(source.url, '(none)')}）：无法再取回，也就无法支撑任何「一手」结论 —— 未被枚举，而不是被当成没问题`,
      })
      unreachable.push(id)
      continue
    }

    // --- one candidate per SOURCE: its evidence-strength label --------------
    push({
      id: `${id}#source`,
      path,
      locator: { sourceId: id, kind: 'source', strength },
      text: clipped(strengthLine(source)),
      ...fileFacts,
      meta: {
        kind: 'source',
        sourceId: id,
        strength,
        strengthDeclared: declared,
        label: STRENGTH_LABELS[strength],
        card,
        url: asText(source.url),
        sourceKind: 'source',
      },
    })

    // --- one candidate per verbatim QUOTE ----------------------------------
    for (const [index, quote] of (Array.isArray(source.quotes) ? source.quotes : []).entries()) {
      const text = String(quote ?? '').trim()
      if (text === '') continue
      push({
        id: `${id}#quote#${index + 1}`,
        path,
        locator: { sourceId: id, kind: 'quote', quoteIndex: index + 1, strength },
        text: clipped(quoteLine(index, text)),
        ...fileFacts,
        meta: {
          kind: 'quote',
          sourceId: id,
          quoteIndex: index + 1,
          strength,
          label: STRENGTH_LABELS[strength],
          card,
          sourceKind: 'quote',
        },
      })
    }

    // --- one candidate per CLAIM -------------------------------------------
    for (const claim of own) {
      const claimId = asText(claim.id)
      if (claimId === '') {
        notes.push(`来源 "${id}" 下有一条结论没有 id，已跳过`)
        continue
      }
      const claimStrength = normalizeStrength(claim.strength ?? source.strength)
      const laundering = overclaims(claimStrength.strength, strength)
      if (laundering) overclaimed += 1
      push({
        id: `${claimId}#claim`,
        path,
        locator: { sourceId: id, kind: 'claim', claimId, strength, claimStrength: claimStrength.strength },
        text: clipped(claimLine({ id: claimId, text: claim.text })),
        ...fileFacts,
        meta: {
          kind: 'claim',
          sourceId: id,
          claimId,
          strength,
          label: STRENGTH_LABELS[strength],
          claimStrength: claimStrength.strength,
          laundering,
          card,
          figure: claim.figure ?? null,
          sourceKind: 'claim',
        },
      })
    }
  }

  // Claims that name a source the seed does not contain. Recall-first: they are
  // enumerated rather than dropped, but the note says why they cannot anchor.
  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object') continue
    const sourceId = asText(claim.sourceId)
    if (sourceId === '' || byId.has(sourceId)) continue
    notes.push(`结论 "${asText(claim.id, '(no id)')}" 引用了 seed 里不存在的来源 "${sourceId}"：无法重算锚点，只能作为待补来源的意见`)
  }

  if (unreachable.length > 0) {
    // Stated at REPORT level, not only in the per-item reason: "a source I could
    // not re-fetch" is the kind of hole that must be visible in the summary even
    // when nobody opens the exclusion list.
    notes.push(`${unreachable.length} 个来源没有 http(s) URL（${unreachable.join(', ')}）：无法再取回，已进入 excluded 且未被枚举 —— 不当作没问题`)
  }
  if (unlabeled > 0) {
    notes.push(`${unlabeled} 个来源没有声明证据强度，一律按「推测」标注（不向上猜测）`)
  }
  if (overclaimed > 0) {
    notes.push(`${overclaimed} 条结论声明的强度高于它的来源（如二手来源 + 一手结论）：这是口径洗白，锚点复核会拒绝`)
  }
  if (claims.length === 0) {
    notes.push('seed 没有提供任何结论，只提供来源：本轮的候选是来源与引文本身，不是结论')
  }

  return { candidates, excluded, notes, bounded: false, truncated }
}

export default defineCandidateSource({
  kind: 'sources-and-claims',
  inputFormat: 'research-seed',
  // The contract (`checkContractIntegrity`) only lets a C domain declare this.
  bounded: false,
  describe: '研究 seed → 每个来源一条「证据强度」候选、每条逐字引文一条候选、每条结论一条候选；候选路径是来源卡片 research/<question>/sources/<source>.md。无 http(s) URL 的来源进 excluded 并说明原因。候选集不可先验枚举、成本无上界，这一点写进每次的 notes。',
  enumerate,
})
