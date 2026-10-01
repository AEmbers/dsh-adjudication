/**
 * project-management — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * An anchor here is a pair of TASK IDS, and the engine — not the model — decides
 * whether that pair is an edge of the plan. The model never supplies a fact about
 * the graph that is taken on trust. This file is the re-derivation, and its most
 * important output is the word `unanchored`.
 *
 * THE THREE CLAIM KINDS
 * ---------------------
 *   task-edge    `{ from, to }` — "T4 depends on T2". Confirmed only when that
 *                DIRECTED edge exists in the graph the claim names.
 *   cycle-path   `{ cycle: [T1, T2, T3] }` — "these three tasks are mutually
 *                blocked". Confirmed only when the graph offers EXACTLY ONE route
 *                T1 → … → T1 over those nodes. Two routes means the model named a
 *                cycle that exists without pinning down which one it meant.
 *   orphan-task  `{ taskId }` — "T9 is unreachable in this plan". Confirmed only
 *                when the task exists AND has no incoming and no outgoing edge.
 *
 * THE LADDER, AND WHICH TIERS ARE TERMINAL
 * ----------------------------------------
 *   declared-locator    the graph the claim named holds the claim exactly. (tier 1)
 *   recomputed-unique   the claim holds in the named graph, but only after the
 *                       verifier consulted MORE of the graph than the claim cited
 *                       — e.g. the cycle is confirmed by re-deriving the route
 *                       rather than by the edge list the model pasted. (tier 1')
 *   relocated-unique    the named graph is absent from the corpus and EXACTLY ONE
 *                       other graph holds the claim; the finding moves there. (tier 2)
 *   locator-mismatch    the named graph exists and CONTRADICTS the claim — the
 *                       edge is reversed, the cycle is not closed, the task has
 *                       the neighbours the claim says it lacks. Terminal. A claim
 *                       the input refutes is never repaired by guessing what it
 *                       "probably" meant. (tier 3)
 *   relocation-ambiguous two or more graphs hold the claim equally well, and the
 *                       competing graph paths are listed. Terminal. (tier 3)
 *   id-ambiguous        a vertex id is declared by two graphs, or twice inside
 *                       one graph, so "the edge T1→T9" names nothing in
 *                       particular. Terminal, and the collisions are listed.
 *                       ** This tier is an EXTENSION `lib/contracts.js` does not
 *                       declare. ** It is kept inside the declared vocabulary by
 *                       reporting it as `relocation-ambiguous` — the contract's
 *                       own tier for "the target is not uniquely determined" —
 *                       and putting the extension name in `detail`/`scope`, so no
 *                       verdict ever carries a tier `validateAnchorVerdict` would
 *                       reject. The distinction survives in the machine-readable
 *                       fields instead of in the tier string.
 *   no-match / kind-mismatch / empty-excerpt / no-documents  terminal.
 *
 * `locator-mismatch`, `relocation-ambiguous` and `no-match` are the three negative
 * cases `test.mjs` must prove, and they are the three a "make the anchor rate look
 * good" reflex would be tempted to soften. They are not softened here.
 *
 * MATCHING IS EXACT. There is no fuzzy identifier matching, no case folding, no
 * "close enough" task id. `T-12` is not `T12`, and a paraphrase ("T4 waits for
 * T2's work") is not a claim this verifier can confirm at all.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import {
  adjacency,
  anchored,
  declarationsOf,
  documentByPath,
  graphDocuments,
  isOrphan,
  relocate,
  simplePaths,
  slash,
  unanchored,
} from '../_lib/graph.js'
import { EDGE_KIND, declaredIds, taskEdgePairs } from './source.js'

/**
 * The anchor kind this domain declares in `index.js`.
 *
 * Kept as a single string, not the three-element `ANCHOR_KINDS` list, because
 * `validateDomainPackV2` compares `pack.anchorVerifier.kind` to `pack.anchor.kind`
 * with strict equality — the verifier's identity is the DOMAIN's anchor, and the
 * three claim kinds are the shapes a claim of that anchor may take.
 */
