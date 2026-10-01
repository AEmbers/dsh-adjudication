/**
 * operator-design — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT IT VERIFIES, AND WHY THERE ARE THREE CHECKS
 * -----------------------------------------------
 * The v1 pack states the obligation: "锚点是「算子签名 + 数值容差断言」。引擎校验
 * 该签名存在、该容差在测试中被实际断言。" So a claim survives only if ALL hold:
 *
 *   1. the copied line really is at the position the model means; and
 *   2. the FORM it names — (operator, backend, dtype, shapeBranch) — really is
 *      declared by the registry, with that signature; and
 *   3. the NUMERIC TESTING STATUS it asserts is what the manifest actually says.
 *
 * Check 3 is the one that makes this an anchor rather than a text search. The
 * finding is "this form has no numeric test" or "this form's test asserts no
 * tolerance". Both are claims about the manifest, and both can be
 * contradicted by it — a contradiction is UNANCHORED, never a discussion.
 *
 * THREE KINDS OF "I CANNOT TELL", ALL OF WHICH REFUSE
 * ---------------------------------------------------
 *   - no document set          -> `no-documents`
 *   - no registry              -> `locator-mismatch` (the form is unverifiable)
 *   - no test manifest         -> `locator-mismatch` (the coverage claim is unverifiable)
 *
 * None of them is allowed to fall through as a pass. "I could not check it" is
 * exactly the state a reviewer must not be handed as "it checks out" — that is
 * the silent-pass failure mode this whole contract is built around.
 *
 * MATCHING IS LITERAL. `normalizeLine` drops leading diff markers and ALL
 * whitespace (the same normalization the reference domain ports from
 * open-code-review `internal/diff/resolver.go:301`); nothing else is tolerated.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** The anchor kind this domain verifies. */
const KIND = 'signature-and-tolerance'

/** The finding kinds this verifier knows how to recompute. Anything else is refused. */
export const FINDING_KINDS = Object.freeze(['uncovered-form', 'missing-tolerance'])

function normalizeLine(line) {
  return String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u).map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= lines.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) { matched = false; break }
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
  status: 'unanchored', tier, path: null, start: null, end: null, detail, ...extra,
})

const anchored = (path, start, end, tier, detail, locator) => ({
  status: 'anchored', tier, path, start, end, detail, locator,
})

function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path !== '') documents.push({ path, content })
  }
  return documents
}

/** A tolerance is only a tolerance if it constrains something. Mirrors source.js. */
export function usableTolerance(test) {
  if (test === null || typeof test !== 'object') return false
  if (test.asserted !== true) return false
  const tolerance = test.tolerance
  if (tolerance === null || tolerance === undefined || typeof tolerance !== 'object') return false
  const atol = Number(tolerance.atol)
  const rtol = Number(tolerance.rtol)
  return (Number.isFinite(atol) && atol >= 0) || (Number.isFinite(rtol) && rtol >= 0)
}

/** Does this test exercise this form? Mirrors source.js. */
export function testCovers(test, operatorName, backend, dtype, shapeBranch) {
  if (test === null || typeof test !== 'object') return false
  return test.operator === operatorName
    && test.backend === backend
    && test.dtype === dtype
    && (test.shape === shapeBranch || test.shape === '*')
}

/**
 * The registry + manifest check. Returns `{ok, reason, locatedSignature}`.
 */
