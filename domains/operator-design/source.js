/**
 * operator-design — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `operator-registry-and-tests`
 * ------------------------------------------------------
 * The format table in `lib/contracts.js` (`DOMAIN_INPUT_FORMATS['operator-design']`)
 * fixes both the name and the shape, and this file implements exactly that shape:
 *
 *   {
 *     operators: [{ signature, name, backends: string[], dtypes: string[],
 *                   shapeBranches: string[], path?, source? }],
 *     tests: [{ operator, backend, dtype, shape, tolerance: { atol, rtol } | null, asserted }]
 *   }
 *
 * and the documented candidate set: "one per (operator, backend, dtype, shapeBranch)".
 *
 * ONE DOCUMENTED EXTENSION, DECLARED OUT LOUD
 * ------------------------------------------
 * The documented shape has no file for an operator — but `candidate.path` is what
 * the P1 gate globs and what a reviewer anchors against, so an operator without
 * one produces a candidate that can be neither gated nor quoted. Rather than
 * invent a path, this source accepts an OPTIONAL `path` (or `source`) on each
 * operator entry and, when it is missing, reports the operator in `excluded` with
 * a readable reason. Silently deriving a fake path would be worse than saying so.
 *
 * WHAT "COVERED" MEANS, AND WHY IT IS DECLARED RATHER THAN GUESSED
 * ---------------------------------------------------------------
 * A test covers a form when `operator`, `backend` and `dtype` all match AND
 * `shape` is either the exact branch name or `*` (a wildcard the manifest may use
 * for shape-independent tests). Nothing else counts. This is a reading, not a
 * standard — it is written here so it can be disagreed with.
 *
 * TWO CANDIDATE KINDS, BOTH INDEXED BY A FORM
 * -------------------------------------------
 *   uncovered-form      no matching test at all. This is the documented candidate.
 *   missing-tolerance   a matching test exists but its `tolerance` is null or its
 *                       `asserted` flag is false — nominally covered, numerically
 *                       unverified, which in a recall-first domain is a gap, not
 *                       a pass. This is the `missing-tolerance` fixture.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** A shape value that matches every shape branch. Declared, not inferred. */
export const SHAPE_WILDCARD = '*'

/** Does this test exercise this form? See the header for the rule. */
export function testCovers(test, operatorName, backend, dtype, shapeBranch) {
  if (test === null || typeof test !== 'object') return false
  if (test.operator !== operatorName) return false
  if (test.backend !== backend) return false
  if (test.dtype !== dtype) return false
  return test.shape === shapeBranch || test.shape === SHAPE_WILDCARD
}

/** A tolerance is only a tolerance if it constrains something. */
export function hasUsableTolerance(test) {
  if (test === null || typeof test !== 'object') return false
  if (test.asserted !== true) return false
  const tolerance = test.tolerance
  if (tolerance === null || tolerance === undefined || typeof tolerance !== 'object') return false
  const atol = Number(tolerance.atol)
  const rtol = Number(tolerance.rtol)
  const anyAtol = Number.isFinite(atol) && atol >= 0
  const anyRtol = Number.isFinite(rtol) && rtol >= 0
  return anyAtol || anyRtol
}

