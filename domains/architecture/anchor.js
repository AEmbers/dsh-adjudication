/**
 * architecture — P5 anchor verifier (contract v2, extension point 2).
 *
 * THIS IS A GRAPH CHECKER, NOT A TEXT MATCHER
 * ------------------------------------------
 * The v1 pack states the obligation: "锚点是「模块 ID」或「ADR 编号」。声明依赖方向
 * 的发现必须能被依赖图验证。" So this verifier does NOT slide a window over
 * source files — there are no source files in this domain's input format. It:
 *
 *   1. recomputes the canonical rendering of the claimed edge / decision from the
 *      graph and compares it to the excerpt LITERALLY, and
 *   2. recomputes the GRAPH FACT the claim depends on, according to its
 *      `findingKind`:
 *
 *        edge            the edge really is in `dependsOn`
 *        cycle           there really is a path from `targetId` back to `moduleId`
 *        reverse-layer   the edge really points backwards through `subject.layers`
 *        adr-superseded  the named ADR's status really is superseded/rejected
 *
 * A claim the graph does not support is UNANCHORED — never a discussion, never a
 * pass. And a claim whose graph fact cannot be recomputed because the input does
 * not supply the graph is ALSO unanchored: "I could not check it" must never read
 * as "it checks out", which is the silent-pass failure mode this whole contract
 * is built around.
 *
 * WHY THE TIER IS `recomputed-unique`
 * -----------------------------------
 * The trusted tiers are fixed by the contract. `declared-locator` and
 * `relocated-unique` are about text positions and do not apply here; what this
 * verifier does is exactly the "the engine recomputed it, and there is exactly
 * one answer" case, which is what `recomputed-unique` names. The anchored verdict
 * therefore carries no line range — the contract allows a non-empty domain
 * `locator` instead, which is what `{moduleId, targetId}` is.
 *
 * PORTING: nothing in this file is ported from open-code-review. That project
 * reviews diffs; it has no module graph and no ADR archive, so there is no
 * upstream counterpart to port. The only shared idiom is `normalize` — dropping
 * surrounding whitespace before comparing — which is the same one NOTICE already
 * lists for `lib/engine.js` and `domains/code-review/anchor.js` (ported from
 * open-code-review, `internal/diff/resolver.go`). It is five characters of
 * meaning here, not a sliding window: this domain has no text to slide over.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** The anchor kind this domain verifies. */
const KIND = 'module-and-adr'

/** The graph facts this verifier knows how to recompute. Anything else is refused. */
export const FINDING_KINDS = Object.freeze(['edge', 'cycle', 'reverse-layer', 'adr-superseded'])

/** ADR statuses that mean "this decision no longer governs the code". */
export const SUPERSEDED_STATUSES = Object.freeze(['superseded', 'rejected', 'deprecated', 'obsolete'])

function normalize(value) {
  return String(value ?? '').replace(/^[+-]/u, '').replace(/\s+/gu, '')
}

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored', tier, path: null, start: null, end: null, detail, ...extra,
})

const anchored = (path, detail, locator) => ({
  status: 'anchored', tier: 'recomputed-unique', path, start: null, end: null, detail, locator,
})

/** `id -> dependsOn[]`, restricted to edges whose target the manifest declares. */
export function adjacencyOf(modules) {
  const known = new Set(modules.filter((module) => typeof module?.id === 'string').map((module) => module.id))
  const graph = new Map()
  for (const module of modules) {
    if (typeof module?.id !== 'string') continue
    const targets = (Array.isArray(module.dependsOn) ? module.dependsOn : [])
      .filter((value) => typeof value === 'string' && value !== '' && known.has(value))
    graph.set(module.id, targets)
  }
  return graph
}

/**
 * Breadth-first search for a directed path `from -> … -> to`.
 *
 * Bounded by `maxDepth` so a pathological graph cannot hang a verifier; hitting
 * the bound returns `null` (no path proven) rather than a partial answer, because
 * a partial answer here would be a guess.
 */
