/**
 * project-management — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `task-graph`
 * ------------------------------------
 *   {
 *     planPath?: string,                    // default 'project/plan.json'
 *     tasks: [{
 *       id,                                 // required, unique across the corpus
 *       title, owner, estimateDays,
 *       dependsOn?: string[],               // 前置任务 ID —— 依赖边的 from 端
 *       status?: 'todo'|'doing'|'done'|'blocked'|'archived',
 *       team?, workstream?, body?, attachmentOnly?, archived?, removed?,
 *     }],
 *     idSpace?: string[],                   // 允许被依赖、但不在 tasks[] 里的 ID
 *                                           // （外部交付物 / 其它域的节点）
 *     milestones?: [{ id, due, tasks: string[] }],
 *     risks?:      [{ id, trigger, impact, mitigation, owners?: string[] }],
 *     owners?:     [{ id, name, teams?: string[] }],
 *     teams?:      [{ id, name, workspaces?: string[] }],
 *     documents?:  [{ path, type, payload, meta }],   // 多文档语料（见下）
 *   }
 *
 * WHAT A CANDIDATE IS, AND WHY IT IS NOT A FILE
 * ---------------------------------------------
 * `lib/contracts.js` §5 declares this domain's candidates as "one per dependency
 * edge, plus one per task (node position in the graph)". A dependency edge is not
 * a file, so the candidate's `path` is a DOCUMENT-REFERENCE path with the real
 * document's stem, a semantic token, and a real extension:
 *
 *   project/cart-checkout/plan-t1-t2.json     the edge T1 → T2
 *   project/cart-checkout/plan-task-t1.json   the node T1
 *   project/risks.json  ->  project/risks-risk-r1.json
 *
 * The raw ids — `T1`, `T1->T2`, `2024-Q3` — appear in `locator` and in `text`,
 * NEVER in `path`. Three engine facts force that:
 *
 *   • `validateCandidateSetResult` requires `path` to match
 *     `^[a-z0-9][a-z0-9._:\/-]*$`, so `>` and uppercase are simply rejected;
 *   • `gate()` reports exclusions as `{ path, predicate }` only, so two candidates
 *     sharing a path would be indistinguishable in `plan.gate.excluded` and the
 *     `all-gated-out` boundary could not assert which item was removed;
 *   • the extension predicate takes `path.slice(path.lastIndexOf('.'))`, so a
 *     fragment containing a dot (`...json#dep-T1->T2`) reads as the extension
 *     `T2` and the candidate is dropped as "unsupported file type".
 *
 * A slug is lossy, so nothing parses an id back out of a path: the verifier
 * compares the LOCATOR. `_lib/graph.js` `derivedPath` is the one implementation of
 * this scheme.
 *
 * The cost, stated rather than discovered later: `coverage()` counts DISTINCT
 * PATHS, so for this domain the coverage denominator is the admitted CANDIDATE
 * count (one per edge/node), not the number of plan documents. That is the right
 * denominator here — the reviewer's unit of judgement is one edge or one node, and
 * "5 of 9 edges adjudicated" is the honest progress claim.
 *
 * WHY EVERY TASK EMITS BOTH A NODE CANDIDATE AND ITS EDGES
 * --------------------------------------------------------
 * A node candidate is what makes "orphan task" and "ownerless task" expressible.
 * Without it, a task with no dependencies and no dependents is INVISIBLE to the
 * pipeline: it appears in no edge, so no candidate mentions it, so no finding can
 * be anchored to it. Emitting the node is what lets the orphan be reported
 * instead of silently omitted — and a graph domain that cannot report an isolated
 * node is a graph domain that cannot report an orphan.
 *
 * WHY `idSpace` EXISTS
 * --------------------
 * "T1 depends on EXTERNAL-RELEASE" is a legitimate, reviewable statement when the
 * external id is declared. It is a DANGEROUS one when it is not: an undeclared
 * dependency is either a typo or a silently dropped prerequisite, and the two are
 * indistinguishable from the plan alone. So this source does NOT filter unknown
 * ids out — it emits the edge and marks it `unknown-target`, which is the finding
 * the reviewer must adjudicate. Dropping it here would hide exactly the class of
 * defect the domain exists to catch.
 *
 * HONESTY: this module only *enumerates*. It does not decide what is reviewable —
 * the P1 gate does, and the two boundary fixtures (`empty`, `all-gated-out`) exist
 * to prove that. The source's own `excluded` list is a separate, reported thing:
 * it says "this input declared something I refuse to turn into a candidate", with
 * a reason, and those reasons are distinct from gate reasons.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'
import { byteLength, clipLines, derivedPath, documentsOf, looksLikeGraph, slash } from '../_lib/graph.js'

/** Edge kinds emitted for `dependsOn`. A blocker is the same edge, different tense. */
export const EDGE_KIND = 'depends-on'

