/**
 * product-planning — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `requirement-registry-and-plan`
 * -------------------------------------------------------
 *   {
 *     requirements: [{
 *       id, title,                        // 需求库条目；title 是会被逐字引用的原文
 *       status,                           // 'confirmed' 之外一律视为未确认
 *       sourceQuoteId?,                   // 该需求回溯到的原话（requirements-research 的锚点）
 *       text?,                            // 可选正文，作为额外可引用行
 *     }],
 *     plans: [{
 *       id, title,
 *       serves: string[],                 // 该方案承接的需求 id
 *       metric: { name, baseline, target, window } | null,
 *       deps: string[], risks: string[],
 *       attachments?: [{ name, bytes? }], // 附件型条目：不可作为文本审定
 *     }],
 *   }
 *
 * THE CANDIDATE IS AN EDGE, NOT A NODE
 * ------------------------------------
 * One candidate per (plan, requirement) link, plus one per ORPHAN on either
 * side. An orphan is not "no data" — it is the finding: a requirement nobody
 * serves, or a plan serving nobody. Both are enumerated rather than left to be
 * noticed later.
 *
 * `path` FORMAT — and why the requirement id is in the plan's path
 * ---------------------------------------------------------------
 *   plans/<planId>/serves/<requirementId>   the edge
 *   requirements/<requirementId>/orphan     unserved requirement
 *   plans/<planId>/orphan                   unserved plan
 * The gate globs these, so `deleted` (unconfirmed requirement) and `binary`
 * (attachment-only material) are decided by the P1 predicates, using facts this
 * source states and does not act on.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const UNSAFE = /[^a-z0-9._-]+/gu
const slug = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/gu, '-').replace(UNSAFE, '-').replace(/^-+|-+$/gu, '')
const byteLength = (value) => new TextEncoder().encode(String(value)).length
const CONFIRMED = 'confirmed'

/**
 * @param {{requirements?: object[], plans?: object[]}} input
 * @param {{maxCandidates?: number, maxExcerptLines?: number}} [context]
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'requirement-registry-and-plan 输入必须是对象 { requirements, plans }')
  }
  if (!Array.isArray(input.requirements)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `requirements`（需求库）')
  }
  if (!Array.isArray(input.plans)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `plans`（方案草案）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

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

  /** Requirement material: the title is the quotable line; `text` adds lines. */
  const material = (requirement) => {
    const lines = [String(requirement.title ?? '')]
    if (typeof requirement.text === 'string' && requirement.text.trim() !== '') lines.push(...requirement.text.split(/\r?\n/u))
    return lines.filter((line) => line.trim() !== '')
  }

  const clip = (lines, label) => {
    if (lines.length <= maxExcerptLines) return lines.join('\n')
    truncated = true
    notes.push(`${label} 超过 maxExcerptLines ${maxExcerptLines}，已截断`)
    return lines.slice(0, maxExcerptLines).join('\n')
  }

  // Index both sides, rejecting entries that cannot be an identity.
  const requirements = new Map()
  for (const [index, requirement] of (input.requirements ?? []).entries()) {
    if (requirement === null || typeof requirement !== 'object') {
      excluded.push({ id: `requirement#${index + 1}`, reason: 'requirement 不是对象' })
      continue
    }
    const id = slug(requirement.id)
    if (id === '') { excluded.push({ id: `requirement#${index + 1}`, reason: 'requirement 缺少可用的 id' }); continue }
    if (requirements.has(id)) { excluded.push({ id: `requirements/${id}`, reason: 'requirement id 重复' }); continue }
    requirements.set(id, { ...requirement, id })
  }

  const plans = new Map()
  for (const [index, plan] of (input.plans ?? []).entries()) {
    if (plan === null || typeof plan !== 'object') {
      excluded.push({ id: `plan#${index + 1}`, reason: 'plan 不是对象' })
      continue
    }
    const id = slug(plan.id)
    if (id === '') { excluded.push({ id: `plan#${index + 1}`, reason: 'plan 缺少可用的 id' }); continue }
    if (plans.has(id)) { excluded.push({ id: `plans/${id}`, reason: 'plan id 重复' }); continue }
    plans.set(id, { ...plan, id })
  }

  const served = new Set()

  for (const plan of plans.values()) {
    const serves = Array.isArray(plan.serves) ? plan.serves.map(slug).filter((id) => id !== '') : []
    const attachments = Array.isArray(plan.attachments) ? plan.attachments : []

    for (const requirementId of serves) {
      const requirement = requirements.get(requirementId)
      if (requirement === undefined) {
        // A link to a requirement the registry does not contain is a broken
        // trace, and it is reported as one — this is what the domain's
        // `fact-checker` reviewer deletes plan items for.
        excluded.push({
          id: `plans/${plan.id}/serves/${requirementId}`,
          reason: `方案 "${plan.id}" 承接了需求库中不存在的需求 "${requirementId}"`,
        })
        continue
      }
      served.add(requirementId)
      const lines = [`方案：${plan.title ?? ''}`, ...material(requirement)]
      const text = clip(lines, `plans/${plan.id}/serves/${requirementId}`)
      push({
        id: `${plan.id}->${requirementId}`,
        path: `plans/${plan.id}/serves/${requirementId}`,
        locator: { planId: plan.id, requirementId },
        text,
        bytes: byteLength(text),
        deleted: requirement.status !== CONFIRMED,
        meta: {
          kind: 'requirement-plan-link',
          planId: plan.id,
          requirementId,
          requirementStatus: requirement.status ?? '(未声明)',
          sourceQuoteId: requirement.sourceQuoteId ?? null,
          metricName: plan.metric?.name ?? null,
          metricHasBaseline: Number.isFinite(Number(plan.metric?.baseline)),
          metricHasWindow: typeof plan.metric?.window === 'string' && plan.metric.window !== '',
          deps: Array.isArray(plan.deps) ? plan.deps.length : 0,
          risks: Array.isArray(plan.risks) ? plan.risks.length : 0,
        },
      })
    }

    if (serves.length === 0) {
      // An orphan plan. When its only material is attachments, the candidate is
      // opaque text-wise and the gate's `binary` predicate says so.
      const attachmentOnly = attachments.length > 0
      const text = attachmentOnly
        ? `方案 "${plan.title ?? plan.id}" 只提供附件：${attachments.map((item) => item?.name ?? '(未命名)').join(', ')}`
        : `方案 "${plan.title ?? plan.id}" 没有承接任何需求`
      push({
        id: `${plan.id}->(orphan)`,
        path: `plans/${plan.id}/orphan`,
        locator: { planId: plan.id },
        text: clip(text.split('\n'), `plans/${plan.id}/orphan`),
        bytes: attachmentOnly
          ? (attachments.reduce((sum, item) => sum + (Number(item?.bytes) > 0 ? Number(item.bytes) : 0), 0) || byteLength(text))
          : byteLength(text),
        binary: attachmentOnly,
        meta: {
          kind: 'orphan-plan',
          planId: plan.id,
          attachments: attachments.map((item) => item?.name ?? null),
          metricName: plan.metric?.name ?? null,
        },
      })
    }
  }

  for (const requirement of requirements.values()) {
    if (served.has(requirement.id)) continue
    const text = [`未被任何方案承接：${requirement.title ?? ''}`, `状态：${requirement.status ?? '(未声明)'}`].join('\n')
    push({
      id: `(orphan)->${requirement.id}`,
      path: `requirements/${requirement.id}/orphan`,
      locator: { requirementId: requirement.id },
      text: clip(text.split('\n'), `requirements/${requirement.id}/orphan`),
      bytes: byteLength(text),
      deleted: requirement.status !== CONFIRMED,
      meta: {
        kind: 'orphan-requirement',
        requirementId: requirement.id,
        requirementStatus: requirement.status ?? '(未声明)',
        sourceQuoteId: requirement.sourceQuoteId ?? null,
      },
    })
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'requirement-to-plan-links',
  inputFormat: 'requirement-registry-and-plan',
  bounded: true,
  describe: '需求库 + 方案草案 -> 每条「方案承接需求」的边一个候选，外加两侧的孤儿；未确认需求交给 deleted 谓词、纯附件方案交给 binary 谓词。',
  enumerate,
})