export function findPath(graph, from, to, maxDepth = 64) {
  if (from === to) return [from]
  const queue = [[from]]
  const seen = new Set([from])
  while (queue.length > 0) {
    const path = queue.shift()
    if (path.length > maxDepth) return null
    const last = path[path.length - 1]
    for (const next of graph.get(last) ?? []) {
      if (next === to) return [...path, next]
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([...path, next])
    }
  }
  return null
}

/** Every cycle reachable as `start -> … -> start`, reported as an edge sequence. */
export function findCycle(graph, start, maxDepth = 64) {
  for (const first of graph.get(start) ?? []) {
    const path = findPath(graph, first, start, maxDepth)
    if (path !== null) return [start, ...path]
  }
  return null
}

/** The layer ranks, outer first. `null` when the caller did not declare them. */
function layerRanks(subject) {
  const layers = subject?.layers
  if (!Array.isArray(layers)) return null
  const ranks = new Map()
  for (const [index, name] of layers.entries()) {
    if (typeof name === 'string' && name !== '') ranks.set(name, index)
  }
  return ranks.size > 0 ? ranks : null
}

/**
 * Recompute the graph fact a claim depends on.
 *
 * @returns {{ok:boolean, reason:string, extra?:object}}
 */
export function graphCheck(locator, module, target, subject) {
  const findingKind = typeof locator?.findingKind === 'string' && locator.findingKind !== ''
    ? locator.findingKind
    : 'edge'
  if (!FINDING_KINDS.includes(findingKind)) {
    return { ok: false, reason: `未知的 findingKind "${findingKind}" —— 本领域只认 ${FINDING_KINDS.join(' / ')}，不猜` }
  }

  const adrId = typeof locator?.adrId === 'string' && locator.adrId !== '' ? locator.adrId : null

  if (findingKind === 'adr-superseded' && adrId === null) {
    return { ok: false, reason: '声明「决策已作废」但没有点名 ADR 编号 —— 没有可重算的归档条目' }
  }

  if (findingKind === 'adr-superseded') {
    const adrs = subject?.adrs
    if (!Array.isArray(adrs)) {
      return { ok: false, reason: '没有提供 ADR 归档（adrs）—— 决策状态无法重算。「无法核验」不是「成立」，因此不予锚定。' }
    }
    const adr = adrs.find((entry) => entry?.id === adrId)
    if (adr === undefined) {
      return { ok: false, reason: `ADR 归档里没有 "${adrId}"。归档中有：${adrs.map((entry) => entry?.id).filter(Boolean).join(', ') || '(空)'}` }
    }
    if (!SUPERSEDED_STATUSES.includes(adr.status)) {
      return { ok: false, reason: `ADR "${adrId}" 的状态是 "${adr.status}"，不是已被取代的状态（${SUPERSEDED_STATUSES.join('/')}）—— 「决策已作废」的主张与归档矛盾` }
    }
    return { ok: true, reason: `ADR "${adrId}" 的状态确实是 "${adr.status}"，决策已不生效`, extra: { adrId: adr.id, status: adr.status ?? null } }
  }

  // A decision claim is about an (ADR, module) pair, not about an edge. The pair
  // itself was already checked by the caller against `adr.affects`; there is no
  // direction to recompute here, so `edge` means exactly "this pair is real".
  if (adrId !== null) {
    if (findingKind !== 'edge') {
      return { ok: false, reason: `决策类锚点不支持 findingKind "${findingKind}" —— 依赖边才有方向、环与层次可言` }
    }
    return { ok: true, reason: `ADR "${adrId}" 确实声明影响模块 "${module.id}"`, extra: { adrId, moduleId: module.id } }
  }

  // The remaining kinds are all about an edge, so the edge must exist first.
  const modules = subject?.modules
  if (!Array.isArray(modules)) {
    return { ok: false, reason: '没有提供模块依赖图（modules）—— 依赖边无法重算' }
  }
  if (target === null) {
    return { ok: false, reason: '这条断言声明的是依赖边，但没有点名 targetId —— 边不完整，无法重算' }
  }
  const dependsOn = Array.isArray(module.dependsOn) ? module.dependsOn : []
  if (!dependsOn.includes(target.id)) {
    return { ok: false, reason: `依赖图里没有这条边：模块 "${module.id}" 的 dependsOn 是 [${dependsOn.join(', ')}]，不含 "${target.id}"` }
  }

  if (findingKind === 'edge') {
    return { ok: true, reason: `依赖图确认存在 "${module.id} -> ${target.id}"`, extra: { moduleId: module.id, targetId: target.id } }
  }

  if (findingKind === 'cycle') {
    const cycle = findCycle(adjacencyOf(modules), module.id)
    if (cycle === null) {
      return { ok: false, reason: `依赖图里没有经过 "${module.id}" 的环 —— 「存在环依赖」的主张与图矛盾` }
    }
    return { ok: true, reason: `依赖图确认存在环：${cycle.join(' → ')}`, extra: { cycle } }
  }

  // reverse-layer
  const ranks = layerRanks(subject)
  if (ranks === null) {
    return { ok: false, reason: '没有提供层次声明（layers）—— 「反向依赖」无法重算。声明一个有序的 layers 数组（外层在前）才能核验。' }
  }
  const fromLayer = module.layer
  const toLayer = target.layer
  if (typeof fromLayer !== 'string' || typeof toLayer !== 'string') {
    return { ok: false, reason: `模块 "${module.id}" / "${target.id}" 没有声明 layer —— 方向无法与层次对齐，不予锚定` }
  }
  const fromRank = ranks.get(fromLayer)
  const toRank = ranks.get(toLayer)
  if (fromRank === undefined || toRank === undefined) {
    return { ok: false, reason: `layers 里没有 "${fromLayer}" 或 "${toLayer}"（layers = ${[...ranks.keys()].join(' → ')}）—— 无法重算方向` }
  }
  if (fromRank <= toRank) {
    return { ok: false, reason: `"${module.id}"(${fromLayer}) → "${target.id}"(${toLayer}) 是允许的方向（外层 → 内层），不构成反向依赖` }
  }
  return { ok: true, reason: `"${module.id}"(${fromLayer}) → "${target.id}"(${toLayer}) 确实是反向依赖（内层指向外层）`, extra: { fromLayer, toLayer } }
}

