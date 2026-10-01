/**
 * 端到端演示（真实插件路径，无网络、无模型，可直接跑）：
 *
 *   node docs/demo-e2e.mjs              # 默认 code-review
 *   node docs/demo-e2e.mjs user-feedback
 *
 * 它做四件事，全部走真实工具（不是内部函数）：
 *   adjudication_plan → adjudication_anchor → adjudication_submit → 卸载
 * 判据：每一步都打印真实数字，任一步失败即以非零码退出。
 *
 * P4/P6 需要一个推理服务（`ctx.subagents` 或 `ctx.llm`）。这里注入一个**假**服务，
 * 它只回固定结果——演示的是「引擎怎么用服务」，不是「模型答得好不好」。
 * 真实宿主里这一层由 DSH 提供，本脚本的存在是为了让整条链路能在没有模型的情况下被看见。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const DOMAIN = process.argv[2] ?? 'code-review'

/** 最小 cordis 上下文：只实现本插件真正用到的那几个面。 */
function createContext(services = {}) {
  const tools = new Map()
  const provided = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    effect(callback) {
      // 插件用 generator 注册工具：收集它 yield 出来的 disposer。
      if (callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const disposers = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') disposers.push(step.value)
          step = iterator.next()
        }
        return () => { for (const dispose of disposers.reverse()) dispose() }
      }
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
      get: (name) => tools.get(name),
    },
    inject(names, callback) {
      const mounted = {}
      for (const name of names) {
        if (services[name] === undefined) return // 服务缺失 = 这一路没有，不是错误
        mounted[name] = services[name]
      }
      callback({ ...mounted, effect: (fn) => ctx.effect(fn) })
    },
    provide(name, value) { provided.set(name, value) },
    set(name, value) { provided.set(name, value) },
    get: (name) => provided.get(name),
    __tools: tools,
  }
  return ctx
}

const fakeSubagents = {
  async start(request) {
    const isP6 = /P6/.test(String(request.label))
    return {
      id: 'demo-child',
      result: Promise.resolve(isP6
        ? { stopReason: 'completed', structured: { verdicts: [{ code: 'demo', keep: true, reason: '引用可重算，维持原判' }] }, output: [] }
        : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
      dispose: async () => {},
    }
  },
}

const { createNodeIo } = await import('file:///' + join(PKG, 'lib', 'domain-loader.js').replace(/\\/g, '/'))
const plugin = await import('file:///' + join(PKG, 'index.js').replace(/\\/g, '/'))
const io = await createNodeIo({ root: PKG })
const ctx = createContext({ subagents: fakeSubagents, systemPrompt: { section: () => 0 } })
plugin.apply(ctx, { domainIo: io, domainRoot: 'domains' })
const call = (name, args) => ctx.__tools.get(name).execute(args, {})

const fixturesDir = join(PKG, 'domains', DOMAIN, 'fixtures')
const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()
const happy = files.find((f) => f.includes('happy')) ?? files[0]
const fixture = JSON.parse(readFileSync(join(fixturesDir, happy), 'utf8'))
/** 取一条「正例且自带 documents」的锚点用例，模拟调用方交上来的发现。 */
let anchorCase = null
for (const file of files) {
  const parsed = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'))
  for (const entry of parsed.anchors?.positive ?? []) {
    if (entry.expectStatus !== 'anchored') continue
    if (Array.isArray(entry.subject?.documents) && (anchorCase === null || entry.subject.documents.length > 0)) anchorCase = { file, entry }
  }
}
if (anchorCase === null) {
  console.error(`✗ domains/${DOMAIN}/fixtures 里没有带 documents 的正例锚点用例，无法演示`)
  process.exit(1)
}

const line = (label, value) => console.log(`${label.padEnd(22)}${value}`)
console.log(`# 端到端演示：${DOMAIN}   （fixture: ${happy}）\n`)

await call('adjudication_domains', {})
console.log('① 工具面（未激活）   ' + [...ctx.__tools.keys()].length + ' 个：' + [...ctx.__tools.keys()].join(', '))
const activated = await call('adjudication_activate', { domain: DOMAIN })
line('② 激活后注册', `${activated.tools.length} 个：${activated.tools.join(', ')}`)

const plan = await call('adjudication_plan', { domain: DOMAIN, target: 'demo', input: fixture.input })
console.log('\n③ adjudication_plan')
line('  候选 → 准入', `${fixture.expect?.candidates} → ${plan.gate.admitted}（排除 ${Array.isArray(plan.gate.excluded) ? plan.gate.excluded.length : plan.gate.excluded}）`)
line('  候选集来源', `${plan.candidateSet?.origin}（领域自己的枚举器）`)
line('  分捆', `${plan.bundles.length} 捆：${plan.bundles.map((b) => `'${b.key}'(${b.paths.length} 路径/${b.rules.length} 规则)`).join(' ')}`)
line('  bundleKey', `applied=${plan.bundleKey.applied} strategy=${plan.bundleKey.strategy} source=${plan.bundleKey.source}`)

const claim = anchorCase.entry.claim
const documents = anchorCase.entry.subject?.documents ?? [{ path: anchorCase.entry.subject.path, content: anchorCase.entry.subject.content }]
const anchored = await call('adjudication_anchor', { domain: DOMAIN, excerpt: claim.excerpt, path: claim.path, locator: claim.locator, documents })
console.log(`\n④ adjudication_anchor   （用例 ${anchorCase.file}）`)
line('  裁决', `${anchored.status} / ${anchored.tier}（via=${anchored.via}）`)
line('  位置', `${anchored.path}:${anchored.start}-${anchored.end}`)
line('  summary', anchored.summary)

const submitted = await call('adjudication_submit', {
  domain: DOMAIN,
  target: 'demo',
  total: 1,
  documents,
  findings: [{
    id: 'demo-1', path: claim.path, excerpt: claim.excerpt, locator: claim.locator,
    severity: 'high', subject: 'correctness', message: '演示用的发现', evidence: claim.excerpt, defended: true,
  }],
})
console.log('\n⑤ adjudication_submit')
line('  保留 / 未锚定', `${submitted.findings.length} / ${submitted.unanchored}（未锚定的明细 ${(submitted.unanchoredDetails ?? []).length} 条）`)
line('  覆盖率', `${submitted.coverage.reviewed}/${submitted.coverage.total} = ${submitted.coverage.coverageRate}（complete=${submitted.coverage.complete} required=${submitted.coverage.required}）`)
line('  P6 独立复核', `ran=${submitted.review?.verify?.ran} mode=${submitted.review?.verify?.mode} source=${submitted.review?.verify?.prompt?.source} 裁决=${(submitted.review?.verify?.verdicts ?? []).length} 条`)
line('  复核者', submitted.criticismKind)
console.log('\n--- 报告（前 10 行）---')
for (const row of String(submitted.summary).split('\n').slice(0, 10)) console.log('| ' + row)

await call('adjudication_deactivate', { domain: DOMAIN })
line('\n⑥ 卸载后工具面', `${[...ctx.__tools.keys()].length} 个`)

const ok = plan.gate.admitted > 0 && anchored.status === 'anchored' && submitted.findings.length > 0 && submitted.review?.verify?.ran === true
console.log(ok ? '\n✓ 端到端通过：枚举 → 闸门 → 分捆 → 锚点重算 → 有界评审 → 独立复核 → 报告' : '\n✗ 端到端失败')
process.exit(ok ? 0 : 1)
