/**
 * architecture — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `module-graph-and-adr`
 * ----------------------------------------------
 * The format table in `lib/contracts.js` (`DOMAIN_INPUT_FORMATS['architecture']`)
 * fixes both the name and the shape, and this file implements exactly that shape:
 *
 *   {
 *     modules: [{ id, path, dependsOn: string[] }],
 *     adrs:    [{ id, title, status, decision, affects: string[] }]
 *   }
 *
 * and the documented candidate set: "one per dependency edge, plus one per
 * (ADR, affected module) pair".
 *
 * WHY THE CANDIDATE TEXT IS A RENDERED EDGE, NOT A SOURCE LINE
 * -----------------------------------------------------------
 * In every other domain the candidate's `text` is a line a reviewer can copy out
 * of a file. Here the input IS the graph — module sources are not part of the
 * documented shape — so the thing to quote is the EDGE, and this source renders
 * it canonically:
 *
 *   dependency edge   `<moduleId> -> <targetId>`
 *   ADR decision      `<adrId> -> <moduleId>`
 *
 * `anchor.js` recomputes that exact rendering from the graph and compares. It is
 * a literal comparison against a deterministically derived artefact, not a fuzzy
 * text search: if the model writes `src/api -> src/core` and the graph says
 * `api -> core`, it is not the same edge and the anchor says so.
 *
 * A DANGLING EDGE IS REPORTED, NOT SILENTLY DROPPED
 * -------------------------------------------------
 * `dependsOn: ['ghost']` naming a module that no entry declares is exactly the
 * kind of thing this domain exists to surface — but it is a fact about the
 * manifest, not a candidate about an edge that exists. It goes in `excluded`
 * with a readable reason, so it appears in the plan's output instead of
 * vanishing.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** The canonical rendering of a dependency edge. Recomputed by anchor.js. */
export function renderEdge(moduleId, targetId) {
  return `${moduleId} -> ${targetId}`
}

/** The canonical rendering of an (ADR, module) pair. Recomputed by anchor.js. */
export function renderDecision(adrId, moduleId) {
  return `${adrId} -> ${moduleId}`
}

