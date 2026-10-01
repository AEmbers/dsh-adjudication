/**
 * Integration test — mounts the plugin on a REAL `@deepseek-ai/cordis` Context
 * taken from a DSH installation, with real fibers and real effect disposal.
 *
 * WHY THIS EXISTS SEPARATELY FROM smoke-test.mjs
 * ----------------------------------------------
 * The smoke test drives a hand-written mock. That mock cannot know the host's
 * undocumented rules, and the first version of this plugin was killed by
 * exactly such a rule: Cordis's `Context.set(name, value)` throws
 * `cannot set property "x" without provide` unless the name was `provide`d on
 * that context first. The throw happened inside `apply`, Cordis marked the
 * fiber FAILED and rolled back every tool the plugin had just registered — so
 * the plugin appeared to mount and then silently vanished. A mock built from
 * the same assumptions as the code it tests will never find that class of bug.
 *
 * USAGE
 *   node mount-test.mjs [path/to/@deepseek-ai/cordis]
 *   DSH_CORDIS=/path/to/cordis node mount-test.mjs
 *
 * The cordis path may be a package directory or the module file itself. When no
 * installation can be found the test SKIPS (exit 0) rather than failing: it
 * verifies a host, and a host is not always present.
 */

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const PLUGIN = new URL('./index.js', import.meta.url).href

// ---------------------------------------------------------------------------
// Locate a real cordis
// ---------------------------------------------------------------------------

const CANDIDATES = [
  process.argv[2],
  process.env.DSH_CORDIS,
  'D:/deepseek-harness/apps/cli/node_modules/@deepseek-ai/cordis',
  'C:/Sophia/deepseek-harness/apps/cli/node_modules/@deepseek-ai/cordis',
  'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis',
].filter(Boolean)

function entryOf(candidate) {
  const target = resolve(candidate)
  if (target.endsWith('.js') && existsSync(target)) return target
  if (!existsSync(target)) return undefined
  const manifestPath = join(target, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const main = typeof manifest.main === 'string' ? manifest.main : 'lib/index.js'
      const mainPath = join(target, main)
      if (existsSync(mainPath)) return mainPath
    } catch {
      /* fall through to the conventional entry */
    }
  }
  const conventional = join(target, 'lib', 'index.js')
  return existsSync(conventional) ? conventional : undefined
}

let cordisEntry
for (const candidate of CANDIDATES) {
  cordisEntry = entryOf(candidate)
  if (cordisEntry !== undefined) break
}

if (cordisEntry === undefined) {
  console.log('mount-test: SKIPPED — no @deepseek-ai/cordis installation found.')
  console.log('  Pass one as argv[2] or set DSH_CORDIS, e.g.')
  console.log('  node mount-test.mjs "C:/path/to/node_modules/@deepseek-ai/cordis"')
  process.exit(0)
}

