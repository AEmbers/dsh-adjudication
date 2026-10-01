/**
 * reverse-engineering — bounded evidence tools (contract v2, extension point 3).
 *
 * Every tool here is BOUNDED by declaration (`limits`) and by behaviour: at most
 * `maxLines` / `maxItems` returned, `truncated` set when it cut, `provenance`
 * always reported. The registry registers them on demand as
 * `adjudicate_reverse_engineering_evidence_*`.
 *
 * WHAT THESE TOOLS DO NOT DO
 * --------------------------
 * They never read the filesystem, never run a disassembler and never fetch
 * anything. The sample and the notes arrive from the caller. A tool that went and
 * executed `objdump` would make the review unreproducible in a different way than
 * the artifact is unreproducible: the result would depend on a toolchain version
 * nobody recorded. When the context it needs is missing a tool REFUSES — it does
 * not answer "nothing found", because "no steps recorded" and "the tool could not
 * run" are different findings and only one of them may be reported as fact.
 *
 * HONESTY: `reproduction_check` compares the seed against ITSELF (which
 * statements have steps). It cannot run the steps, and `provenance` says so.
 */

import { defineEvidenceToolkit } from '../../lib/contracts.js'

const asArray = (value) => (Array.isArray(value) ? value : null)
const str = (value) => (typeof value === 'string' ? value : '')

/** The registry, from `args.registry` or an `re/<…>.json` document. */
function registryOf(args) {
  if (args?.registry !== undefined && args.registry !== null) {
    if (args.registry.artifact === undefined || args.registry.artifact === null) {
      throw new Error('`registry` 必须是 { artifact, observations }')
    }
    return { artifact: args.registry.artifact, observations: asArray(args.registry.observations) ?? [] }
  }
  for (const document of asArray(args?.documents) ?? []) {
    if (!/^re\/.+\.json$/u.test(String(document?.path ?? ''))) continue
    try {
      const parsed = JSON.parse(str(document?.content))
      if (parsed?.artifact !== undefined && parsed.artifact !== null) {
        return { artifact: parsed.artifact, observations: asArray(parsed.observations) ?? [] }
      }
    } catch {
      throw new Error(`文档 ${document.path} 不是合法 JSON：样本登记表无法解析`)
    }
  }
  throw new Error('缺少 `registry`（或一份 re/<…>.json 样本登记表文档）：没有登记表就无法核对样本与复现状态')
}

/** The note files, from `args.documents` (registry documents excluded). */
function notesOf(args) {
  const documents = asArray(args?.documents)
  if (documents === null) throw new Error('缺少 `documents`（线索笔记数组）：没有笔记就无法定位原文')
  return documents.filter((document) => !/^re\/.+\.json$/u.test(String(document?.path ?? '')))
}

const linesOf = (document) => str(document?.content).split(/\r?\n/u)

// CHANGED (t33/t24-F2): `documents` and `registry` are read by every tool below
// but were MISSING from their published `parameters.properties`, so a caller
// that followed the schema could not call them at all (`note_excerpt` threw
// 「缺少 documents」, `reproduction_check` threw 「缺少 registry」). The
// declaration is now a superset of the implementation, and the test suite
// derives that property mechanically from this file's `args.<key>` reads.
const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '调用方交回的线索笔记：[{ path, content }]。必须由调用方注入；本工具绝不读盘、绝不执行反汇编工具。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

const REGISTRY_SCHEMA = {
  type: 'object',
  description: '样本登记表 { artifact, observations }。也可以不给 registry，而是把登记表作为一份 re/<…>.json 文档放进 documents —— 两种给法等价，registry 优先。',
  properties: { artifact: { type: 'object' }, observations: { type: 'array' } },
  required: ['artifact'],
}

/** Steps that count: non-empty strings. Exported so the two functions agree. */
const stepsOf = (observation) =>
  (Array.isArray(observation?.reproducibility?.steps) ? observation.reproducibility.steps : [])
    .map((step) => String(step ?? '').trim())
    .filter((step) => step !== '')