const KIND = 'task-and-edge'

/** The claim shapes `locator.kind` may take. Exported for the domain's tests. */
export const ANCHOR_KINDS = Object.freeze([
  'task-edge', 'cycle-path', 'orphan-task', 'unregistered-target', 'hedged-target',
])

/**
 * Set of tiers this verifier can return, for the test's completeness check.
 *
 * Every name here MUST exist in `lib/contracts.js` `ANCHOR_TIERS`, because
 * `validateAnchorVerdict` rejects an unknown `tier` outright and the engine turns
 * such a verdict into a contract violation. That constraint is why two useful
 * distinctions do NOT appear as tiers in this list:
 *
 *   • "the claim is structurally empty" (no `from`, an empty cycle, …) reports
 *     `empty-excerpt` — the contract's own terminal tier for "there is nothing
 *     here to verify", which is exactly what an empty id pair is.
 *   • "an id is declared by two graphs" reports `relocation-ambiguous` — the
 *     contract's own terminal tier for "the target is not uniquely determined" —
 *     with `scope: 'id-ambiguous'` carrying the finer distinction.
 *
 * Both are asserted in `test.mjs`: no verdict may ever carry a tier the contract
 * does not declare, and the extension distinction must still be machine-readable.
 */
export const REACHABLE_TIERS = Object.freeze([
  'declared-locator', 'recomputed-unique', 'relocated-unique',
  'locator-mismatch', 'relocation-ambiguous', 'no-match',
  'kind-mismatch', 'empty-excerpt', 'no-documents',
])

/**
 * The extension tier name, reported through `scope` rather than through `tier`.
 * See the header: the contract's own `relocation-ambiguous` is what leaves the
 * building, and this name is what keeps the two causes distinguishable.
 */
export const ID_AMBIGUOUS = 'id-ambiguous'

/** `[{ id }]` -> `Map<id, item>`, first declaration wins. */
function byId(list) {
  const out = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '') {
      if (!out.has(item.id)) out.set(item.id, item)
    }
  }
  return out
}

