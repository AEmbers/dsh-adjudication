/**
 * algo-model — P7 evidence tools (contract v2, extension point 3).
 *
 * Three questions a bounded reviewer of experiment records can ask without
 * inventing context:
 *
 *   experiment_card    what does this experiment's record card say, line by line?
 *   metric_delta       this metric vs the baseline's same-named metric — and
 *                      "there is no baseline" is a REFUSAL, not a zero
 *   definition_compare the same metric name across experiments, so 口径不一致 is
 *                      visible BEFORE any number is compared
 *
 * Every tool declares `limits` and returns `{items, truncated, provenance}`.
 * Everything they read is injected through `args` (`documents`, `records`); none
 * of them touches the filesystem — this package has zero runtime imports.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '可比对文档：[{ path, content }]（实验记录卡）。必须由调用方注入。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

const RECORDS_SCHEMA = {
  type: 'object',
  description: 'tracker 导出的记录：{ experiments: [{ id, metrics: [{ name, value, definition? }], baseline? }] }。必须由调用方注入。',
  additionalProperties: true,
  properties: { experiments: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['experiments'],
}

function recordsFrom(args) {
  const raw = args?.records
  const experiments = Array.isArray(raw) ? raw : raw?.experiments
  if (!Array.isArray(experiments)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `records`（{ experiments: [...] }）。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return experiments.filter((entry) => entry !== null && typeof entry === 'object')
}

function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `documents`：[{ path, content }]。')
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, content: typeof entry.content === 'string' ? entry.content : '' }))
}

function resolveDocument(documents, path) {
  const wanted = String(path ?? '')
  const exact = documents.find((document) => document.path === wanted)
  if (exact !== undefined) return exact
  const suffix = documents.find((document) => document.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(
    ERROR_CODES.E_INPUT_FORMAT,
    `文档集里没有 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ') || '(空)'}`,
  )
}

const valueText = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))
const metricOf = (experiment, name) => (Array.isArray(experiment?.metrics) ? experiment.metrics : [])
  .find((metric) => metric !== null && typeof metric === 'object' && String(metric.name ?? '') === name) ?? null

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'experiment_card',
      description: '读取某个实验记录卡的指定行区间（默认整卡，有硬上限）。行数超出即截断并说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '实验记录卡路径（可写后缀，须在文档集里唯一）' },
          start: { type: 'integer', description: '起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '结束行（含，默认 start + 上限 - 1）' },
          documents: DOCUMENTS_SCHEMA,
        },
        required: ['path', 'documents'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 80, maxItems: 80, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const documents = documentsFrom(args)
        const document = resolveDocument(documents, args.path)
        const lines = String(document.content).split(/\r?\n/u)
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const end = Math.min(requestedEnd, start + 80 - 1, lines.length)
        const items = []
        for (let number = start; number <= end; number += 1) items.push({ path: document.path, line: number, text: lines[number - 1] ?? '' })
        const truncated = requestedEnd > end
        return {
          items,
          truncated,
          provenance: `${document.path}:${start}-${end}（共 ${lines.length} 行）`,
          notes: truncated ? [`请求到第 ${requestedEnd} 行，按 maxLines=80 截断在第 ${end} 行`] : [],
        }
      },
    },
    {
      name: 'metric_delta',
      description: '把某个实验的指标与它 baseline 的同名指标相减。没有 baseline、或 baseline 没有同名指标时**拒绝**并说明原因，而不是当成 0。',
      parameters: {
        type: 'object',
        properties: {
          experimentId: { type: 'string', description: '实验 id' },
          metricName: { type: 'string', description: '只看某个指标（可省略，则比较全部）' },
          records: RECORDS_SCHEMA,
        },
        required: ['experimentId', 'records'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 40, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const experiments = recordsFrom(args)
        const id = String(args?.experimentId ?? '')
        const experiment = experiments.find((entry) => String(entry.id ?? '') === id) ?? null
        if (experiment === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `记录里没有实验 "${id}"。已知：${experiments.map((entry) => String(entry.id ?? '')).join(', ') || '(空)'}`)
        }
        const baselineId = String(experiment?.baseline?.id ?? '')
        if (baselineId === '') {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `实验 "${id}" 没有 baseline —— 无基线时任何「提升」都不成立，本工具拒绝给出差值为 0`)
        }
        const baseline = experiments.find((entry) => String(entry.id ?? '') === baselineId)
          ?? (Array.isArray(experiment.baseline?.metrics) ? { id: baselineId, metrics: experiment.baseline.metrics } : null)
        if (baseline === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `实验 "${id}" 声明的 baseline "${baselineId}" 不在记录里，也没有内联 metrics`)
        }
        const wanted = typeof args?.metricName === 'string' && args.metricName !== '' ? args.metricName : null
        const items = []
        let truncated = false
        for (const metric of Array.isArray(experiment.metrics) ? experiment.metrics : []) {
          const name = String(metric?.name ?? '')
          if (name === '' || (wanted !== null && name !== wanted)) continue
          if (items.length >= 40) { truncated = true; break }
          const counterpart = metricOf(baseline, name)
          items.push({
            experimentId: id,
            metricName: name,
            value: metric.value ?? null,
            baselineId,
            baselineValue: counterpart?.value ?? null,
            delta: typeof metric.value === 'number' && typeof counterpart?.value === 'number'
              ? Number((metric.value - counterpart.value).toFixed(6))
              : null,
            note: counterpart === null ? 'baseline 没有同名指标 —— 这个差值不存在，不是 0' : undefined,
            definition: typeof metric.definition === 'string' ? metric.definition : null,
            baselineDefinition: typeof counterpart?.definition === 'string' ? counterpart.definition : null,
          })
        }
        return {
          items,
          truncated,
          provenance: `实验 "${id}" 对比 baseline "${baselineId}"：${items.length} 个指标（记录里共 ${experiments.length} 个实验）`,
          notes: [
            ...(truncated ? ['指标数达到 maxItems=40，结果已截断'] : []),
            '单题 delta 只是单题：整体是否好转必须逐题看，并检查口径是否一致。',
          ],
        }
      },
    },
    {
      name: 'definition_compare',
      description: '把同一个指标名在各实验里的定义列出来，标出口径不一致。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          metricName: { type: 'string', description: '指标名' },
          records: RECORDS_SCHEMA,
        },
        required: ['metricName', 'records'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 40, maxItems: 40, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const experiments = recordsFrom(args)
        const name = String(args?.metricName ?? '')
        if (name === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`metricName` 不能为空')
        const items = []
        let truncated = false
        for (const experiment of experiments) {
          const metric = metricOf(experiment, name)
          if (metric === null) continue
          if (items.length >= 40) { truncated = true; break }
          items.push({
            experimentId: String(experiment.id ?? ''),
            definition: typeof metric.definition === 'string' && metric.definition !== '' ? metric.definition : '(未声明)',
            value: valueText(metric.value),
          })
        }
        const distinct = new Set(items.map((item) => item.definition))
        return {
          items,
          truncated,
          provenance: `指标 "${name}" 出现在 ${items.length}/${experiments.length} 个实验里，共 ${distinct.size} 种口径`,
          notes: [
            ...(truncated ? ['实验数达到 maxItems=40，结果已截断'] : []),
            ...(distinct.size > 1 ? [`口径不一致（${distinct.size} 种）：跨实验比较前必须先对齐定义`] : []),
          ],
        }
      },
    },
  ],
})