/** Candidate kinds. `candidateSet.kind` in `index.js` is the same vocabulary. */
export const CANDIDATE_KINDS = Object.freeze({
  task: 'task-node',
  edge: 'dependency-edge',
  risk: 'risk-entry',
  milestone: 'milestone-entry',
})

/** Statuses whose dependency edges are deliberate non-facts, not defects. */
const ARCHIVED = new Set(['archived', 'removed', 'cancelled'])

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The semantic token, and therefore the candidate path, for an edge.
 *
 * The `->` of a raw id becomes `-` here — see `derivedPath` in `_lib/graph.js` for
 * why a candidate path may not contain `>` at all. The raw pair is what the
 * candidate's `locator` carries, and that is the value the verifier compares.
 */
export function edgePath(documentPath, from, to, kind = EDGE_KIND) {
  const token = kind === EDGE_KIND ? `${from}-${to}` : `${kind}-${from}-${to}`
  return derivedPath(documentPath, token)
}

/** The candidate path for a task node. */
export function taskPath(documentPath, taskId) {
  return derivedPath(documentPath, `task-${taskId}`)
}

/** The candidate path for a risk entry. */
export function riskPath(documentPath, riskId) {
  return derivedPath(documentPath, `risk-${riskId}`)
}

/** The candidate path for a milestone entry. */
export function milestonePath(documentPath, milestoneId) {
  return derivedPath(documentPath, `milestone-${milestoneId}`)
}

const ownerOf = (task) => (isNonEmpty(task.owner) ? task.owner : null)

/**
 * The task's declared workstream, or null when it declares none.
 *
 * Returning null rather than substituting a placeholder keeps the fallback chain
 * in ONE place — `workstreamKey` in `index.js` — so there is no second guess about
 * what a candidate with no workstream groups under.
 */
export function workstreamOf(task) {
  if (isNonEmpty(task?.workstream)) return task.workstream
  if (isNonEmpty(task?.team)) return task.team
  return null
}

// ---------------------------------------------------------------------------
// The corpus: one plan document, or a caller-supplied set
// ---------------------------------------------------------------------------

/**
 * Turn the input into the list of graph documents.
 *
 * `input.documents[]` exists because a real plan is several documents (a plan, a
 * risk register, a milestone list) and the gate's exclusion predicates are
 * DOCUMENT-level. Without it, "this whole risk register was deleted upstream"
 * cannot be expressed as a P1 exclusion and the fixture boundary the contract
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
        problems.push(`${document.path}: 文档 payload 既没有 tasks 也没有 idSpace/milestones/risks/owners，无法当作任务图读取`)
        continue
      }
      documents.push(document)
    }
    if (documents.length === 0) problems.push('documents[] 里没有可读的任务图文档')
    return { documents, problems }
  }

  const planPath = isNonEmpty(input?.planPath) ? slash(input.planPath) : 'project/plan.json'
  const single = {
    path: planPath,
    type: 'task-graph',
    payload: {
      tasks: Array.isArray(input?.tasks) ? input.tasks : [],
      idSpace: Array.isArray(input?.idSpace) ? input.idSpace : [],
      milestones: Array.isArray(input?.milestones) ? input.milestones : [],
      risks: Array.isArray(input?.risks) ? input.risks : [],
      owners: Array.isArray(input?.owners) ? input.owners : [],
      teams: Array.isArray(input?.teams) ? input.teams : [],
    },
    meta: input?.meta !== null && typeof input?.meta === 'object' ? input.meta : {},
  }
  documents.push(single)
  return { documents, problems }
}

/** `[{ id, ... }]` -> `Map<id, item>`, first declaration wins. */
export function byId(list) {
  const out = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object' || !isNonEmpty(item.id)) continue
    if (!out.has(item.id)) out.set(item.id, item)
  }
  return out
}

