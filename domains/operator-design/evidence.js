/**
 * operator-design — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT AN OPERATOR-NUMERICS REVIEWER ACTUALLY NEEDS TO LOOK AT
 * -----------------------------------------------------------
 * Three questions, and nothing more:
 *
 *   read_kernel       what does this kernel actually do at these lines?
 *   coverage_matrix   which forms (backend × dtype × shape branch) have a test?
 *   tolerance_lookup  what tolerance did the tests actually assert?
 *
 * THE CONTEXT SHAPES ARE THE P0 SHAPES, ON PURPOSE
 * ------------------------------------------------
 * `operators` and `tests` are read in the SAME shapes the documented input format
 * uses (`operator-registry-and-tests`), so a reviewer holding the P0 payload does
 * not have to translate it to call a tool:
 *
 *   operators: [{ signature, name, backends, dtypes, shapeBranches, path?, source? }]
 *   tests:     [{ operator, backend, dtype, shape, tolerance, asserted }]
 *
 * EVERY TOOL READS ONLY WHAT THE CALLER INJECTS. They touch no filesystem: this
 * package has zero runtime imports, and a tool that reached for `node:fs` would
 * break that on the first host that links the plugin instead of installing it.
 * A tool that cannot find what it needs says so; it never returns an empty
 * result that reads as "this form is fine".
 *
 * A TOOL MUST NOT ANSWER "COVERED" WHEN IT HAS NOTHING TO CHECK
 * ------------------------------------------------------------
 * `coverage_matrix` with no `tests` array throws rather than reporting every form
 * as uncovered — for a recall-first domain, "the manifest is missing" and "the
 * form has no test" are opposite conclusions and must never be conflated.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

/** A tolerance is only a tolerance if it constrains something. Mirrors source.js. */
function usable(test) {
  if (test === null || typeof test !== 'object') return false
  if (test.asserted !== true) return false
  const tolerance = test.tolerance
  if (tolerance === null || tolerance === undefined || typeof tolerance !== 'object') return false
  const atol = Number(tolerance.atol)
  const rtol = Number(tolerance.rtol)
  return (Number.isFinite(atol) && atol >= 0) || (Number.isFinite(rtol) && rtol >= 0)
}

