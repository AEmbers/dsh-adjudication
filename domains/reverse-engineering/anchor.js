/**
 * reverse-engineering — anchor verifier (contract v2, extension point 2).
 *
 * `verify` recomputes a claim's anchor from the inputs themselves. For this
 * domain a claim is anchored when BOTH hold:
 *
 *   1. it is about the SAME SAMPLE — the artifact id and sha256 the claim names
 *      are the ones in the registry; and
 *   2. it does not upgrade a hypothesis into an observation — a statement whose
 *      reproduction steps are empty (or that is explicitly marked unverified) is
 *      a 猜想, and a claim that presents it as verified is refused before its
 *      text is even read.
 *
 * Step 1 is not pedantry. Reverse engineering's most expensive mistake is a
 * finding that is correct about a DIFFERENT build: offsets, string tables and
 * patch signatures all move between samples, and a report that does not pin the
 * hash cannot be reproduced by anyone. Step 2 is the same failure one layer up:
 * "the blob is AES-128-CBC" reads like an observation and is a hypothesis.
 *
 * THE ONE TIER RULE
 * -----------------
 * `ANCHOR_TIERS` (lib/contracts.js) is closed — a domain may not invent a tier,
 * and an `unanchored` verdict may not carry a line number. So every
 * domain-specific refusal travels in the extra `code` field, next to the standard
 * tier:
 *
 *   artifact-mismatch      the claim is about a different sample (hash disagrees)
 *   unknown-artifact       the named artifact is not the registry's artifact
 *   unknown-observation    the named observation is not in the registry
 *   verification-overclaim an unreproduced statement is presented as verified
 *   no-artifact            no registry was supplied (tier `no-documents`)
 *
 * 转述不锚定 AND 歧义拒绝猜测
 * --------------------------
 * The match is a normalized WHOLE-LINE comparison over a sliding window, so a
 * paraphrase never lands; and when the same line occurs in more than one note
 * file the verdict is `relocation-ambiguous` with every competing location listed
 * in `ambiguousIn` — the verifier reports the ambiguity instead of picking the
 * most likely note.
 *
 * WHERE THE REGISTRY COMES FROM
 * -----------------------------
 * `adjudication_submit` can only hand a verifier `{path, content, document,
 * documents}`; there is no structured channel. So the artifact and the
 * observation list travel as a convention document — `re/<…>.json` whose content
 * is `{ artifact, observations }` — exactly as the lineage graph does for
 * `data-engineering`. `subject.artifact` / `subject.observations` are also
 * accepted for direct callers.
 *
 * HONESTY: this file confirms that a claim is about the right sample and does not
 * overstate its evidence. It does not confirm the observation is TRUE, and the
 * returned `detail` says so rather than letting `anchored` imply more.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import { isReproduced, statementLine } from './source.js'

/**
 * A line normalised for comparison: leading list/diff markers removed, whitespace
 * folded. Case, punctuation and every identifier are compared exactly — a
 * paraphrase that keeps the offsets still fails.
 */
function normalizeLine(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-+*>]+|\d+[.)])\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Every 1-based line number in `content` whose normalized form equals `target`. */
export function matchesAt(content, target) {
  const wanted = normalizeLine(target)
  if (wanted === '') return []
  const hits = []
  for (const [index, line] of String(content ?? '').split(/\r?\n/u).entries()) {
    if (normalizeLine(line) === wanted) hits.push(index + 1)
  }
  return hits
}

/** Every `(path, lines)` where the target line occurs. Exported for reuse. */
export function allMatches(documents, target) {
  const found = []
  for (const document of Array.isArray(documents) ? documents : []) {
    const hits = matchesAt(document?.content, target)
    if (hits.length > 0) found.push({ path: document?.path ?? null, hits })
  }
  return found
}

/** Is this document the structured REGISTRY rather than a note to search? */
function isRegistryDocument(path) {
  return /^re\/.+\.json$/u.test(String(path ?? ''))
}

/**
 * Parse the registry out of `subject.artifact`, a convention DOCUMENT, or the
 * subject's own `content` (the self-folded form).
 *
 * WHY THE THIRD FORM EXISTS: through `adjudication_anchor` the engine collapses
 * whatever the caller supplied into `{ path, content, document, documents }` — a
 * structured `subject.artifact` / `subject.observations` pair does not survive
 * that trip. A caller that hands the sample REGISTRY back as the subject document
 * (path `re/<…>.json`, content the JSON text) is handing back exactly the input
 * material the review was based on, so the domain must be able to read it back
 * out of `content`. Not a bypass: the parsed registry still goes through the SAME
 * sample-hash and reproduction-status recomputation, so a wrong hash is still
 * `artifact-mismatch` and a promoted inference is still
 * `verification-overclaim`.
 */
