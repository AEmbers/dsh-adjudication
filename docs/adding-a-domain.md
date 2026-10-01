# Adding a domain

An executable guide for the person adding the **next** domain package (this document was
written when nineteen existed; everything below is measured against them).

**Run every command from the package root** — the directory containing `package.json`,
`index.js` and `lib/`. Paths inside the text are relative to that root.

---

## 0. How this document relates to `docs/review-antipatterns.md`

They are two halves of one method and they should not be read as one document:

| | `docs/review-antipatterns.md` | this file |
|---|---|---|
| audience | the **reviewer**: how to refute someone else's work | the **author**: how to avoid writing something that needs refuting |
| unit | a defect shape, with the probe that exposes it | a step you are about to take, with the command that checks it |
| stance | assume it is wrong until a measurement says otherwise | assume the measurement is measuring the wrong set until you have seen the set |

Refer to the reviewer's taxonomy by section number rather than restating it:
`§1.1` count/state coupling, `§1.2` `skipped.length === 0`, `§1.3` global `npm test` as the
local verify, `§1.4` "all gated out" only under the fixture's extra rules, `§1.5`
tautological upper bound, `§1.9` nominal support, `§1.10` a field whose name promises a set
the code does not compute, `§1.11` an enforced-but-unmeasured bound, `§4.1` reachability,
`§4.2` green on the wrong path, `Appendix A` a glob in a block comment, `Appendix B`
`import()` is not free.

Section 10 of this file covers the same ten shapes **from the author's side**: what you are
about to type, how the defect will present itself to you, and the command that tells you
that you have already done it.

---

## 1. Ninety seconds

```bash
# 1. the shape: eight pieces under one directory
node -e "const fs=require('fs');const d='domains/requirement-alignment';for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))console.log('  '+(e.isDirectory()?e.name+'/':e.name))"
#   anchor.js
#   evidence.js
#   fixtures/
#   index.js
#   prompts.js
#   rules/
#   source.js
#   test.mjs

# 2. does it load, and does it pass the completion gate?
node --input-type=module -e "import { loadDomain, createNodeIo } from './lib/domain-loader.js'; const io = await createNodeIo({ root: process.cwd() }); const r = await loadDomain(io, { id: 'requirement-alignment', dir: 'domains/requirement-alignment' }); console.log(r.problems.length ? r.problems.join(String.fromCharCode(10)) : 'pack OK — ' + r.files.join(', '));"
# pack OK — index.js, source.js, anchor.js, evidence.js, prompts.js, rules/*.md

# 3. your own suite (this is your local verify — see §10.2)
node domains/requirement-alignment/test.mjs

# 4. the whole repository, once you are done and not before
npm test
```

A domain is **complete** only when all of this holds at once:

1. `domains/<id>/source.js` — documented input format → candidate set, with a fixture and
   boundary tests for the empty set and the fully-gated-out set;
2. `domains/<id>/anchor.js` — an anchor verifier that recomputes against real input, with a
   positive case and negative cases (ambiguity refuses, it does not guess);
3. `domains/<id>/evidence.js` — bounded domain evidence tools, loaded on demand;
4. `domains/<id>/rules/*.md` — at least 20 rules, each with `name` / `match` / `text`, and
   `needs-expert-review: true` in the front matter;
5. `domains/<id>/prompts.js` — a P4 bounded review prompt and a P6 independent verify prompt;
6. `domains/<id>/index.js` — the v2 pack, with all five extension points wired;
7. `domains/<id>/test.mjs` — P0→P7 over the fixtures, asserting the report and the coverage
   numbers;
8. pulled into `npm test` (this is automatic — see §2).

---

## 2. Directory shape

```
domains/requirement-alignment/
├── index.js          the v2 pack (default export) — DATA ONLY, no extension points inlined
├── source.js         candidateSource   → one candidate per edge and per node side
├── anchor.js         anchorVerifier    → recomputes a trace/ref claim
├── evidence.js       evidenceTools     → 4 bounded tools
├── prompts.js        reviewPrompts     → P4 `review()` and P6 `verify()`
├── rules/*.md        23 rule documents → ruleLibrary
├── fixtures/*.json   9 inputs + expectations
└── test.mjs          the suite that proves the above
```

The mapping from file to contract field lives in one place:

```bash
node -e "const fs=require('fs');fs.readFileSync('lib/domain-loader.js','utf8').split(String.fromCharCode(10)).slice(108,118).forEach((l,i)=>console.log((109+i)+': '+l))"
# 109: export const EXTENSION_FILES = Object.freeze({
# 110:   candidateSource: 'source.js',
# 111:   anchorVerifier: 'anchor.js',
# 112:   evidenceTools: 'evidence.js',
# 113:   reviewPrompts: 'prompts.js',
# 114: })
# 115:
# 116: /** Directory names that are never domains. */
# 117: export const IGNORED_DIRECTORY_NAMES = Object.freeze(['index.js', 'node_modules'])
# 118:
```

| file | contract field | loaded at |
|---|---|---|
| `index.js` | the pack itself (`default` export) | `lib/domain-loader.js:353-358` |
| `source.js` | `candidateSource` | `lib/domain-loader.js:110` |
| `anchor.js` | `anchorVerifier` | `lib/domain-loader.js:111` |
| `evidence.js` | `evidenceTools` | `lib/domain-loader.js:112` |
| `prompts.js` | `reviewPrompts` | `lib/domain-loader.js:113` |
| `rules/*.md` | `ruleLibrary` | `lib/domain-loader.js:382-390`, reader at `:293` |
| `fixtures/*.json` | `fixtures` (names only) | `lib/domain-loader.js:402-408` |
| `test.mjs` | nothing — it is *discovered* | `domains-test.mjs:61-87` |

Directory-level rules, all enforced by the loader:

* the declared `id` must equal the directory name — `lib/domain-loader.js:412-413`;
* the id must be lowercase kebab-case — `:269`;
* directories starting with `.` or `_`, plus `index.js` and `node_modules`, are never
  domains — `:264` and `:117`. Shared helpers go in `domains/_lib/` (or a `_`-prefixed
  file), which is why the loader skips them;
* `test.mjs` is **not registered anywhere**. `domains-test.mjs` (at `:61-87`) reads the
  directory, runs `<id>/test.mjs` as a child process (`:44`, `spawnSync` with
  `stdio: 'inherit'`) and fails the aggregate if any domain exits non-zero (`:94-95`).
  Shipping the file is the whole wiring step.

---

## 3. What the completion gate rejects

`validateDomainPackV2` (`lib/contracts.js:1098`) is the gate. Run it against your **loaded**
pack, not against the object you exported from `index.js` — the loader fills in the
extension points, so the two are different objects.

