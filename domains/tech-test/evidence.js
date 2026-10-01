/**
 * tech-test — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT A COVERAGE-GAP REVIEWER ACTUALLY NEEDS TO LOOK AT
 * -----------------------------------------------------
 * Three questions, and nothing more:
 *
 *   source_lines     what is at these lines, and is each one covered?
 *   coverage_query   which coverage entries exist, and which cases ran a file?
 *   case_lookup      what does a named case actually assert?
 *
 * THE CONTEXT SHAPES ARE THE P0 SHAPES, ON PURPOSE
 * ------------------------------------------------
 * `source`, `coverage` and `cases` are read in the SAME shapes the documented
 * input format uses (`test-inventory-and-coverage`), so a reviewer that has the
 * P0 payload in hand does not have to translate it to call a tool:
 *
 *   source:   { '<path>': { lines: string[] } }
 *   coverage: { files: { '<path>': { lines: { '<n>': count }, branches: {} } } }
 *   cases:    [{ id, file, assertions: [{ kind, target }] }]
 *
 * The compact forms (`sources: [{path, content}]`, `coverage: [{path, lines}]`)
 * are accepted too — being stricter than the caller about a shape the caller
 * already holds would just make the tool unusable in practice.
 *
 * EVERY TOOL READS ONLY WHAT THE CALLER INJECTS. They touch no filesystem: this
 * package has zero runtime imports, and a tool that reached for `node:fs` would
 * break that on the first host that links the plugin instead of installing it.
 * A tool that cannot find what it needs says so; it never returns an empty
 * result that reads as "there is no coverage gap here".
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

function toLines(list) {
  const lines = []
  for (const item of Array.isArray(list) ? list : []) {
    if (Array.isArray(item)) {
      const start = Number(item[0])
      const end = Number(item[1])
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      for (let line = start; line <= end; line += 1) lines.push(line)
      continue
    }
    const line = Number(item)
    if (Number.isFinite(line)) lines.push(line)
  }
  return lines
}

/** `{ '<path>': { lines } }` | `{ '<path>': string }` | `[{ path, content }]` -> `[{path, content}]`. */
function sourcesFrom(args) {
  const rawMap = args?.source
  if (rawMap !== null && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const sources = []
    for (const [path, entry] of Object.entries(rawMap)) {
      const content = typeof entry === 'string'
        ? entry
        : (Array.isArray(entry?.lines) ? entry.lines.map((line) => String(line)).join('\n') : '')
      sources.push({ path, content })
    }
    if (sources.length > 0) return sources
  }
  const raw = args?.sources
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `source`：{ "<path>": { lines: string[] } }（也接受 `sources: [{ path, content }]`）。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({
      path: entry.path,
      content: typeof entry.content === 'string'
        ? entry.content
        : (Array.isArray(entry.lines) ? entry.lines.map((line) => String(line)).join('\n') : ''),
    }))
}

/** Documented `{ files: {…} }` | bare map | array -> `Map<path, {lines:Set, cases:string[]}>`. */
function coverageMap(args) {
  const raw = args?.coverage
  if (raw === undefined || raw === null) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `coverage`：{ files: { "<path>": { lines, branches } } }。没有覆盖数据就无法区分「未覆盖」与「不知道」。')
  }
  const map = new Map()
  const add = (path, entry) => {
    const list = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.lines : entry
    const lines = new Set()
    if (list !== null && typeof list === 'object' && !Array.isArray(list)) {
      for (const [key, count] of Object.entries(list)) {
        const line = Number(key)
        if (Number.isFinite(line) && Number(count ?? 0) > 0) lines.add(line)
      }
    } else {
      for (const line of toLines(list)) lines.add(line)
    }
    const cases = Array.isArray(entry?.cases) ? entry.cases.filter((value) => typeof value === 'string') : []
    map.set(path, { lines, cases })
  }

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
      add(entry.path, entry)
    }
    return map
  }
  if (typeof raw !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`coverage` 必须是对象或数组')
  }
  const files = raw.files !== null && typeof raw.files === 'object' ? raw.files : raw
  for (const [path, entry] of Object.entries(files)) add(path, entry)
  return map
}