/** Every fact the verifier needs about one graph document, derived once. */
function analyse(document) {
  const tasks = Array.isArray(document.payload.tasks) ? document.payload.tasks : []
  const idSpace = (Array.isArray(document.payload.idSpace) ? document.payload.idSpace : []).filter((id) => typeof id === 'string' && id !== '')
  const edges = taskEdgePairs(document).map(([from, to]) => [from, to])
  const declared = declaredIds(document)
  const counts = new Map()
  for (const id of declared) counts.set(id, (counts.get(id) ?? 0) + 1)
  const nodes = adjacency([document], (doc) => taskEdgePairs(doc))
  // A task with no edges at all is invisible to `adjacency`, which only ever sees
  // ids that appear on an edge. Orphan detection would then be impossible — the
  // very case this domain exists for. So every declared id is seeded as a node
  // first; the edges only add the arrows.
  for (const id of declared) if (!nodes.has(id)) nodes.set(id, { from: null, to: null, out: [], in: [] })
  return {
    path: document.path,
    document,
    tasks,
    byTask: byId(tasks),
    idSpace,
    edges,
    nodes,
    declared,
    duplicated: [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    has: (id) => declared.includes(String(id)),
    /** Is this id a node of the graph at all — declared, or attached to an edge? */
    isNode: (id) => declared.includes(String(id)) || nodes.has(String(id)),
  }
}

/**
 * Verify a claim against ONE analysed graph.
 *
 * @returns {{ tier: string, hit: object }|{ tier: string, conflict: string }|null}
 *   a confirmation, a contradiction, or `null` when the graph neither holds nor
 *   refutes the claim (which is what makes relocation possible).
 */
function against(graph, claim) {
  const locator = claim.locator ?? {}
  const kind = locator.kind

  if (kind === 'task-edge') {
    const from = String(locator.from ?? '')
    const to = String(locator.to ?? '')
    if (from === '' || to === '') return { tier: 'empty-excerpt', conflict: 'task-edge 声明缺少 from / to' }
    // Membership is checked BEFORE the edge, and both ids must be in the SAME
    // graph. A graph that knows only one end has not refuted the claim — it simply
    // cannot speak to it — so it returns `null` and the caller may relocate. A
    // graph that knows BOTH ends is making a statement, and if the edge is absent
    // that statement is a contradiction.
    if (!graph.has(from) || !graph.has(to)) return null
    const holds = graph.edges.some(([a, b]) => a === from && b === to)
    if (holds) return { tier: 'declared-locator', hit: { from, to } }
    // The graph names both vertices and does not have the edge: that is a
    // CONTRADICTION, not an absence. The reversed edge is reported so the reader
    // can see which way round the model had it.
    const reversed = graph.edges.some(([a, b]) => a === to && b === from)
    return {
      tier: 'locator-mismatch',
      conflict: reversed
        ? `图中存在的是反向边 ${to}→${from}，声明的是 ${from}→${to} —— 方向相反，拒绝按方向猜测`
        : `图中 ${from} 与 ${to} 都存在，但 ${from}→${to} 这条边不存在`,
    }
  }

  if (kind === 'cycle-path') {
    const cycle = (Array.isArray(locator.cycle) ? locator.cycle : []).map(String)
    if (cycle.length < 2) return { tier: 'empty-excerpt', conflict: 'cycle-path 至少需要两个节点 id' }
    const missing = cycle.filter((id) => !graph.has(id))
    if (missing.length > 0) return null
    const hops = []
    for (const [from, to] of cycle.map((id, index) => [id, cycle[(index + 1) % cycle.length]])) {
      hops.push({ from, to, present: graph.edges.some(([a, b]) => a === from && b === to) })
    }
    const broken = hops.filter((hop) => !hop.present)
    if (broken.length > 0) {
      return {
        tier: 'locator-mismatch',
        conflict: `声明的环 ${cycle.join('→')} 中缺少边 ${broken.map((hop) => `${hop.from}→${hop.to}`).join(', ')} —— 环未闭合`,
      }
    }
    // The cycle's edges all exist. It is confirmed only if the graph offers
    // exactly one route from its first node back to itself: two routes means this
    // finding is one of several cycles over the same nodes, and a model that
    // named one of several equally valid readings has not anchored anything.
    const [first] = cycle
    const { paths } = simplePaths(first, first, graph.edges)
    if (paths.length > 1) {
      return {
        tier: 'relocation-ambiguous',
        conflict: `节点 ${cycle.join('、')} 之间存在 ${paths.length} 条不同的回路，声明没有唯一确定是哪一条`,
        ambiguousIn: paths.map((path) => `${graph.path}#cycle:${path.join('→')}`),
      }
    }
    if (paths.length === 0) {
      return {
        tier: 'locator-mismatch',
        conflict: `声明的环 ${cycle.join('→')} 的每条边都在，但 ${first} 出发回到自身没有简单回路 —— 声明与图矛盾`,
      }
    }
    return {
      tier: 'declared-locator',
      hit: { cycle, length: cycle.length },
    }
  }

  if (kind === 'orphan-task') {
    const taskId = String(locator.taskId ?? '')
    if (taskId === '') return { tier: 'empty-excerpt', conflict: 'orphan-task 声明缺少 taskId' }
    if (!graph.has(taskId)) return null
    const node = graph.nodes.get(taskId)
    if (!isOrphan(node)) {
      return {
        tier: 'locator-mismatch',
        conflict: `${taskId} 在图中有 ${node?.in.length ?? 0} 条入边、${node?.out.length ?? 0} 条出边 —— 它不是孤儿，声明的「无上下游」被图证伪`,
      }
    }
    return {
      tier: 'declared-locator',
      hit: { taskId },
    }
  }

  if (kind === 'unregistered-target' || kind === 'hedged-target') {
    const targetId = String(locator.targetId ?? '')
    const referrer = String(locator.referrer ?? '')
    if (targetId === '') return { tier: 'empty-excerpt', conflict: `${kind} 声明缺少 targetId` }
    // TWO DIFFERENT DEFECTS, and the split is by WHICH GRAPH STRUCTURE mentions the id —
    // not by how strongly the reviewer feels about it.
    //
    // An earlier version split them the other way round and made one of the two
    // UNFALSIFIABLE: it confirmed whenever the id was absent from the graph entirely,
    // which is true of any string at all, including an id the reviewer invented. This
    // domain's own test caught it — "unregistered-target has no confirming case" — and the
    // fix is to ask each claim for the piece of evidence that distinguishes it:
    //
    //   unregistered-target  a STRUCTURE leans on the id (it is an endpoint of a
    //                        dependency edge) while NO record declares it. Refuted the
    //                        moment the id has a record of its own.
    //   hedged-target        NOTHING in the graph mentions the id at all — no record and
    //                        no edge. Refuted as soon as anything knows it.
    //
    // The first is the interesting one: the plan depends on something nobody registered.
    // The second is the weaker "this id is not in this plan" claim, kept because it is
    // still checkable and still refutable.
    const node = graph.nodes.get(targetId)
    const declaredHere = graph.declared.includes(targetId)
    const referenced = (node?.in.length ?? 0) > 0 || (node?.out.length ?? 0) > 0
    if (kind === 'unregistered-target') {
      if (declaredHere) {
        return {
          tier: 'locator-mismatch',
          conflict: `${targetId} 在图中已被声明为节点，声明的「有引用、无记录」被图证伪`,
        }
      }
      if (!referenced) {
        return {
          tier: 'locator-mismatch',
          conflict: `${targetId} 没有被任何边引用，声明的「被依赖但无记录」不成立 —— 若真正的问题是它压根没在图里出现，那是 hedged-target`,
        }
      }
      return {
        tier: 'declared-locator',
        hit: { targetId, referrer, dangling: true, referenced: true },
      }
    }
    if (declaredHere || referenced) {
      return {
        tier: 'locator-mismatch',
        conflict: `${targetId} 在图中是已知的（${declaredHere ? '有它自己的记录' : '至少出现在一条边上'}），`
          + '声明的「完全没在图里出现过」被图证伪 —— 若真正的问题是它有引用却没有记录，那是 unregistered-target',
      }
    }
    return {
      tier: 'declared-locator',
      hit: { targetId, referrer, dangling: true, referenced: false, hedged: true },
    }
  }

  return { tier: 'kind-mismatch', conflict: `未定义的 locator.kind "${String(kind)}"，本域只认 ${ANCHOR_KINDS.join('/')}` }
}

/** Turn a confirmation into the shared verdict shape. */
function confirm(kind, graph, hit, tier, detail) {
  const extra = { scope: 'single-graph' }
  if (kind === 'task-edge') {
    return anchored({
      path: graph.path, start: 1, end: 1, position: 'edge', tier, claim: kind, detail,
      nodes: [hit.from, hit.to],
      extra: { ...extra, graph: { from: hit.from, to: hit.to } },
    })
  }
  if (kind === 'cycle-path') {
    return anchored({
      path: graph.path, start: 1, end: hit.length, position: 'cycle-hop', tier, claim: kind, detail,
      nodes: hit.cycle,
      extra: { ...extra, graph: { cycle: hit.cycle } },
    })
  }
  if (kind === 'unregistered-target' || kind === 'hedged-target') {
    return anchored({
      path: graph.path, start: 1, end: 1, position: 'node', tier, claim: kind, detail,
      nodes: [hit.targetId],
      extra: {
        ...extra,
        graph: {
          targetId: hit.targetId, referrer: hit.referrer, referenced: hit.referenced === true,
          ...(hit.hedged === true ? { hedged: true } : { dangling: true }),
        },
      },
    })
  }
  return anchored({
    path: graph.path, start: 1, end: 1, position: 'node', tier, claim: kind, detail,
    nodes: [hit.taskId],
    extra: { ...extra, graph: { taskId: hit.taskId } },
  })
}

/** Turn a refusal into the shared verdict shape. */
function refuse(kind, tier, detail, extra = {}) {
  // `unanchored` names `ambiguousIn` as its own parameter and spreads the rest from
  // `extra`, so an arbitrary field passed at the top level would be silently dropped.
  // `scope` is what keeps this domain's EXTENSION cause (`id-ambiguous`) distinguishable
  // from the contract's own `relocation-ambiguous`, so it has to survive the call.
  const { ambiguousIn, ...rest } = extra
  return unanchored({
    tier, detail, claim: kind,
    ...(ambiguousIn === undefined ? {} : { ambiguousIn }),
    extra: rest,
  })
}

/**
 * Does the caller's locator name the claim's constituents ITSELF?
 *
 * This is the tier judgement, and it deliberately does NOT read a flag.
 *
 * The captain's ruling on t9 settled it, after the first version of this file read
 * a `claim.declared` bit: **`declared-locator` means "the locator the CALLER
 * supplied was independently confirmed", not "the engine said so".** A flag set by
 * the engine would move the tier's basis from the verifier's own verification to
 * the engine's announcement — the exact shape this whole program exists to remove.
 * Nine already-migrated domains infer the tier the same way (they check whether the
 * caller's locator carries `startLine`/`utteranceIndex` and then confirm it);
 * `claim.declared` was a bit nobody ever set, read only here.
 *
 * For a graph claim the constituents ARE the claim body, so:
 *
 *   constituent ids present  -> the caller declared which relationship it means,
 *                               and the graph confirmed it -> `declared-locator`
 *   constituents absent      -> the caller declared only a POSITION or a quoted
 *                               excerpt; the verifier has to work out which
 *                               relationship is meant by re-deriving it from the
 *                               graph -> `recomputed-unique`, and only when the
 *                               re-derivation is unique
 *
 * The second path is not decoration: it is what makes `recomputed-unique` an honest
 * reachable tier here instead of a label kept around for symmetry. See
 * `recompute()` below.
 */
export function constituentsDeclared(kind, locator) {
  if (locator === null || typeof locator !== 'object') return false
  const text = (value) => typeof value === 'string' && value.trim() !== ''
  if (kind === 'task-edge') return text(locator.from) && text(locator.to)
  if (kind === 'cycle-path') {
    return Array.isArray(locator.cycle) && locator.cycle.length >= 2 && locator.cycle.every(text)
  }
  if (kind === 'unregistered-target' || kind === 'hedged-target') return text(locator.targetId)
  if (kind === 'orphan-task') return text(locator.taskId)
  return false
}

/** The fields each claim kind needs before it can be called declared. */
function describeRequired(kind) {
  if (kind === 'task-edge') return 'from / to'
  if (kind === 'cycle-path') return 'cycle[]'
  if (kind === 'orphan-task') return 'taskId'
  return 'targetId'
}

/**
 * Does `excerpt` mention `id` as a WHOLE id, not as a substring of a longer one?
 *
 * The boundary matters: a plain `includes('T1')` matches `T12`, so an excerpt
 * mentioning only `T12` would be read as naming `T1` and the verifier would confirm
 * a relationship the caller never claimed. Ids are `[A-Za-z0-9_-]` here, so the
 * guard is "no id character on either side".
 */
function mentions(excerpt, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'u').test(excerpt)
}