function operatorsFrom(args) {
  const raw = args?.operators
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `operators`：[{ name, signature, backends, dtypes, shapeBranches, path?, source? }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

function testsFrom(args) {
  const raw = args?.tests
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `tests`：[{ operator, backend, dtype, shape, tolerance, asserted }]。没有测试清单就无法区分「未覆盖」与「不知道」。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

function kindsOf(operator) {
  return {
    backends: Array.isArray(operator.backends) ? operator.backends.filter((value) => typeof value === 'string') : [],
    dtypes: Array.isArray(operator.dtypes) ? operator.dtypes.filter((value) => typeof value === 'string') : [],
    shapeBranches: Array.isArray(operator.shapeBranches) ? operator.shapeBranches.filter((value) => typeof value === 'string') : [],
  }
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'read_kernel',
      description: '读取某个算子实现源码的指定行区间。行数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '实现文件路径（可写后缀，须在算子集里唯一）' },
          start: { type: 'integer', description: '起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '结束行（含，默认 start + 上限 - 1）' },
          operators: {
            type: 'array',
            description: '算子注册表：[{ name, signature, backends, dtypes, shapeBranches, path?, source? }]（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
          documents: {
            type: 'array',
            description: '可选：额外源码 [{ path, content }]，当算子条目没有 `source` 时使用',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 100, maxItems: 100, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const operators = operatorsFrom(args)
        const documents = Array.isArray(args.documents) ? args.documents : []
        const wanted = String(args?.path ?? '')
        const candidates = []
        for (const operator of operators) {
          const path = typeof operator.path === 'string' ? operator.path : ''
          if (path !== '' && (path === wanted || path.endsWith(wanted))) {
            candidates.push({ path, content: typeof operator.source === 'string' ? operator.source : '' })
          }
        }
        for (const document of documents) {
          const path = typeof document?.path === 'string' ? document.path : ''
          if (path !== '' && (path === wanted || path.endsWith(wanted))) {
            candidates.push({ path, content: typeof document.content === 'string' ? document.content : '' })
          }
        }
        const named = candidates.find((entry) => entry.content !== '')
        if (named === undefined) {
          const available = [...operators.map((operator) => operator.path), ...documents.map((document) => document.path)]
            .filter((value) => typeof value === 'string' && value !== '')
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `算子实现集里没有 "${wanted}" 的源码。可比对的有：${available.join(', ') || '(空)'}`)
        }

        const lines = named.content.split(/\r?\n/u)
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const end = Math.min(requestedEnd, start + 99, lines.length)
        const items = []
        for (let number = start; number <= end; number += 1) items.push({ path: named.path, line: number, text: lines[number - 1] ?? '' })
        const truncated = requestedEnd > end
        return {
          items,
          truncated,
          provenance: `${named.path}:${start}-${end}（共 ${lines.length} 行）`,
          notes: truncated ? [`请求到第 ${requestedEnd} 行，按 maxLines=100 截断在第 ${end} 行`] : [],
        }
      },
    },
    {
      name: 'coverage_matrix',
      description: '列出每个算子形态（后端 × dtype × shape 分支）的数值测试状态：覆盖了几个测试、有几个带可用容差。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          operator: { type: 'string', description: '只看这个算子（可省略 = 全部）' },
          operators: {
            type: 'array',
            description: '算子注册表（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
          tests: {
            type: 'array',
            description: '数值测试清单（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['operators', 'tests'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 200, maxItems: 60, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const operators = operatorsFrom(args)
        const tests = testsFrom(args)
        const wanted = typeof args.operator === 'string' && args.operator !== '' ? args.operator : null
        const items = []
        let truncated = false
        let forms = 0
        for (const operator of operators) {
          if (wanted !== null && operator.name !== wanted) continue
          const { backends, dtypes, shapeBranches } = kindsOf(operator)
          for (const backend of backends) {
            for (const dtype of dtypes) {
              for (const shapeBranch of shapeBranches) {
                forms += 1
                if (items.length >= 60) { truncated = true; continue }
                const matching = tests.filter((test) => test.operator === operator.name
                  && test.backend === backend && test.dtype === dtype
                  && (test.shape === shapeBranch || test.shape === '*'))
                items.push({
                  operator: operator.name,
                  backend,
                  dtype,
                  shapeBranch,
                  tests: matching.length,
                  withUsableTolerance: matching.filter(usable).length,
                  status: matching.length === 0 ? 'uncovered' : (matching.filter(usable).length === 0 ? 'missing-tolerance' : 'covered'),
                })
              }
            }
          }
        }
        return {
          items,
          truncated,
          provenance: `枚举 ${forms} 个形态，返回 ${items.length} 个${wanted === null ? '' : `（算子 "${wanted}"）`}`,
          notes: truncated ? ['形态数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
    {
      name: 'tolerance_lookup',
      description: '按算子（或全部）列出数值测试及其容差与 asserted 标记。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          operator: { type: 'string', description: '只看这个算子（可省略 = 全部）' },
          tests: {
            type: 'array',
            description: '数值测试清单（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['tests'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 120, maxItems: 60, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const tests = testsFrom(args)
        const wanted = typeof args.operator === 'string' && args.operator !== '' ? args.operator : null
        const items = []
        let truncated = false
        let scanned = 0
        for (const test of tests) {
          scanned += 1
          if (wanted !== null && test.operator !== wanted) continue
          if (items.length >= 60) { truncated = true; break }
          items.push({
            operator: test.operator ?? null,
            backend: test.backend ?? null,
            dtype: test.dtype ?? null,
            shape: test.shape ?? null,
            tolerance: test.tolerance ?? null,
            asserted: test.asserted === true,
            usable: usable(test),
          })
        }
        return {
          items,
          truncated,
          provenance: `扫过 ${scanned}/${tests.length} 个测试条目${wanted === null ? '' : `，算子 "${wanted}"`}`,
          notes: truncated ? ['命中数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
  ],
})