| you will see | cause | line |
|---|---|---|
| `contractVersion must be 2` | `contractVersion` missing/≠2 | `lib/contracts.js:1102` |
| `missing required field "criticism"` | one of `id title category lossOrientation anchor candidateSet criticism` | `:1105` |
| `id must be lowercase kebab-case` | `CartReview` | `:1108` |
| `category must be one of A/B/C/D` | unknown category | `:1109` |
| `candidateSource.kind "x" must equal candidateSet.kind "y"` | the two declarations drifted apart | `:1113` |
| `candidateSet.inputFormat must equal candidateSource.inputFormat` | same | `:1116` |
| `anchorVerifier.kind "x" must equal anchor.kind "y"` | same | `:1122` |
| `anchor.verify must be one of engine-recomputable/externally-recheckable` | typo | `:1125` |
| `criticism.kind "fact-checker" disagrees with lossOrientation "recall-first"` | the two declarations contradict | `:1138-1142` |
| `invalid evidenceTools: evidenceTools.tools has 9 entries; at most 8 are allowed` | more tools than `EVIDENCE_LIMITS.maxToolsPerDomain` | `:1130` (message at `:531`) |
| `invalid reviewPrompts: verify().instructions must be a non-empty string` | the P6 renderer returned nothing to say | `:1133` (messages at `:601-634`) |
| `invalid ruleLibrary: rules/*.md: match must be a non-empty array of globs` | a rule document whose front matter is incomplete | `:1136` (messages at `:719-815`) |
| `bundleKey must use the v2 object form` | you kept the v1 string | `:1147-1148` |
| `bundleKey.strategy must be one of path/file/directory/extension (or supply bundleKey.resolve)` | private strategy name without a resolver | `:1149-1152` |
| `missing mandatory fixture "all-gated-out"` | see §5 | `:1160-1162` |
| `test.mjs must be wired into npm test` | only with `{ requireTestWiring: true }` | `:1166-1168` |

Rules are validated separately, one document at a time:

* `MIN_RULES_PER_DOMAIN = 20` — `lib/contracts.js:655`;
* `name`, non-empty `match`, `needs-expert-review: true` are required —
  `lib/contracts.js:659`, enforced at `:725-726` and `:814-815`;
* an HTML comment instead of front matter is refused — `:818`.

### The one hard-coded number you must coordinate, not edit

```bash
node -e "const fs=require('fs');const re=/expected 19|length, 19|count, 19/;const hit=(f)=>{if(!fs.existsSync(f))return;fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).forEach((l,i)=>{if(re.test(l))console.log('  '+f+':'+(i+1)+'  '+l.trim())})};for(const d of fs.readdirSync('domains'))hit('domains/'+d+'/test.mjs');for(const f of ['lib/contracts.js','contract-test.mjs','smoke-test.mjs'])hit(f)"
#   domains/algo-model/test.mjs:1030  assert.equal(listed.count, 19)
#   domains/backend-engineering/test.mjs:948  assert.equal(listed.count, 19, 'replacement must not change the domain count')
#   … nine more domain suites …
#   lib/contracts.js:1428  if (DOCUMENTED_DOMAIN_IDS.length !== 19) problems.push(`expected 19 documented input formats, got …`)
#   contract-test.mjs:90  assert.equal(contracts.DOCUMENTED_DOMAIN_IDS.length, 19)
#   smoke-test.mjs:210  assert.equal(BUILTIN_DOMAINS.length, 19)
#   smoke-test.mjs:347  assert.equal(facade.listDomains().length, 19)
#   smoke-test.mjs:631  assert.equal(listed.count, 19)
```