/**
 * Enumerate the dependency edges and decision pairs.
 *
 * @param {{modules?:object[],adrs?:object[]}} input
 * @param {object} [context] `{ maxCandidates, maxExcerptLines }` — the engine's bounds
 * @returns {{candidates:object[],excluded:object[],notes:string[],bounded:boolean,truncated:boolean}}
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      'module-graph-and-adr 输入必须是对象 { modules, adrs }')
  }
  if (!Array.isArray(input.modules)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `modules`（模块清单与依赖边）')
  }
  if (input.adrs !== undefined && !Array.isArray(input.adrs)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`adrs` 必须是数组（可省略 = 没有决策归档）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const modules = input.modules
  const adrs = input.adrs ?? []
  const byId = new Map()
  const duplicates = new Set()
  for (const module of modules) {
    if (module === null || typeof module !== 'object') continue
    if (typeof module.id !== 'string' || module.id === '') continue
    if (byId.has(module.id)) { duplicates.add(module.id); continue }
    byId.set(module.id, module)
  }
  // A duplicated module id is not a cosmetic problem: the same id now names two
  // different implementations, so "the edge api -> core" no longer identifies
  // one edge. Enumerating it anyway would be a guess, so those candidates are
  // reported instead of produced.
  const ambiguousIds = [...duplicates].sort()

  const candidates = []
  const excluded = []
  const notes = []
  let truncated = false

  if (ambiguousIds.length > 0) {
    notes.push(`模块清单里有重复的 id：${ambiguousIds.join(', ')} —— 同一个 id 对应多个实现，相关候选一律不予枚举（歧义时拒绝猜测，而不是取第一个）`)
  }
  const ambiguousReason = (id) => `模块 id "${id}" 在清单里出现了多次 —— 同一个 id 对应多个不同实现，这条断言无法确定指向哪一个，不予枚举`

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  // --- one candidate per dependency edge ------------------------------------
  for (const module of modules) {
    if (module === null || typeof module !== 'object') {
      excluded.push({ id: '(module)', reason: 'module entry that is not an object' })
      continue
    }
    const id = typeof module.id === 'string' && module.id !== '' ? module.id : null
    if (id === null) {
      excluded.push({ id: '(module)', reason: '模块没有 `id` —— 依赖边无法被依赖图重算' })
      continue
    }
    const path = typeof module.path === 'string' && module.path !== '' ? module.path : null
    if (path === null) {
      excluded.push({ id, reason: `模块 "${id}" 没有给出实现路径（path）—— 候选无法被闸门 glob，也无法落成一条可锚定的边` })
      continue
    }
    const dependsOn = Array.isArray(module.dependsOn) ? module.dependsOn.filter((value) => typeof value === 'string' && value !== '') : []

    if (duplicates.has(id)) {
      excluded.push({ id, reason: ambiguousReason(id) })
      continue
    }

    for (const targetId of dependsOn) {
      if (duplicates.has(targetId)) {
        excluded.push({ id: `${id} -> ${targetId}`, reason: ambiguousReason(targetId) })
        continue
      }
      if (!byId.has(targetId)) {
        excluded.push({
          id: `${id} -> ${targetId}`,
          reason: `模块 "${id}" 声明依赖 "${targetId}"，但模块清单里没有这个模块 —— 悬空边无法被依赖图验证（这本身是一条要单独处理的发现，不是一条候选）`,
        })
        continue
      }
      const text = renderEdge(id, targetId)
      push({
        id: `${path}#edge-${id}->${targetId}`,
        path,
        locator: { kind: 'dependency-edge', path, moduleId: id, targetId, findingKind: 'edge' },
        text,
        bytes: byteLength(text),
        additions: 0,
        deletions: 0,
        title: `${id} → ${targetId}`,
        meta: { kind: 'dependency-edge', moduleId: id, targetId, layer: module.layer ?? null },
      })
    }

    if (dependsOn.length === 0) notes.push(`模块 "${id}" 没有任何出边 —— 孤立模块，无法从依赖结构上评价`)
  }

  // --- one candidate per (ADR, affected module) pair ------------------------
  for (const adr of adrs) {
    if (adr === null || typeof adr !== 'object' || typeof adr.id !== 'string' || adr.id === '') {
      excluded.push({ id: '(adr)', reason: 'ADR 条目缺少 `id` —— 决策无法被归档系统验证' })
      continue
    }
    const affects = Array.isArray(adr.affects) ? adr.affects.filter((value) => typeof value === 'string' && value !== '') : []
    if (affects.length === 0) {
      notes.push(`ADR "${adr.id}" 没有声明影响任何模块（affects 为空）—— 它无法与任何边形成可核验的组合`)
      continue
    }
    for (const moduleId of affects) {
      if (duplicates.has(moduleId)) {
        excluded.push({ id: `${adr.id} -> ${moduleId}`, reason: ambiguousReason(moduleId) })
        continue
      }
      const module = byId.get(moduleId)
      if (module === undefined || typeof module.path !== 'string' || module.path === '') {
        excluded.push({
          id: `${adr.id} -> ${moduleId}`,
          reason: `ADR "${adr.id}" 声明影响模块 "${moduleId}"，但模块清单里没有可用的该模块 —— 决策无法落到一条可锚定的位置上`,
        })
        continue
      }
      const text = renderDecision(adr.id, moduleId)
      push({
        id: `${module.path}#adr-${adr.id}-${moduleId}`,
        path: module.path,
        locator: { kind: 'adr-decision', path: module.path, adrId: adr.id, moduleId, status: adr.status ?? null, findingKind: 'edge' },
        text,
        bytes: byteLength(text),
        additions: 0,
        deletions: 0,
        title: `${adr.id} → ${moduleId}`,
        meta: { kind: 'adr-decision', adrId: adr.id, moduleId, status: adr.status ?? null },
      })
    }
  }

  for (const [id, module] of byId) {
    const inbound = modules.some((other) => Array.isArray(other?.dependsOn) && other.dependsOn.includes(id))
    const outbound = Array.isArray(module.dependsOn) && module.dependsOn.length > 0
    if (!inbound && !outbound) notes.push(`模块 "${id}" 既不被依赖也没有出边 —— 它是一个孤立模块`)
  }

  // `maxExcerptLines` cannot bite here: every candidate is a one-line rendering.
  // Said out loud rather than silently ignored.
  if (maxExcerptLines < 1) notes.push('maxExcerptLines 小于 1，但本领域的候选都是单行渲染，因此没有任何截断发生')

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'modules-and-decisions',
  inputFormat: 'module-graph-and-adr',
  bounded: true,
  describe: '模块依赖图 + ADR 归档 → 每条依赖边一个候选，每个 (ADR, 受影响模块) 组合一个候选；边与决策都渲染成规范文本供 P5 重算。',
  enumerate,
})

export { byteLength }
