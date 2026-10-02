/**
 * requirement-alignment — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * An anchor here is a PAIR OF NODE IDS, or a single node id, and the ENGINE — not
 * the model — decides whether the claimed relationship holds in the trace graph.
 * The model never supplies a fact about the graph that is taken on trust. This file
 * is the re-derivation, and its most important output is the word `unanchored`.
 *
 * WHY THIS DOMAIN IS A META-DOMAIN, IN THE ANCHOR
 * -----------------------------------------------
 * Six of the seven claim kinds below are graph facts. The seventh — `cross-domain-ref`
 * and its mirror `stale-ref` — is about a node's `ref`, which is an anchor id
 * produced by ANOTHER domain. Confirming it is what "consume other domains' anchor
 * ids instead of building a closed data structure" means operationally: the model
 * may not assert that a trace link is real because it looks plausible; the verifier
 * checks the ref against the `upstream[]` set the corpus declares. A ref that no
 * longer appears there is a STALE LINK, and this is the only place that can be
 * decided.
 *
 * TWO STRENGTHS OF EVIDENCE, KEPT APART
 * -------------------------------------
 *   shape    — the ref's FORM is one a sibling domain emits (see `REF_SHAPES`).
 *              Necessary, not sufficient. Answerable always.
 *   declared — the ref is a member of `upstream[]`, i.e. some domain says it
 *              produced it. Answerable only when the corpus declares `upstream[]`.
 *
 * Collapsing them would turn "looks like a diff-line anchor" into "an upstream
 * domain really emitted it", which is precisely the false confirmation this domain
 * exists to prevent. So `cross-domain-ref` reports `scope: 'shape-only'` and
 * `staleCheck: 'not-declared'` when `upstream[]` is absent, and `stale-ref` refuses
 * outright (`no-match`) rather than quietly passing.
 *
 * THE CLAIM KINDS
 * ---------------
 *   trace-edge           `{fromId,toId,edgeKind?}`  the directed edge exists
 *   chain-path           `{fromId,toId,route?}`     a route exists, and is UNIQUE
 *   dangling-ref         `{fromId,toId?}`           an edge endpoint has no node record
 *   uncovered-requirement`{fromId,toId?}`           a requirement reaches no implementation
 *   orphan-node          `{fromId}`                 the node has no edges at all
 *   cross-domain-ref     `{fromId,ref?}`            the node's ref is consumable
 *   stale-ref            `{fromId,ref?}`            the node's ref is NO LONGER produced
 *   trace-node-side      `{fromId,side}`            the node has a record here, and
 *                        `side` (upstream/downstream) is the side named. This is the
 *                        ENUMERATOR's name for the card it emits once per side of
 *                        every node; the side's neighbours are card content, not a
 *                        second claim.
 *
 * THE TIER IS DECIDED BY THE LOCATOR, NOT BY A FLAG
 * -------------------------------------------------
 * `declared-locator` means: the caller's locator NAMED THE WHOLE FACT — every
 * endpoint of the claimed relationship — and the graph independently confirmed
 * exactly that. `recomputed-unique` means: the locator named PART of the fact and
 * the verifier had to DERIVE the rest (the route between two endpoints, which
 * endpoint is the dangling one, which target is the unreachable one) before it
 * could confirm.
 *
 * That is a property of the claim the caller actually submitted, so it is inferred
 * from `locator` itself:
 *
 *   trace-edge  fromId+toId+edgeKind all pinned        -> declared-locator
 *               both ends pinned, `edgeKind` omitted   -> recomputed-unique
 *               (the locator claimed "some relationship exists"; the verifier had
 *                to read the kind off the graph to confirm it)
 *   chain-path  `route[]` pinned and confirmed         -> declared-locator
 *               endpoints pinned, route derived       -> recomputed-unique
 *   dangling-ref / stale-ref / uncovered-requirement / cross-domain-ref
 *               the second half pinned (toId/ref)      -> declared-locator
 *               the second half derived by the engine -> recomputed-unique
 *
 * `claim.declared` is NEVER read. It is a flag the engine could theoretically set,
 * and a tier that depends on a flag is a tier a caller can assert rather than earn;
 * the domain's own `test.mjs` asserts that setting it changes nothing.
 *
 * THE LADDER, AND WHICH TIERS ARE TERMINAL
 * ----------------------------------------
 *   declared-locator     the graph the claim named holds the claim exactly, with the
 *                        locator naming the whole fact. (tier 1)
 *   recomputed-unique    the graph holds it, and the verifier derived the part the
 *                        locator left out. (tier 1')
 *   relocated-unique     the named graph is absent and EXACTLY ONE other graph holds
 *                        the claim; the finding moves there. (tier 2)
 *   locator-mismatch     the named graph exists and CONTRADICTS the claim — the edge
 *                        is reversed, the kind differs, the route is broken, the
 *                        node is not an orphan. Terminal: a claim the input refutes
 *                        is never repaired by guessing what it "probably" meant.
 *   relocation-ambiguous two or more graphs (or two or more routes) hold it equally
 *                        well, and the competitors are LISTED. Terminal.
 *   no-match             the corpus cannot speak to the claim at all (also: the
 *                        `stale-ref` question with no `upstream[]` declared).
 *   kind-mismatch / empty-excerpt / no-documents   terminal.
 *
 * Id collisions are reported as `relocation-ambiguous` with `scope: 'id-ambiguous'`
 * — the same treatment `project-management` uses, for the same reason: the
 * contract's tier vocabulary is closed (`validateAnchorVerdict` rejects an unknown
 * tier), and `relocation-ambiguous` is its own word for "the target is not uniquely
 * determined". The finer cause stays machine-readable in `scope`.
 *
 * MATCHING IS EXACT. No case folding, no "close enough" id, no fuzzy ref match.
 * `R-12` is not `R12`, and a paraphrase ("这个需求没有对应的实现") is not a claim
 * this verifier can confirm at all.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import {
  adjacency,
  anchored,
  declarationsOf,
  derivedPath,
  documentByPath,
  graphDocuments,
  isOrphan,
  relocate,
  simplePaths,
  slash,
  unanchored,
} from '../_lib/graph.js'
import { declaredIds, edgePath, edgeTriples, nodeFacts, nodeSidePath, refShape, SIDES, upstreamSet } from './source.js'

/**
 * The anchor kind this domain declares in `index.js`.
 *
 * A single string, not the list of claim kinds, because `validateDomainPackV2`
 * compares `pack.anchorVerifier.kind` to `pack.anchor.kind` with strict equality:
 * the verifier's identity is the DOMAIN's anchor; the seven claim kinds are the
 * shapes a claim of that anchor may take.
 */