function formCheck(locator, locatedText, subject) {
  const operatorName = typeof locator?.operator === 'string' && locator.operator !== '' ? locator.operator : null
  if (operatorName === null) return { ok: false, reason: '这条锚点没有点名算子 —— 无法重算形态，拒绝猜测' }

  const operators = subject?.operators
  if (!Array.isArray(operators)) {
    return { ok: false, reason: '没有提供算子注册表（operators）—— 形态无法核验。「无法核验」不是「成立」，因此不予锚定。' }
  }
  const operator = operators.find((item) => item?.name === operatorName)
  if (operator === undefined) {
    return {
      ok: false,
      reason: `算子注册表里没有 "${operatorName}"。注册表中有：${operators.map((item) => item?.name).filter(Boolean).join(', ') || '(空)'}`,
    }
  }

  const signature = typeof operator.signature === 'string' ? operator.signature : ''
  if (signature === '') {
    return { ok: false, reason: `注册表里的 "${operatorName}" 没有 signature —— 签名侧没有可重算的基准` }
  }
  const normalizedSignature = normalizeLine(signature)
  const normalizedLocated = normalizeLine(locatedText ?? '')
  if (!normalizedLocated.includes(normalizedSignature) && !normalizedSignature.includes(normalizedLocated)) {
    return {
      ok: false,
      reason: `抄写的那一行与注册表里 "${operatorName}" 的签名不一致：抄写 "${String(locatedText ?? '').trim()}" vs 注册表 "${signature}"`,
    }
  }

  for (const [field, list] of [['backend', operator.backends], ['dtype', operator.dtypes], ['shapeBranch', operator.shapeBranches]]) {
    const wanted = locator?.[field]
    if (typeof wanted !== 'string' || wanted === '') {
      return { ok: false, reason: `这条锚点没有点名 ${field} —— 形态不完整，无法核验` }
    }
    if (!Array.isArray(list) || !list.includes(wanted)) {
      return {
        ok: false,
        reason: `注册表里的 "${operatorName}" 不声明 ${field} "${wanted}"。它声明的是：${(Array.isArray(list) ? list : []).join(', ') || '(空)'}`,
      }
    }
  }

  const findingKind = typeof locator?.findingKind === 'string' && locator.findingKind !== '' ? locator.findingKind : 'uncovered-form'
  if (!FINDING_KINDS.includes(findingKind)) {
    return { ok: false, reason: `未知的 findingKind "${findingKind}" —— 本领域只认 ${FINDING_KINDS.join(' / ')}，不猜` }
  }

  const tests = subject?.tests
  if (!Array.isArray(tests)) {
    return { ok: false, reason: `没有提供数值测试清单（tests）—— 「${operatorName}」的 ${locator.backend}/${locator.dtype}/${locator.shapeBranch} 覆盖状态无法核验` }
  }
  const matching = tests.filter((test) => testCovers(test, operatorName, locator.backend, locator.dtype, locator.shapeBranch))
  const usable = matching.filter(usableTolerance)

  if (findingKind === 'uncovered-form') {
    if (matching.length > 0) {
      return {
        ok: false,
        reason: `测试清单里已经有 ${matching.length} 个覆盖该形态的测试（${matching.map((test) => test.shape).join(', ')}）—— 「没有任何数值测试」的主张与清单矛盾`,
      }
    }
    return { ok: true, reason: '测试清单里确实没有覆盖该形态的测试，缺口主张成立', locatedSignature: signature }
  }

  if (matching.length === 0) {
    return { ok: false, reason: '测试清单里根本没有覆盖该形态的测试 —— 「有测试但没容差」的主张与清单矛盾（这属于 uncovered-form）' }
  }
  if (usable.length > 0) {
    return {
      ok: false,
      reason: `该形态已有 ${usable.length} 个带可用容差的测试（${usable.map((test) => JSON.stringify(test.tolerance)).join(', ')}）—— 「没有容差断言」的主张与清单矛盾`,
    }
  }
  return { ok: true, reason: `该形态有 ${matching.length} 个测试，但没有一个带可用容差（asserted 为假或容差为空）`, locatedSignature: signature }
}

/**
 * The form check, rebuilt from the engine's own candidate set.
 *
 * ADDED (t23). `formCheck` above needs `subject.operators` / `subject.tests`, which
 * only a library caller supplies — so on the plugin path this domain always
 * answered "没有提供算子注册表" and scored zero coverage through the engine whatever
 * the locator said. The registry is not absent, it is one level away: P0 consumed
 * the `input.payload` registry and manifest and emitted one candidate per
 * (operator, backend, dtype, shapeBranch) form, and the engine forwards that
 * candidate set as `subject.candidates` (contract §1.2: "P0 产出，locator 空间在
 * 这里"). Each candidate carries `{operator, backend, dtype, shapeBranch,
 * findingKind, signature}` in its locator and the matching-test count in `meta`.
 *
 * WHAT THIS BASIS PROVES, AND WHAT IT DOES NOT: it proves the claim corresponds to
 * a form the plan really enumerated, under the same classification, with the same
 * signature — a model that invents a form, or that relabels a covered form as a
 * gap, is rejected. It does NOT re-read the numeric test manifest, because the
 * engine does not forward it. Every verdict produced from this basis says so in
 * its reason, so nobody mistakes it for the stronger one. When the manifest IS
 * available (`subject.operators`), that route wins.
 *
 * Returns `null` when there is no candidate set to work from, so the caller keeps
 * refusing with the wording that already exists.
 */