console.log(`\ndsh-adjudication real-cordis mount test`)
console.log(`  cordis: ${cordisEntry}`)
console.log('='.repeat(60))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0
const check = (title, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok || detail === '' ? '' : `\n       ${detail}`}`)
  if (!ok) failures += 1
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const plugin = await import(PLUGIN)

const tools = new Map()
const sections = []
const trace = []

const app = new Context()
app.provide('tools', {
  register(definition) {
    if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
    tools.set(definition.name, definition)
    trace.push(`+ ${definition.name}`)
    return () => {
      tools.delete(definition.name)
      trace.push(`- ${definition.name}`)
    }
  },
  get: (toolName) => tools.get(toolName),
})
app.provide('systemPrompt', {
  section(spec) {
    sections.push(spec)
    return () => {
      const index = sections.indexOf(spec)
      if (index >= 0) sections.splice(index, 1)
    }
  },
})

const settle = () => new Promise((done) => setTimeout(done, 120))
const names = () => [...tools.keys()].sort()

process.on('unhandledRejection', (error) => console.log('!! unhandledRejection:', error?.stack ?? error))
process.on('uncaughtException', (error) => console.log('!! uncaughtException:', error?.stack ?? error))

// Wrap only to surface an error Cordis would otherwise swallow into the fiber.
let applyError = null
const wrapper = {
  name: plugin.name,
  inject: plugin.inject,
  apply(ctx, config) {
    try {
      plugin.apply(ctx, config)
    } catch (error) {
      applyError = error
      throw error
    }
  },
}

// ---------------------------------------------------------------------------
// 1. mount
// ---------------------------------------------------------------------------

let fiber
try {
  fiber = app.plugin(wrapper)
  await settle()
  check('apply() completes without throwing on a real Cordis Context', applyError === null, String(applyError?.stack ?? applyError))
} catch (error) {
  check('apply() completes without throwing on a real Cordis Context', false, String(error?.stack ?? error))
}

check('exactly the six core tools are registered', JSON.stringify(names()) === JSON.stringify([
  'adjudication_activate', 'adjudication_anchor', 'adjudication_deactivate',
  'adjudication_domains', 'adjudication_plan', 'adjudication_submit',
]), `got ${JSON.stringify(names())}`)

check('a system-prompt section is installed', sections.length === 1, `sections=${sections.length}`)

if (sections.length === 1) {
  const rendered = sections[0].text()
  check('the prompt section renders and stays small', typeof rendered === 'string' && rendered.length < 1400, `${rendered?.length} chars`)
  check('the prompt section advertises the activation tool', rendered.includes('adjudication_activate'))
}

// ---------------------------------------------------------------------------
// 2. on-demand lifecycle on real fibers
// ---------------------------------------------------------------------------

try {
  const result = await tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  // CHANGED (t4). Was `result.tools.length === 3`.
  //
  // Activation returns EVERY tool the domain contributes, and `code-review` now
  // ships as a v2 directory pack whose `evidence.js` contributes three bounded
  // tools — a contract requirement (P7), not a regression. Asserting a count
  // would go stale again the moment a domain adds a fourth tool, so the check is
  // now the SET of names: the three declared domain tools plus the three
  // evidence tools that `evidenceToolName()` derives.
  const expected = [
    'adjudicate_code_review',
    'adjudicate_code_review_plan',
    'adjudicate_code_review_rules',
    'adjudicate_code_review_evidence_read_lines',
    'adjudicate_code_review_evidence_search_diff',
    'adjudicate_code_review_evidence_enclosing',
  ]
  const missing = expected.filter((name) => !result.tools.includes(name))
  const unexpected = result.tools.filter((name) => !expected.includes(name))
  check('activate registers the domain toolset', result.ok === true && missing.length === 0 && unexpected.length === 0,
    `missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)} got=${JSON.stringify(result.tools)}`)
  check('the domain tools exist after activation', tools.has('adjudicate_code_review'), names().join(','))
} catch (error) {
  check('activate registers the domain toolset', false, String(error?.stack ?? error))
}

try {
  const listed = await tools.get('adjudication_domains').execute({}, {})
  check('the registry reports all 19 built-in packs', listed.count === 19, `count=${listed.count}`)
} catch (error) {
  check('the registry reports all 19 built-in packs', false, String(error?.stack ?? error))
}

try {
  const plan = await tools.get('adjudication_plan').execute({
    domain: 'code-review',
    target: 'integration probe',
    candidates: [{ path: 'src/a.ts', additions: 3 }, { path: '.env' }, { path: 'node_modules/x.js' }],
  }, {})
  check('plan gates and bundles', plan.gate.admitted === 1 && plan.gate.excluded.length === 2, JSON.stringify(plan.gate).slice(0, 200))
} catch (error) {
  check('plan gates and bundles', false, String(error?.stack ?? error))
}

try {
  const submitted = await tools.get('adjudication_submit').execute({
    domain: 'code-review',
    total: 1,
    // CHANGED (t17): submit now recomputes every anchor through the domain's
    // anchorVerifier instead of trusting `finding.anchored`/`finding.start`, so
    // the finding must quote a line and the document must be supplied. The
    // assertion below is unchanged.
    documents: [{ path: 'src/a.ts', content: 'const a = 1\nconst b = 2\nconst c = 3' }],
    findings: [{ id: 'a', path: 'src/a.ts', start: 3, severity: 'high', message: 'x', evidence: 'const c = 3', defended: true }],
  }, {})
  check('submit runs P6/P7', submitted.findings.length === 1, JSON.stringify(submitted).slice(0, 200))
} catch (error) {
  check('submit runs P6/P7', false, String(error?.stack ?? error))
}

try {
  await tools.get('adjudication_deactivate').execute({ domain: 'code-review' }, {})
  check('deactivate withdraws that domain only', !tools.has('adjudicate_code_review') && tools.has('adjudication_domains'), names().join(','))
} catch (error) {
  check('deactivate withdraws that domain only', false, String(error?.stack ?? error))
}

// ---------------------------------------------------------------------------
// 3. full teardown through the real fiber lifecycle
// ---------------------------------------------------------------------------

try {
  await tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  await tools.get('adjudication_activate').execute({ domain: 'tech-test' }, {})
  const before = tools.size
  if (typeof app.dispose === 'function') app.dispose()
  else fiber?.dispose?.()
  await settle()
  check('fiber disposal withdraws every tool', tools.size === 0, `before=${before} after=${tools.size} left=${names().join(',')}`)
  check('fiber disposal withdraws the prompt section', sections.length === 0, `sections=${sections.length}`)
} catch (error) {
  check('fiber disposal withdraws every tool', false, String(error?.stack ?? error))
}

console.log('='.repeat(60))
console.log(failures === 0 ? 'real-cordis mount: all checks passed' : `real-cordis mount: ${failures} failed`)
if (failures > 0) {
  console.log(`\ntrace (last 12):\n${trace.slice(-12).join('\n')}`)
  process.exitCode = 1
}