/**
 * Rebuild the module graph from the engine's own candidate set.
 *
 * ADDED (t23). Before this, the verifier required `subject.modules`, which only a
 * library caller supplies — so on the plugin path it always answered
 * `no-documents` and the domain scored zero coverage through the engine however
 * good the locator was. The material is not missing, it is one level away: P0
 * turned the `input.payload` graph into candidates, and the engine forwards that
 * candidate set as `subject.candidates` (contract §1.2: "P0 产出，locator 空间在
 * 这里"). Each candidate carries its own locator, so the graph is recoverable:
 *
 *   - `{kind:'dependency-edge', moduleId, targetId}` -> an adjacency edge, plus
 *     the source module's `path` and its `layer` (on the candidate's `meta`)
 *   - `{kind:'adr-decision', adrId, moduleId, status}` -> an ADR and one entry in
 *     its `affects`
 *
 * WHAT IS NOT RECOVERABLE, and is therefore left undefined rather than invented:
 * a module that only ever appears as a TARGET has no `path` and no `layer` (no
 * candidate was emitted from it). Every check that needs them refuses on its own
 * — `reverse-layer` reports "没有声明 layer" instead of guessing a direction.
 *
 * Returns `null` when there is no candidate set to work from, so the caller can
 * keep refusing with `no-documents`.
 */
