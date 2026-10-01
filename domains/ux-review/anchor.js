/**
 * ux-review — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE TWO HALVES
 * --------------
 *   STEP side   `locator.stepId` must name a step that really exists in the
 *               flow, AND `locator.branchId` must name a branch whose `steps`
 *               list really contains that step. A step that exists in the flow
 *               but is not on the claimed branch is NOT on that branch: the
 *               engine recomputes the membership instead of taking it on trust.
 *   EVIDENCE side  the verbatim excerpt must re-locate through the same ladder
 *               the rest of the package uses.
 *
 * Either half missing => `unanchored`. A claim that names a branch the flow does
 * not have, or a step that branch does not reach, is the exact failure this
 * domain refuses to repair by guessing.
 *
 * WHERE THE STRUCTURE COMES FROM — the shared (b)-family convention
 * ----------------------------------------------------------------
 * `subject.flow` / `subject.branches` are the original flow-spec, and when the
 * caller can hand them over they win: they are the authoritative input.
 *
 * In the real plugin path the caller CANNOT hand them over. The engine builds
 * the verifier's subject from the documents a finding quotes (`{path, content,
 * document, documents}`) plus `candidates` (index.js:797-803) — and these
 * branches are not text in any document, so no `documents` entry can carry them.
 * The structure is the P0 `input.payload`, which `source.js` already consumed
 * and left behind as the candidate set.
 *
 * THE CONVENTION (contract §1.2 declares `subject.candidates` as "P0 产出，
 * locator 空间在这里"; the engine now honours it — index.js:789-803): the
 * candidate set is the authoritative source of this domain's locator space, and
 * the verifier REBUILDS what it needs from it. For this domain that is the
 * `{stepId, branchId, nodeId}` space: every admitted candidate contributes its
 * `locator.branchId` / `locator.stepId` to a branch -> steps membership map,
 * which is exactly the structure the STEP side recomputes against.
 *
 * This is a REBUILD, NOT A BYPASS. The rebuilt tables are handed to the same
 * checks as the declared ones, so a claim naming a step that is in no candidate,
 * or a branch that reaches no candidate, is still `no-match`. And when neither
 * the declared tables nor a candidate set is available the verdict is still
 * `no-documents` — "I was given nothing to recompute against" never becomes
 * "fine, then".
 *
 * The same convention is what the other (b)-family domains adopt, so t21 can
 * hold all five to one rule: *the P0 candidate set is the locator space; rebuild
 * from `candidate.locator`, never invent it.*
 *
 * TIER MAPPING (the tier vocabulary is closed — `ANCHOR_TIERS` in
 * `lib/contracts.js` — so domain-specific refusals map onto it explicitly)
 * ---------------------------------------------------------------------
 *   stepId / branchId missing, unknown, or not on that branch .... `no-match`
 *   excerpt empty ............................................... `empty-excerpt`
 *   neither a flow/branch list nor a candidate set supplied ..... `no-documents`
 *   every evidence-ladder failure ............................... `locator-mismatch`
 *                                                                 / `relocation-ambiguous`
 *                                                                 / `no-match`
 *                                                                 / `kind-mismatch`
 *
 * MATCHING IS LITERAL. Only whitespace is dropped. A paraphrase, a renamed
 * control or a changed punctuation mark is a DIFFERENT line, and this verifier
 * says so instead of scoring a near miss.
 *
 * PORTING: `normalizeLine` and the sliding-window match are the same idiom
 * NOTICE already lists for lib/engine.js and domains/code-review/anchor.js
 * (ported from open-code-review, `internal/diff/resolver.go`). The same
 * deviation applies: the ladder ends at "unanchored" — there is no LLM
 * re-location tier. Everything above the ladder (recomputing whether the branch
 * really reaches the claimed step) is original to this domain.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

function normalizeLine(line) {
  return String(line).replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

const KIND = 'flow-step-and-node'

const lineCount = (content) => String(content).split(/\r?\n/u).length

function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u)
  const normalised = lines.map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= normalised.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (normalised[start + offset] !== needle[offset]) { matched = false; break }
    }
    if (matched) hits.push({ start: start + 1, end: start + needle.length })
  }
  return hits
}

function matchesAt(content, needle, startLine) {
  const lines = String(content).split(/\r?\n/u)
  if (startLine < 1 || startLine + needle.length - 1 > lines.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (normalizeLine(lines[startLine - 1 + offset]) !== needle[offset]) return false
  }
  return true
}

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  path: null,
  start: null,
  end: null,
  step: null,
  detail,
  ...extra,
})

const anchored = (path, start, end, tier, detail, step) => ({
  status: 'anchored',
  tier,
  path,
  start,
  end,
  step,
  detail,
})

const toDocuments = (subject) => {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content })
  }
  return documents
}

/** `subject.branches`, or the branch list embedded in a single-branch subject. */
const toBranches = (subject) => {
  if (Array.isArray(subject?.branches)) return subject.branches
  if (subject?.branch !== null && typeof subject?.branch === 'object') return [subject.branch]
  return null
}

const toSteps = (subject) => {
  if (Array.isArray(subject?.flow?.steps)) return subject.flow.steps
  if (Array.isArray(subject?.steps)) return subject.steps
  return null
}

/**
 * Rebuild the flow structure from the P0 candidate set — the (b)-family
 * convention documented at the top of this file.
 *
 * Every admitted candidate carries the locator it was enumerated with
 * (`{stepId, branchId, nodeId?}`), so the candidate set IS the `{stepId,
 * branchId, nodeId}` space this verifier recomputes against. Reading it back is
 * not a shortcut: the rebuilt tables go through exactly the same membership
 * checks as a declared `flow`/`branches`, which is why a claim outside the
 * candidate set is still refused.
 *
 * Returns `null` when the array carries no usable locator at all, so the caller
 * can tell "no candidate set was offered / it says nothing" (=> `no-documents`)
 * apart from "a candidate set was offered and the claim is not in it"
 * (=> `no-match`, decided by the normal checks below).
 */