/** Ids declared by a document, in declaration order. */
export function declaredIds(document) {
  const payload = document?.payload ?? {}
  return [
    ...(Array.isArray(payload.tasks) ? payload.tasks.map((task) => task?.id) : []),
    ...(Array.isArray(payload.idSpace) ? payload.idSpace : []),
  ].filter(isNonEmpty)
}

/**
 * Every `(from, to)` dependency pair in one document, in declaration order.
 *
 * Exported because `anchor.js` and `evidence.js` must build the SAME adjacency the
 * source used. A verifier that re-derived edges differently from the enumerator
 * would confirm claims about a graph the source never saw, and the disagreement
 * would only ever show up as an inexplicable unanchored verdict.
 */
export function taskEdgePairs(document) {
  const pairs = []
  for (const task of Array.isArray(document?.payload?.tasks) ? document.payload.tasks : []) {
    if (task === null || typeof task !== 'object' || !isNonEmpty(task.id)) continue
    for (const dependency of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
      if (isNonEmpty(dependency)) pairs.push([task.id, String(dependency), EDGE_KIND])
    }
    for (const edge of Array.isArray(task.blockedBy) ? task.blockedBy : []) {
      if (isNonEmpty(edge)) pairs.push([task.id, String(edge), 'blocked-by'])
    }
  }
  return pairs.map(([from, to, kind]) => [from, to, kind])
}

/** Does this document declare `id`, as a task or as an id-space member? */
export function declares(document, id) {
  return declaredIds(document).includes(String(id ?? ''))
}