function graphFromCandidates(subject) {
  const candidates = Array.isArray(subject?.candidates) ? subject.candidates : null
  if (candidates === null) return null

  const modules = new Map()
  const adrs = new Map()
  const moduleFor = (id) => {
    if (!modules.has(id)) modules.set(id, { id, dependsOn: [], layer: undefined, path: undefined })
    return modules.get(id)
  }

  for (const candidate of candidates) {
    const locator = candidate?.locator
    if (locator === null || typeof locator !== 'object') continue

    if (locator.kind === 'dependency-edge') {
      if (typeof locator.moduleId !== 'string' || locator.moduleId === '') continue
      const from = moduleFor(locator.moduleId)
      if (typeof locator.path === 'string' && locator.path !== '' && from.path === undefined) from.path = locator.path
      const layer = candidate?.meta?.layer
      if (typeof layer === 'string' && layer !== '') from.layer = layer
      if (typeof locator.targetId === 'string' && locator.targetId !== '') {
        moduleFor(locator.targetId)
        if (!from.dependsOn.includes(locator.targetId)) from.dependsOn.push(locator.targetId)
      }
      continue
    }

    if (locator.kind === 'adr-decision') {
      if (typeof locator.adrId !== 'string' || locator.adrId === '') continue
      if (!adrs.has(locator.adrId)) adrs.set(locator.adrId, { id: locator.adrId, status: undefined, affects: [] })
      const adr = adrs.get(locator.adrId)
      if (typeof locator.status === 'string' && locator.status !== '') adr.status = locator.status
      if (typeof locator.moduleId === 'string' && locator.moduleId !== '' && !adr.affects.includes(locator.moduleId)) {
        adr.affects.push(locator.moduleId)
      }
    }
  }

  if (modules.size === 0 && adrs.size === 0) return null
  // Only fill in what the caller did NOT already supply: an explicitly handed-over
  // graph always wins over a reconstruction, because it carries `path`/`layer` for
  // every module and this one cannot.
  return {
    ...subject,
    modules: Array.isArray(subject?.modules) ? subject.modules : [...modules.values()],
    adrs: Array.isArray(subject?.adrs) ? subject.adrs : [...adrs.values()],
    graphFromCandidates: true,
  }
}