`lib/contracts.js:1428` is the engine's own self-check (`checkContractIntegrity`, `:1418`), the
same check that refuses `bounded: false` outside the two C-family ids (`:1441`). Adding a
twentieth domain therefore turns **sixteen** assertions red at once — eleven domain suites,
`lib/contracts.js` and `contract-test.mjs`, and three lines in `smoke-test.mjs` — all of them
in files that are not yours.
**That is by design** — they are replacement checks ("a directory package must not change the
count"), and the count is a fact someone has to update deliberately. Report it; do not
sweep it. See §10.1.

---

## 4. Wiring the five extension points

`index.js` is a **pure data pack**. Do not inline an extension point there: the loader looks
at whether the pack already carries the field, and a field declared in `index.js` wins over
the sibling file (`lib/domain-loader.js:364-380`). Inlining means `source.js` can be
imported, tested, and *never executed* by the plugin — the failure shape is
`§4.1 reachability`.

```js
// domains/<id>/index.js — shape, abbreviated from domains/requirement-alignment/index.js
export default {
  contractVersion: 2,
  id: 'requirement-alignment',          // must equal the directory name
  title: '需求对齐',
  category: 'D',                        // A / B / C / D
  lossOrientation: 'recall-first',      // recall-first → criticism.kind 'triage'
  candidateSet: { kind: 'trace-graph-edges', inputFormat: 'trace-graph', bounded: true },
  gate: { exclude: ['**/.git/**', '**/archived/**'], extensions: GATE_EXTENSIONS },
  bundleKey: { strategy: 'trace-chain', resolve: chainKey },   // object form, see §7
  anchor: { kind: 'trace-node-and-edge', verify: 'engine-recomputable' },
  criticism: { kind: 'triage' },
  fixtures: ['empty', 'all-gated-out', 'happy-path', /* … */],
  // NO candidateSource / anchorVerifier / evidenceTools / reviewPrompts / ruleLibrary here
}
```

Two traps that cost real time:

* **Do not re-export a sibling under its contract name** from `index.js`
  (`export { default as candidateSource } from './source.js'`) *and* leave the declaration to
  the loader. A named export is picked up by the loader's namespace check at
  `lib/domain-loader.js:368-371`, which can shadow `source.js` with a value the loader then
  rejects (`candidateSource.enumerate must be a function`). Let the loader assemble; if you
  want the value for tests, import it directly from `./source.js`.
* **The plugin's tool names derive from the id**, so a wrong `id` produces tools that look
  right and are registered under the wrong names. `adjudicate_<id>_<suffix>` with `-`
  replaced by `_` (`lib/contracts.js:480-482`).

Verify the assembly — this command prints exactly the files the loader actually imported:

```bash
node --input-type=module -e "import { loadDomain, createNodeIo } from './lib/domain-loader.js'; const io = await createNodeIo({ root: process.cwd() }); const r = await loadDomain(io, { id: 'requirement-alignment', dir: 'domains/requirement-alignment' }); console.log(r.problems.length ? r.problems.join(String.fromCharCode(10)) : 'pack OK — ' + r.files.join(', '));"
# pack OK — index.js, source.js, anchor.js, evidence.js, prompts.js, rules/*.md
```

A named import that the loader cannot resolve shows up here as `module load failed`, and the
plugin then silently falls back to the engine's generic text resolver — i.e. your verifier
never runs. `npm run test:imports` (`lib/imports-check.mjs`) checks every named import in the
repository resolves, which is the cheap version of the same check.

---

## 5. Fixtures: three mandatory boundaries, and keeping them honest

`MANDATORY_FIXTURES = ['empty', 'all-gated-out', 'happy-path']` — `lib/contracts.js:1044`,
enforced at `:1160-1162`.

`validateFixture` (`lib/contracts.js:1052`) further requires: lowercase kebab `name`, `domain`,
`format`, `input.format === fixture.format`, a non-empty `expect` block drawn from
`FIXTURE_EXPECT_FIELDS` (`:1047`) declaring at least one of `candidates` / `admitted` /
`throws`, and — if `anchors` is present at all — **at least one `positive` and one `negative`
case** (`:1078-1083`). That last rule applies to the empty fixture too: on an empty corpus the
only legal verdict is a refusal, so put the refusal in the `positive` bucket and say in the
note that it asserts a refusal, rather than inventing a confirmation.

**`all-gated-out` must hold under the pack's own gate.** A fixture that carries its own
`gate.exclude` proves only that the engine honours `options.exclude`; it does not prove your
domain refuses anything by default. That is `§1.4`, and the guard is one line:

```bash
node -e "const fs=require('fs');fs.readFileSync('domains/requirement-alignment/test.mjs','utf8').split(String.fromCharCode(10)).slice(345,352).forEach((l,i)=>console.log((346+i)+': '+l))"
# 346: test('the all-gated-out boundary holds under the PACK\'S OWN gate, with no fixture-supplied exclude', () => {
# 347:   // The failure this blocks: a fixture that narrows the gate itself proves only that
# 348:   // the engine honours `options.exclude`. It does not prove the domain excludes
# 349:   // retired chains by default, which is what a reader believes it proves.
# 350:   assert.ok(!Object.hasOwn(fixture('all-gated-out'), 'gate'),
# 351:     'the fixture must not carry its own gate — the boundary has to be the pack\'s')
```

The real casualty of this defect is documented in the reference domain, together with the
one-line-per-predicate repair:

```bash
node -e "const fs=require('fs');const show=(f,a,b)=>fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).slice(a,b).forEach((l,i)=>console.log(f+':'+(a+1+i)+': '+l));show('domains/code-review/index.js',43,56);show('domains/backend-engineering/index.js',31,38)"
# domains/code-review/index.js:44:   // reference domain's own boundary circular: the suite proved
# domains/code-review/index.js:45:   // "pack ∪ fixture drains the fixture", while the thing a boundary must prove is
# domains/code-review/index.js:46:   // "the PACK alone drains it". Measured with `docs/review-antipatterns.md` §1.4's
# domains/code-review/index.js:47:   // command, the real plan tool admitted exactly one candidate —
# domains/code-review/index.js:48:   // `generated/types.ts`, the pattern the fixture was quietly supplying.
# domains/code-review/index.js:49:   //
# domains/code-review/index.js:50:   // (The glob is written here as a line comment rather than inside the doc block
# domains/code-review/index.js:51:   // above because it contains the sequence that ends a block comment.)
# …
# domains/backend-engineering/index.js:32: const DOC_GATE = {
# domains/backend-engineering/index.js:33:   // `**/generated/**` is declared by the pack itself, not only by the fixture:
# domains/backend-engineering/index.js:37:   exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
```

Measure the three boundaries through the pack's own gate and enumerator:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { loadDomain, createNodeIo } from './lib/domain-loader.js'; import { gate } from './lib/engine.js'; const id = 'requirement-alignment'; const io = await createNodeIo({ root: process.cwd() }); const { pack } = await loadDomain(io, { id, dir: 'domains/' + id }); for (const name of ['empty', 'all-gated-out', 'happy-path']) { const v = JSON.parse(readFileSync('domains/' + id + '/fixtures/' + name + '.json', 'utf8')); const e = pack.candidateSource.enumerate(v.input.payload, { maxCandidates: 400, maxExcerptLines: 400 }); const g = gate(e.candidates, { include: pack.gate?.include, exclude: pack.gate?.exclude, extensions: pack.gate?.extensions ?? null }); console.log(name.padEnd(15), 'candidates=' + e.candidates.length, 'admitted=' + g.selected.length, 'excluded=' + g.excluded.length); }"
# empty           candidates=0  admitted=0  excluded=0
# all-gated-out   candidates=25 admitted=0  excluded=25
# happy-path      candidates=28 admitted=28 excluded=0
```

---

## 6. `gate.extensions` × the rules' `match` globs

There is **no engine constant named `GATE_EXTENSIONS`**. The name is a convention some packs
use for their own export (`domains/project-management/index.js:123`,
`domains/user-feedback/index.js:127`, private in `domains/requirement-alignment/index.js:118`).
What the engine reads is `pack.gate.extensions`, and it is consumed in two places: handed to
your enumerator (`index.js:1021-1026`) and handed to the gate's extension predicate
(`index.js:1070-1074`, predicate at `lib/engine.js:307`, matcher at `:377-382`). Every migrated
source documents that it deliberately does **not** apply the extension list itself —
`domains/requirement-alignment/source.js:150`, `domains/code-review/source.js:228`,
`domains/project-management/source.js:247`.

Two ways to get this wrong, both of which look green:

**(a) The nominal-support check that passes on a catch-all.** The pattern in the tree is:

```bash
node -e "const fs=require('fs');fs.readFileSync('domains/project-management/test.mjs','utf8').split(String.fromCharCode(10)).slice(344,370).forEach((l,i)=>console.log((345+i)+': '+l))"
```

It probes `prefix + extension` for each declared extension and requires at least one injected
rule. A single broad glob satisfies that floor for every extension, which is why the
strongest version of this check pins **exact** counts instead:

```bash
node -e "const fs=require('fs');fs.readFileSync('domains/algo-model/test.mjs','utf8').split(String.fromCharCode(10)).slice(1222,1243).forEach((l,i)=>console.log((1223+i)+': '+l))"
```

That table records `insideRules` / `outsideRules` per extension — including the `outsideRules: 0`
rows, which are the point: a rule family that matches nothing outside its own subtree is
coverage-shaped, not coverage. Its floor assertion is explicit about being a floor
(`inside.rules >= 1`, `:1242`) and sits *below* the exact numbers rather than replacing them.

**(b) The check that measures the wrong set.** Probe with paths your enumerator can actually
produce. A real, measured example from the tree — this command reports the extensions a
domain's own enumerator+gate will admit:

```bash
node --input-type=module -e "import { readFileSync, readdirSync } from 'node:fs'; import { loadDomain, createNodeIo } from './lib/domain-loader.js'; import { gate, selectRules } from './lib/engine.js'; const id = 'requirement-alignment'; const io = await createNodeIo({ root: process.cwd() }); const { pack } = await loadDomain(io, { id, dir: 'domains/' + id }); const rules = pack.ruleLibrary.rules; const produced = new Set(); const starved = []; for (const file of readdirSync('domains/' + id + '/fixtures').filter((f) => f.endsWith('.json'))) { const v = JSON.parse(readFileSync('domains/' + id + '/fixtures/' + file, 'utf8')); const e = pack.candidateSource.enumerate(v.input.payload, { maxCandidates: 400, maxExcerptLines: 400 }); const g = gate(e.candidates, { include: pack.gate?.include, exclude: pack.gate?.exclude, extensions: pack.gate?.extensions ?? null }); for (const c of g.selected) { produced.add(c.path.slice(c.path.lastIndexOf('.'))); if (selectRules(rules, [c.path]).injected.length === 0) starved.push(file + ':' + c.path); } } console.log('extensions produced: ' + [...produced].sort().join(' ')); console.log('declared-but-never-produced: ' + ((pack.gate?.extensions ?? []).filter((x) => !produced.has(x)).join(' ') || 'none')); console.log('admitted with zero rules: ' + (starved.length ? starved.slice(0, 5).join(', ') + ' (+' + (starved.length - 5) + ' more)' : 'none'));"
# extensions produced: .json
# declared-but-never-produced: .yaml .yml .md .csv
# admitted with zero rules: none
```

Read the second line carefully, because it is this document's most useful measurement:
`requirement-alignment` declares five gate extensions and its enumerator can only ever
produce `.json` candidates, so four of the five declarations are inert. Probing
`prefix + '.yaml'` (pattern (a)) would have reported a *starved* extension and sent you to
widen globs for documents your domain will never admit. Both statements come from the same
idea and only one of them is about your domain. **Probe the paths your enumerator produces,
then compare that set against what you declared**; and keep a second, declaration-level
check only if you also pin exact rule counts, so a catch-all cannot satisfy it.

---

## 7. `bundleKey`

The engine's `bundle()` groups by `entry.key` (`lib/engine.js:459`) and is unchanged by v2;
the key is derived by `resolveBundleKey` from `pack.bundleKey` (`lib/contracts.js:932`,
strategies at `:889-902`). The gate accepts exactly two forms:

* an object `{ strategy, ... }` whose `strategy` is one of `path` / `file` / `directory` /
  `extension`; or
* an object carrying `resolve(candidate)` for your domain's own grouping semantics
  (`lib/contracts.js:1149-1152`).

A string form is rejected (`:1147-1148`). `{ strategy: 'path' }` passes validation and is
still wrong when your domain has structure: it means one candidate per bundle, i.e. no
grouping at all. The accepted shape of the test is not "the object was applied" but "two
candidates that should share a bundle really do" — see `domains/requirement-alignment/test.mjs:1610-1621`.

`resolve` must be able to work from the **path alone**. The engine normalises every candidate
through `toCandidates`, which keeps a fixed set of fields and drops `meta`; a resolver that
reads `candidate.meta.sessionId` works in your unit test and silently falls back in the plugin.
Derive from the path and let an explicit candidate key win when one is present
(`lib/contracts.js:918-925`).

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { loadDomain, createNodeIo } from './lib/domain-loader.js'; import { resolveBundleKey, BUNDLE_KEY_STRATEGIES } from './lib/contracts.js'; const id = 'requirement-alignment'; const io = await createNodeIo({ root: process.cwd() }); const { pack } = await loadDomain(io, { id, dir: 'domains/' + id }); const v = JSON.parse(readFileSync('domains/' + id + '/fixtures/happy-path.json', 'utf8')); const e = pack.candidateSource.enumerate(v.input.payload, { maxCandidates: 400, maxExcerptLines: 400 }); const keys = e.candidates.map((c) => resolveBundleKey(pack, c, { strategies: {}, trustDeclaredStrategies: true })); console.log('declared strategy: ' + pack.bundleKey.strategy + (BUNDLE_KEY_STRATEGIES[pack.bundleKey.strategy] ? ' (built-in)' : ' (custom resolve)')); console.log('applied: ' + keys.every((k) => k.applied === true)); const groups = {}; keys.forEach((k) => { (groups[k.key] ??= []).push(1) }); console.log('bundles: ' + Object.keys(groups).length + ' over ' + keys.length + ' candidates; largest holds ' + Math.max(...Object.values(groups).map((g) => g.length)));"
# declared strategy: trace-chain (custom resolve)
# applied: true
# bundles: 2 over 28 candidates; largest holds 17
```

If your domain's structure is a plain directory (the diff-family domains), use the built-in
`{ strategy: 'directory', depth: 1 }` rather than a private name — `domains/backend-engineering/index.js`
and `domains/frontend-engineering/index.js` both do, so their grouping口径 matches the
reference domain's.

---

## 8. `anchor.js` — the tier rules

A verifier is `defineAnchorVerifier({ kind, verifyLevel, describe, verify })`
(`lib/contracts.js:431`) and returns
`{ status, tier, path, start, end, locator?, ambiguousIn?, detail? }`. `status` is `anchored`
or `unanchored` (`:286`). Every domain verdict passes `validateAnchorVerdict` (`:395`) at
`index.js:936`, and it is that validator which makes the two lists below load-bearing.

**Trusted** — `TRUSTED_ANCHOR_TIERS`, `lib/contracts.js:366`; an `anchored` verdict must use
one of these (`:402`):

| trusted | meaning |
|---|---|
| `declared-locator` | the claim's locator was independently confirmed against the subject |
| `declared-document` | the excerpt was found verbatim in the document the claim named — the *document* is confirmed, the locator is not consulted |
| `recomputed-unique` | the locator was absent or wrong, the excerpt resolved to exactly one place |
| `relocated-unique` | the excerpt was found in exactly one *other* document; the finding moved there |

**Untrusted** — the other nine entries of `ANCHOR_TIERS` (`lib/contracts.js:292-325`); an
`unanchored` verdict must use one of these (`:422`):

| untrusted | when |
|---|---|
| `sliding-window` | the consecutive-line matcher's INTERNAL hit marker (`lib/engine.js:143`) — the ladder re-tiers it before it can escape; never claim it as an anchor |
| `locator-mismatch` | the locator contradicts the input — the model is not trusted over the input |
| `no-excerpt` | the finding supplied no verbatim excerpt at all (`index.js:959`), so self-reported positions are not trusted |
| `invalid-verdict` | the returned verdict violated this contract and was downgraded, with the violations reported (`index.js:942`) |
| `relocation-ambiguous` | two or more equally valid locations — never guessed (must list them in `ambiguousIn`, `:424`) |
| `no-match` | nothing matched |
| `empty-excerpt` | the excerpt normalised to nothing |
| `kind-mismatch` | `claim.kind` ≠ `verifier.kind` |
| `no-documents` | no subject material was supplied |

*Audited against commit `c84f752` (`git log -1 --format=%h`) — the commit that closed the
anchor-tier vocabulary: `domain-locator` removed, and `declared-document`, `sliding-window`,
`no-excerpt`, `invalid-verdict` declared. The command below re-derives both tables from
`contracts.js`, so re-run it instead of trusting the date.*

### The two tables are a copy — let the command check them

`ANCHOR_TIERS` and `TRUSTED_ANCHOR_TIERS` are the source of truth; the tables above are a hand
copy of them, and a hand copy drifts in silence. This command reads both sets from the
contract, reads the tier names out of the tables above, scans the real producers, and prints
the three differences:

```bash
node --input-type=module -e "import { readFileSync, readdirSync } from 'node:fs'; import { ANCHOR_TIERS, TRUSTED_ANCHOR_TIERS } from './lib/contracts.js'; const BT = String.fromCharCode(96); const doc = readFileSync('docs/adding-a-domain.md', 'utf8'); const section = doc.slice(doc.indexOf('## 8.'), doc.indexOf('## 9.')); const row = new RegExp('^\\|\\s*' + BT + '([a-z][a-z-]*)' + BT + '\\s*\\|', 'gmu'); const inGuide = [...section.matchAll(row)].map((m) => m[1]); const files = [...readdirSync('domains').map((d) => 'domains/' + d + '/anchor.js'), ...readdirSync('lib').filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f), 'index.js']; const produced = new Map(); for (const file of files) { let text; try { text = readFileSync(file, 'utf8') } catch { continue } for (const m of text.matchAll(/tier:\s*'([a-z][a-z-]*)'/gu)) { if (!produced.has(m[1])) produced.set(m[1], []); produced.get(m[1]).push(file) } } const declared = Object.keys(ANCHOR_TIERS); const diff = (a, b) => a.filter((x) => !b.includes(x)); console.log('contract trusted   : ' + TRUSTED_ANCHOR_TIERS.join(', ')); console.log('contract declared  : ' + declared.join(', ')); console.log('guide table        : ' + [...inGuide].sort().join(', ')); console.log('declared, not in guide: ' + (diff(declared, inGuide).join(', ') || 'none')); console.log('in guide, not declared: ' + (diff(inGuide, declared).join(', ') || 'none')); console.log('produced, not declared: ' + ([...produced.keys()].filter((t) => !declared.includes(t)).map((t) => t + ' (' + produced.get(t)[0] + ')').join('; ') || 'none'));"
# contract trusted   : declared-locator, declared-document, recomputed-unique, relocated-unique
# contract declared  : declared-locator, declared-document, recomputed-unique, relocated-unique, sliding-window, locator-mismatch, no-excerpt, invalid-verdict, relocation-ambiguous, no-match, empty-excerpt, kind-mismatch, no-documents
# guide table        : declared-document, declared-locator, empty-excerpt, invalid-verdict, kind-mismatch, locator-mismatch, no-documents, no-excerpt, no-match, recomputed-unique, relocated-unique, relocation-ambiguous, sliding-window
# declared, not in guide: none
# in guide, not declared: none
# produced, not declared: none
```

How to read it: lines 1–2 are the contract, line 3 is this document. A non-empty
`declared, not in guide` or `in guide, not declared` means the copy drifted — fix the tables
above (or fix `contracts.js`, if the copy is right). A non-empty `produced, not declared` means
some producer returns a tier the vocabulary cannot describe; the code-side halves of that
question are pinned by `lib/kernel-test.mjs` §16 in both directions, so a hit here means the
guide and the kernel guard disagree. Run this whenever you change a tier anywhere.

### Which of these may your verifier return?

Two of the thirteen are not yours to produce, and two more are produced *for* you:

* **`declared-document` is legitimately yours.** It is what the engine's generic ladder
  reports when a pack declares no `anchorVerifier` at all (`lib/engine.js:194`) — the excerpt
  was found verbatim in the named document and the locator was never consulted. If your
  verifier confirms a document rather than a position, this is the honest tier for it.
* **`sliding-window` is not yours.** It is the internal hit marker of the consecutive-line
  matcher (`lib/engine.js:143`); the ladder re-tiers every hit as `declared-document` or
  `relocated-unique` before it can escape, and the marker must never reach a finding —
  `lib/kernel-test.mjs` §16 pins that. Measured: an `anchored` verdict carrying it is refused.
* **`no-excerpt` and `invalid-verdict` are the caller's outcomes, not a verifier's.** They are
  what the plugin records when a finding supplies no excerpt (`index.js:959`) or when a
  returned verdict fails `validateAnchorVerdict` and is downgraded (`index.js:942`). Do not
  return them; you would be describing your own output as a contract violation.

Measured, on the shipped contract:

```bash
node --input-type=module -e "import { validateAnchorVerdict } from './lib/contracts.js'; for (const tier of ['sliding-window', 'declared-document', 'invalid-verdict', 'no-excerpt']) { console.log(tier.padEnd(18) + 'anchored   -> ' + JSON.stringify(validateAnchorVerdict({ status: 'anchored', tier, path: 'a.json', start: 1, end: 2 }))); console.log(tier.padEnd(18) + 'unanchored -> ' + JSON.stringify(validateAnchorVerdict({ status: 'unanchored', tier, path: 'a.json' }))); }"
# sliding-window    anchored   -> ["anchored with untrusted tier \"sliding-window\""]
# sliding-window    unanchored -> []
# declared-document anchored   -> []
# declared-document unanchored -> []
# invalid-verdict   anchored   -> ["anchored with untrusted tier \"invalid-verdict\""]
# invalid-verdict   unanchored -> []
# no-excerpt        anchored   -> ["anchored with untrusted tier \"no-excerpt\""]
# no-excerpt        unanchored -> []
```

The vocabulary itself is pinned by measurement in **both** directions — every declared tier must
be returned by a real producer, and every tier a real producer names must be declared
(`lib/kernel-test.mjs:2547` §16; the two halves at `:2622` and `:2647`). That is how
`domain-locator` was removed: it had no producer a user could run, and an `anchored` verdict
with a non-line locator is legal with `declared-locator` under `lib/contracts.js:415-417`, so
the second name carried no capability. If you are about to add a tier, add the producer first
and then measure.

The engine's generic ladder is not routed through `validateAnchorVerdict` (`:395`, whose only
caller is `index.js:936`). That is why the ladder's own tiers had to be declared explicitly
rather than being caught by a validator at run time.

Notes that are easy to get wrong:

* `ANCHOR_TIERS` is an **object**, not an array. `ANCHOR_TIERS.includes(tier)` is not a
  membership test; use `Object.hasOwn(ANCHOR_TIERS, tier)` (`domains/requirement-alignment/test.mjs:297`).
* The equivalence `trusted ⇔ anchored` is worth asserting over every fixture case
  (`domains/requirement-alignment/test.mjs:587`), but note that only **one** direction is
  enforced: the validator rejects `anchored` with an untrusted tier (`lib/contracts.js:402`),
  and accepts `unanchored` with a trusted tier name (measured: `[]`). So
  "trusted ⇒ anchored" is your domain's own discipline — keep the assertion, and do not
  assume the engine is holding that half for you.
* `declared-locator` is inferred from the **locator's completeness**, never from a flag the
  caller sets. A tier that flips on `claim.declared` is a tier the model can forge.
* Candidate `path` values must match `/^[a-z0-9][a-z0-9._:/-]*$/u` (`lib/contracts.js:199`,
  enforced at `:244`). An uppercase filename — `src/Cart.tsx` — is rejected as an illegal
  path. Lower-case your fixture paths.
* Direct `verify()` calls test the verifier under ideal input. The claim that matters is that
  it can be reached **through the plugin**: `adjudication_anchor` must return
  `via: 'anchorVerifier'` for your domain, otherwise the engine's generic resolver answered
  and your code never ran. Pattern: `domains/requirement-alignment/test.mjs:1673`.

---

## 9. `prompts.js` — P4 and P6 are not the same text

`defineReviewPrompts({ review, verify })` (`lib/contracts.js:640`):

* `review(context) → { system, rules?, budget? }` — the P4 reviewer. It may see the work
  order: bundles, rule text, budget.
* `verify(context) → { system, instructions }` — the independent P6 reviewer. Its context is
  built from a fixed field list — domain, pack, target, orientation, findings — and nothing
  else: no rule text, no bundle, no budget (`lib/reasoner.js:630-638`). If P6 can read P4's
  assignment it is not an independent check.

**The validators check the prompt *functions*, not the prompt *text*.** That is layer 1 of a
two-layer gate, and the two layers catch different shapes: layer 1 is load-time and can only
see identity, layer 2 is run-time and compares the rendered documents.

*Layer 1 — load time (`lib/contracts.js:603-621`).* A validator has no context and therefore
cannot render; what it can compare is identity:

* one function object serving both roles is refused —
  `reviewPrompts.review and reviewPrompts.verify must be two different functions: P6 is an INDEPENDENT re-check…`
  (`lib/contracts.js:620`);
* two distinct functions are accepted even when their text agrees — `[]` from
  `validateReviewPrompts`, and `validateDomainPackV2` delegates to it at `lib/contracts.js:1133`.

*Layer 2 — run time, same context (`lib/reasoner.js:651-672`).* `runVerify` renders **both**
prompts from the same context and refuses a byte-identical pair with `E_P6_NOT_INDEPENDENT`
(`ran: false`), returning *before* `onCharge` and before the P6 child session is started — the
child is never started at all, not started-and-ignored. This is the half layer 1 deliberately
does not try to guess at.

The two layers are complementary, not redundant: layer 1 catches *one function doing both
jobs*, layer 2 catches *two different functions that render the same characters*. Neither of
them judges two *different* texts that ask the same question.

**Know when layer 2 is even reached** — it lives inside the P6 stage, which returns earlier in
two cases: no reasoner mounted (`if (!status.available)` — `lib/reasoner.js:608-611`, the
`E_NO_REASONER` path), and zero anchored findings (`:612-616`). So the gate can only ever speak
about runs that got as far as P6, and it never runs in your own `node test.mjs` unless you mount
a reasoner. It is a backstop, **not** a substitute for your own assertion — add this line next
to your other prompt assertions, where `p4`/`p6` are your two rendered documents:

```js
assert.notEqual(p6.system, p4.system)   // domains/requirement-alignment/test.mjs:1174
```

Both prompts run: `review()` via `renderReviewPrompt` (`lib/reasoner.js:139`), `verify()` via
the symmetric `renderVerifyPrompt` (`:143`) inside the P6 stage of `adjudication_submit`.
Degradation is explicit and must be stated rather than glossed: with neither `ctx.subagents`
nor `ctx.llm` mounted the run reports `mode: 'none'`, `ran: false` and an `E_NO_REASONER`
reason, and a pack without `reviewPrompts` gets the weaker `legacy-verify` text (`:159`).
P6's verdicts are reported, not applied — admission is still decided by the loss orientation
and the protected subjects.

---

## 10. The first defence line: ten ways this goes wrong with no red light

Every item below is a shape that has actually occurred in this package. The phenotype is
usually **a green suite**, which is why each one ends with how to notice.

### 10.1 Count coupling — "this package has exactly N domains"

**You will meet it as:** the first `npm test` after adding your domain turns red in eleven
files you do not own, none of which is about your domain.

The audit command is in §3 (it lists all sixteen sites). Coordinates here:
`lib/contracts.js:1428`, `contract-test.mjs:90`, three lines in `smoke-test.mjs`
(`:210`, `:347`, `:631`), and `assert.equal(listed.count, 19)` in eleven domain suites
(`domains/code-review/test.mjs:1418`, `domains/backend-engineering/test.mjs:948`, …).
Reviewer-side treatment: `§1.1`.

**Do this:** make *your* assertions count-free — compare the set of discovered domain ids to
the set of directories that actually exist under `domains/`, which is what `domains-test.mjs`
does when it discovers suites (`:61-87`). Then report the hard-coded 19 to whoever owns
`lib/` and `contract-test.mjs` instead of editing their files.

### 10.2 The global suite as your local verify

**You will meet it as:** a red `npm test` whose failing section is someone else's unfinished
domain, while your own suite is green.

Coordinates: `package.json:52` runs six suites in one `&&` chain;
`domains-test.mjs:94-95` fails the aggregate when any discovered domain fails.

**Do this:** `node domains/<id>/test.mjs` is your verify. Run `npm test` once your work is
finished, and read *which* section failed before concluding anything about your code.
`npm run test:contracts`, `npm run test:kernel`, `npm run test:mount` and
`npm run test:imports` are the narrower slices when you need one of them.

### 10.3 The "all gated out" boundary that only holds under the fixture's extra rules

**You will meet it as:** nothing. The boundary test is green, and the domain admits generated
code in production because the fixture was the only place the pattern existed.

Coordinates: `domains/code-review/index.js:44-56` narrates the measurement (the real plan tool
admitted exactly one candidate — the pattern the fixture was quietly supplying);
`domains/backend-engineering/index.js:32-38` and `domains/frontend-engineering/index.js:19-23`
are the repaired form; the guard is `domains/requirement-alignment/test.mjs:350`. Reviewer-side:
`§1.4`.

**Do this:** declare the exclusion in the pack's `gate.exclude`, assert
`!Object.hasOwn(fixture('all-gated-out'), 'gate')`, and additionally assert the boundary
through the plugin with the pack's own gate only —
`assert.equal(plan.gate.admitted, 0)` (`domains/backend-engineering/test.mjs:874`).

### 10.4 Nominal support: declared extensions that no rule can ever fire on

**You will meet it as:** a starved-extension report from a check you copied verbatim, or —
more often — nothing at all, because you copied it with a hard-coded probe prefix.

Coordinates and both directions of the defect: `domains/project-management/test.mjs:345-370`
(extensions with zero rules, and rules that can match nothing the gate admits),
`domains/algo-model/test.mjs:1223-1243` (exact inside/outside counts, with the subtree-zero
rows). Measured on the current tree: `requirement-alignment` declares
`['.json','.yaml','.yml','.md','.csv']` and its enumerator produces only `.json` candidates,
so four declarations are inert — see the command in §6. Reviewer-side: `§1.9`.

**Do this:** derive the probe from **your own enumerator** over the fixtures (the §6 command);
compare the produced set with the declared set; and, for each declared extension that *is*
produced, pin the exact rule count rather than a floor of one.

### 10.5 Tautological upper bounds

**You will meet it as:** a bound assertion that cannot fail — both sides computed by the
helper under test, or a limit so loose that any output satisfies it. `assert.ok(reviewed <= 3)`
is green for a coverage proof that reviewed nothing and green for one that reviewed three.

**Do this:** assert the exact number, or say in words why it is a bound. The in-tree pattern
records the distinction in the assertion message itself:

```bash
node -e "const fs=require('fs');fs.readFileSync('domains/algo-model/test.mjs','utf8').split(String.fromCharCode(10)).slice(945,950).forEach((l,i)=>console.log((946+i)+': '+l))"
# 946:   // therefore 2/5 — the number follows the input, it is not asserted into being.
# 947:   assert.equal(submitted.coverage.reviewed, 2, 'two distinct experiment records were reviewed')
# 948:   assert.ok(Number.isInteger(submitted.coverage.reviewed) && submitted.coverage.reviewed > 0, 'reviewed must be an exact count, not a bound')
# 949:   assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / submitted.coverage.total).toFixed(4)), 'the rate is exactly reviewed/total, not an upper bound')
```

Audit what you wrote:

```bash
node -e "const fs=require('fs');const f='domains/algo-model/test.mjs';let n=0;fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).forEach((l,i)=>{const s=l.trim();if(s.startsWith('//')||!s.includes('assert.ok(')||!s.includes('<='))return;n++;console.log('  '+f+':'+(i+1)+'  '+s.slice(0,96))});console.log('  ('+n+' bound assertions total)')"
#   domains/algo-model/test.mjs:1362  assert.ok(result.items.length <= tool.limits.maxItems, `${tool.name} returned more items than it
#   (1 bound assertions total)
```

Every hit is a question: which side is produced by the code under test, and what input would
make this false? If you cannot answer the second half, it is decoration. The single hit above
is the legitimate kind — an observed count bounded by a *declared* limit that
`lib/contracts.js:485-489` clamps into the engine's hard caps — and it is paired with an exact
equality on the next line. Reviewer-side: `§1.5`.

### 10.6 A bound that is declared tighter than the tool behaves

**You will meet it as:** nothing — the declaration reads as protection, and no test compares
it to the actual output. A tool declaring `maxItems: 1` while returning 40 items is an
unbounded tool with a reassuring comment.

Coordinates: the engine's hard caps are `EVIDENCE_LIMITS` (`lib/contracts.js:466-474`, hard
maxima 8 tools / 20 calls / 2000 lines / 1000 items / 256 KiB) and a declared limit is
normalised into them (`:485-489`). The measurement pattern is in the tree:

```bash
node -e "const fs=require('fs');fs.readFileSync('domains/algo-model/test.mjs','utf8').split(String.fromCharCode(10)).slice(1360,1370).forEach((l,i)=>console.log((1361+i)+': '+l))"
```

**Do this:** in your own `test.mjs`, drive each tool with a probe built from your happy-path
fixture and assert the *observed* count against the *declared* limit — exactly, when more
items were available:

```js
const result = await tool.execute(probeArgsFromHappyPath, {})
assert.ok(result.items.length <= tool.limits.maxItems, `${tool.name} returned more than it declares`)
assert.equal(result.items.length, tool.limits.maxItems)   // when the input had more to give
assert.deepEqual(Object.keys(result).sort(), ['items', 'provenance', 'truncated'])
```

Reviewer-side: `§1.11`.

### 10.7 A field whose name promises a set the code does not compute

**You will meet it as:** a downstream reader (a prompt, a report) treating the field as a
guarantee. `unmappedPaths` reads as "candidates that got no rule"; it was computed as "paths
minus one representative per injected rule", so it came back non-empty for essentially any
bundle with two or more paths — a warning that fired constantly and meant nothing.

Coordinates: the engine's own header records the change and the reproduction
(`lib/engine.js:524-533`, computation now at `:543-566`), and a domain prompt documents the
old reading and why it tolerated it (`domains/project-management/prompts.js:79-107`,
accessor at `:134-147`). Reviewer-side: `§1.10`.

**Do this:** for every field you put on a finding, a bundle or a report, write down the set it
names and the set the code computes, and make them the same sentence. If they differ, rename
the field rather than documenting the difference.

### 10.8 A mock whose service model differs from the host's — green on the degraded path

**You will meet it as:** a service-dependent assertion that passes while asserting the
*fallback*. The plugin reads an injected service as a **property** of the context
(`index.js:425-426`: `serviceSlots[name].value = serviceCtx[name]`, never `serviceCtx.get(name)`).
A mock whose `provide`/`set` only fill a Map, and whose `inject` special-cases one service name,
can never hand a service over: the plugin degrades to `mode: 'none'` and your "with
`ctx.subagents` mounted, activating adds the P4 tool" assertion measures the no-service surface.

Coordinates: the faithful mock is `lib/kernel-test.mjs:159-167` (`mounted[name] = services[name]`,
then `cb({ ...mounted, effect })`); the packaged mock now does the same — `smoke-test.mjs:99`
(`expose`, which writes the service to the context *and* the map) and its generic `inject`
branch — and pins both sides with the pair of assertions at `smoke-test.mjs:657`
(`DEGRADATION PATH`) and `:676` (`MAIN PATH`); the domain-level mock is
`domains/requirement-alignment/test.mjs:1557-1580`. Reviewer-side: `§4.2`.

**Do this:** when a test asserts anything driven by an optional service, first assert that the
service was actually seen (`reasoner.describe().mode === 'subagents'`), and keep a companion
assertion that the *absence* of the service produces the degraded surface. The pair is what
makes the trap visible; either one alone is compatible with the defect.

### 10.9 `import()` executes the module

**You will meet it as:** committed files rewritten, or a whole test suite running inside your
script and overwriting its exit code, because something imported a generator or a `test.mjs`.

Coordinates: the loader's injected module import is deliberate (`lib/domain-loader.js:348`);
the runner uses a child process, not an import (`domains-test.mjs:44`, `spawnSync` with
`stdio: 'inherit'`); every suite ends by setting the process exit status (e.g.
`domains/requirement-alignment/test.mjs:1939`); and the safe generator pattern lives in
`domains/user-feedback/_generate-util.mjs:32-36` (`isEntryPoint`) and `:69-71`
(`runEntry` returns `{ ran: false }` when imported), with `--check` as the default mode at
`:71` and writes confined to `writeRendered` at `:54-57`. Reviewer-side: `Appendix B`.

**Do this:** never `import()` a generator or a suite from another script. If you keep a
generator in the tree, gate it on `isEntryPoint`, make the harmless mode the default, and keep
all writes inside one function.

Notice it:

```bash
git status --porcelain    # every line is either something you typed or something a script wrote
```

Several files in this package are deliberately untracked, so the check is not "the list is
empty" but "you can account for every line": a modification you did not make on a tracked
file, or a rewritten file inside an untracked directory, is the signature.

### 10.10 A glob inside a block comment

**You will meet it as:** a syntax error at import time (`Unexpected token '.'`), or — worse —
a file that parses because the truncated comment happens to leave valid code behind. The
sequence that ends a block comment cannot appear inside one, and `**/` contains it.

Coordinates: both repaired forms are in the tree —
`domains/code-review/index.js:49-51` (the glob is written as a line comment for exactly this
reason) and `domains/requirement-alignment/source.js:197` (a glob written as
`experiments/<run>/*.json`). Reviewer-side: `Appendix A`.

**Do this:** in a block comment, describe a glob, do not write it. Notice it with a parse:

```bash
node --check domains/requirement-alignment/index.js && node --check domains/requirement-alignment/source.js && node --check domains/requirement-alignment/anchor.js && node --check domains/requirement-alignment/evidence.js && node --check domains/requirement-alignment/prompts.js && node --check domains/requirement-alignment/test.mjs && echo "all files parsed"
# all files parsed
```

`--check` parses without executing, so it also catches the case where the truncated comment
leaves valid code behind. The §4 load command catches the same defect from the other end
(`module load failed`).

---

## 11. The honesty premise

Rule libraries in this package are **drafted by an agent and flagged for expert review**. That
is a capability boundary, not a formality, and it is encoded:

```bash
node -e "const fs=require('fs');fs.readFileSync('lib/contracts.js','utf8').split(String.fromCharCode(10)).slice(666,672).forEach((l,i)=>console.log((667+i)+': '+l))"
# 667: export const RULE_PROVENANCE = Object.freeze({
# 668:   draftedBy: 'agent',
# 669:   expertValidated: false,
# 670:   requiresExpertReview: true,
# 671:   statement: '规则库由 agent 起草、标注 needs-expert-review: true，未经领域专家审定。任何交付物不得声称已通过专家验证。',
# 672: })
```

* `needs-expert-review: true` is required in every rule document's front matter and must be
  exactly `true` (`lib/contracts.js:814-815`); an HTML comment is refused (`:818`);
* `RULE_PROVENANCE.expertValidated` must stay `false` and `requiresExpertReview` must stay
  `true`, and the contract's own self-check fails if either changes (`:1451-1452`);
* no deliverable — README, tool description, prompt text, comment or report — may describe a
  draft library as expert-validated.

State the same thing where a human will read it, not only where a validator will: your
`adjudicate_<id>_rules` output, your prompt text, and your report. Then be equally precise
about what is **text** and what is **runtime**:

* the rule *library* is a draft: it is loaded, counted, injected and printed — it is not
  expert-endorsed;
* your P6 prompt *is* executed on a real path (`renderVerifyPrompt` → `runVerify`), but its
  verdicts are advisory: admission is still decided by the loss orientation and the protected
  subjects;
* your anchor tiers *are* recomputed by the engine on every submit, which is why an
  unanchored finding is excluded rather than merely flagged.

If any assertion in your suite can only check a delivered text (a prompt string, a summary
line, a README claim) rather than a runtime property, say so in the assertion message. A
reader must be able to tell "this is checked by execution" from "this is checked by reading".

---

## 12. Before you open the pull request

| # | command | expected |
|---|---|---|
| 1 | `node domains/<id>/test.mjs` | `N passed, 0 failed`, exit 0 |
| 2 | the §4 load command | `pack OK — index.js, source.js, anchor.js, evidence.js, prompts.js, rules/*.md` |
| 3 | the §5 fixture command | empty 0/0, all-gated-out `admitted=0`, happy-path `admitted=` your declared number |
| 4 | the §6 extension command | every produced extension has rules; declared-but-never-produced is a sentence you can defend |
| 5 | the §7 bundle-key command | `applied: true` and a largest bundle > 1 |
| 6 | the §10.10 `--check` chain | `all files parsed` |
| 7 | `npm run test:imports` | every named import resolves |
| 8 | `npm run test:contracts` | `0 failed` |
| 9 | `npm test` | every section `0 failed` (see §10.2 for a red that is not yours) |
| 10 | `git status --porcelain` | every line accounted for — see §10.9 |

If a step needs a number you cannot defend out loud — "admitted is 28 because the fixture has
28 candidates, and here is the fixture" — it is not evidence yet. The reviewer's document is
written for exactly that moment; this one exists so you arrive without it.
