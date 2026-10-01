/**
 * dsh-adjudication — named-import resolution check (t21).
 *
 * WHY THIS EXISTS
 * ---------------
 * `domains/requirement-alignment/` shipped a `source.js` that imported
 * `derivedPath` from a sibling **without re-exporting it**, while `anchor.js`
 * imported `derivedPath` *from* `source.js`. The module graph was therefore
 * broken: `loadDomains` reported `module load failed`, the pack was skipped, and
 * the plugin silently fell back to the engine's generic ladder — `via:
 * 'engine-resolveAnchor'`, which looks EXACTLY like "this domain has not
 * migrated yet". A domain could be fully written, fully tested, and still never
 * run, with no error at the tool boundary.
 *
 * That is the same failure shape this project keeps removing everywhere else: a
 * silent downgrade that is indistinguishable from an honest one. So it gets a
 * check instead of a convention.
 *
 * WHAT IT CHECKS
 * --------------
 * For every `.js` file in the package (root, `lib/`, `domains/<id>/`) — and
 * recursively for the relative modules they import — every NAMED import
 * (`import { a, b as c } from './x.js'`) and every named re-export
 * (`export { a } from './x.js'`) must resolve to an actual export of the target
 * module. Importing the target module is the only way to be sure: a name can be
 * re-exported, aliased, or a binding declared deep in a file, and reading the
 * text is exactly what produced the original mistake.
 *
 * It also fails on a module that cannot be imported at all, since that is the
 * same silent downgrade one level earlier.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * Default imports, namespace imports, dynamic `import()`, and anything resolved
 * through a package name. None of them can fail this way, and guessing at them
 * would make the check noisy enough to be ignored — which is how a check dies.
 *
 * Zero dependencies; node built-ins only, and only inside this file.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** Every `.js` file this check should look at, relative to the package root. */
function collectFiles() {
  const files = []
  const walk = (directory, depth) => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs')) continue
      files.push(full)
    }
  }
  for (const name of ['index.js']) {
    const full = join(ROOT, name)
    if (existsSync(full)) files.push(full)
  }
  for (const name of ['lib', 'domains']) walk(join(ROOT, name), 0)
  return files
}

/**
 * Named bindings of `import { … } from '…'` / `export { … } from '…'`.
 * Returns `[{specifier, names: [{imported, local}], line}]`.
 */
export function namedBindings(source) {
  const found = []
  const lines = source.split('\n')
  const pattern = /(?:^|\n)\s*(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu
  let match
  while ((match = pattern.exec(source)) !== null) {
    const names = []
    for (const part of match[1].split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const asMatch = trimmed.match(/^([\w$]+)\s+as\s+([\w$]+)$/u)
      if (asMatch !== null) names.push({ imported: asMatch[1], local: asMatch[2] })
      else names.push({ imported: trimmed, local: trimmed })
    }
    if (names.length === 0) continue
    const line = source.slice(0, match.index).split('\n').length
    found.push({ specifier: match[2], names, line })
  }
  return found
}

const problems = []
let checkedFiles = 0
let checkedBindings = 0

for (const file of collectFiles()) {
  let source
  try { source = readFileSync(file, 'utf8') } catch { continue }
  checkedFiles += 1
  for (const { specifier, names, line } of namedBindings(source)) {
    if (!specifier.startsWith('.')) continue
    const target = resolve(dirname(file), specifier)
    const where = `${file.slice(ROOT.length + 1).replace(/\\/g, '/')}:${line}`
    if (!existsSync(target)) {
      problems.push(`${where}: imports "${specifier}", which does not exist`)
      continue
    }
    let module
    try {
      module = await import(pathToFileURL(target).href)
    } catch (error) {
      problems.push(`${where}: importing "${specifier}" threw — ${error?.message ?? String(error)}`)
      continue
    }
    for (const { imported, local } of names) {
      checkedBindings += 1
      if (!(imported in module)) {
        const available = Object.keys(module).filter((key) => key !== 'default').sort()
        problems.push(
          `${where}: ${imported === local ? imported : `${imported} as ${local}`} is not exported by "${specifier}"`
          + ` (available: ${available.length === 0 ? '(none)' : available.join(', ')})`,
        )
      }
    }
  }
}

console.log(`imports-check: ${checkedFiles} module(s), ${checkedBindings} named binding(s)`)
if (problems.length > 0) {
  console.log(`\n${problems.length} unresolvable named import(s):`)
  for (const problem of problems) console.log(`  FAIL ${problem}`)
  console.log('\nA named import that does not resolve means the module cannot load, which the plugin')
  console.log('reports as "this domain has no verifier" — indistinguishable from "not migrated yet".')
  process.exitCode = 1
} else {
  console.log('imports-check: every named relative import resolves')
}
