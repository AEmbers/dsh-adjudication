/**
 * ux-review — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded usability reviewer needs to check the flow graph it is judging, and
 * the only thing it may not have is unlimited access. Each tool declares
 * `limits`; `normaliseEvidenceLimits` clamps them to the contract's hard
 * ceilings; every result carries `{ items, truncated, provenance }`.
 *
 *   list_branch_steps  which steps does this branch actually reach?
 *   read_step          what does this step declare (next / onError / onCancel)?
 *   find_node          which design-prototype node backs this step?
 *
 * All three read the flow the CALLER injects through `args.flow` /
 * `args.branches` / `args.prototype`. They touch no filesystem: this package has
 * zero runtime imports, and an evidence tool that reached for `node:fs` would
 * break that on the first host that links the plugin instead of installing it.
 *
 * A missing context is refused LOUDLY rather than answered with "nothing found":
 * "I searched nothing and found nothing" is the most misleading result a
 * usability tool can return.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

const BRANCHES_SCHEMA = {
  type: 'array',
  description: '分支表：[{ id, kind, steps: string[], archived? }]。',
  items: { type: 'object', additionalProperties: true },
}

function branchesFrom(args) {
  const raw = args?.branches
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `branches`：[{ id, kind, steps }]。没有分支表就无法回答「这个步骤在哪条分支上」。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

function stepsFrom(args) {
  const raw = args?.flow?.steps ?? args?.steps
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `flow.steps`（或 `steps`）：没有步骤表就无法核对一个步骤是否真的存在。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

function nodesFrom(args) {
  const raw = args?.prototype?.nodes ?? args?.nodes
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `prototype.nodes`（或 `nodes`）：没有设计稿节点表就无法核对界面状态。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'list_branch_steps',
      description: '列出某条分支真正到达的步骤（来自分支自己的 steps 表，并与流程步骤表交叉核对）。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          branchId: { type: 'string', description: '分支 id' },
          flow: { type: 'object', description: '流程对象 { id, name, steps }', additionalProperties: true },
          branches: BRANCHES_SCHEMA,
        },
        required: ['branchId', 'branches'],
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
      limits: { maxLines: 80, maxItems: 48, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const wanted = String(args?.branchId ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`branchId` 不能为空')
        const branches = branchesFrom(args)
        const branch = branches.find((entry) => entry.id === wanted)
        if (branch === undefined) {
          throw contractError(
            ERROR_CODES.E_INPUT_FORMAT,
            `分支表里没有 "${wanted}"。可用的分支：${branches.map((entry) => String(entry.id)).join(', ') || '(空)'}`,
          )
        }
        const declared = Array.isArray(branch.steps) ? branch.steps : []
        const known = new Set(stepsFrom(args).map((step) => step.id))
        const items = []
        let truncated = false
        for (const stepId of declared) {
          if (items.length >= 48) { truncated = true; break }
          items.push({ branchId: wanted, stepId, existsInFlow: known.has(stepId) })
        }
        const missing = items.filter((item) => !item.existsInFlow).length
        return {
          items,
          truncated,
          provenance: `分支 "${wanted}"（kind=${String(branch.kind ?? '(未分类)')}）声明 ${declared.length} 个步骤，其中 ${missing} 个在流程步骤表里不存在`,
          notes: missing > 0 ? [`⚠️ ${missing} 个步骤是悬空引用：这不是候选，是流程图的缺陷`] : [],
        }
      },
    },
    {
      name: 'read_step',
      description: '读取一个步骤声明的流转（next / onError / onCancel）与类型。这是「可恢复性」类发现的取证入口。',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: '步骤 id' },
          flow: { type: 'object', description: '流程对象 { id, name, steps }', additionalProperties: true },
          steps: { type: 'array', description: '步骤表（当未给出 flow 时使用）', items: { type: 'object', additionalProperties: true } },
        },
        required: ['stepId'],
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
      limits: { maxLines: 40, maxItems: 16, maxBytes: 32_768, maxCalls: 10 },
      execute(args) {
        const wanted = String(args?.stepId ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`stepId` 不能为空')
        const steps = stepsFrom(args)
        const step = steps.find((entry) => entry.id === wanted)
        if (step === undefined) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `步骤表里没有 "${wanted}"。可用的步骤：${steps.map((entry) => String(entry.id)).join(', ') || '(空)'}`)
        }
        const declared = ['next', 'onError', 'onCancel'].filter((key) => step[key] !== undefined && step[key] !== null && step[key] !== '')
        return {
          items: [{
            stepId: wanted,
            name: step.name ?? null,
            type: step.type ?? null,
            next: step.next ?? null,
            onError: step.onError ?? null,
            onCancel: step.onCancel ?? null,
            declaredTransitions: declared.length,
          }],
          truncated: false,
          provenance: `步骤 "${wanted}"：声明了 ${declared.length}/3 条流转（${declared.join(', ') || '无'}）`,
          notes: declared.length < 3 ? ['未声明 onError / onCancel 是常见的可恢复性缺口，但需要结合分支证据才能下结论'] : [],
        }
      },
    },
    {
      name: 'find_node',
      description: '找出某个步骤对应的设计稿节点（按步骤的 node 字段或同 id 匹配）。找不到时明确返回空，而不是猜一个节点。',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: '步骤 id' },
          stepNode: { type: 'string', description: '步骤声明的节点 id（可省略，默认取 stepId）' },
          prototype: { type: 'object', description: '{ nodes: [{ id, name, screen, imageOnly?, bytes? }] }', additionalProperties: true },
          nodes: { type: 'array', description: '节点表（当未给出 prototype 时使用）', items: { type: 'object', additionalProperties: true } },
        },
        required: ['stepId'],
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
      limits: { maxLines: 20, maxItems: 8, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const wanted = String(args?.stepId ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`stepId` 不能为空')
        const nodeId = typeof args?.stepNode === 'string' && args.stepNode !== '' ? args.stepNode : wanted
        const nodes = nodesFrom(args)
        const matches = nodes.filter((node) => node.id === nodeId)
        const items = matches.slice(0, 8).map((node) => ({
          nodeId: node.id,
          name: node.name ?? null,
          screen: node.screen ?? null,
          imageOnly: node.imageOnly === true,
          bytes: Number.isFinite(Number(node.bytes)) ? Number(node.bytes) : null,
        }))
        return {
          items,
          truncated: matches.length > items.length,
          provenance: `在 ${nodes.length} 个节点中按 id "${nodeId}" 命中 ${matches.length} 个`,
          notes: matches.length === 0
            ? ['该步骤没有对应的设计稿节点 —— 界面状态无法核对，这本身是一个候选而不是一个空结果']
            : [],
        }
      },
    },
  ],
})
