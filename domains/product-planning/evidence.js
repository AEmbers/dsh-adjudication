/**
 * product-planning — P7 evidence tools (contract v2, extension point 3).
 *
 * TWO QUESTIONS A PLANNER MAY ACTUALLY ASK
 * ----------------------------------------
 *   orphan_scan    哪条需求没人接、哪个方案不接需求？ —— 可追溯性是计数，不是印象
 *   metric_lookup  承接这条需求的方案打算用什么指标、有没有基线？ —— 「提升 X%」必须落到数字
 *
 * These two take STRUCTURED arguments rather than an injected document set: the
 * question "which requirement has no plan" is a question about the registry, and
 * re-encoding the registry as prose so a text tool can re-parse it would be a
 * worse tool. Both are still bounded — `limits` is clamped by
 * `defineEvidenceToolkit`, every result carries `{ items, truncated, provenance }`.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

const asArray = (value) => (Array.isArray(value) ? value : [])
const idOf = (entry) => String(entry?.id ?? '').trim()

function requirementIndex(args) {
  const index = new Map()
  for (const requirement of asArray(args?.requirements)) {
    const id = idOf(requirement)
    if (id !== '') index.set(id, requirement)
  }
  return index
}

function planIndex(args) {
  const index = new Map()
  for (const plan of asArray(args?.plans)) {
    const id = idOf(plan)
    if (id !== '') index.set(id, plan)
  }
  return index
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'orphan_scan',
      description: '扫描需求库与方案草案，列出「没有任何方案承接的需求」与「不承接任何需求的方案」。两侧孤儿都是发现，不是空数据。',
      parameters: {
        type: 'object',
        properties: {
          requirements: { type: 'array', description: '需求库：[{ id, title, status }]', items: { type: 'object', additionalProperties: true } },
          plans: { type: 'array', description: '方案草案：[{ id, title, serves: [] }]', items: { type: 'object', additionalProperties: true } },
        },
        required: ['requirements', 'plans'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 40, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const requirements = requirementIndex(args)
        const plans = planIndex(args)
        if (requirements.size === 0 && plans.size === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`requirements` 与 `plans` 不能同时为空 —— 空输入不是「没有孤儿」，是没给材料。')
        }
        const served = new Set()
        for (const plan of plans.values()) {
          for (const id of asArray(plan.serves).map((value) => String(value))) served.add(id)
        }
        // A link to an id the registry does not have is reported as a BROKEN
        // trace, not as an orphan: the two need different fixes.
        const broken = []
        for (const plan of plans.values()) {
          for (const id of asArray(plan.serves).map((value) => String(value))) {
            if (!requirements.has(id)) broken.push({ kind: 'broken-link', id: idOf(plan), planId: idOf(plan), requirementId: id })
          }
        }
        const items = []
        let truncated = false
        const emit = (item) => {
          if (items.length >= 40) { truncated = true; return }
          items.push(item)
        }
        for (const requirement of requirements.values()) {
          if (!served.has(idOf(requirement))) emit({ kind: 'orphan-requirement', id: idOf(requirement), status: requirement.status ?? '(未声明)', title: requirement.title ?? '' })
        }
        for (const plan of plans.values()) {
          if (asArray(plan.serves).length === 0) emit({ kind: 'orphan-plan', id: idOf(plan), title: plan.title ?? '' })
        }
        for (const item of broken) emit(item)
        return {
          items,
          truncated,
          provenance: `${requirements.size} 条需求 / ${plans.size} 个方案；孤儿与断链共 ${items.length} 项`,
          notes: truncated ? ['条目数达到 maxItems=40，结果已截断'] : [],
        }
      },
    },
    {
      name: 'metric_lookup',
      description: '列出承接某条需求（或全部）的方案所声明的指标，并标明指标是否缺基线、缺时间窗。缺基线的目标不成立，必须在取证阶段就看见。',
      parameters: {
        type: 'object',
        properties: {
          plans: { type: 'array', description: '方案草案：[{ id, title, serves: [], metric: { name, baseline, target, window } | null }]', items: { type: 'object', additionalProperties: true } },
          requirementId: { type: 'string', description: '只列承接该需求的方案（可省略）' },
        },
        required: ['plans'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 30, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const plans = planIndex(args)
        if (plans.size === 0) throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`plans` 为空 —— 没有方案可查指标。')
        const wanted = args?.requirementId === undefined ? null : String(args.requirementId)
        const items = []
        let truncated = false
        let scanned = 0
        for (const plan of plans.values()) {
          const serves = asArray(plan.serves).map(String)
          if (wanted !== null && !serves.includes(wanted)) continue
          scanned += 1
          if (items.length >= 30) { truncated = true; break }
          const metric = plan.metric ?? null
          items.push({
            planId: idOf(plan),
            serves,
            metricName: metric?.name ?? null,
            baseline: metric?.baseline ?? null,
            target: metric?.target ?? null,
            window: metric?.window ?? null,
            missingBaseline: metric === null || !Number.isFinite(Number(metric.baseline)),
            missingWindow: metric === null || typeof metric.window !== 'string' || metric.window === '',
          })
        }
        return {
          items,
          truncated,
          provenance: `${scanned} 个方案参与匹配${wanted === null ? '（未限定需求）' : `（需求 ${wanted}）`}`,
          notes: truncated ? ['方案数达到 maxItems=30，结果已截断'] : [],
        }
      },
    },
  ],
})