/**
 * Re-derive an undedeclared claim from the caller's excerpt, over the whole corpus.
 *
 * This is the tier-1' path: the caller gave a quoted excerpt (or a bare position)
 * and NOT the constituent ids, so the verifier must work out which relationship the
 * claim is about. It is confirmed only when that reading is UNIQUE across every
 * document; two candidate relationships means the claim has not pinned anything down,
 * and the competitors are listed rather than collapsed.
 *
 * A bounded vocabulary on purpose: only the two claim kinds whose constituents can
 * be recovered from an excerpt are recomputable (`task-edge` from a pair of ids,
 * `orphan-task` from a single id). A `cycle-path` cannot — an excerpt naming three
 * nodes does not say which order they close in — and it says so instead of guessing.
 */
function recompute(claim, kind, documents) {
  const excerpt = typeof claim.excerpt === 'string' ? claim.excerpt : ''
  if (excerpt.trim() === '') {
    return refuse(kind, 'empty-excerpt',
      `locator 没有给出 ${describeRequired(kind)}，也没有附 excerpt 供引擎重算 —— 声明是空的，没有任何可核验的内容`)
  }
  if (kind === 'cycle-path') {
    return refuse(kind, 'empty-excerpt',
      `cycle-path 必须给出 cycle[]：一段摘录无法说明这几个节点以什么顺序闭合，引擎拒绝按顺序猜测`)
  }

  const hits = []
  for (const document of documents) {
    const graph = analyse(document)
    const nodes = graph.nodes
    if (kind === 'task-edge') {
      for (const [from, to] of graph.edges) {
        if (mentions(excerpt, from) && mentions(excerpt, to)) {
          hits.push({ graph, where: `${document.path}#task-edge:${from}->${to}`, hit: { from, to } })
        }
      }
      continue
    }
    if (kind === 'orphan-task') {
      for (const id of graph.declared) {
        if (!mentions(excerpt, id)) continue
        const node = nodes.get(id)
        if (isOrphan(node)) hits.push({ graph, where: `${document.path}#orphan-task:${id}`, hit: { taskId: id } })
      }
      continue
    }
    // unregistered-target / hedged-target: the excerpt must name an id the graph does
    // NOT declare. Which of the two kinds the hit reports follows the SAME structural
    // split as `against` above — referenced by an edge => unregistered-target, mentioned
    // by nothing at all => hedged-target — so the recomputed reading cannot disagree with
    // the declared one.
    for (const id of nodes.keys()) {
      if (graph.declared.includes(id) || !mentions(excerpt, id)) continue
      const referrers = nodes.get(id)?.in ?? []
      if (referrers.length > 0) hits.push({ graph, where: `${document.path}#unregistered-target:${id}`, hit: { targetId: id, referrer: referrers[0], referenced: true } })
    }
    if (kind === 'hedged-target') {
      // A hedged target is mentioned by nothing, so it is invisible to the adjacency walk
      // above; it can only be recomputed from an excerpt that names an id the graph has
      // never heard of. There is nothing to enumerate, so this path reports the absence of
      // any candidate rather than inventing one.
      continue
    }
  }

  if (hits.length === 0) {
    return refuse(kind, 'no-match',
      `摘录没有唯一对应到任何一条 ${kind} 关系：摘录里提到的 ID 在图上找不到能成立的那种关系`)
  }
  if (hits.length > 1) {
    return refuse(kind, 'relocation-ambiguous',
      `摘录在 ${hits.length} 处都能成立，声明没有唯一确定是哪一处 —— 拒绝猜测`,
      { ambiguousIn: hits.map((entry) => entry.where).sort() })
  }
  const [only] = hits
  return confirm(kind, only.graph, only.hit, 'recomputed-unique',
    `locator 未给出 ${describeRequired(kind)}；引擎从摘录重算出唯一成立的 ${kind}（${only.where}）`)
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string, path?:string, locator?:object, declared?:boolean}} claim
 * @param {{path?:string, documents?:Array<{path,type,payload}>}} subject
 * @returns {object} an AnchorVerdict
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`（它指向任务图文档）')
  }
  if (claim.locator === undefined || claim.locator === null || typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（本域的锚点没有其它形态）')
  }
  if (claim.kind !== KIND) {
    return refuse(claim.locator?.kind ?? null, 'kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }
  if (!ANCHOR_KINDS.includes(claim.locator.kind)) {
    return refuse(claim.locator.kind ?? null, 'kind-mismatch', `未知的 locator.kind "${String(claim.locator.kind)}"，只认 ${ANCHOR_KINDS.join('/')}`)
  }

  const documents = graphDocuments(subject)
  if (documents.length === 0) {
    return refuse(claim.locator.kind, 'no-documents', '没有提供任何任务图文档 —— 锚点无法重算')
  }

  const claimKind = claim.locator.kind
  const wanted = slash(subject?.path !== undefined && subject.path !== '' ? subject.path : claim.path)
  const named = documentByPath(documents, wanted)

  // TIER INFERENCE FIRST. A claim whose locator does not carry this domain's
  // constituent fields has declared no relationship at all — only a position or a
  // quoted excerpt — so there is nothing for the graph to confirm or refute yet.
  // The verifier re-derives the constituents from the excerpt and reports
  // `recomputed-unique`; see `recompute` and `constituentsDeclared`.
  if (!constituentsDeclared(claimKind, claim.locator)) {
    return recompute(claim, claimKind, documents)
  }

  /** The ids this claim is about — the ones whose identity must be unambiguous. */
  const touchedIds = () => {
    if (claimKind === 'task-edge') return [String(claim.locator.from ?? ''), String(claim.locator.to ?? '')]
    if (claimKind === 'cycle-path') return (Array.isArray(claim.locator.cycle) ? claim.locator.cycle : []).map(String)
    if (claimKind === 'unregistered-target' || claimKind === 'hedged-target') return [String(claim.locator.targetId ?? '')]
    return [String(claim.locator.taskId ?? '')]
  }

  /** Ids declared more than once INSIDE one graph — the graph cannot be used. */
  const selfCollisions = (graph) => {
    const counts = new Map()
    for (const id of declaredIds(graph.document)) counts.set(id, (counts.get(id) ?? 0) + 1)
    return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort()
  }

  if (named !== null) {
    const graph = { document: named, ...analyse(named) }
    // Identity first, edge second: while two different things are both called T1,
    // "T1→T9 exists" is neither true nor false.
    const selfDupes = selfCollisions(graph)
    const touchedDupes = touchedIds().filter((id) => id !== '' && selfDupes.includes(id))
    if (touchedDupes.length > 0) {
      return refuse(claimKind, 'relocation-ambiguous',
        `ID 冲突：${touchedDupes.join('、')} 在 ${named.path} 内被声明了不止一次 —— 同一 ID 指向两个对象时，任何关于它的边都无法确认，拒绝猜测`,
        { ambiguousIn: touchedDupes.map((id) => `${named.path}#${id}`), scope: ID_AMBIGUOUS })
    }
    // A claim about an id the corpus does not declare at all is not something this
    // graph can speak to, EXCEPT when the claim is a negative existence statement —
    // `unregistered-target` is exactly that, so it is evaluated rather than skipped.
    const outcome = against(graph, claim)
    if (outcome === null) {
      const present = graph.declared.length === 0
        ? `${named.path} 没有声明任何任务 ID`
        : `${named.path} 声明的 ID 里没有这条声明涉及的全部节点`
      return refuse(claimKind, 'no-match', `${present} —— 声明指向的图不包含它，也不与它矛盾`)
    }
    if (outcome.hit !== undefined) {
      return confirm(claimKind, graph, outcome.hit, outcome.tier, `在 ${named.path} 确认（${claimKind}）`)
    }
    return refuse(claimKind, outcome.tier, outcome.conflict, {
      ...(outcome.ambiguousIn === undefined ? {} : { ambiguousIn: outcome.ambiguousIn }),
      scope: outcome.ambiguousIn === undefined ? 'single-graph' : 'multi-route',
    })
  }

  // The named graph is absent from the corpus. Relocation is allowed, but only onto
  // a claim that holds in EXACTLY ONE other graph.
  //
  // NOTE the deliberate asymmetry with the named branch above: a cross-document id
  // COLLISION is NOT by itself a refusal here. Two plans legitimately share a task
  // id (every team's plan has a `T1`), and refusing on that alone would make a
  // perfectly anchored finding unmovable for a reason that has nothing to do with
  // it. What disqualifies a relocation is that the claim HOLDS IN MORE THAN ONE
  // graph — that is the ambiguity. Collisions are recorded in the detail so the
  // reader can see why the same id resolved in several places, but they do not
  // manufacture an ambiguity that the claim itself does not have.
  const scopes = documents.map((document) => ({ path: document.path, nodes: declaredIds(document) }))
  const collisions = touchedIds()
    .filter((id) => id !== '')
    .map((id) => ({ id, declarations: [...new Set(declarationsOf(scopes, id).map((scope) => scope.path))] }))
    .filter((entry) => entry.declarations.length > 1)

  const ledger = relocate()
  /** Graphs that CONTRADICT the claim — recorded, but not immediately fatal. */
  const contradictions = []
  /** `path#kind` of every graph that HOLDS the claim, in walk order. */
  const holders = []
  for (const document of documents) {
    const graph = { document, ...analyse(document) }
    const outcome = against(graph, claim)
    if (outcome !== null && outcome.hit !== undefined) {
      holders.push(`${document.path}#${claimKind}`)
      ledger.record(claim, `${document.path}#${claimKind}`, { graph })
      // THE AMBIGUITY IS DETECTED FORWARD, not after the walk. If two graphs both
      // hold the claim, the corpus does not support a unique relocation and the
      // walk is already over — continuing would only let a later contradiction
      // pre-empt the answer the model needs ("this claim is true of two different
      // plans"), which is the more useful of the two.
      if (holders.length > 1) {
        return refuse(claimKind, 'relocation-ambiguous',
          `声明的 "${wanted}" 不在语料中，但该声明在 ${holders.length} 张图中同样成立 —— 搬迁不唯一，拒绝猜测`,
          { ambiguousIn: holders })
      }
    } else if (outcome !== null && outcome.hit === undefined) {
      contradictions.push({ path: document.path, conflict: outcome.conflict })
    }
  }
  const collisionNote = collisions.length === 0
    ? ''
    : `（注意 ${collisions.map((entry) => `${entry.id} 被 ${entry.declarations.join('、')} 同时声明`).join('；')}，`
      + '但真正决定是否可搬迁的是「声明在几张图里成立」）'
  const verdict = ledger.verdict()
  if (verdict.kind === 'unique') {
    const graph = verdict.hit.graph
    const outcome = against(graph, claim)
    return confirm(claimKind, graph, outcome.hit, 'relocated-unique',
      `声明的 "${wanted}" 不在语料中；该声明在 "${graph.path}" 唯一成立，发现已搬迁。${collisionNote}`)
  }
  if (verdict.kind === 'ambiguous') {
    return refuse(claimKind, 'relocation-ambiguous',
      `声明的 "${wanted}" 不在语料中，且该声明在 ${verdict.ambiguousIn.length} 张图中同样成立 —— 搬迁不唯一，拒绝猜测。${collisionNote}`,
      { ambiguousIn: verdict.ambiguousIn })
  }
  if (contradictions.length > 0) {
    // Nothing holds it and at least one graph refutes it. The contradiction is the
    // more informative answer: "the corpus says the opposite" is actionable,
    // "nothing matched" is not.
    const [first] = contradictions
    return refuse(claimKind, 'locator-mismatch',
      `声明的 "${wanted}" 不在语料中，而 "${first.path}" 明确与声明矛盾：${first.conflict}`)
  }
  return refuse(claimKind, 'no-match', `声明的 "${wanted}" 不在语料中，也没有任何一张任务图含这条声明`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '任务 ID + 依赖边：引擎在任务图上重算该边的存在性、方向与闭环唯一性；ID 冲突、方向相反、环未闭合一律判未锚定。',
  verify,
})

/** Re-exported for the domain's own tests and evidence tools. */
export { analyse as analyseGraph, EDGE_KIND }
