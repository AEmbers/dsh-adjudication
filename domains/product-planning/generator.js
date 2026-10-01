/**
 * product-planning — the constrained planner (the B family's FIRST stage).
 *
 * WHAT IT DID BEFORE IT SAID ANYTHING
 * -----------------------------------
 * A plan item is a claim of the form "this requirement is served by this plan,
 * for this metric". This module takes DRAFT items and makes each one carry the
 * domain anchor verifier's verdict before it is allowed to exist: the
 * requirement id must be in the registry, the quoted requirement text must match
 * that entry word for word, and a named metric must be declared by the plan.
 *
 * WHY THE METRIC IS DECLARED, NOT READ FROM PROSE
 * -----------------------------------------------
 * The registry hands this module a metric vocabulary per plan. A plan item whose
 * metric nobody declared is the exact failure the domain exists to catch — "提升
 * 转化率" with no baseline — so it is refused at the extractor, not at review
 * time, and it lands in `unsourced` with the reason.
 *
 * UNSUPPORTED DRAFTS ARE LISTED, NOT DROPPED
 * ------------------------------------------
 * Same rule as every B domain: scope creep is a finding. An item with no
 * requirement behind it goes to `unsourced` (kind `scope-creep`), where a human
 * can decide whether it is a missing requirement or a stray feature.
 */

import { ERROR_CODES, contractError } from '../../lib/contracts.js'
import { verify } from './anchor.js'

export const GENERATOR_KIND = 'plan-item-drafting'
export const ANCHOR_KIND = 'requirement-and-metric'

const slug = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/gu, '-').replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')

/**
 * Build the material the anchor verifier checks against:
 *   requirements/<id>  content = title (+ text lines), metrics = []
 *   plans/<id>         content = title,               metrics = [declared metric names]
 */
export function registryDocuments(input) {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.requirements) || !Array.isArray(input.plans)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'requirement-registry-and-plan 输入必须是对象 { requirements, plans }')
  }
  const documents = []
  for (const requirement of input.requirements) {
    if (requirement === null || typeof requirement !== 'object') continue
    const id = slug(requirement.id)
    if (id === '') continue
    const lines = [String(requirement.title ?? '')]
    if (typeof requirement.text === 'string' && requirement.text.trim() !== '') lines.push(...requirement.text.split(/\r?\n/u))
    documents.push({ path: `requirements/${id}`, content: lines.filter((line) => line.trim() !== '').join('\n'), metrics: [] })
  }
  for (const plan of input.plans) {
    if (plan === null || typeof plan !== 'object') continue
    const id = slug(plan.id)
    if (id === '') continue
    const metrics = plan.metric?.name === undefined || plan.metric?.name === null ? [] : [String(plan.metric.name)]
    documents.push({ path: `plans/${id}`, content: String(plan.title ?? ''), metrics })
  }
  return documents
}

/**
 * Turn draft plan items into anchored ones.
 *
 * @param {{requirements: object[], plans: object[]}} input
 * @param {{drafts?: object[]}} [context] `drafts[i] = { id, statement, requirementId, quote, planId?, metricName? }`
 * @returns {{kind:string, items:object[], unsourced:object[], notes:string[], bounded:boolean}}
 */
export function generate(input, context = {}) {
  const drafts = Array.isArray(context.drafts) ? context.drafts : []
  const documents = registryDocuments(input)
  const known = new Set(documents.filter((document) => document.path.startsWith('requirements/')).map((document) => document.path))
  const items = []
  const unsourced = []
  const notes = []

  if (drafts.length === 0) notes.push('没有提供 drafts 草案：编排器不凭空生成方案项，items 为空。')

  for (const [index, draft] of drafts.entries()) {
    const id = String(draft?.id ?? `draft-${index + 1}`)
    const statement = String(draft?.statement ?? '')
    const requirementId = slug(draft?.requirementId ?? '')
    const planId = slug(draft?.planId ?? '')

    if (requirementId === '') {
      unsourced.push({
        id, statement, kind: 'scope-creep',
        reason: 'no-requirement',
        detail: '草案没有挂任何需求 —— 这是范围蔓延，单独列出，不丢弃也不伪装成有来源',
      })
      continue
    }
    if (!known.has(`requirements/${requirementId}`)) {
      unsourced.push({
        id, statement, kind: 'broken-trace', reason: 'unknown-requirement',
        detail: `需求 "${requirementId}" 不在需求库里 —— 断链不作为追溯依据`,
        attemptedRequirementId: requirementId,
      })
      continue
    }

    const claim = {
      kind: ANCHOR_KIND,
      path: `requirements/${requirementId}`,
      locator: { requirementId, metricName: draft?.metricName ?? undefined, planId: planId === '' ? undefined : `plans/${planId}` },
      excerpt: String(draft?.quote ?? ''),
    }

    let verdict
    try {
      verdict = verify(claim, { documents })
    } catch (error) {
      unsourced.push({ id, statement, kind: 'anchor-contract', reason: 'anchor-contract', detail: error?.message ?? String(error), claim })
      continue
    }

    if (verdict.status === 'anchored') {
      items.push({
        id, statement, claim, anchor: verdict,
        sourceAnchor: `${verdict.path}:${verdict.start}`,
        planId: planId === '' ? null : planId,
        requirementId,
        metricName: draft?.metricName ?? null,
      })
    } else {
      unsourced.push({ id, statement, kind: 'unverifiable', reason: verdict.tier, detail: verdict.detail, ambiguousIn: verdict.ambiguousIn, claim })
    }
  }

  if (unsourced.length > 0) {
    notes.push(`${unsourced.length} 条草案挂不上需求/指标，已单独列为「无来源」—— 未丢弃，需人工确认是缺需求还是范围蔓延。`)
  }

  return { kind: GENERATOR_KIND, anchorKind: ANCHOR_KIND, items, unsourced, notes, bounded: true }
}

export default { kind: GENERATOR_KIND, anchorKind: ANCHOR_KIND, generate, registryDocuments }