const KIND = 'trace-node-and-edge'

/** The claim shapes `locator.kind` may take. Exported for this domain's tests. */
export const ANCHOR_KINDS = Object.freeze([
  'trace-edge', 'chain-path', 'dangling-ref', 'uncovered-requirement',
  'orphan-node', 'cross-domain-ref', 'stale-ref',
  // ADDED (self-audit): the ENUMERATOR's own node-side kind (`source.js`
  // `CANDIDATE_KINDS.nodeSide`). It shipped `trace-node-side` on all twenty
  // node-side candidates of the happy-path fixture, while this list knew only the
  // claim-level names above — so every one of them came back `kind-mismatch` from
  // its own verifier. No test could see it: the fixtures hand-write locators in the
  // CLAIM vocabulary and had never fed the enumerator's output back in.
  'trace-node-side',
])

/**
 * Every tier this verifier can return.
 *
 * Each name MUST exist in `lib/contracts.js` `ANCHOR_TIERS`, because
 * `validateAnchorVerdict` rejects an unknown tier outright and the engine turns
 * such a verdict into a contract violation. That is why the id-collision
 * distinction does not appear here as a tier: it is carried in `scope`.
 */
export const REACHABLE_TIERS = Object.freeze([
  'declared-locator', 'recomputed-unique', 'relocated-unique',
  'locator-mismatch', 'relocation-ambiguous', 'no-match',
  'kind-mismatch', 'empty-excerpt', 'no-documents',
])

/** The extension cause name, reported through `scope` rather than through `tier`. */
export const ID_AMBIGUOUS = 'id-ambiguous'

/** The node type the `uncovered-requirement` claim is about. */
export const REQUIREMENT_TYPE = 'requirement'