function resolveSource(sources, path) {
  const wanted = String(path ?? '')
  const exact = sources.find((entry) => entry.path === wanted)
  if (exact !== undefined) return exact
  const suffix = sources.find((entry) => entry.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(
    ERROR_CODES.E_INPUT_FORMAT,
    `源码集里没有 "${wanted}"。可比对的有：${sources.map((entry) => entry.path).join(', ') || '(空)'}`,
  )
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'source_lines',
      description: '读取某个文件的指定行区间，并逐行标注该行在覆盖报告里是否命中。行数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（可写后缀，须在源码集里唯一）' },
          start: { type: 'integer', description: '起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '结束行（含，默认 start + 上限 - 1）' },
          source: {
            type: 'object',
            description: '源码快照：{ "<path>": { lines: string[] } }（与 P0 的 `source` 同形）。',
            additionalProperties: true,
          },
          coverage: {
            type: 'object',
            description: '覆盖报告：{ files: { "<path>": { lines: { "<n>": count }, branches: {} } } }（与 P0 同形；可省略 = 该文件没有任何覆盖数据）。',
            additionalProperties: true,
          },
        },
        required: ['path', 'source'],
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
      limits: { maxLines: 120, maxItems: 120, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const sources = sourcesFrom(args)
        const source = resolveSource(sources, args.path)
        const lines = source.content.split(/\r?\n/u)
        const covered = coverageMap(args).get(source.path)?.lines ?? new Set()
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const end = Math.min(requestedEnd, start + 119, lines.length)
        const items = []
        for (let number = start; number <= end; number += 1) {
          items.push({ path: source.path, line: number, text: lines[number - 1] ?? '', covered: covered.has(number) })
        }
        const truncated = requestedEnd > end
        return {
          items,
          truncated,
          provenance: `${source.path}:${start}-${end}（共 ${lines.length} 行；覆盖报告命中 ${covered.size} 行）`,
          notes: truncated ? [`请求到第 ${requestedEnd} 行，按 maxLines=120 截断在第 ${end} 行`] : [],
        }
      },
    },
    {
      name: 'coverage_query',
      description: '按文件路径或用例 ID 检索覆盖条目，返回每个条目的命中行数与执行过它的用例。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '按文件路径过滤（可省略）' },
          caseId: { type: 'string', description: '按用例 ID 过滤（可省略）' },
          coverage: {
            type: 'object',
            description: '覆盖报告：{ files: { "<path>": { lines: { "<n>": count }, cases?: string[] } } }',
            additionalProperties: true,
          },
        },
        required: ['coverage'],
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
        const entries = coverageMap(args)
        const wantedPath = typeof args.path === 'string' && args.path !== '' ? args.path : null
        const wantedCase = typeof args.caseId === 'string' && args.caseId !== '' ? args.caseId : null
        if (wantedPath === null && wantedCase === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'coverage_query 需要 `path` 或 `caseId` 至少一个 —— 无条件的全量转储不是取证')
        }
        const items = []
        let truncated = false
        let scanned = 0
        for (const [path, entry] of entries) {
          scanned += 1
          const lines = [...entry.lines].sort((left, right) => left - right)
          if (wantedPath !== null && !(path === wantedPath || path.endsWith(wantedPath))) continue
          if (wantedCase !== null && !entry.cases.includes(wantedCase)) continue
          if (items.length >= 60) { truncated = true; break }
          items.push({
            path,
            coveredLineCount: lines.length,
            first: lines[0] ?? null,
            last: lines[lines.length - 1] ?? null,
            cases: entry.cases,
          })
        }
        return {
          items,
          truncated,
          provenance: `扫过 ${scanned}/${entries.size} 个覆盖条目${wantedPath ? `，路径含 "${wantedPath}"` : ''}${wantedCase ? `，用例 "${wantedCase}"` : ''}`,
          notes: truncated ? ['命中数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
    {
      name: 'case_lookup',
      description: '按 ID（或名称子串）查找用例，返回它的断言种类与被覆盖的文件。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '用例 ID（精确匹配优先）或名称子串' },
          cases: {
            type: 'array',
            description: '用例清单：[{ id, file?, name?, assertions?: [{ kind, target }] }]',
            items: { type: 'object', additionalProperties: true },
          },
          coverage: {
            type: 'object',
            description: '覆盖报告（用于回答「这个用例跑过哪些文件」）',
            additionalProperties: true,
          },
        },
        required: ['id', 'cases'],
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
      limits: { maxLines: 80, maxItems: 20, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const wanted = String(args?.id ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`id` 不能为空')
        const raw = Array.isArray(args.cases) ? args.cases : null
        if (raw === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `cases`：[{ id, file, assertions }]。')
        }
        const entries = Array.isArray(args.coverage) || (args.coverage !== null && typeof args.coverage === 'object')
          ? coverageMap(args)
          : new Map()
        const exact = raw.filter((entry) => entry?.id === wanted)
        const matches = exact.length > 0
          ? exact
          : raw.filter((entry) => typeof entry?.name === 'string' && entry.name.includes(wanted))
        const items = []
        let truncated = false
        for (const entry of matches) {
          if (items.length >= 20) { truncated = true; break }
          const files = []
          for (const [path, coverage] of entries) if (coverage.cases.includes(entry.id)) files.push(path)
          items.push({
            id: entry.id,
            file: entry.file ?? null,
            name: entry.name ?? null,
            assertionKinds: Array.isArray(entry.assertions)
              ? entry.assertions.map((assertion) => assertion?.kind ?? null)
              : null,
            coveredFiles: files,
          })
        }
        return {
          items,
          truncated,
          provenance: `在 ${raw.length} 个用例中按 "${wanted}" 命中 ${items.length} 个${exact.length > 0 ? '（精确）' : '（名称子串）'}`,
          notes: truncated ? ['命中数达到 maxItems=20，结果已截断'] : [],
        }
      },
    },
  ],
})
