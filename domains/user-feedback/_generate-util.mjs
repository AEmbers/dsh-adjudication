/**
 * The two mechanisms both `_generate.mjs` scripts in this domain need in order to be
 * safe to keep in the tree at all (t42).
 *
 * WHY THIS IS A MODULE AND NOT TWO COPIES
 * ---------------------------------------
 * `isEntryPoint` is what keeps "importing a generator" from rewriting committed files,
 * and `compareRendered` is what keeps the generator's output and the committed
 * artifacts from drifting apart. Copying either one into both generators would recreate,
 * one level up, exactly the defect this file exists to remove: two copies of one rule
 * with nothing keeping them equal. So the safety mechanism has a single definition —
 * for the same reason the extension set now has a single one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * -------------------------------
 * No filesystem access at module top level, and no writes at all outside
 * `writeRendered`, so importing this file (or any generator that uses it) can never
 * have an effect.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * True only when `moduleUrl` is the script node was actually asked to run.
 *
 * `process.argv[1]` is a filesystem path and `import.meta.url` is a URL, so this cannot
 * be a string comparison. The `.toLowerCase()` folds the Windows drive-letter case
 * difference, which would otherwise make the guard silently never fire — a guard that
 * never fires is worse than no guard, because it reads as protection.
 */
export function isEntryPoint(moduleUrl) {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  return pathToFileURL(resolve(entry)).href.toLowerCase() === moduleUrl.toLowerCase()
}

/**
 * `{checked, missing, differing}`. Text comparison, not a hash: the point of `--check`
 * is to be able to say WHICH file drifted, and a hash cannot.
 */
export function compareRendered(rendered, directory) {
  const missing = []
  const differing = []
  for (const [name, text] of rendered) {
    let actual
    try { actual = readFileSync(join(directory, name), 'utf8') } catch { missing.push(name); continue }
    if (actual !== text) differing.push(name)
  }
  return { checked: rendered.size, missing, differing }
}

/** Write every rendered file into `directory`. The only writing code in either generator. */
export function writeRendered(rendered, directory) {
  for (const [name, text] of rendered) writeFileSync(join(directory, name), text, 'utf8')
  return rendered.size
}

/**
 * The `--check` / `--write` entry guard, shared so both generators behave identically and
 * a fix to one is a fix to both.
 *
 * `--check` is the DEFAULT on purpose: the harmless invocation has to be the one someone
 * types by accident, and the destructive one has to be typed deliberately. It also makes
 * "run the generator" a usable consistency check instead of a rewrite.
 *
 * Returns `{ran:false}` when the module was imported rather than run — i.e. normally.
 */
export function runEntry({ moduleUrl, label, here, render, argv = process.argv.slice(2) }) {
  if (!isEntryPoint(moduleUrl)) return { ran: false, mode: null }
  const mode = argv[0] ?? '--check'
  if (mode === '--check') {
    const report = compareRendered(render(), here)
    if (report.missing.length === 0 && report.differing.length === 0) {
      console.log(`${label}: ${report.checked} file(s) in sync with this generator`)
      return { ran: true, mode, ...report }
    }
    console.log(`${label}: generated output does NOT match what is committed`)
    if (report.missing.length > 0) console.log(`  missing: ${report.missing.join(', ')}`)
    if (report.differing.length > 0) console.log(`  differs: ${report.differing.join(', ')}`)
    console.log('Re-run with --write to regenerate, or fix the generator.')
    process.exitCode = 1
    return { ran: true, mode, ...report }
  }
  if (mode === '--write') {
    const written = writeRendered(render(), here)
    console.log(`${label}: wrote ${written} file(s)`)
    return { ran: true, mode, checked: written, missing: [], differing: [] }
  }
  console.log(`${label}: unknown argument "${mode}"`)
  console.log('  usage: node <this file> [--check|--write]   (--check is the default)')
  process.exitCode = 2
  return { ran: true, mode: null }
}