// ---------------------------------------------------------------------------
// enumerate()
// ---------------------------------------------------------------------------

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
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'task-graph 输入必须是对象 { tasks: [...], ... }')
  }
  if (input.tasks !== undefined && !Array.isArray(input.tasks)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`tasks` 必须是数组（可省略，改用 documents[]）')
  }
  if (input.documents !== undefined && !Array.isArray(input.documents)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`documents` 必须是数组（可省略）')
  }
  if (input.milestones !== undefined && !Array.isArray(input.milestones)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`milestones` 必须是数组（可省略）')
  }
  if (input.risks !== undefined && !Array.isArray(input.risks)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`risks` 必须是数组（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 200

  const { documents, problems } = corpus(input)
  const candidates = []
  const excluded = []
  const notes = [...problems]
  let truncated = false

  /**
   * A candidate is emitted once per semantic entity PER DOCUMENT.
   *
   * The dedupe is deliberately scoped inside one document, not across the corpus,
   * and that boundary is the whole point of this comment:
   *
   *   • INSIDE a document, the same task declared twice is noise — one record, one
   *     candidate. Emitting it twice would make the verifier's identity check see a
   *     false collision and refuse every claim about that task.
   *
   *   • ACROSS documents, the same ID declared by two plans is a DEFECT, not noise.
   *     It is the `duplicate-task-id` rule's exact subject, and it is unreviewable if
   *     the enumerator collapses it: the reviewer would receive one candidate for T4
   *     and have no way to see that a second plan also claims T4. So both documents
   *     emit their own candidate, and the collisions are ALSO reported as notes so
   *     the reviewer is told to look rather than left to notice.
   *
   * The discriminator `k` is split by FIELD FAMILY, not by kind: an edge and a node
   * hold their identity in different bundles of keys (`from/to/edgeKind` versus
   * `taskId`), so `e` fires for edges and `n` for every node-shaped candidate. A
   * single "kind" field would ALSO work, but only by accident — a future locator
   * kind that reuses `taskId` on an edge would silently collide.
   */
  const semanticKey = (candidate) => JSON.stringify({
    k: candidate.locator.from !== undefined || candidate.locator.to !== undefined ? `e:${candidate.locator.edgeKind ?? ''}` : 'n',
    t: candidate.locator.taskId ?? null,
    f: candidate.locator.from ?? null,
    o: candidate.locator.to ?? null,
    r: candidate.locator.riskId ?? null,
    m: candidate.locator.milestoneId ?? null,
  })

  /** Ids already emitted for the document currently being walked. */
  let seenInDocument = new Map()
  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    const key = semanticKey(candidate)
    const existing = seenInDocument.get(key)
    if (existing !== undefined) {
      notes.push(`${candidate.path} 与 ${existing} 是同一文档内的同一个图元素，已跳过（同一 ID 出现在不同文档时不合并 —— 那是重复 ID 缺陷本身）`)
      return false
    }
    seenInDocument.set(key, candidate.path)
    candidates.push(candidate)
    return true
  }

  for (const document of documents) {
    // The dedupe scope is one document. See the comment on `semanticKey`: two
    // documents declaring the same id is the defect, not a duplicate.
    seenInDocument = new Map()
    const payload = document.payload
    const path = document.path
    const meta = document.meta ?? {}
    const deleted = meta.deleted === true
    const binary = meta.binary === true
    const docBytes = Number(meta.bytes) > 0 ? Number(meta.bytes) : null

    const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
    const tasksById = byId(tasks)
    const idSpace = Array.isArray(payload.idSpace) ? payload.idSpace : []
    const milestones = Array.isArray(payload.milestones) ? payload.milestones : []
    const risks = Array.isArray(payload.risks) ? payload.risks : []
    const known = new Set([...tasks.map((task) => task?.id), ...idSpace].filter(isNonEmpty))

    const carried = { bytes: docBytes ?? undefined, binary: binary || undefined, deleted: deleted || undefined }

    // --- dependency edges -------------------------------------------------
    for (const [from, to, kind] of taskEdgePairs(document)) {
      const task = tasksById.get(from)
      const status = isNonEmpty(task?.status) ? task.status : 'unspecified'
      const candidateId = edgePath(path, from, to, kind)
      // A whole document that is gone upstream takes its edges with it; that is
      // a `deleted` exclusion, not a finding about the edge.
      if (deleted) {
        excluded.push({ id: candidateId, reason: `依赖边 ${from}→${to} 所在文档 ${path} 已标记 deleted` })
        continue
      }
      const unknown = !known.has(to)
      const text = [
        `${kind} ${from} → ${to}`,
        `下游任务：${from}（${task?.title ?? '(无标题)'}，状态 ${status}，负责人 ${ownerOf(task) ?? '(未指派)'}）`,
        `上游任务：${to}${unknown ? ' —— **不在本图声明的 ID 空间内**' : ''}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'dependency-edge', graphPath: path, from, to, edgeKind: kind },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.edge,
          from, to,
          edgeKind: kind,
          workstream: workstreamOf(task),
          status,
          owner: ownerOf(task),
          unknownTarget: unknown,
          graphPath: path,
          archived: ARCHIVED.has(String(status)),
        },
      })
    }

    // --- task nodes -------------------------------------------------------
    for (const [taskIndex, task] of tasks.entries()) {
      if (task === null || typeof task !== 'object' || !isNonEmpty(task.id)) {
        excluded.push({ id: `${derivedPath(path, `task-${taskIndex + 1}`)}`, reason: '任务缺少非空字符串 id —— 无法在图上定位' })
        continue
      }
      const candidateId = taskPath(path, task.id)
      if (task.archived === true || ARCHIVED.has(String(task.status))) {
        excluded.push({ id: candidateId, reason: `任务 ${task.id} 状态为 ${task.status ?? 'archived'}，不在本次评审范围` })
        continue
      }
      const dependsOn = (Array.isArray(task.dependsOn) ? task.dependsOn : []).filter(isNonEmpty)
      const text = [
        `task ${task.id}（${task.title ?? '(无标题)'}）`,
        `负责人：${ownerOf(task) ?? '(未指派 —— 责任空缺)'}`,
        `估算：${Number.isFinite(Number(task.estimateDays)) ? `${Number(task.estimateDays)} 天` : '(未估算)'}`,
        `前置：${dependsOn.length === 0 ? '(无)' : dependsOn.join(', ')}`,
        isNonEmpty(task.body) ? `说明：${task.body}` : '',
      ].filter((line) => line !== '').join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      const attachmentOnly = task.attachmentOnly === true
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'task-node', graphPath: path, taskId: task.id },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        // An attachment-only task has no in-document body to judge. It is still a
        // candidate — the gate's `binary` predicate removes it — because moving
        // that decision into the source would make "excluded by P1" and "excluded
        // by P0" indistinguishable in the plan.
        binary: binary || attachmentOnly || undefined,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.task,
          taskId: task.id,
          workstream: workstreamOf(task),
          status: isNonEmpty(task.status) ? task.status : 'unspecified',
          owner: ownerOf(task),
          estimateDays: Number.isFinite(Number(task.estimateDays)) ? Number(task.estimateDays) : null,
          dependsOn,
          attachmentOnly,
          graphPath: path,
        },
      })
    }

    // --- risk entries -----------------------------------------------------
    for (const [riskIndex, risk] of risks.entries()) {
      if (risk === null || typeof risk !== 'object' || !isNonEmpty(risk.id)) {
        excluded.push({ id: derivedPath(path, `risk-${riskIndex + 1}`), reason: '风险条目缺少非空字符串 id' })
        continue
      }
      const candidateId = riskPath(path, risk.id)
      if (risk.archived === true) {
        excluded.push({ id: candidateId, reason: `风险 ${risk.id} 已归档，不在本次评审范围` })
        continue
      }
      const text = [
        `risk ${risk.id}`,
        `触发条件：${risk.trigger ?? '(未给出)'}`,
        `影响面：${risk.impact ?? '(未给出)'}`,
        `应对措施：${risk.mitigation ?? '(未给出 —— 「待观察」不是应对措施)'}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'risk-entry', graphPath: path, riskId: risk.id, owners: risk.owners ?? [] },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.risk,
          riskId: risk.id,
          workstream: workstreamOf(risk),
          hasMitigation: isNonEmpty(risk.mitigation),
          graphPath: path,
        },
      })
    }

    // --- milestones -------------------------------------------------------
    for (const [milestoneIndex, milestone] of milestones.entries()) {
      if (milestone === null || typeof milestone !== 'object' || !isNonEmpty(milestone.id)) {
        excluded.push({ id: derivedPath(path, `milestone-${milestoneIndex + 1}`), reason: '里程碑缺少非空字符串 id' })
        continue
      }
      const candidateId = milestonePath(path, milestone.id)
      const members = Array.isArray(milestone.tasks) ? milestone.tasks.filter(isNonEmpty) : []
      const text = [
        `milestone ${milestone.id}（${milestone.title ?? '(无标题)'}）`,
        `截止：${milestone.due ?? '(未给出)'}`,
        `包含任务：${members.length === 0 ? '(空 —— 里程碑没有承接任何任务)' : members.join(', ')}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'milestone-entry', graphPath: path, milestoneId: milestone.id, tasks: members },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.milestone,
          milestoneId: milestone.id,
          workstream: workstreamOf(milestone),
          emptyMilestone: members.length === 0,
          dueMissing: !isNonEmpty(milestone.due),
          graphPath: path,
        },
      })
    }
  }

  // Cross-document id collisions are REPORTED here, not deduped away.
  //
  // Both copies are already in `candidates` (see the dedupe comment), and the
  // verifier will refuse any claim that touches the shared id — which is correct.
  // But a reviewer that only sees two candidates with similar names has to notice
  // the collision for itself, and "the model must notice" is not a mechanism. So
  // the collision is stated: which id, and which documents claim it.
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
      notes.push(`⚠️ 任务 ID "${id}" 被 ${owners.length} 个文档同时声明（${owners.join('、')}）—— 关于它的任何边都无法唯一锚定，请先消除重复 ID`)
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'task-graph-edges',
  inputFormat: 'task-graph',
  bounded: true,
  describe: '任务图 -> 每条依赖边一个候选，每个任务/风险/里程碑一个节点候选；未知 ID 不静默丢弃，标记为 unknownTarget 交由评审判定。',
  enumerate,
})