function registryOf(subject) {
  if (subject?.artifact !== undefined && subject.artifact !== null && typeof subject.artifact === 'object') {
    return { artifact: subject.artifact, observations: Array.isArray(subject.observations) ? subject.observations : [] }
  }
  for (const document of Array.isArray(subject?.documents) ? subject.documents : []) {
    if (!isRegistryDocument(document?.path)) continue
    try {
      const parsed = JSON.parse(String(document.content ?? ''))
      if (parsed?.artifact !== undefined && parsed.artifact !== null) {
        return { artifact: parsed.artifact, observations: Array.isArray(parsed.observations) ? parsed.observations : [] }
      }
    } catch {
      return null
    }
  }
  if (typeof subject?.content === 'string' && subject.content.trim() !== '') {
    try {
      const parsed = JSON.parse(subject.content)
      if (parsed?.artifact !== undefined && parsed.artifact !== null) {
        return { artifact: parsed.artifact, observations: Array.isArray(parsed.observations) ? parsed.observations : [] }
      }
    } catch {
      return null
    }
  }
  return null
}

/**
 * The documents a text search may look at: notes only, never the registry.
 *
 * The engine hands the same note twice (as `subject.content` and inside
 * `subject.documents`); identical (path, content) pairs collapse, because
 * counting one note twice would make every anchor look like a cross-file
 * relocation ambiguity. Two documents sharing a path but differing in content
 * stay separate — that IS ambiguous.
 */
function searchableDocuments(subject) {
  const documents = []
  const seen = new Set()
  const add = (path, content) => {
    const key = `${String(path ?? '')}\u0000${content}`
    if (seen.has(key)) return
    seen.add(key)
    documents.push({ path: path ?? null, content })
  }
  if (typeof subject?.content === 'string' && subject.content !== '') add(subject.path ?? null, subject.content)
  for (const document of Array.isArray(subject?.documents) ? subject.documents : []) {
    if (isRegistryDocument(document?.path)) continue
    if (typeof document?.content === 'string' && document.content !== '') add(document.path ?? null, document.content)
  }
  return documents
}

const unanchored = (tier, code, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  path: null,
  start: null,
  end: null,
  code,
  detail,
  ...extra,
})