/** The operator's implementation file, if the entry names one. */
function operatorPath(operator) {
  for (const field of ['path', 'source', 'file']) {
    const value = operator?.[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * Enumerate the uncovered and numerically-unverified operator forms.
 *
 * @param {{operators?:object[],tests?:object[]}} input
 * @param {object} [context] `{ maxCandidates, maxExcerptLines }` — the engine's bounds
 * @returns {{candidates:object[],excluded:object[],notes:string[],bounded:boolean,truncated:boolean}}
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      'operator-registry-and-tests 输入必须是对象 { operators, tests }')
  }
  if (!Array.isArray(input.operators)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `operators`（算子注册表）')
  }
  if (input.tests !== undefined && !Array.isArray(input.tests)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`tests` 必须是数组（可省略 = 完全没有数值测试清单）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const tests = input.tests ?? []
  const candidates = []
  const excluded = []
  const notes = []
  let truncated = false

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  for (const operator of input.operators) {
    if (operator === null || typeof operator !== 'object') {
      excluded.push({ id: '(operator)', reason: 'operator entry that is not an object' })
      continue
    }
    const name = typeof operator.name === 'string' && operator.name !== '' ? operator.name : null
    if (name === null) {
      excluded.push({ id: '(operator)', reason: '算子没有 `name` —— 无法与测试清单对齐，也无法成为可锚定的候选' })
      continue
    }
    const path = operatorPath(operator)
    if (path === null) {
      excluded.push({
        id: name,
        reason: `算子 "${name}" 没有给出实现文件（path / source / file）—— 候选无法被闸门 glob，也无法抄写原文来锚定`,
      })
      continue
    }
    const signature = typeof operator.signature === 'string' ? operator.signature : ''
    if (signature === '') {
      excluded.push({ id: name, reason: `算子 "${name}" 的 signature 是空串 —— 锚点的签名侧没有可重算的基准` })
      continue
    }

    const backends = Array.isArray(operator.backends) ? operator.backends.filter((value) => typeof value === 'string') : []
    const dtypes = Array.isArray(operator.dtypes) ? operator.dtypes.filter((value) => typeof value === 'string') : []
    const shapeBranches = Array.isArray(operator.shapeBranches) ? operator.shapeBranches.filter((value) => typeof value === 'string') : []

    if (backends.length === 0 || dtypes.length === 0 || shapeBranches.length === 0) {
      notes.push(`算子 "${name}" 的 backends/dtypes/shapeBranches 有空集 —— 没有任何形态可枚举`)
      continue
    }

    const sourceLines = typeof operator.source === 'string' ? operator.source.split(/\r?\n/u) : null
    const signatureLine = sourceLines === null
      ? null
      : (sourceLines.findIndex((line) => line.includes(signature)) + 1 || null)
    const signatureText = signatureLine === null
      ? signature
      : sourceLines.slice(signatureLine - 1, signatureLine).join('\n')

    for (const backend of backends) {
      for (const dtype of dtypes) {
        for (const shapeBranch of shapeBranches) {
          const matching = tests.filter((test) => testCovers(test, name, backend, dtype, shapeBranch))
          const form = `${name}｜${backend}｜${dtype}｜${shapeBranch}`
          const base = {
            path,
            bytes: byteLength(signatureText),
            additions: 0,
            deletions: 0,
            meta: { operator: name, backend, dtype, shapeBranch },
          }

          if (matching.length === 0) {
            push({
              ...base,
              id: `${path}#${form}#uncovered-form`,
              locator: { kind: 'operator-form', path, signature, operator: name, backend, dtype, shapeBranch, findingKind: 'uncovered-form' },
              text: signatureText,
              title: `${form} 没有任何数值测试`,
              meta: { ...base.meta, findingKind: 'uncovered-form' },
            })
            continue
          }

          const usable = matching.filter(hasUsableTolerance)
          if (usable.length === 0) {
            push({
              ...base,
              id: `${path}#${form}#missing-tolerance`,
              locator: { kind: 'operator-form', path, signature, operator: name, backend, dtype, shapeBranch, findingKind: 'missing-tolerance' },
              text: signatureText,
              title: `${form} 有 ${matching.length} 个测试，但没有一个带可用容差`,
              meta: { ...base.meta, findingKind: 'missing-tolerance', tests: matching.length },
            })
          }
        }
      }
    }
  }

  for (const name of new Set(tests.map((test) => test?.operator).filter((value) => typeof value === 'string'))) {
    if (!input.operators.some((operator) => operator?.name === name)) {
      excluded.push({ id: name, reason: `测试清单里有算子 "${name}" 的测试，但注册表里没有这个算子 —— 无法判断它属于哪个形态` })
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'operator-implementations',
  inputFormat: 'operator-registry-and-tests',
  bounded: true,
  describe: '算子注册表 + 数值测试清单 → 每个「没有任何数值测试的形态」与每个「有测试但没有容差断言」的形态一个候选。',
  enumerate,
})

export { operatorPath }
