/**
 * ux-review — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `flow-spec`
 * ------------------------------------
 *   {
 *     flow:      { id, name, steps: [{ id, name, type, next?, onError?, onCancel? }] },
 *     branches:  [{ id, kind, steps: string[], archived? }],
 *     prototype?: { nodes: [{ id, name, screen, imageOnly?, bytes? }] }
 *   }
 *
 * ONE CANDIDATE PER (branch, step). A branch's `steps` list is the authoritative
 * membership: a step id that appears in a branch but not in `flow.steps` is a
 * REAL defect (the flow graph references a step that does not exist), so it is
 * reported in `excluded` rather than silently dropped. That is the
 * `undeclared-branch` fixture.
 *
 * THE CANDIDATE IDENTITY
 * ----------------------
 * `candidate.path` is `<flow-scope>/<branch-scope>/<step-slug>`. The leading two
 * segments are the branch, so grouping by the leading segments IS grouping by
 * "the branch this step is reached through" — the domain's true bundle
 * semantics — and it survives any downstream normalisation that keeps `path`.
 * The gate still globs the whole string, which is why the pack can exclude an
 * `exported` branch by path (`**&#47;exported/**`).
 *
 * The SOURCE does not apply the gate. It only reports what it saw, so "P0
 * enumerated nothing" and "P1 removed everything" stay distinguishable.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** A lowercase, path-segment-safe spelling of an id. */
function slug(value, fallback) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return text === '' ? fallback : text
}

/**
 * Render the material a bounded reviewer would see for one (branch, step).
 */
export function stepText(flow, branch, step, node, maxLines) {
  const lines = [
    `流程 ${String(flow?.id ?? '(无 id)')}《${String(flow?.name ?? '(无名称)')}》`,
    `分支 ${String(branch?.id ?? '(无 id)')}（${String(branch?.kind ?? '未分类')}）`,
    `步骤 ${String(step?.id ?? '(无 id)')} — ${String(step?.name ?? '(无名称)')}（类型 ${String(step?.type ?? '未分类')}）`,
    '',
    '流转：',
    `  next    = ${String(step?.next ?? '(未声明)')}`,
    `  onError = ${String(step?.onError ?? '(未声明)')}`,
    `  onCancel= ${String(step?.onCancel ?? '(未声明)')}`,
    '',
    '设计稿节点：',
    node === null || node === undefined
      ? '  （该步骤没有对应的设计稿节点 —— 本身就是一个候选：无法核对界面状态）'
      : `  ${String(node.id)}「${String(node.name ?? '')}」屏幕 ${String(node.screen ?? '(未声明)')}${node.imageOnly === true ? ' [仅位图，无可读文本]' : ''}`,
  ]
  if (!(Number(maxLines) > 0) || lines.length <= Number(maxLines)) return { text: lines.join('\n'), clipped: false }
  return { text: lines.slice(0, Number(maxLines)).join('\n'), clipped: true }
}

/**
 * The domain's documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source: `{ maxCandidates,
 * maxExcerptLines, include, exclude, extensions }`.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'flow-spec 输入必须是对象 { flow, branches, prototype? }')
  }
  if (input.flow === null || typeof input.flow !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'flow-spec 输入缺少对象字段 `flow`')
  }
  if (input.flow.steps !== undefined && !Array.isArray(input.flow.steps)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`flow.steps` 必须是数组（可省略）')
  }
  if (input.branches !== undefined && !Array.isArray(input.branches)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`branches` 必须是数组（可省略）')
  }
  if (input.prototype !== undefined && (input.prototype === null || typeof input.prototype !== 'object')) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`prototype` 必须是对象（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const flow = input.flow
  const steps = Array.isArray(flow.steps) ? flow.steps : []
  const branches = Array.isArray(input.branches) ? input.branches : []
  const nodes = Array.isArray(input.prototype?.nodes) ? input.prototype.nodes : []

  const stepById = new Map()
  for (const step of steps) {
    if (step !== null && typeof step === 'object' && typeof step.id === 'string' && step.id !== '') stepById.set(step.id, step)
  }
  const nodeFor = (step) => {
    const wanted = typeof step?.node === 'string' && step.node !== '' ? step.node : step?.id
    return nodes.find((node) => node !== null && typeof node === 'object' && node.id === wanted) ?? null
  }

  const flowScope = slug(flow.id, 'flow')
  const candidates = []
  const excluded = []
  const notes = []
  const seenIds = new Set()
  let truncated = false

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (seenIds.has(candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过（分支 id 或步骤 id 不唯一？）`)
      return false
    }
    seenIds.add(candidate.id)
    candidates.push(candidate)
    return true
  }

  for (const [index, branch] of branches.entries()) {
    if (branch === null || typeof branch !== 'object') {
      excluded.push({ id: `branch#${index + 1}`, reason: '分支条目不是对象' })
      continue
    }
    const branchId = String(branch.id ?? '').trim()
    if (branchId === '') {
      excluded.push({ id: `branch#${index + 1}`, reason: '分支缺少 id —— 步骤侧锚点将无法重算' })
      continue
    }
    if (!Array.isArray(branch.steps)) {
      excluded.push({ id: branchId, reason: '分支缺少 steps 数组 —— 这个分支上没有任何可审的步骤' })
      continue
    }
    if (branch.steps.length === 0) {
      excluded.push({ id: branchId, reason: '分支的步骤表为空 —— 「这个分支什么都不做」本身可疑，但没有可锚定的步骤' })
      continue
    }

    const branchScope = slug(branchId, 'branch')
    const branchKey = `${flowScope}/${branchScope}`

    for (const rawStepId of branch.steps) {
      const stepId = String(rawStepId ?? '')
      const step = stepById.get(stepId)
      if (step === undefined) {
        // A real defect, not a malformed request: the flow graph names a step
        // that does not exist. Reported, never silently dropped.
        excluded.push({
          id: `${branchId}:${stepId === '' ? '(empty)' : stepId}`,
          reason: `分支 "${branchId}" 引用了流程中不存在的步骤 "${stepId}" —— 该分支的这一格无法锚定到任何步骤`,
        })
        continue
      }
      const node = nodeFor(step)
      const rendered = stepText(flow, branch, step, node, maxExcerptLines)
      if (rendered.clipped) {
        truncated = true
        notes.push(`${branchId}:${stepId} 的候选正文超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      }
      const declaredBytes = Number(node?.bytes)
      push({
        id: `${branchId}:${stepId}`,
        path: `${branchKey}/${slug(stepId, 'step')}`,
        locator: { stepId, branchId, ...(node === null ? {} : { nodeId: node.id }) },
        text: rendered.text,
        bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : byteLength(rendered.text),
        ...(node?.imageOnly === true ? { binary: true } : {}),
        ...(branch.archived === true ? { deleted: true } : {}),
        meta: {
          flowId: flow.id ?? null,
          flowName: flow.name ?? null,
          branchId,
          branchKind: branch.kind ?? null,
          branchKey,
          stepId,
          stepName: step.name ?? null,
          stepType: step.type ?? null,
          nodeId: node?.id ?? null,
          screen: node?.screen ?? null,
        },
      })
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'flow-steps',
  inputFormat: 'flow-spec',
  bounded: true,
  describe: '流程图（步骤与分支）+ 设计稿节点表 -> 每个 (分支, 步骤) 一个候选；分支引用了不存在的步骤时进 excluded 并说明。',
  enumerate,
})