export function verify(claim, subject = {}, _context = {}) {
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt }')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可为空对象）')
  }
  if (claim.kind !== undefined && claim.kind !== null && claim.kind !== 'reproducible-observation') {
    return unanchored('kind-mismatch', 'kind-mismatch', `本域只验证 kind="reproducible-observation" 的锚点，收到 "${claim.kind}"`)
  }
  const excerpt = String(claim.excerpt ?? '')
  if (excerpt.trim() === '') {
    return unanchored('empty-excerpt', 'empty-excerpt', '摘录为空：没有原文就不存在锚点')
  }

  const registry = registryOf(subject)
  if (registry === null) {
    return unanchored(
      'no-documents',
      'no-artifact',
      '没有样本登记表：请把 { artifact, observations } 作为 re/<…>.json 文档随发现一起交回（或放在 subject.artifact / subject.observations）',
    )
  }

  const locator = claim.locator ?? {}
  const documentPath = claim.path === undefined || claim.path === null ? null : String(claim.path)
  const artifact = registry.artifact ?? {}
  const artifactId = String(artifact.id ?? '')
  const artifactSha = String(artifact.sha256 ?? '')

  const observationId = String(locator.observationId ?? '').trim()
  const observation = observationId === ''
    ? null
    : registry.observations.find((entry) => String(entry?.id ?? '') === observationId) ?? null

  const confirmCode = locator.kind === 'artifact'
    ? 'artifact-confirmed'
    : locator.kind === 'repro'
      ? 'repro-confirmed'
      : (observation?.kind === 'inference' ? 'inference-labelled' : 'statement-confirmed')

  // --- the seed-level (no locator) confirmation ------------------------------
  if (String(locator.artifactId ?? '').trim() === '' && observationId === '') {
    const notes = searchableDocuments(subject)
    const matches = allMatches(notes, excerpt)
    if (matches.length > 1) {
      return unanchored('relocation-ambiguous', 'relocation-ambiguous', `同一行出现在 ${matches.length} 处笔记里，无法判定它属于哪一条线索`, { ambiguousIn: matches.flatMap((hit) => hit.hits.map((line) => `${hit.path}:${line}`)) })
    }
    if (matches.length === 0) {
      return unanchored('no-match', 'no-match', '没有定位到这一行：链级确认需要摘录是某份线索笔记里逐字存在的一行')
    }
    return {
      status: 'anchored',
      tier: 'recomputed-unique',
      path: matches[0].path,
      start: matches[0].hits[0],
      end: matches[0].hits[0],
      code: 'artifact-confirmed',
      sha256: artifactSha === '' ? null : artifactSha,
      detail: `链级确认：摘录逐字存在于线索笔记，样本哈希是 ${artifactSha === '' ? '(未登记)' : artifactSha}；未确认具体观察，也未确认该陈述可复现`,
    }
  }

  // --- 1. is it the same SAMPLE? --------------------------------------------
  const claimedArtifactId = String(locator.artifactId ?? '').trim()
  if (claimedArtifactId !== '' && artifactId !== '' && claimedArtifactId !== artifactId) {
    return unanchored('no-match', 'unknown-artifact', `声明针对产物 "${claimedArtifactId}"，而登记的产物是 "${artifactId}"：不是同一个样本`, { knownArtifact: artifactId, sha256: artifactSha })
  }
  const claimedSha = String(locator.sha256 ?? '').trim()
  if (claimedSha !== '' && artifactSha !== '' && claimedSha.toLowerCase() !== artifactSha.toLowerCase()) {
    return unanchored(
      'locator-mismatch',
      'artifact-mismatch',
      `声明的样本哈希 ${claimedSha} 与登记的 ${artifactSha} 不一致：偏移、字符串表与补丁特征都会随样本变化，结论不能搬到另一个产物上`,
      { sha256: artifactSha },
    )
  }

  // --- 2. is the statement being upgraded into an observation? --------------
  if (observationId !== '' && observation === null) {
    return unanchored('no-match', 'unknown-observation', `观察 "${observationId}" 不在登记表里：无法确认它是否可复现`, { knownObservations: registry.observations.map((entry) => String(entry?.id ?? '')) })
  }
  if (observation !== null) {
    const reproduced = isReproduced(observation)
    if (locator.verified === true && !reproduced) {
      const steps = Array.isArray(observation?.reproducibility?.steps) ? observation.reproducibility.steps.filter((step) => String(step ?? '').trim() !== '').length : 0
      return unanchored(
        'locator-mismatch',
        'verification-overclaim',
        `观察 "${observationId}" 的复现步骤是 steps=${steps}${observation?.verified === false ? ' 且显式标记 verified=false' : ''}：它仍是猜想，不能被写成已验证的观察`
        + (observation?.kind === 'inference' ? '（登记表把它标为推断 inference）' : ''),
        { steps, observationKind: observation?.kind === 'inference' ? 'inference' : 'observation' },
      )
    }
  }

  // --- 3. the verbatim text ladder ------------------------------------------
  const matches = allMatches(searchableDocuments(subject), excerpt)
  if (matches.length === 0) {
    return unanchored(
      'no-match',
      'no-match',
      `摘录在任何线索笔记里都不是逐字存在的一整行 —— 转述、改偏移写法、改大小写都不算锚定。声明的笔记路径是 ${documentPath ?? '(未声明)'}`,
    )
  }
  if (matches.length > 1) {
    return unanchored(
      'relocation-ambiguous',
      'relocation-ambiguous',
      `同一行出现在 ${matches.length} 处笔记里，拒绝猜测它属于哪一条线索`,
      { ambiguousIn: matches.flatMap((hit) => hit.hits.map((line) => `${hit.path}:${line}`)) },
    )
  }

  const hit = matches[0]
  const reproduced = observation === null ? null : isReproduced(observation)
  if (documentPath !== null && hit.path !== null && hit.path !== documentPath) {
    return {
      status: 'anchored',
      tier: 'relocated-unique',
      path: hit.path,
      start: hit.hits[0],
      end: hit.hits[0],
      code: locator.kind === 'artifact' ? 'artifact-relocated' : 'note-relocated',
      verified: reproduced,
      detail: `摘录声明的路径 ${documentPath} 上没有这一行，但它唯一存在于 ${hit.path}：按搬迁确认，行号以重算结果为准`,
    }
  }
  if (locator.startLine !== undefined && locator.startLine !== null) {
    const declaredStart = Number(locator.startLine)
    if (!Number.isInteger(declaredStart) || declaredStart !== hit.hits[0]) {
      return unanchored('locator-mismatch', 'locator-mismatch', `声明的行号 ${String(locator.startLine)} 与原文实际所在的第 ${hit.hits[0]} 行不一致`)
    }
    return {
      status: 'anchored',
      tier: 'declared-locator',
      path: hit.path,
      start: hit.hits[0],
      end: hit.hits[0],
      code: confirmCode,
      verified: reproduced,
      detail: `逐字命中且行号一致；样本哈希与复现状态已核对（verified=${String(reproduced)}）。锚点确认的是「笔记里确实这么写」，不是「这个判断为真」`,
    }
  }

  return {
    status: 'anchored',
    tier: 'recomputed-unique',
    path: hit.path,
    start: hit.hits[0],
    end: hit.hits[0],
    code: confirmCode,
    verified: reproduced,
    detail: `逐字命中于第 ${hit.hits[0]} 行；样本哈希与复现状态已核对（verified=${String(reproduced)}）。锚点确认的是「笔记里确实这么写」，不是「这个判断为真」`,
  }
}

/** Exported so the pack's `anchor.verify` and the test agree on one name. */
export const verifyLevel = 'engine-recomputable'

/** For callers that want the note exactly as the verifier's registry describes it. */
export { statementLine }

export default defineAnchorVerifier({
  kind: 'reproducible-observation',
  verifyLevel: 'engine-recomputable',
  verify,
  describe: '先重算样本（产物 id 与 sha256 是否与登记表一致），再重算可复现性（没有 steps 或显式未验证的陈述是猜想，不得被写成已验证的观察），最后在线索笔记里逐字滑窗定位原文；转述不锚定，同一行命中多处时拒绝猜测并列出全部位置。',
})
