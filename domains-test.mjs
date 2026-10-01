/**
 * Domain test runner — `node domains-test.mjs`. No framework, no dependencies.
 *
 * WHY THIS EXISTS AS A FILE INSTEAD OF A LINE IN `package.json`
 * ------------------------------------------------------------
 * The obvious npm-script glob does not work: npm scripts run through `sh`, which
 * does not expand a glob in argument position on every platform this package
 * supports, and a shell `for` loop is a second thing to get right per platform.
 * More importantly, a glob in `package.json` has to be EDITABLE to add a domain,
 * and this package's whole migration story is "a domain owner touches only their
 * own directory".
 *
 * So the contract is: **`domains/<id>/test.mjs` is discovered, not registered.**
 * A domain that lands a `test.mjs` is in `npm test` with no shared file edited,
 * and this runner is what makes that true.
 *
 * EXIT SEMANTICS
 * --------------
 *   • no `domains/` directory        -> 0, with a printed note (nothing to run is
 *                                       not a failure: it is the pre-migration state)
 *   • a domain directory with no test.mjs -> 0, listed as skipped WITH a reason
 *   • N failing domains              -> 1, and the failure list is repeated at the
 *                                       end so it survives a wall of passing output
 *
 * @returns never; sets `process.exitCode`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// `argv[2]` overrides the scan root. It exists so the runner's own branches —
// "a domain ships no test", "a domain's test fails" — can be exercised against a
// scratch directory instead of by temporarily breaking a real domain.
const root = process.argv[2] !== undefined ? process.argv[2] : join(here, 'domains')

// `spawnSync` with `stdio: 'inherit'` rather than `spawn` + captured pipes: this
// package is used inside a SandboxedWindows host where a child process whose
// stdio is a pipe cannot start at all (DSH file policy), and a domain test's
// output is worth streaming live anyway.
function runOne(testPath) {
  const result = spawnSync(process.execPath, [testPath], { stdio: 'inherit' })
  if (result.error !== undefined) {
    console.log(`  !! ${testPath} could not start: ${result.error.message}`)
    return false
  }
  return result.status === 0
}

console.log('\ndsh-adjudication domain tests')
console.log('='.repeat(60))

if (!existsSync(root)) {
  console.log('  no domains/ directory — nothing to run.')
  console.log('  (This is the pre-migration state, not a failure: the nineteen')
  console.log('   built-in packs in lib/domains.js are covered by the kernel test.)')
  process.exitCode = 0
} else {
  const directories = readdirSync(root)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()

  const ran = []
  const skipped = []
  const failed = []

  for (const id of directories) {
    const testPath = join(root, id, 'test.mjs')
    if (!existsSync(testPath)) {
      // Skipped WITH a reason, never silently: a domain that ships a package but
      // no test is a real gap, and it must be visible in the run's output.
      skipped.push({ id, reason: 'no test.mjs — the domain package is not covered by npm test' })
      continue
    }
    console.log(`\n--- domains/${id} ---`)
    const ok = runOne(testPath)
    ran.push(id)
    if (!ok) failed.push(id)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`domains: ${ran.length} ran, ${failed.length} failed, ${skipped.length} skipped`)
  for (const entry of skipped) console.log(`  ⏭ ${entry.id} — ${entry.reason}`)
  if (failed.length > 0) {
    console.log(`  ✗ failing: ${failed.join(', ')}`)
    process.exitCode = 1
  }
}