export const tools = [
  {
    name: 'note_excerpt',
    description: '读取一份线索笔记的指定行范围（含陈述行与复现状态行）。只读调用方注入的文档，绝不读盘、绝不执行反汇编工具。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '线索笔记路径，如 re/fw123/observations/auth-flow.md' },
        start: { type: 'number', description: '起始行（1-based，默认 1）' },
        documents: DOCUMENTS_SCHEMA,
      },
      required: ['path', 'documents'],
    },
    output: { schema: { type: 'object' } },
    // CHANGED (t33/t24-F3): `maxItems` said 1 while the tool returns one item per
    // line read, i.e. up to `maxLines`. The declaration is the bound a caller can
    // rely on, so it has to describe what the tool can actually return.
    limits: { maxLines: 40, maxItems: 40, maxBytes: 8192, maxCalls: 6 },
    execute(args = {}) {
      const path = str(args.path)
      if (path === '') throw new Error('`path` 必填')
      const notes = notesOf(args)
      const document = notes.find((entry) => String(entry?.path ?? '') === path)
      if (document === undefined) {
        throw new Error(`线索笔记的文档集里没有 "${path}"（已注入 ${notes.length} 份笔记）：不猜路径、不读本地文件`)
      }
      const lines = linesOf(document)
      const start = Number.isInteger(args.start) && args.start > 0 ? args.start : 1
      const slice = lines.slice(start - 1, start - 1 + this.limits.maxLines)
      const unreproduced = lines.filter((line) => /^repro .*verified=false/u.test(line)).length
      return {
        items: slice.map((line, index) => ({ line: start + index, text: line })),
        truncated: start - 1 + slice.length < lines.length,
        provenance: `${path}（第 ${start}-${start + slice.length - 1} 行，共 ${lines.length} 行）`,
        notes: [`该笔记中有 ${unreproduced} 条陈述标记为未复现：它们只能作为猜想引用`],
      }
    },
  },
  {
    name: 'reproduction_check',
    description: '逐条列出陈述的可复现状态：有几步、是否标记为已验证、是否自称推断。只核对登记表里的记录，不执行任何步骤。',
    parameters: {
      type: 'object',
      properties: {
        registry: REGISTRY_SCHEMA,
        documents: DOCUMENTS_SCHEMA,
      },
      // 两条给法等价（registry 优先），故不写 required：写出 required 会把另一种
      // 真实可用的给法排除在「已发布接口」之外。两者都缺时工具仍然拒绝回答。
      required: [],
    },
    output: { schema: { type: 'object' } },
    limits: { maxLines: 200, maxItems: 50, maxBytes: 32768, maxCalls: 4 },
    execute(args = {}) {
      const registry = registryOf(args)
      const items = []
      let truncated = false
      for (const observation of registry.observations) {
        if (items.length >= this.limits.maxItems) { truncated = true; break }
        const steps = stepsOf(observation)
        items.push({
          observationId: String(observation?.id ?? ''),
          kind: observation?.kind === 'inference' ? 'inference' : 'observation',
          lead: str(observation?.lead) === '' ? 'general' : str(observation.lead),
          steps: steps.length,
          verifiedFlag: observation?.verified !== false,
          reproduced: steps.length > 0 && observation?.verified !== false,
        })
      }
      const reproduced = items.filter((item) => item.reproduced).length
      const inferences = items.filter((item) => item.kind === 'inference').map((item) => item.observationId)
      return {
        items,
        truncated,
        provenance: `核对 ${registry.observations.length} 条陈述（样本 ${String(registry.artifact?.sha256 ?? '(无哈希)')}），可复现 ${reproduced} 条；只核对登记表，不执行步骤`,
        notes: [
          `${items.length - reproduced} 条没有可复现步骤：未复现不等于不成立，但不得被写成已验证的观察`,
          inferences.length === 0 ? '没有自称推断的陈述' : `自称推断的陈述（必须保留猜想标注）：${inferences.join(', ')}`,
        ],
      }
    },
  },
  {
    name: 'sample_identity',
    description: '核对一个被声明的样本哈希是否就是登记的产物：逆向结论随样本变化，哈希不同即结论不能搬运。只比较，不下载。',
    parameters: {
      type: 'object',
      properties: {
        sha256: { type: 'string', description: '被声明的样本哈希' },
        registry: REGISTRY_SCHEMA,
        documents: DOCUMENTS_SCHEMA,
      },
      required: ['sha256'],
    },
    output: { schema: { type: 'object' } },
    // CHANGED (t33/t24-F3): this tool compares exactly ONE declared hash against
    // ONE registered artifact, so its item count is 1 BY CONSTRUCTION and the
    // truncation branch is unreachable by design — `maxItems: 1` says that
    // instead of declaring head-room that no input can fill. The test asserts
    // both the equality (`items.length === limits.maxItems`) and the reason.
    limits: { maxLines: 20, maxItems: 1, maxBytes: 4096, maxCalls: 8 },
    execute(args = {}) {
      const claimed = str(args.sha256).trim().toLowerCase()
      if (claimed === '') throw new Error('`sha256` 必填')
      const registry = registryOf(args)
      const registered = str(registry.artifact?.sha256).trim().toLowerCase()
      if (registered === '') throw new Error('登记表里的产物没有 sha256：无法核对样本，不能把「大概是同一个」当成确认')
      const same = claimed === registered
      return {
        items: [{ claimed, registered, same, artifactId: String(registry.artifact?.id ?? '') }],
        truncated: false,
        provenance: `登记样本 ${String(registry.artifact?.id ?? '')} sha256=${registered}；只比较哈希，不下载、不重算`,
        notes: same
          ? ['样本一致：结论至少是在同一个产物上得出的']
          : ['样本不一致：偏移、字符串表与补丁特征都会随样本变化，这条结论不能搬运到另一个产物'],
      }
    },
  },
]

export default defineEvidenceToolkit({ tools })
