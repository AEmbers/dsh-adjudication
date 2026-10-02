// ---------------------------------------------------------------------------
// producer → consumer self-audit
// ---------------------------------------------------------------------------
// Every domain ships an enumerator (P0) and a verifier (P5). The edge BETWEEN
// them is the one nobody walked: a domain's own test can pass every assertion it
// has while the two halves still speak different vocabularies, because the test
// usually builds its input by hand (`user-feedback/test.mjs` did feed
// `entry.locator` into the verifier — but `entry` was a GAP record, not a
// candidate, so the twenty candidate locators the enumerator actually emits had
// never been near their own verifier).
//
// This walks that edge with the PRODUCER'S OWN OUTPUT, for every built-in
// domain, and reports the refusals that mean "P0 and P5 cannot talk":
//
//   kind-mismatch    the verifier does not recognise the locator kind at all
//   invalid-verdict  the verdict broke the contract and had to be downgraded
//
// It is wired into `npm test`, after `domains-test.mjs`: a gate that ships
// permanently red stops being a signal, so it joined the suite in the same change
// that turned it green (project-management and requirement-alignment shipped
// enumerator kinds their own verifiers refused).
//
// Usage:  node lib/self-audit.mjs
// Exit:   0 when every domain's own output is consumable by itself, 1 otherwise.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const DOMAINS = join(PACKAGE_ROOT, 'domains')

/** Verdicts that mean the two halves do not agree about the vocabulary. */
const REFUSALS = ['kind-mismatch', 'invalid-verdict']

const ids = readdirSync(DOMAINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort()

console.log('dsh-adjudication producer → consumer self-audit')
console.log('='.repeat(54))

let refusals = 0
let candidates = 0
const failing = []

for (const id of ids) {
  const fixturePath = join(DOMAINS, id, 'fixtures', 'happy-path.json')
  let fixture = null
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  } catch (error) {
    console.log(`SKIP ${id}: cannot read a happy-path fixture — ${error?.message ?? error}`)
    continue
  }
  const source = await import(pathToFileURL(join(DOMAINS, id, 'source.js')).href)
  const anchor = await import(pathToFileURL(join(DOMAINS, id, 'anchor.js')).href)
  const enumerate = source.enumerate ?? source.default?.enumerate
  const verify = anchor.verify ?? anchor.default?.verify
  const kind = anchor.default?.kind ?? anchor.kind

  if (typeof enumerate !== 'function' || typeof verify !== 'function') {
    console.log(`SKIP ${id}: enumerator or verifier missing`)
    continue
  }

  const emitted = enumerate(fixture.input.payload, {}).candidates ?? []
  const before = refusals
  for (const candidate of emitted) {
    candidates += 1
    const verdict = verify(
      { kind, path: candidate.path, locator: candidate.locator, excerpt: candidate.text },
      { path: candidate.path, content: candidate.text },
    )
    const refused = REFUSALS.includes(verdict.code) || REFUSALS.includes(verdict.tier)
    if (refused) {
      refusals += 1
      if (refusals - before <= 2) {
        console.log(`  ${id}: ${JSON.stringify(candidate.id)} -> ${verdict.code ?? verdict.tier}`
          + ` — ${String(verdict.detail ?? '').slice(0, 120)}`)
      }
    }
  }
  const mine = refusals - before
  const emittedKinds = [...new Set(emitted.map((candidate) => candidate.locator?.kind).filter(Boolean))]
  console.log(`${mine === 0 ? 'ok  ' : 'FAIL'} ${id.padEnd(24)} ${mine}/${emitted.length} refused`
    + (emittedKinds.length === 0 ? '' : `   emits: ${emittedKinds.join(', ')}`))
  if (mine > 0) failing.push(id)
}

console.log('='.repeat(54))
console.log(`${candidates - refusals} of ${candidates} candidate locators are consumable by their own verifier`)
if (refusals === 0) {
  console.log('self-audit: ok')
  process.exit(0)
}
console.log(`self-audit: FAILED — ${refusals} refusal(s) across ${failing.length} domain(s): ${failing.join(', ')}`)
process.exit(1)