export function rebuildFromCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const steps = []
  const nodes = []
  const branchSteps = new Map()
  const seenSteps = new Set()
  const seenNodes = new Set()

  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const locator = candidate.locator !== null && typeof candidate.locator === 'object' ? candidate.locator : {}
    const meta = candidate.meta !== null && typeof candidate.meta === 'object' ? candidate.meta : {}
    const stepId = typeof locator.stepId === 'string' && locator.stepId !== ''
      ? locator.stepId
      : (typeof meta.stepId === 'string' && meta.stepId !== '' ? meta.stepId : null)
    const branchId = typeof locator.branchId === 'string' && locator.branchId !== ''
      ? locator.branchId
      : (typeof meta.branchId === 'string' && meta.branchId !== '' ? meta.branchId : null)
    // A candidate with no (step, branch) locator is not part of this domain's
    // space; it contributes nothing and is not treated as a wildcard.
    if (stepId === null || branchId === null) continue

    if (!seenSteps.has(stepId)) {
      seenSteps.add(stepId)
      steps.push({ id: stepId, name: meta.stepName ?? null, type: meta.stepType ?? null })
    }
    if (!branchSteps.has(branchId)) branchSteps.set(branchId, [])
    const members = branchSteps.get(branchId)
    if (!members.includes(stepId)) members.push(stepId)

    const nodeId = typeof locator.nodeId === 'string' && locator.nodeId !== '' ? locator.nodeId : null
    if (nodeId !== null && !seenNodes.has(nodeId)) {
      seenNodes.add(nodeId)
      nodes.push({ id: nodeId, screen: meta.screen ?? null })
    }
  }

  if (steps.length === 0 || branchSteps.size === 0) return null
  return {
    steps,
    nodes,
    branches: [...branchSteps].map(([id, members]) => ({ id, kind: null, steps: members })),
  }
}

const structureLabel = (source) => (source === 'candidates'
  ? '结构来源：P0 候选集重建（locator 空间）'
  : '结构来源：调用方提供的流程/分支表')

/**
 * Verify one flow-step-and-node claim.
 *
 * @param {{kind?:string,path?:string,locator?:{stepId?:string,branchId?:string,nodeId?:string,startLine?:number},excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<{path:string,content:string}>,flow?:object,steps?:Array<object>,branches?:Array<object>,branch?:object}} subject
 * @returns {object} an AnchorVerdict
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const stepId = typeof locator.stepId === 'string' && locator.stepId.trim() !== '' ? locator.stepId.trim() : null
  const branchId = typeof locator.branchId === 'string' && locator.branchId.trim() !== '' ? locator.branchId.trim() : null

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原文规范化后为空 —— 没有可核验的证据，不得据以出结论')
  }

  const documents = toDocuments(subject)
  // Declared tables first (they are the authoritative flow-spec); otherwise
  // rebuild the same structure from the P0 candidate set. See the convention at
  // the top of this file.
  const declaredBranches = toBranches(subject)
  const declaredSteps = toSteps(subject)
  const declaredStructure = declaredBranches !== null || declaredSteps !== null
  const rebuilt = declaredStructure ? null : rebuildFromCandidates(subject?.candidates)
  const structureSource = declaredStructure ? 'subject' : (rebuilt === null ? 'none' : 'candidates')
  const branches = declaredStructure ? declaredBranches : (rebuilt?.branches ?? null)
  const steps = declaredStructure ? declaredSteps : (rebuilt?.steps ?? null)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null

  if (branches === null && steps === null) {
    return unanchored('no-documents',
      '既没有流程步骤表、也没有分支表，也没有可重建该结构的 P0 候选集 —— 「这个步骤属于这个分支」无法重算')
  }

  if (stepId === null || branchId === null) {
    return unanchored('no-match',
      '步骤侧锚点不完整：必须同时给出 branchId 与 stepId。只给其一即无法证明「这个步骤在这个分支上」')
  }

  if (steps !== null && !steps.some((step) => step !== null && typeof step === 'object' && step.id === stepId)) {
    return unanchored('no-match', `流程步骤表里没有 "${stepId}" —— 步骤侧锚点无法重算，拒绝猜测最接近的步骤`)
  }
  if (branches !== null) {
    const branch = branches.find((entry) => entry !== null && typeof entry === 'object' && entry.id === branchId)
    if (branch === undefined) {
      return unanchored('no-match', `分支表里没有 "${branchId}" —— 拒绝把这条发现挂到一个不存在的分支上`)
    }
    if (!Array.isArray(branch.steps) || !branch.steps.includes(stepId)) {
      return unanchored('no-match',
        `分支 "${branchId}" 的步骤表里没有 "${stepId}" —— 该步骤不在这个分支上，绑定不成立`)
    }
  }

  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent }
    : documents.find((document) => document.path === preferred) ?? null

  if (named !== null) {
    const declared = locator.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）；步骤侧 ${branchId}/${stepId} 绑定已确认；${structureLabel(structureSource)}`, `${branchId}/${stepId}`)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号；步骤侧 ${branchId}/${stepId} 绑定已确认；${structureLabel(structureSource)}`, `${branchId}/${stepId}`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const others = documents.filter((document) => document.path !== preferred)
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁；步骤侧 ${branchId}/${stepId} 绑定已确认`, `${branchId}/${stepId}`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对文档中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '步骤侧（分支真实存在且该分支确实包含这个步骤）+ 证据侧（逐字滑窗重算行号）。两半缺一即判未锚定。',
  verify,
})

export { allMatches, matchesAt }