function candidateFormCheck(locator, locatedText, subject) {
  const candidates = Array.isArray(subject?.candidates) ? subject.candidates : null
  if (candidates === null) return null

  const operatorName = typeof locator?.operator === 'string' && locator.operator !== '' ? locator.operator : null
  if (operatorName === null) return { ok: false, reason: '这条锚点没有点名算子 —— 无法重算形态，拒绝猜测' }

  const forOperator = candidates.filter((candidate) => candidate?.locator?.operator === operatorName)
  if (forOperator.length === 0) {
    const names = [...new Set(candidates.map((candidate) => candidate?.locator?.operator).filter(Boolean))]
    return {
      ok: false,
      reason: `P0 候选集里没有算子 "${operatorName}" 的任何形态。候选集枚举到的算子是：${names.join(', ') || '(空)'}`,
    }
  }

  const findingKind = typeof locator?.findingKind === 'string' && locator.findingKind !== '' ? locator.findingKind : 'uncovered-form'
  if (!FINDING_KINDS.includes(findingKind)) {
    return { ok: false, reason: `未知的 findingKind "${findingKind}" —— 本领域只认 ${FINDING_KINDS.join(' / ')}，不猜` }
  }

  const backend = locator?.backend
  const dtype = locator?.dtype
  const shapeBranch = locator?.shapeBranch
  const listed = (candidate) => `${candidate.locator.backend}/${candidate.locator.dtype}/${candidate.locator.shapeBranch}`
  const claimed = forOperator.find((candidate) => candidate.locator.backend === backend
    && candidate.locator.dtype === dtype
    && candidate.locator.shapeBranch === shapeBranch)
  if (claimed === undefined) {
    return {
      ok: false,
      reason: `P0 候选集里 "${operatorName}" 没有 ${backend}/${dtype}/${shapeBranch} 这个形态。`
        + `它枚举到的形态是：${forOperator.map(listed).join(', ')}`,
    }
  }

  const signature = typeof claimed.locator.signature === 'string' ? claimed.locator.signature : ''
  if (signature !== '') {
    const normalizedSignature = normalizeLine(signature)
    const normalizedLocated = normalizeLine(locatedText ?? '')
    if (!normalizedLocated.includes(normalizedSignature) && !normalizedSignature.includes(normalizedLocated)) {
      return {
        ok: false,
        reason: `抄写的那一行与候选集里 "${operatorName}" 的签名不一致：抄写 "${String(locatedText ?? '').trim()}" vs 候选集 "${signature}"`,
      }
    }
  }

  const claimedKind = claimed.locator.findingKind ?? 'uncovered-form'
  if (claimedKind !== findingKind) {
    return {
      ok: false,
      reason: `P0 候选集把 "${operatorName}" 的 ${backend}/${dtype}/${shapeBranch} 形态枚举为 "${claimedKind}"，`
        + `而这条主张说的是 "${findingKind}" —— 两者矛盾`,
    }
  }

  const matchedTests = Number(claimed?.meta?.tests ?? 0)
  const detail = claimedKind === 'missing-tolerance'
    ? `候选集记录该形态有 ${matchedTests} 个匹配测试、但都没有可用容差`
    : '候选集里该形态没有任何匹配测试'
  return {
    ok: true,
    reason: `P0 候选集把 "${operatorName}" 的 ${backend}/${dtype}/${shapeBranch} 形态枚举为缺口（${detail}）—— 主张与计划一致`
      + '。注意：这是与 P0 计划的一致，不是重读了数值测试清单（引擎不转发清单）。',
    locatedSignature: signature,
  }
}

/** `formCheck` when the manifest is available, else the candidate-set rebuild. */
function formCheckAny(locator, locatedText, subject) {
  if (Array.isArray(subject?.operators)) return formCheck(locator, locatedText, subject)
  const fromCandidates = candidateFormCheck(locator, locatedText, subject)
  return fromCandidates ?? formCheck(locator, locatedText, subject)
}

/**
 * Verify one operator-form anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:object[],operators?:object[],tests?:object[],candidates?:object[]}} subject
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

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const locator = claim.locator ?? {}
  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent }
    : documents.find((document) => document.path === preferred) ?? null
  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的实现源码 —— 无法重算锚点')
  }

  /** Everything that must hold once a position is established. */
  const finish = (path, start, end, tier, base, content) => {
    const located = content.split(/\r?\n/u).slice(start - 1, end).join('\n')
    const form = formCheckAny(locator, located, subject)
    if (!form.ok) return unanchored('locator-mismatch', `${base}；但 ${form.reason}`)
    return anchored(path, start, end, tier, `${base}；${form.reason}`, {
      kind: 'operator-form',
      operator: locator.operator ?? null,
      backend: locator.backend ?? null,
      dtype: locator.dtype ?? null,
      shapeBranch: locator.shapeBranch ?? null,
      findingKind: locator.findingKind ?? 'uncovered-form',
    })
  }

  if (named !== null) {
    const declared = locator.startLine ?? locator.line
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return finish(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误`, named.content)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }

    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return finish(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`, named.content)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测，请补足上下文后重抄`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end, content: document.content })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return finish(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对源码中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`, only.content)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对源码中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对源码都不含这段原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '算子形态锚点：逐字重算签名位置，并用注册表核验形态（后端/dtype/shape 分支）、用数值测试清单核验覆盖与容差状态；三者任一与输入矛盾、或缺少核验基准时，一律未锚定。',
  verify,
})

export { allMatches, matchesAt, formCheck }