/**
 * Verify one module-graph anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{modules?:object[],adrs?:object[],layers?:string[],candidates?:object[]}} subject
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

  const excerpt = normalize(claim.excerpt ?? '')
  if (excerpt === '') {
    return unanchored('empty-excerpt', '抄写的边/决策规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const locator = claim.locator ?? {}
  // The graph may arrive directly (`subject.modules`, which a library caller hands
  // over) or be reconstructed from the engine's own candidate set. ADDED (t23).
  const basis = Array.isArray(subject?.modules) ? subject : graphFromCandidates(subject)
  const modules = basis?.modules
  if (!Array.isArray(modules)) {
    return unanchored('no-documents',
      '没有提供模块依赖图 —— 既没有直接给出 modules，也没有可以从候选集（subject.candidates）重建的依赖边。本领域没有任何可比对的结构，无法重算锚点')
  }
  // Whether the graph was handed over or rebuilt is part of the verdict, because
  // the two bases are not equally strong: a rebuilt graph cannot carry `path` or
  // `layer` for modules that only appear as edge targets.
  const basisNote = basis?.graphFromCandidates === true
    ? '（依赖图由 P0 候选集重建 —— 与计划一致，不是重新读取了模块清单）'
    : ''

  const moduleId = typeof locator.moduleId === 'string' && locator.moduleId !== '' ? locator.moduleId : null
  if (moduleId === null) {
    return unanchored('locator-mismatch', '这条锚点没有点名 moduleId —— 发现落不到任何模块上')
  }
  // Ambiguity is refused, never resolved by taking the first match. The same id
  // naming two different implementations means the edge is not identified, and
  // picking one would be a guess dressed up as a verified anchor.
  const namesakes = modules.filter((entry) => entry?.id === moduleId)
  if (namesakes.length > 1) {
    return unanchored('relocation-ambiguous',
      `模块清单里 "${moduleId}" 出现了 ${namesakes.length} 次 —— 同一个 id 对应多个不同实现，锚点无法唯一确定，不予锚定`,
      { ambiguousIn: namesakes.map((entry) => (typeof entry.path === 'string' && entry.path !== '' ? entry.path : '(无 path)')) })
  }
  const module = modules.find((entry) => entry?.id === moduleId)
  if (module === undefined) {
    return unanchored('locator-mismatch',
      `模块依赖图里没有 "${moduleId}"。图中有：${modules.map((entry) => entry?.id).filter(Boolean).join(', ') || '(空)'}`)
  }
  const path = typeof module.path === 'string' && module.path !== '' ? module.path : claim.path

  const adrId = typeof locator.adrId === 'string' && locator.adrId !== '' ? locator.adrId : null
  const targetId = typeof locator.targetId === 'string' && locator.targetId !== '' ? locator.targetId : null
  if (adrId === null && targetId === null) {
    return unanchored('locator-mismatch', '这条锚点既没有 targetId 也没有 adrId —— 既不是边也不是决策，无法重算')
  }

  // The canonical rendering, recomputed from the graph and compared LITERALLY.
  const expected = adrId === null ? `${moduleId} -> ${targetId}` : `${adrId} -> ${moduleId}`
  if (excerpt !== normalize(expected)) {
    return unanchored('no-match',
      `抄写的内容与依赖图重算出的规范形式不一致：抄写 "${String(claim.excerpt).trim()}" vs 重算 "${expected}"。`
      + '本领域的锚点是图上的边/决策，必须逐字一致。')
  }

  let target = null
  if (adrId !== null) {
    const adrs = basis?.adrs
    if (!Array.isArray(adrs)) {
      return unanchored('locator-mismatch', '没有提供 ADR 归档（adrs）—— 决策断言无法重算')
    }
    const adrNamesakes = adrs.filter((entry) => entry?.id === adrId)
    if (adrNamesakes.length > 1) {
      return unanchored('relocation-ambiguous',
        `ADR 归档里 "${adrId}" 出现了 ${adrNamesakes.length} 次 —— 同一个编号对应多条决策，锚点无法唯一确定，不予锚定`,
        { ambiguousIn: adrNamesakes.map((entry) => (typeof entry.title === 'string' && entry.title !== '' ? entry.title : `${adrId}(无标题)`)) })
    }
    const adr = adrs.find((entry) => entry?.id === adrId)
    if (adr === undefined) {
      return unanchored('locator-mismatch', `ADR 归档里没有 "${adrId}"。归档中有：${adrs.map((entry) => entry?.id).filter(Boolean).join(', ') || '(空)'}`)
    }
    const affects = Array.isArray(adr.affects) ? adr.affects : []
    if (!affects.includes(moduleId)) {
      return unanchored('locator-mismatch',
        `ADR "${adrId}" 的 affects 是 [${affects.join(', ')}]，不含 "${moduleId}" —— 这条决策并没有声明影响该模块`)
    }
  } else {
    target = modules.find((entry) => entry?.id === targetId) ?? null
    if (target === null) {
      return unanchored('locator-mismatch',
        `模块依赖图里没有 targetId "${targetId}"。图中有：${modules.map((entry) => entry?.id).filter(Boolean).join(', ') || '(空)'}`)
    }
  }

  const check = graphCheck(locator, module, target, basis)
  if (!check.ok) return unanchored('locator-mismatch', `${check.reason}${basisNote}`)

  return anchored(path, `图上重算成立：${expected}${basisNote}；${check.reason}`, {
    kind: adrId === null ? 'dependency-edge' : 'adr-decision',
    moduleId,
    targetId,
    adrId,
    findingKind: locator.findingKind ?? 'edge',
    ...(check.extra ?? {}),
  })
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '模块/决策锚点：把抄写的边或决策与依赖图重算出的规范形式逐字比对，并按发现种类重算图上事实（边存在性 / 环可达性 / 层次方向 / ADR 状态）；图上不成立或无法重算时一律未锚定。',
  verify,
})

export { normalize, layerRanks }