/** The node type that satisfies a requirement. */
export const IMPLEMENTATION_TYPE = 'implementation'

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

function byId(list) {
  const out = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item !== null && typeof item === 'object' && isNonEmpty(item.id)) {
      if (!out.has(item.id)) out.set(item.id, item)
    }
  }
  return out
}

/**
 * Every fact the verifier needs about one trace document, derived ONCE.
 *
 * The adjacency is seeded with every declared id before the edges are added: a node
 * with no edges is invisible to `adjacency` (which only ever sees ids that appear on
 * an edge), and an invisible isolated node is exactly the gap this domain exists to
 * report.
 */
function analyse(document) {
  const nodes = Array.isArray(document.payload.nodes) ? document.payload.nodes : []
  const idSpace = (Array.isArray(document.payload.idSpace) ? document.payload.idSpace : []).filter(isNonEmpty)
  const triples = edgeTriples(document)
  const edges = triples.map(([from, to]) => [from, to])
  const kinds = new Map()
  for (const [from, to, kind] of triples) {
    if (!kinds.has(`${from}\u0000${to}`)) kinds.set(`${from}\u0000${to}`, [])
    kinds.get(`${from}\u0000${to}`).push(kind)
  }
  const declared = declaredIds(document)
  const counts = new Map()
  for (const id of declared) counts.set(id, (counts.get(id) ?? 0) + 1)
  const graph = adjacency([document], (doc) => edgeTriples(doc).map(([from, to]) => [from, to]))
  for (const id of [...declared, ...idSpace]) {
    if (!graph.has(id)) graph.set(id, { from: null, to: null, out: [], in: [] })
  }
  const index = byId(nodes)
  return {
    path: document.path,
    document,
    nodes,
    byNode: index,
    idSpace,
    edges,
    kinds,
    nodes_: graph,
    declared,
    known: new Set([...declared, ...idSpace]),
    /** Ids declared more than once inside THIS document. */
    duplicated: [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    has: (id) => declared.includes(String(id)),
    /** Known to the graph at all: declared as a node, in idSpace, or on an edge. */
    isKnown: (id) => declared.includes(String(id)) || idSpace.includes(String(id)) || graph.has(String(id)),
    /** A real node RECORD — the thing `dangling-ref` says is missing. */
    hasRecord: (id) => declared.includes(String(id)),
    nodeType: (id) => {
      const node = index.get(String(id))
      return isNonEmpty(node?.type) ? String(node.type) : null
    },
    refOf: (id) => nodeFacts(index.get(String(id))).ref,
  }
}

/** The route from `from` to `to`, bounded, over this graph's edges. */
function routes(graph, from, to) {
  const found = simplePaths(from, to, graph.edges)
  return { paths: found.paths, truncated: found.truncated }
}

/** Confirm at the tier the caller's own locator earned. */
const tierFor = (locatorNamesWholeFact) => (locatorNamesWholeFact ? 'declared-locator' : 'recomputed-unique')

/**
 * Verify a claim against ONE analysed graph.
 *
 * @returns {{tier:string, hit:object}|{tier:string, conflict:string, ambiguousIn?:string[]}|null}
 *   a confirmation, a contradiction, or `null` when the graph neither holds nor
 *   refutes the claim — which is what makes relocation possible.
 */
function against(graph, claim) {
  const locator = claim.locator ?? {}
  const kind = locator.kind
  const fromId = String(locator.fromId ?? '')
  const toId = isNonEmpty(locator.toId) ? String(locator.toId) : null

  if (kind === 'trace-edge') {
    const edgeKind = isNonEmpty(locator.edgeKind) ? String(locator.edgeKind) : null
    if (fromId === '' || toId === null) return { tier: 'empty-excerpt', conflict: 'trace-edge 声明缺少 fromId / toId' }
    // Membership before the edge, and both ends must be in the SAME graph. A graph
    // that knows only one end has not refuted the claim — it cannot speak to it —
    // so it returns null and the caller may relocate.
    if (!graph.isKnown(fromId) || !graph.isKnown(toId)) return null
    const present = graph.kinds.get(`${fromId}\u0000${toId}`)
    if (present !== undefined) {
      if (edgeKind !== null && !present.includes(edgeKind)) {
        return {
          tier: 'locator-mismatch',
          conflict: `${fromId}→${toId} 这条边存在，但 kind 是 ${present.join('/')}，声明的是 ${edgeKind} —— 关系类型不同，拒绝按「大概是一回事」接受`,
        }
      }
      return { tier: tierFor(edgeKind === null ? false : true), hit: { nodes: [fromId, toId], position: 'edge' } }
    }
    const reversed = graph.kinds.has(`${toId}\u0000${fromId}`)
    return {
      tier: 'locator-mismatch',
      conflict: reversed
        ? `图中存在的是反向边 ${toId}→${fromId}，声明的是 ${fromId}→${toId} —— 方向相反，拒绝按方向猜测`
        : `图中 ${fromId} 与 ${toId} 都有记录，但 ${fromId}→${toId} 这条边不存在`,
    }
  }

  if (kind === 'chain-path') {
    if (fromId === '' || toId === null) return { tier: 'empty-excerpt', conflict: 'chain-path 声明缺少 fromId / toId' }
    if (!graph.isKnown(fromId) || !graph.isKnown(toId)) return null
    const claimed = Array.isArray(locator.route) ? locator.route.map(String) : null
    const { paths } = routes(graph, fromId, toId)
    if (claimed !== null) {
      const real = paths.find((path) => path.length === claimed.length && path.every((id, index) => id === claimed[index]))
      if (real === undefined) {
        return {
          tier: 'locator-mismatch',
          conflict: `声明的路径 ${claimed.join('→')} 在图上不存在。图上从 ${fromId} 到 ${toId} ${
            paths.length === 0 ? '没有任何路径' : `有 ${paths.length} 条路径：${paths.map((p) => p.join('→')).join(' | ')}`}`,
        }
      }
      return { tier: tierFor(true), hit: { nodes: real, route: real, position: 'chain-hop' } }
    }
    if (paths.length === 0) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 与 ${toId} 都有记录，但从 ${fromId} 到 ${toId} 没有任何路径 —— 这条链在这里断了`,
      }
    }
    if (paths.length > 1) {
      return {
        tier: 'relocation-ambiguous',
        conflict: `${fromId} 到 ${toId} 之间有 ${paths.length} 条不同的路径，声明没有唯一确定是哪一条`,
        ambiguousIn: paths.map((path) => `${graph.path}#chain:${path.join('→')}`),
      }
    }
    const [only] = paths
    return { tier: tierFor(false), hit: { nodes: only, route: only, position: 'chain-hop' } }
  }

  if (kind === 'dangling-ref') {
    if (fromId === '') return { tier: 'empty-excerpt', conflict: 'dangling-ref 声明缺少 fromId' }
    if (!graph.isKnown(fromId)) return null
    const targets = (graph.nodes_.get(fromId)?.out ?? []).filter((to) => !graph.hasRecord(to)).sort()
    if (toId !== null) {
      const edgeExists = graph.kinds.has(`${fromId}\u0000${toId}`)
      if (!graph.hasRecord(toId)) {
        if (edgeExists) {
          return { tier: tierFor(true), hit: { nodes: [fromId, toId], position: 'node', extra: { dangling: toId } } }
        }
        // A dangling LINK is "an edge whose target has no record". With no edge at
        // all there is nothing dangling — the two ids are simply unrelated.
        return {
          tier: 'locator-mismatch',
          conflict: `${fromId}→${toId} 这条边根本不存在 —— 断链说的是「有边、缺节点」，不是「无边」`,
        }
      }
      return {
        tier: 'locator-mismatch',
        conflict: `${toId} 在图里有节点记录，声明的「端点没有记录」不成立`,
      }
    }
    if (targets.length === 0) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 的每条出边的端点都有节点记录 —— 声明的「存在断链」被图证伪`,
      }
    }
    if (targets.length > 1) {
      return {
        tier: 'relocation-ambiguous',
        conflict: `${fromId} 有 ${targets.length} 个无记录的出边端点，声明没有唯一确定是哪一个`,
        ambiguousIn: targets.map((to) => `${graph.path}#dangling:${fromId}→${to}`),
      }
    }
    return { tier: tierFor(false), hit: { nodes: [fromId, targets[0]], position: 'node', extra: { dangling: targets[0] } } }
  }

  if (kind === 'uncovered-requirement') {
    if (fromId === '') return { tier: 'empty-excerpt', conflict: 'uncovered-requirement 声明缺少 fromId' }
    if (!graph.isKnown(fromId)) return null
    const type = graph.nodeType(fromId)
    if (type !== null && type !== REQUIREMENT_TYPE) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 的 type 是 ${type}，不是 ${REQUIREMENT_TYPE} —— 「需求未被实现」这句话对它不成立`,
      }
    }
    const implementations = graph.declared.filter((id) => graph.nodeType(id) === IMPLEMENTATION_TYPE)
    if (toId !== null) {
      if (!graph.isKnown(toId)) return null
      const { paths } = routes(graph, fromId, toId)
      if (paths.length > 0) {
        return {
          tier: 'locator-mismatch',
          conflict: `${fromId} 能走到 ${toId}（${paths[0].join('→')}）—— 声明的「到不了实现」被图证伪`,
        }
      }
      return { tier: tierFor(true), hit: { nodes: [fromId, toId], position: 'node' } }
    }
    if (implementations.length === 0) {
      // Nothing implements anything, so "THIS requirement is uncovered" cannot be
      // distinguished from "the whole graph has no implementation". Saying so is
      // more useful than a green tick, and it is not a pass.
      return {
        tier: 'no-match',
        conflict: `这张图里没有任何 type=${IMPLEMENTATION_TYPE} 的节点，「${fromId} 未被实现」与「整个图都没有实现」在这里无法区分 —— 先补实现节点，或改为声明具体的 toId`,
      }
    }
    const reached = implementations.filter((id) => routes(graph, fromId, id).paths.length > 0)
    if (reached.length > 0) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 能走到实现节点 ${reached.join('、')} —— 声明的「未被实现」被图证伪`,
      }
    }
    return { tier: tierFor(false), hit: { nodes: [fromId], position: 'node', extra: { implementations } } }
  }

  if (kind === 'orphan-node') {
    if (fromId === '') return { tier: 'empty-excerpt', conflict: 'orphan-node 声明缺少 fromId' }
    if (!graph.hasRecord(fromId)) return null
    const node = graph.nodes_.get(fromId)
    if (!isOrphan(node)) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 在图中有 ${node?.in.length ?? 0} 条入边、${node?.out.length ?? 0} 条出边 —— 它不是孤点，声明的「没有任何边」被图证伪`,
      }
    }
    return { tier: tierFor(true), hit: { nodes: [fromId], position: 'node' } }
  }

  if (kind === 'trace-node-side') {
    // The enumerator emits ONE candidate per SIDE of every node (`source.js`
    // `SIDES`), and its card asserts the node's existence in this trace together
    // with which side it renders. The side-specific facts — its in/out neighbours,
    // its ref — are the card's CONTENT, not a second claim, so the anchor confirms
    // the record and the side name and nothing more. An unrecognised side is
    // refused rather than defaulted to `upstream`: "we do not know which side you
    // mean" is not the same claim as "the upstream side".
    if (fromId === '') return { tier: 'empty-excerpt', conflict: 'trace-node-side 声明缺少 fromId' }
    const side = isNonEmpty(locator.side) ? String(locator.side) : null
    if (side === null || !SIDES.includes(side)) {
      return {
        tier: 'empty-excerpt',
        conflict: `trace-node-side 的 side 必须是 ${SIDES.join(' / ')}，收到 "${String(locator.side)}" —— 不认识的一侧就拒绝，不落到默认值`,
      }
    }
    if (!graph.hasRecord(fromId)) return null
    return { tier: tierFor(true), hit: { nodes: [fromId], position: 'node', extra: { side } } }
  }

  if (kind === 'cross-domain-ref' || kind === 'stale-ref') {
    if (fromId === '') return { tier: 'empty-excerpt', conflict: `${kind} 声明缺少 fromId` }
    if (!graph.hasRecord(fromId)) return null
    const pinned = isNonEmpty(locator.ref) ? String(locator.ref) : null
    const actual = graph.refOf(fromId)
    const ref = pinned ?? actual
    const upstream = upstreamSet([graph.document])

    if (ref === null) {
      return {
        tier: 'locator-mismatch',
        conflict: `${fromId} 没有绑定任何 ref —— 那是「缺绑定」（missing-ref），不是一条可以被确认或否定的跨域引用`,
      }
    }
    if (pinned !== null && actual !== null && pinned !== actual) {
      return {
        tier: 'locator-mismatch',
        conflict: `声明的 ref "${pinned}" 与图上记录的 "${actual}" 不是同一个 —— 逐字对不上就是未锚定`,
      }
    }
    const shape = refShape(ref)
    if (shape === null) {
      return {
        tier: 'locator-mismatch',
        conflict: `ref "${ref}" 的形状不属于任何本域可消费的上游锚点（REF_SHAPES 里没有匹配项）—— 无法消费即无法确认`,
      }
    }

    const tier = tierFor(pinned !== null)
    if (kind === 'cross-domain-ref') {
      if (!upstream.declared) {
        // Honest degradation: the FORM is consumable, and whether the upstream
        // domain still produces it is UNANSWERED. Reported, not assumed.
        return {
          tier,
          hit: {
            nodes: [fromId], position: 'node',
            extra: {
              scope: 'shape-only', ref, refDomain: shape.domain, refForm: shape.form,
              refBasis: shape.basis, refBasisDetail: shape.basisDetail ?? null,
              staleCheck: 'not-declared',
              note: '语料未声明 upstream[]：只确认了 ref 的形状可消费，未确认上游仍在产出它',
            },
          },
        }
      }
      if (!upstream.refs.has(ref)) {
        return {
          tier: 'locator-mismatch',
          conflict: `ref "${ref}" 不在 upstream[] 声明的产出集合里 —— 这是一条**失效链接**（stale），本域无法把它当成有效的跨域引用`,
        }
      }
      return {
        tier,
        hit: {
          nodes: [fromId], position: 'node',
          extra: {
            scope: 'declared-upstream', ref, refDomain: shape.domain, refForm: shape.form,
            refBasis: shape.basis, refBasisDetail: shape.basisDetail ?? null,
            staleCheck: 'declared-and-present',
          },
        },
      }
    }

    // stale-ref — the mirror claim. It can only be confirmed when the corpus
    // declares what upstream produces; otherwise the question is unanswerable and
    // `no-match` says so rather than passing the finding through.
    if (!upstream.declared) {
      return {
        tier: 'no-match',
        conflict: `语料没有声明 upstream[]，无法判断 "${ref}" 是否已经失效 —— 这个问题在这里不能回答，也不算通过`,
      }
    }
    if (upstream.refs.has(ref)) {
      return {
        tier: 'locator-mismatch',
        conflict: `ref "${ref}" 仍在 upstream[] 里 —— 它不是失效链接`,
      }
    }
    return {
      tier,
      hit: {
        nodes: [fromId], position: 'node',
        extra: {
          scope: 'declared-upstream', ref, refDomain: shape.domain, refForm: shape.form,
          refBasis: shape.basis, refBasisDetail: shape.basisDetail ?? null, stale: true,
        },
      },
    }
  }

  return { tier: 'kind-mismatch', conflict: `未定义的 locator.kind "${String(kind)}"，本域只认 ${ANCHOR_KINDS.join('/')}` }
}

/** Turn a confirmation into the shared verdict shape. */
function confirm(graph, claim, hit, tier, detail) {
  const extra = { scope: hit.extra?.scope ?? 'single-graph', ...(hit.extra ?? {}) }
  const end = hit.position === 'chain-hop' ? hit.nodes.length : 1
  return anchored({
    // The verdict's `path` is the CANDIDATE path of the item that was confirmed — the
    // same document-reference path `source.js` emits for it — not the document it
    // lives in. Two reasons, and the second is the load-bearing one:
    //
    //   1. The engine sets a finding's `path` from the RECOMPUTED location, so this is
    //      what a report prints and what a reader can line up against the plan.
    //   2. `coverage()` counts DISTINCT PATHS. Every claim of a trace graph lives in
    //      the same document, so a document-level path would collapse "9 of 28 items
    //      adjudicated" into "1 of 28" for every run — a coverage number that can
    //      never move, i.e. no coverage proof at all.
    path: itemPath(graph.path, claim),
    start: 1,
    end,
    position: hit.position,
    tier,
    claim: claim?.locator?.kind ?? null,
    detail,
    nodes: hit.nodes,
    extra: { ...extra, graphPath: graph.path, graph: { nodes: hit.nodes, ...(hit.route === undefined ? {} : { route: hit.route }) } },
  })
}

/**
 * The candidate path of the item a claim is about, in `source.js`'s own scheme.
 *
 * Exported so this domain's `test.mjs` can assert that an anchored verdict's `path`
 * is one of the paths P0 actually enumerated — i.e. that the coverage denominator and
 * the coverage numerator are counting the same things.
 */
export function itemPath(graphPath, claim) {
  const locator = claim?.locator ?? {}
  const fromId = String(locator.fromId ?? '')
  const toId = isNonEmpty(locator.toId) ? String(locator.toId) : null
  switch (locator.kind) {
    case 'trace-edge':
      return edgePath(graphPath, fromId, toId ?? '', isNonEmpty(locator.edgeKind) ? String(locator.edgeKind) : 'unspecified')
    case 'chain-path':
      return derivedPath(graphPath, `chain-${fromId}-${toId ?? ''}`)
    case 'dangling-ref':
    case 'uncovered-requirement':
      // The item that is missing is on the node's DOWNSTREAM side: it leads nowhere.
      return nodeSidePath(graphPath, fromId, 'downstream')
    case 'orphan-node':
      return nodeSidePath(graphPath, fromId, 'upstream')
    case 'trace-node-side':
      // The enumerator's own card path, byte for byte: `node-<id>-<side>`.
      return nodeSidePath(graphPath, fromId, isNonEmpty(locator.side) ? String(locator.side) : 'upstream')
    case 'cross-domain-ref':
    case 'stale-ref':
      // A binding points UPSTREAM at the domain that produced the anchor.
      return nodeSidePath(graphPath, fromId, 'upstream')
    default:
      return derivedPath(graphPath, `claim-${String(locator.kind ?? 'unknown')}-${fromId}`)
  }
}

/** Turn a refusal into the shared verdict shape. */
function refuse(kind, tier, detail, extra = {}) {
  // `unanchored()` takes `extra` as a NAMED parameter, not as a rest argument:
  // spreading `...extra` into the call makes every field land in the top-level object
  // literal, where `unanchored` never reads it — `scope` would be silently dropped and
  // the extension cause would become unobservable. So the fields are routed
  // explicitly: `ambiguousIn` is its own named parameter there, and everything else
  // has to arrive inside `extra`.
  const { ambiguousIn, ...rest } = extra
  return unanchored({ tier, detail, claim: kind, ambiguousIn, extra: rest })
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string, path?:string, locator?:object}} claim
 * @param {{path?:string, documents?:Array}} subject
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
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`（它指向追踪图文档）')
  }
  if (claim.locator === undefined || claim.locator === null || typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象 { fromId, toId? } —— 本域的锚点没有其它形态')
  }
  if (claim.kind !== KIND) {
    return refuse(claim.locator?.kind ?? null, 'kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }
  if (!ANCHOR_KINDS.includes(claim.locator.kind)) {
    return refuse(claim.locator.kind ?? null, 'kind-mismatch', `未知的 locator.kind "${String(claim.locator.kind)}"，只认 ${ANCHOR_KINDS.join('/')}`)
  }

  const documents = graphDocuments(subject)
  if (documents.length === 0) {
    return refuse(claim.locator.kind, 'no-documents', '没有提供任何追踪图文档 —— 锚点无法重算')
  }

  const claimKind = claim.locator.kind
  const wanted = slash(subject?.path !== undefined && subject.path !== '' ? subject.path : claim.path)
  const named = documentByPath(documents, wanted)

  /** The ids this claim is about — the ones whose identity must be unambiguous. */
  const touchedIds = () => {
    const from = String(claim.locator.fromId ?? '')
    const to = isNonEmpty(claim.locator.toId) ? String(claim.locator.toId) : ''
    const route = Array.isArray(claim.locator.route) ? claim.locator.route.map(String) : []
    return [from, to, ...route].filter((id) => id !== '')
  }

  if (named !== null) {
    const graph = analyse(named)
    // Identity first, relationship second: while two different nodes are both called
    // R1, "R1→I1 exists" is neither true nor false.
    const touchedDupes = touchedIds().filter((id) => graph.duplicated.includes(id))
    if (touchedDupes.length > 0) {
      return refuse(claimKind, 'relocation-ambiguous',
        `ID 冲突：${touchedDupes.join('、')} 在 ${named.path} 内被声明了不止一次 —— 同一 ID 指向两个对象时，任何关于它的关系都无法确认，拒绝猜测`,
        { ambiguousIn: touchedDupes.map((id) => `${named.path}#${id}`), scope: ID_AMBIGUOUS })
    }
    const outcome = against(graph, claim)
    if (outcome === null) {
      const present = graph.declared.length === 0
        ? `${named.path} 没有声明任何节点 ID`
        : `${named.path} 声明的 ID 里没有这条声明涉及的全部节点`
      return refuse(claimKind, 'no-match', `${present} —— 声明指向的图不包含它，也不与它矛盾`)
    }
    if (outcome.hit !== undefined) {
      return confirm(graph, claim, outcome.hit, outcome.tier, `在 ${named.path} 确认（${claimKind}）`)
    }
    return refuse(claimKind, outcome.tier, outcome.conflict, {
      ...(outcome.ambiguousIn === undefined ? {} : { ambiguousIn: outcome.ambiguousIn }),
      scope: outcome.ambiguousIn === undefined ? 'single-graph' : 'multi-route',
    })
  }

  // The named graph is absent from the corpus. Relocation is allowed, but only onto a
  // claim that holds in EXACTLY ONE other graph.
  //
  // Note the deliberate asymmetry with the named branch: a cross-document id
  // COLLISION is not by itself a refusal here. Two chains legitimately share a node
  // id, and refusing on that alone would make a perfectly anchored finding unmovable
  // for a reason that has nothing to do with it. What disqualifies a relocation is
  // that the claim HOLDS IN MORE THAN ONE graph.
  const scopes = documents.map((document) => ({ path: document.path, nodes: declaredIds(document) }))
  const collisions = touchedIds()
    .map((id) => ({ id, declarations: [...new Set(declarationsOf(scopes, id).map((scope) => scope.path))] }))
    .filter((entry) => entry.declarations.length > 1)

  const ledger = relocate()
  const contradictions = []
  const holders = []
  for (const document of documents) {
    const graph = analyse(document)
    const outcome = against(graph, claim)
    if (outcome !== null && outcome.hit !== undefined) {
      holders.push(`${document.path}#${claimKind}`)
      ledger.record(claim, `${document.path}#${claimKind}`, { graph, hit: outcome.hit, tier: outcome.tier })
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
    return confirm(verdict.hit.graph, claim, verdict.hit.hit, 'relocated-unique',
      `声明的 "${wanted}" 不在语料中；该声明在 "${verdict.hit.graph.path}" 唯一成立，发现已搬迁。${collisionNote}`)
  }
  if (verdict.kind === 'ambiguous') {
    return refuse(claimKind, 'relocation-ambiguous',
      `声明的 "${wanted}" 不在语料中，且该声明在 ${verdict.ambiguousIn.length} 张图中同样成立 —— 搬迁不唯一，拒绝猜测。${collisionNote}`,
      { ambiguousIn: verdict.ambiguousIn })
  }
  if (contradictions.length > 0) {
    const [first] = contradictions
    return refuse(claimKind, 'locator-mismatch',
      `声明的 "${wanted}" 不在语料中，而 "${first.path}" 明确与声明矛盾：${first.conflict}`)
  }
  return refuse(claimKind, 'no-match', `声明的 "${wanted}" 不在语料中，也没有任何一张追踪图含这条声明`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '节点 ID 对 + 追踪边：引擎在追踪图上重算边的存在性与方向、链路的唯一性、断链与跨域 ref 的可消费性；方向相反、链断、读法不唯一、ref 无法消费一律判未锚定。跨域归因带 `basis`：`exact` = 形状唯一指向该域，`form` = 形状只指向一个家族（diff 扩展名路径、通配 `*.json`），此时 refDomain 只是家族代表，成员与「是否仍产出」只有 upstream[] 能回答。',
  verify,
})

/** Re-exported for this domain's own tests and evidence tools. */
export { analyse as analyseGraph, routes as graphRoutes }
