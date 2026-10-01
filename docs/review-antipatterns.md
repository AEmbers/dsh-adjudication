# Review anti-patterns

**Who this is for.** Anyone adding a domain, a tool, a checker or a test to this
package. Everything here was learned by writing the nineteen domain packs that ship
today, and every pattern below reappeared at least twice in a place that was already
considered finished. The audience is the person who has not hit these yet.

**What this is not.** It is not a style guide, not a list of rules to obey blindly,
and not a description of any current defect. Every example is cited so it can be
re-opened, and every check is a command you can run yourself and disagree with.

**Scope of every command below.** They are written to run from the directory that
*contains* `dsh-adjudication/`, they need nothing but the Node.js the package already
requires, and they contain no backslashes so they survive copy-paste into any shell.

---

## The one question

Every form below is a variation of a single mistake:

> **The assertion describes what the author believed happened, not what must happen.**

So the working question for any assertion is not "does this look reasonable". It is:

> **Under what input does this assertion fail?**
> If the honest answer is "almost none", the assertion is empty.

Two follow-up questions catch the rest:

* **A correct fix changes this collection — will the assertion go red?** If yes, the
  assertion is pinned to the present rather than to a property. (Too tight.)
* **Can I construct an input that makes this false?** If not, the property is a
  tautology and the assertion above it proves nothing. (Unfalsifiable.)

---

## Taxonomy

Four sections, fifteen forms. The number in the first column is the section-local label
used by the headings, so `1.10` is the tenth form of the first section:

| # | Section | Form | One-line symptom |
|---|---|---|---|
| 1.1 | Too loose | Count/state coupling | asserts "the current members are exactly these" |
| 1.2 | Too loose | `skipped.length === 0` | writes "my siblings are all finished right now" as an assertion |
| 1.3 | Too loose | Global `npm test` as the local verify | a red result that cannot be attributed to anything |
| 1.4 | Too loose | All-gated-out on the fixture's extra rules | the fixture, not the pack, does the excluding |
| 1.5 | Too loose | Tautological upper bound | a bound satisfied by the empty case |
| 1.6 | Too loose | Unreachable refusal reason | the branch's precondition never holds in the corpus |
| 1.7 | Too loose | The refutation changed the kind | it proves a different sentence than the one under test |
| 1.8 | Too loose | Right shape, wrong input set | the assertion is about a hand copy of the inputs |
| 1.9 | Too loose | Nominal support | the declared set and the reachable set do not intersect |
| 1.10 | Too loose | The field's name promises a set the code does not compute | the value is right about a different question, so it warns on correct input |
| 1.11 | Too loose | An enforced bound that was never measured | the declaration is checked at runtime and the number is wrong |
| 2.1 | Too tight | "Exactly N items" | a correct fix goes red |
| 3.1 | Unfalsifiable | The property is a tautology | every fabricated input satisfies it |
| 4.1 | Methodology | Reachability | the question "has this ever run?" was never asked |
| 4.2 | Methodology | Green on the wrong path | the assertion *did* run — through a degraded branch it was not about |

**Too tight and too loose are the same disease.** Both point the assertion at the
*state of the world* instead of at a *property of the mechanism*:

* too loose: the property is so weak that everything satisfies it, so the assertion
  cannot fail;
* too tight: the property is a photograph of today's output, so the assertion fails
  for the wrong reason the moment anything real changes.

The cure is the same in both directions: **assert the relation, not the roster.**
"A is unchanged" beats "A is 19". "Every produced path is consumable" beats "these
seven producers are consumable". "At least one member of this bundle is not the
whole corpus" beats "this bundle holds exactly 5 entries".

The methodology section (4.1) sits underneath all of them: it is the question of
whether the code the assertion is about has ever run at all.

Two appendices follow the four sections. Neither is a form of this disease: one is a
mechanical trap in how a glob is written inside a comment, which has already appeared three
times in this package, and one is the wider discipline that grew out of a module whose
import rewrote the files it generates.

---

## 1. 太松 — too loose

### 1.1 Count/state coupling

**The sentence to ask.** "If a legitimate change alters this collection, does my
assertion go red — and would that be the right reason?"

**Real example.** `domains/code-review/test.mjs:1302`
(`assert.equal(listed.count, 19, 'replacement must not change the domain count')`),
and the same line in ten other domain suites. The command below prints all of them.

**Fix.** Assert the *relation the test is really about*: capture the value before the
operation and compare after.

```js
const before = ctx.adjudication.listDomains().length
// …the operation under test…
assert.equal(ctx.adjudication.listDomains().length, before,
  'registering a directory pack must replace, not add')
```

**Why it is more insidious than it looks.** It is not wrong today — 19 is correct
today. It is a *maintenance* assertion wearing a *correctness* assertion's clothes:
it stays green while the thing it claims to protect has already changed, and it goes
red only for the person who adds the twentieth domain, who then "fixes" it by
editing the number, which teaches the wrong lesson. It is also the first thing a
reader copies into a new domain.

**Reproduce.**

```bash
node -e "const fs=require('fs'),p='dsh-adjudication/domains';for(const d of fs.readdirSync(p)){const f=p+'/'+d+'/test.mjs';if(!fs.existsSync(f))continue;fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).forEach((l,i)=>{if(l.includes('listed.count,')||l.includes('listDomains().length,'))console.log('  '+d+'/test.mjs:'+(i+1)+'  '+l.trim())})}"
```

### 1.2 `skipped.length === 0`

**The sentence to ask.** "Is this value a property of the thing under test, or of
everything else in the directory right now?"

**Real example.** The domain runner (`domains-test.mjs`) exists so that a domain
landing a `test.mjs` needs no shared file edited. Its output is a statement about the
*directory*, not about any single domain:

```
domains: 0 ran, 0 failed, 2 skipped
  ⏭ finished — no test.mjs — the domain package is not covered by npm test
  ⏭ in-progress — no test.mjs — the domain package is not covered by npm test
```

An assertion of the form `assert.equal(result.skipped.length, 0)` in a domain's suite
is therefore asserting "every sibling of mine is complete at this instant". It is
green while the team is finished and red while a colleague is mid-edit, and in
neither case does it say anything about the domain.

**Fix.** Assert what the runner promises about *your* domain (`loaded` contains your
id, `skipped` does not contain it), or assert the invariant that holds in both
states: `loaded.length + skipped.length === accounted.size`.

**Why it is more insidious than it looks.** A red result caused by a colleague's
half-written directory gets recorded as *your* regression, and the natural response
is to relax the assertion — which is how a real invariant gets deleted.

**Reproduce.** Two directories, neither with a `test.mjs`; the runner reports both as
skipped *with a reason*, which is the honest form of the same information.

```bash
node -e "const fs=require('fs'),os=require('os'),cp=require('child_process');const root=fs.mkdtempSync(os.tmpdir()+'/siblings-');fs.mkdirSync(root+'/finished');fs.mkdirSync(root+'/in-progress');console.log('scratch root: '+root);cp.spawnSync(process.execPath,['dsh-adjudication/domains-test.mjs',root],{stdio:'inherit'})"
```

### 1.3 Global `npm test` as the local verify

**The sentence to ask.** "If this command goes red, how do I know which domain is
at fault without reading the whole log?"

**Real example.** `package.json` chains six suites:

```
node contract-test.mjs && node lib/imports-check.mjs && node lib/kernel-test.mjs
  && node domains-test.mjs && node smoke-test.mjs && node mount-test.mjs
```

Nineteen domains and six suites in one stream. A domain author using this as their
verify step cannot attribute a failure, and will spend the first ten minutes of every
red build looking in the wrong directory.

**Fix.** The verify for a domain is
`node dsh-adjudication/domains/<id>/test.mjs`. Keep the package-level run for the
moment when you believe you are done. The domain runner takes the same shape: it
reports per-domain results and repeats the failing list at the end.

**Why it is more insidious than it looks.** The aggregate command *is* the one CI
runs, so it feels like the authoritative one. The cost is invisible until the first
unrelated red, and by then the habit is set. The generalisation is worth stating
explicitly: a verify step that cannot attribute a failure is also a verify step whose
**green** result cannot be trusted — it just happens to be right for the wrong reason.

**Reproduce.** A scratch root with one passing and one failing domain: the runner
names the failing one, which the aggregate command cannot do.

```bash
node -e "const fs=require('fs'),os=require('os'),cp=require('child_process');const root=fs.mkdtempSync(os.tmpdir()+'/attrib-');fs.mkdirSync(root+'/green');fs.mkdirSync(root+'/broken');const NL=String.fromCharCode(10);fs.writeFileSync(root+'/green/test.mjs','process.exitCode=0'+NL);fs.writeFileSync(root+'/broken/test.mjs','process.exitCode=1'+NL);console.log('package.json test chain: '+require('./dsh-adjudication/package.json').scripts.test);cp.spawnSync(process.execPath,['dsh-adjudication/domains-test.mjs',root],{stdio:'inherit'})"
```

### 1.4 "All gated out" only under the fixture's extra rules

**The sentence to ask.** "Does this fixture reach its conclusion using the pack's own
gate, or a rule the pack does not declare?"

**Real example.** Two shapes are live in the repository today, and the command below
prints both.

* A fixture that carries excludes the pack does not declare, e.g. a fixture adding
  `**/archive/**` or `**/generated/**` while the pack's own `DOC_GATE` lists only
  `.git`, `dist` and `build`. The fixture then proves that the *engine honours
  `options.exclude`*, not that the domain excludes anything by default.
* A fixture whose exclusion depends on a gate field the pack never sets, e.g.
  `domains/data-engineering/fixtures/all-gated-out.json` carries
  `"gate": {"maxFileBytes": 200}` with `expect.admitted: 0`. The pack's gate has no
  `maxFileBytes`, so the same corpus goes through a different gate than the one the
  fixture describes. Its companion assertion is the weak form too — see
  `domains/data-engineering/test.mjs:351`, which asserts only that *something* was
  excluded.

The correct shape is the one that landed in the diff-extension family: the pattern
lives in the pack, `domains/backend-engineering/index.js:37` and
`domains/frontend-engineering/index.js:23` both declare `**/generated/**` in their own
`DOC_GATE`, with a comment saying why a fixture-supplied pattern would not do.

**Fix.** Move every pattern the fixture relies on into the pack's gate, and assert
`plan.gate.admitted === 0` through the real plan tool — not through a gate object the
test built. Assert the *predicate* that fired for each path, so a change in which
rule fires is visible rather than silent. For `maxFileBytes`, decide whether the pack
should own the limit; if it should not, the fixture has to demonstrate exclusion
without it.

**Why it is more insidious than it looks.** The fixture's own gate field looks like
test configuration, so nobody reads it as a claim about the product. The suite is
green, the boundary is named `all-gated-out`, and the one number a reader would check
(`admitted: 0`) was produced by the test's own gate. The command below finds five
domains where the same corpus does *not* reach zero on the pack's gate alone.

**Reproduce.** The plan goes through the real plugin and the pack's own gate; only
the fixture's extra patterns are reported separately.

```bash
node --input-type=module -e "import fs from 'node:fs';import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const L=await import(pathToFileURL(R+'lib/domain-loader.js').href);const {apply}=await import(pathToFileURL(R+'index.js').href);const io=await L.createNodeIo({baseUrl:pathToFileURL(R).href});const tools=new Map();const ctx={logger:{warn:()=>{},info:()=>{},error:()=>{}},tools:{register:async(d)=>{tools.set(d.name,d);return()=>tools.delete(d.name)}},effect:(fn)=>{const g=fn();const ds=[];if(g&&typeof g.next==='function'){let r=g.next();while(!r.done){const y=r.value;if(y&&typeof y.then==='function')y.then((d)=>{if(typeof d==='function')ds.push(d)});else if(typeof y==='function')ds.push(y);r=g.next()}}return()=>{while(ds.length){const d=ds.pop();try{d()}catch{}}}},provide:(k,v)=>{ctx[k]=v},set:(k,v)=>{ctx[k]=v},inject:()=>{},on:()=>()=>{},systemPrompt:{section:()=>()=>{}}};await apply(ctx,{domainIo:io,domainRoot:'domains'});await tools.get('adjudication_domains').execute({},{});let flagged=0;for(const id of fs.readdirSync(R+'domains')){const f=R+'domains/'+id+'/fixtures/all-gated-out.json';if(!fs.existsSync(f))continue;const fx=JSON.parse(fs.readFileSync(f,'utf8'));await tools.get('adjudication_activate').execute({domain:id},{});const plan=await tools.get('adjudicate_'+id.split('-').join('_')+'_plan').execute({target:'gated',input:{format:fx.input.format,payload:fx.input.payload}},{});const pack=ctx.adjudication.getDomain(id);const extra=(fx.gate?.exclude||[]).filter((x)=>!(pack.gate?.exclude||[]).includes(x));if(plan.gate.admitted!==0||extra.length>0)flagged++;console.log('  '+id+': admitted-by-PACK-GATE='+plan.gate.admitted+' fixture-added-excludes='+JSON.stringify(extra))}console.log('  domains where the all-gated-out fixture does not hold on the pack gate alone: '+flagged)"
```

### 1.5 Tautological upper bound

**The sentence to ask.** "What value does the left-hand side actually take, and how
far is it from the bound?"

**Real example.** `domains/risk-compliance/test.mjs` used to assert
`assert.ok(submitted.coverage.reviewed <= 3)`. The measured value was `0` — the engine
had rejected every finding — so the assertion was satisfied by the worst possible
outcome. The fixed form is at `domains/risk-compliance/test.mjs:1208-1217`: it now
asserts the exact count, the exact rate derived from that count, and separately that
the single unanchored item is the paraphrase and is refused as `no-match`. A vacuous
bound was replaced by two assertions that separate the real states.

**Fix.** Assert the exact value when the fixture determines it, and add a second
assertion that *distinguishes the two outcomes you care about* ("exactly one item is
unanchored, it is this one, and its tier is this"). Bounds belong on tool limits, not
on outcomes.

**Why it is more insidious than it looks.** An upper bound reads as a safety
property, so it looks *more* rigorous than an equality. The tell is that its
satisfying set includes the empty and the zero case. It is also self-concealing: the
number you would need to check it is exactly the number the test never prints, so the
reader has to go and measure.

**Reproduce.** Every `assert.ok(… <= <literal>)` in the suite, excluding comment
lines and the comparisons against a tool's *declared* limit (those are legitimate).
Note how many of them are the same shape as the one that was wrong; the only way to
tell them apart is to measure the left-hand side.

```bash
node -e "const fs=require('fs'),p='dsh-adjudication/domains';for(const d of fs.readdirSync(p)){const f=p+'/'+d+'/test.mjs';if(!fs.existsSync(f))continue;fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).forEach((l,i)=>{const s=l.trim();if(s.startsWith('//')||!s.includes('assert.ok(')||!s.includes('<='))return;console.log('  '+d+'/test.mjs:'+(i+1)+'  '+s.slice(0,96))})}"
```

### 1.6 Unreachable refusal reason

**The sentence to ask.** "What input makes this branch fire — and is that input in my
corpus?"

**Real example.** A verifier's refusal vocabulary is only as real as the corpus that
drives it. `domains/project-management/anchor.js` can refuse with `no-match` and
`relocation-ambiguous`, but both are reachable **only when the claim does not declare
its constituent ids** (`recompute()`, `domains/project-management/anchor.js:440-502`).
A battery in which every claim carries a full `locator` can never reach them.

**Fix.** Build one case per reason, and prefer cases that differ *only* in the
precondition the reason depends on: same document, same claim kind, one with the
locator's constituent ids and one with only an excerpt. Then assert the reason, not
merely "unanchored".

**Why it is more insidious than it looks.** Every negative test passes, the coverage
number looks healthy, and the missing branch is invisible — the tier list still
*declares* the reason, so a reader assumes it is exercised. A refusal path that has
never run is indistinguishable from a refusal path that cannot run.

**Reproduce.** The same fixture battery, twice: as written, and with each locator's
constituent fields stripped to leave only its `kind`. The reasons that appear only in
the second histogram are the ones the first battery cannot reach.

```bash
node --input-type=module -e "import fs from 'node:fs';import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const A=await import(pathToFileURL(R+'domains/project-management/anchor.js').href);const fx=JSON.parse(fs.readFileSync(R+'domains/project-management/fixtures/happy-path.json','utf8'));const all=[...fx.anchors.positive,...fx.anchors.negative];const hist=(strip)=>{const m={};for(const c of all){const loc=strip?{kind:c.claim.locator.kind}:c.claim.locator;const v=A.verify({kind:'task-and-edge',path:c.claim.path,locator:loc,excerpt:c.claim.excerpt},c.subject);m[v.tier]=(m[v.tier]||0)+1}return m};console.log('  locator declared as written: '+JSON.stringify(hist(false)));console.log('  locator stripped to its kind: '+JSON.stringify(hist(true)))"
```

### 1.7 The refutation used a different kind

**The sentence to ask.** "Does my refuting case use the *same* claim kind as the
confirming case it is supposed to refute?"

**Real example.** `domains/project-management/fixtures/happy-path.json` carries both
a confirming family and a refuting family over `task-edge`; at least one refuting
entry also uses a kind the verifier does not define, which is fine as an *extra* case
but would prove nothing as the *only* one. The command below shows the trap directly:
three structurally different claims that share one undefined `kind` all come back
`unanchored/kind-mismatch`. That assertion can never fail for the reason its author
intended.

**Fix.** Refute with the same kind and a genuinely different payload: right kind,
wrong constituents; right constituents, wrong document. Keep "unknown kind is
refused" as a separate, plainly-named case.

**Why it is more insidious than it looks.** The refuting table *exists*, has the
right number of rows, and every row is red — the shape of a well-tested claim. What
is wrong is what the rows are about. This is the failure mode where having a
refutation table is not enough: the table itself can be fake, because its rows test a
different sentence.

**Reproduce.**

```bash
node --input-type=module -e "import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const A=await import(pathToFileURL(R+'domains/project-management/anchor.js').href);const doc={path:'g/plan.json',payload:{idSpace:['T1'],tasks:[{id:'T1',title:'a'}]}};for(const k of ['not-a-kind','still-not','nope']){const v=A.verify({kind:'task-and-edge',path:'g/plan.json',locator:{kind:k,from:'T1',to:'T2'}},{path:'g/plan.json',documents:[doc]});console.log('  three different claims, kind='+k+' -> '+v.status+'/'+v.tier)}console.log('  identical verdicts: this proves only that unknown kinds are refused.')"
```

### 1.8 Right shape, wrong input set

**The sentence to ask.** "Where did the inputs in this assertion come from — the
filesystem, or the author's memory?"

**Real example.** `domains/requirement-alignment/test.mjs:713-721` keeps a
hand-written table of sibling domains. It is honest about being a *representative*
subset, but every hand-written table is a snapshot: it can name a producer that no
longer exists, and — worse — it silently *omits* one that does. The domain's own
exhaustive check is the right shape and is worth copying:
`domains/requirement-alignment/test.mjs:821-853` reads `domains/`, runs each
producer's own enumerator, and fails when reality drifts from the pinned table. The
same file records the other half of the lesson at `:751-754`: the assertion has to
cover **every** produced path, not a `slice(0, 3)`, because the first three being
right is exactly how the rest stays wrong.

**Fix.** Derive the input set from its source of truth (the directory, the
enumerator, the registry). If a pinned expectations table is genuinely needed, keep
it beside an assertion that reads the source and reports drift, so the table cannot
rot quietly.

**Why it is more insidious than it looks.** The assertion's *shape* is exactly right
— it iterates, it checks each item, it has a good message — so it reads as thorough.
Nothing distinguishes "I checked every producer" from "I checked the producers I
remembered" except where the list came from. A missing entry produces no red and no
log line; the suite simply covers less than its name claims.

**Reproduce.**

```bash
node --input-type=module -e "import fs from 'node:fs';const R='dsh-adjudication/domains/';const real=fs.readdirSync(R,{withFileTypes:true}).filter((e)=>e.isDirectory()&&!e.name.startsWith('_')&&!e.name.startsWith('.')).map((e)=>e.name);const src=fs.readFileSync(R+'requirement-alignment/test.mjs','utf8');const a=src.indexOf('const SIBLINGS = [');const b=src.indexOf(']',a);const block=src.slice(a,b);const table=[...new Set(block.split('id: ').slice(1).map((x)=>x.split(String.fromCharCode(39))[1]))];console.log('  producers on disk: '+real.length);console.log('  the hand-written SIBLINGS table names: '+table.length+' -> '+table.join(', '));console.log('  table entries with no directory: '+JSON.stringify(table.filter((id)=>!real.includes(id))));console.log('  a copy is a snapshot: an exhaustive claim has to read the directory.')"
```

### 1.9 Nominal support

**The sentence to ask.** "I declare support for this input type — which rule,
checker or tool can actually fire on it?"

**Real example.** A pack declares the extensions it reads and, separately, the path
globs its rules match. Those two sets are written by different people at different
times, and nothing compares them. The command below finds every pack where a declared
extension has **no rule glob that can match it**: today that is `algo-model`
(`domains/algo-model/index.js:58` declares `.json/.md/.csv/.yaml/.yml/.txt` while its
rules match only `**/*.json` and `**/experiments/**`), `market-research`
(`domains/market-research/index.js:81` declares `.md/.txt/.json`, rules match
`**/*.md` and `**/sources/**`), `reverse-engineering`, `requirement-alignment` and
`backend-engineering`. The product-level effect is visible in the plan: a document of
a starved extension is admitted, and every bundle it lands in gets
`rules: []` with an empty `ruleText`.

**Fix.** Make the two sets agree, in whichever direction is honest. Either add the
extension to the rules' `match`, or narrow the gate and write down why the format is
not supported. (A gate that is deliberately broad "just in case" is the one to
reconsider: it converts "unsupported" into "supported but unguarded", which is worse
than refusing.) When the enumeration can only ever produce one extension, say so at
the gate rather than leaving the others looking supported.

**Why it is more insidious than it looks.** Both halves are individually correct and
individually tested: the gate test asserts the gate admits the right files, the rule
test asserts the rules match the right paths. Neither test can see the empty
intersection, because the intersection is not an object in the codebase — it is the
absence of one. The failure is silent by construction: zero rules injected produces
no warning, and the nearest field that could have carried the evidence,
`plan.bundles[].unmappedPaths`, was itself wrong about its own question — it fired on
almost every multi-path bundle (measured: 56 of 57 real multi-path inputs), so a
non-empty value there cannot be read as evidence of anything (1.10). Evidence has to
be published on a channel that stays quiet when nothing is wrong: a bundle whose
injected rule list is empty says `注入规则 [无]` in the plan itself, because that is a
statement about this bundle and not a side effect of how many paths it happens to hold.

**Reproduce.**

```bash
node --input-type=module -e "import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const L=await import(pathToFileURL(R+'lib/domain-loader.js').href);const io=await L.createNodeIo({baseUrl:pathToFileURL(R).href});const {packs}=await L.loadDomains(io,{root:'domains'});for(const p of packs){const exts=p.gate?.extensions||[];const globs=(p.ruleLibrary?.rules||[]).flatMap((r)=>r.match||[]);const coversAll=globs.includes('**/*')||globs.includes('**');const starved=exts.filter((e)=>!coversAll&&!globs.some((g)=>g.includes(e)));if(starved.length>0)console.log('  '+p.id+': gate admits '+exts.length+' extensions '+JSON.stringify(exts)+' but no rule glob can match '+JSON.stringify(starved))}"
```

---

### 1.10 The field's name promises a set the code does not compute

**The sentence to ask.** "What does the name of this field promise, and what does the
code that fills it actually compute **on the common case** — not on the empty case the
author had in mind?"

**Real example.** `lib/engine.js` `selectRules()` returns `unmapped`, surfaced as
`plan.bundles[].unmappedPaths` (`index.js` — `paths`, `rules`, `ruleText`,
`unmappedPaths` per bundle) and read by consumers as "the paths no rule covers". It was
computed as **one representative path per rule** — `matched.add(hits[0])` — not as "every
path a rule matched". Every rule of a family shares the same `match` globs, so every rule
re-found the same first path and the same single path was marked over and over.

Measured on this repository's own fixtures — 57 multi-path inputs, with that one marking
line put back and nothing else changed:

| | multi-path inputs | disagreements | e.g. `requirement-alignment/happy-path` |
|---|---|---|---|
| current | 57 | **0** | `unmappedPaths=[]`, truth `[]` |
| `matched.add(hits[0])` | 57 | **56** | 23 of 28 paths reported unmapped, truth `[]` |

The minimal case is smaller than it looks: three paths and two rules that both match all
three → `unmappedPaths = ["p/two.json","p/three.json"]` while every path is matched. The
trigger is not exotic data — it is **more paths than injected rules**, which every
multi-member bundle has.

**Fix.** Compute the field from what the rules actually matched, over the rules that were
actually injected: mark **every** hit of each injected rule, then take the difference.
Duplicate-named rules never inject, so they must not be able to mark a path either. Then
assert the field against an independently recomputed truth set, not against a number
(see **Reproduce**).

**Why it is more insidious than it looks.** Both halves are individually right: the
matching works, the field is wired up, and the value is non-empty exactly when the author
expected a warning. The defect is in the *direction* of the error: the field was not
silently empty, it was **loudly wrong** — a warning produced by correct behaviour. Any
consumer that writes the obvious assertion ("if `unmappedPaths` is non-empty, warn") ends
up warning about almost every bundle, and a warning that fires on correct input is how a
codebase learns to ignore warnings. **A field that permanently misfires is worse than no
field at all**: the absent field forces the caller to compute the answer, while the wrong
field lets the caller believe it already has it.

**Boundary that must not move.** With no rule injected the answer is still "every path is
unmapped" (`injected` empty ⇒ nothing marked). That is the honest reading, and it is why
the one-line revert above could not be caught by the assertions that had been written
about *that* shape: the empty-injection case is right in both versions. The case that was
wrong is the case with **more paths than rules**.

**Reproduce.**

```bash
node --input-type=module -e "import {pathToFileURL} from 'node:url';import fs from 'node:fs';const R='dsh-adjudication/';const L=await import(pathToFileURL(R+'lib/domain-loader.js').href);const E=await import(pathToFileURL(R+'lib/engine.js').href);const io=await L.createNodeIo({baseUrl:pathToFileURL(R).href});const {packs}=await L.loadDomains(io,{root:'domains'});let n=0,bad=0,nonEmpty=0;for(const p of packs){const dir=R+'domains/'+p.id+'/fixtures';if(!fs.existsSync(dir))continue;const rules=p.ruleLibrary?.rules??[];for(const f of fs.readdirSync(dir).filter((x)=>x.endsWith('.json'))){const j=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'));if(j.input===undefined)continue;let res;try{res=await p.candidateSource.enumerate(j.input.payload,{})}catch{continue}const paths=[...new Set((res.candidates??[]).map((c)=>c.path))];if(paths.length<2)continue;n++;const r=E.selectRules(rules,paths);const truth=paths.filter((x)=>E.selectRules(rules,[x]).injected.length===0);if(truth.length>0)nonEmpty++;if(JSON.stringify(r.unmapped)!==JSON.stringify(truth)){bad++;console.log('  DISAGREES '+p.id+'/'+j.name+'  reported='+JSON.stringify(r.unmapped)+'  truth='+JSON.stringify(truth))}}}console.log('  '+n+' multi-path inputs checked, '+bad+' disagreement(s); '+nonEmpty+' of them have at least one genuinely unmapped path (the field is not vacuous)')"
```

Reported versus self-recomputed, on real inputs, including the five where the answer is
legitimately non-empty. The second column of the table above is this command run against
the same tree with `matched.add(hits[0])` restored.

---

### 1.11 A bound that is enforced and was never measured

**The sentence to ask.** "Is this declared number checked anywhere at runtime — and if it
is, has anyone ever **measured** the quantity it is checked against?"

**Real example.** `domains/market-research/evidence.js` declares, for its `source_card`
tool, `limits: { maxLines: 40, maxItems: 40, maxBytes: 8192, maxCalls: 6 }`. It previously
declared `maxItems: 1` while the implementation returns **one item per line read**, i.e. up
to `maxLines`. The engine checks every real result against that declaration (`index.js`
calls `validateEvidenceResult(result, spec.limits)`; the check lives in `lib/contracts.js`),
so a card read of more than one line came back carrying

> `⚠️ 结果不符合契约：result.items length 40 exceeds maxItems 1`

— a contract violation reported for a completely correct call. Measured with a 61-line
card: with today's declaration `problems` is `[]`; with `maxItems: 1` it is
`["result.items length 40 exceeds maxItems 1"]`, on exactly the same result. The identical
declaration was fixed in `domains/reverse-engineering/evidence.js` (`note_excerpt`).

The contrast worth keeping is in the same file: `sample_identity` declares `maxItems: 1`
and that number is **right**, because the tool compares exactly one declared hash against
one registered artifact. The bound is not "tight" there — it is derived from the
construction, and because it makes the truncation branch unreachable, the code says so and
the test asserts both the count and the reason. Same number, opposite conclusion: the
defect was never the size of the bound, it was that nobody asked where the number came
from.

**Fix.** Declare what the implementation can actually return, and derive the declaration
from the code that produces the result rather than from intuition about it. When a bound
makes a branch unreachable, say so where the branch lives; do not delete the branch and do
not leave it looking exercised.

**Why it is more insidious than it looks.** The declaration *is* checked, and the checker
is correct — which is exactly why this was invisible. Every static validator asks whether
the declaration is *admissible* (a positive integer, within the engine's hard ceiling), and
none of them asks whether it is *true*: the declaration is only ever compared with itself.
The one place it meets reality is the runtime result check, and that check fires **only
when a call exceeds the bound** — so the defect looks like a per-call data problem, not
like a wrong number. A bound that lives only in a declaration, a description string and a
validator is a number nobody has ever cut the code with.

**Reproduce.**

```bash
node --input-type=module -e "import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const E=await import(pathToFileURL(R+'domains/market-research/evidence.js').href);const C=await import(pathToFileURL(R+'lib/contracts.js').href);const tool=E.tools.find((t)=>t.name==='source_card');const content=['strength = primary',...Array.from({length:60},(_,i)=>'evidence line '+(i+1))].join(String.fromCharCode(10));const r=tool.execute({path:'research/x/card.md',documents:[{path:'research/x/card.md',content}]});console.log('  declared maxItems='+tool.limits.maxItems+'  declared maxLines='+tool.limits.maxLines+'  observed items='+r.items.length+'  truncated='+r.truncated);console.log('  problems with TODAY declaration : '+JSON.stringify(C.validateEvidenceResult(r,tool.limits)));console.log('  problems with the OLD maxItems:1 : '+JSON.stringify(C.validateEvidenceResult(r,{...tool.limits,maxItems:1})))"
```

The tool is driven past its own declared bound and the result is checked against both the
shipped declaration and the old one — the disagreement is the defect, and it shows up as a
warning attached to a correct answer rather than as a failure.

---

## 2. 太紧 — too tight

### 2.1 "Exactly N items"

**The sentence to ask.** "If a correct fix changes this collection, does the
assertion go red?"

**Real example.** `domains/product-planning/test.mjs:177` asserts
`assert.equal(evidence.tools.length, 2)`, and
`domains/backend-engineering/test.mjs:208` together with
`domains/frontend-engineering/test.mjs:208` assert
`assert.equal(evidence.tools.length, codeReviewEvidence.tools.length + 1, 'exactly one tool is this domain's own')`.
Both are photographs of the current toolkit. The third one is especially instructive:
it *looks* like a relationship rather than a constant, but its right-hand side is
still "one more than today".

**Fix.** Assert the properties the tool set is supposed to have: the reused names are
present (set inclusion), every tool declares all four limits, no two tools share a
name, at least one tool is not part of the reused set. Inclusion and bounds carry the
meaning; cardinality does not.

**Why it is more insidious than it looks.** Unlike a vacuous assertion, this one
fails — just for the wrong reason. The person who adds a second domain-specific tool
gets a red build, reads the message `exactly one tool is this domain's own`, and
learns that adding tools is not allowed. Nothing in the message says "this assertion
pins the present"; the cost is paid in a future change that should have been easy.

**Reproduce.**

```bash
node -e "const fs=require('fs'),p='dsh-adjudication/domains';for(const d of fs.readdirSync(p)){const f=p+'/'+d+'/test.mjs';if(!fs.existsSync(f))continue;fs.readFileSync(f,'utf8').split(String.fromCharCode(10)).forEach((l,i)=>{const k=l.indexOf('.tools.length,');if(k<0)return;const rhs=l.slice(k+14).trim();if(rhs[0]>='0'&&rhs[0]<='9'||rhs.includes('.length +'))console.log('  '+d+'/test.mjs:'+(i+1)+'  '+l.trim())})}"
```

---

## 3. 不可证伪 — unfalsifiable

### 3.1 The property is a tautology

**The sentence to ask.** "Write down the input that makes this false. If I cannot,
what is the assertion proving?"

**Real example.** A claim kind of the form "this id is absent from the graph" is
*disfigured by construction*: it holds for every id that is absent, and it is the
absence that is the whole content of the kind. The command below feeds 200
independently fabricated ids to such a kind in `domains/project-management/anchor.js`
(`ANCHOR_KINDS`, `domains/project-management/anchor.js:86-88`) and gets **one**
distinct verdict — `anchored` — every time. Such a case cannot distinguish a real
finding from a randomly generated string.

**Fix.** For every claim kind, ship a **refuting** case alongside the confirming one,
and make the refuting case fail for a *structural* reason: a kind that is true of
anything is a kind that cannot be evidence. If a kind is genuinely useful as a
"notice this absence" signal, that is fine — but it must not be the thing that
carries a finding into the report, and the test must say so.

**Why it is more insidious than it looks.** Tautologies are *green and specific*.
The verdict is `anchored`, the detail text is fluent and correct-sounding, and the
assertion passes on every run. The only way to notice is to ask what would falsify
it — which is why the REQUEST FOR A REFUTATION TABLE, and then the check that the
table refutes *this* kind, are two separate disciplines.

**Reproduce.**

```bash
node --input-type=module -e "import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';const A=await import(pathToFileURL(R+'domains/project-management/anchor.js').href);const doc={path:'g/plan.json',payload:{idSpace:['T1'],tasks:[{id:'T1',title:'a'}]}};const seen=new Set();for(let i=0;i<200;i++){const id='ghost-'+i;seen.add(A.verify({kind:'task-and-edge',path:'g/plan.json',locator:{kind:'hedged-target',targetId:id}},{path:'g/plan.json',documents:[doc]}).status)}console.log('  200 independently fabricated ids -> distinct verdicts: '+seen.size+' ('+[...seen].join(', ')+')')"
```

---

## 4. 方法学 — methodology

### 4.1 Reachability — the dual of falsifiability

Falsifiability asks "can this be false?". Reachability asks the mirror question:
**"has this ever run?"** They fail in opposite ways and are caught by the same habit
of making the counterfactual explicit.

#### Face A — declared surface vs. exercised surface

**The sentence to ask.** "This tier / reason / branch is declared — which input
produces it?"

**Real example.** `domains/project-management/anchor.js:108-112` declares nine
reachable tiers (`REACHABLE_TIERS`), and `domains/user-feedback/anchor.js:125` and
`domains/requirement-alignment/anchor.js:140` declare the same nine. A declaration is
not evidence. The audit below runs a domain's whole fixture battery through its own
verifier and reports which declared tiers never appeared.

**Fix.** Either add the missing case, or delete the tier from the declaration and
write down why the label was aspirational. Do not leave the two disagreeing. Read the
output as a question, not a verdict: a domain whose tests build their cases in code
rather than in fixtures will look under-covered even when every tier is exercised, so
confirm before changing anything.

**Why it is more insidious than it looks.** The list of tiers is used by readers as a
summary of the verifier's behaviour, so a stale entry is worse than no entry: it
tells the next author that a case exists. And the gap is asymmetric — you cannot see
a missing case by reading the cases that are present.

**Reproduce.**

```bash
node --input-type=module -e "import fs from 'node:fs';import {pathToFileURL} from 'node:url';const R='dsh-adjudication/';for(const d of ['project-management','user-feedback','requirement-alignment']){const A=await import(pathToFileURL(R+'domains/'+d+'/anchor.js').href);const seen=new Set();for(const f of fs.readdirSync(R+'domains/'+d+'/fixtures')){if(!f.endsWith('.json'))continue;const x=JSON.parse(fs.readFileSync(R+'domains/'+d+'/fixtures/'+f,'utf8'));for(const c of [...(x.anchors?.positive||[]),...(x.anchors?.negative||[])]){const v=A.verify({kind:c.claim.kind||A.default?.kind,path:c.claim.path,locator:c.claim.locator,excerpt:c.claim.excerpt},c.subject);seen.add(v.tier)}}const declared=A.REACHABLE_TIERS||[];const miss=declared.filter((t)=>!seen.has(t));console.log('  '+d+': declares '+declared.length+' tiers, its fixtures produce '+seen.size+(miss.length?' — never produced: '+miss.join(', '):''))}"
```

#### Face B — the mutation must land on the executed path

**The sentence to ask.** "Is the code I am about to break actually reachable from the
test I am running?"

**Real example.** An exported function in `domains/_lib/graph.js` was changed to
`return true` unconditionally — an obvious, severe bug — and both domains that import
that module stayed green. The reason was not a weak test: the function was imported
by nothing at all, in the whole package. (It has since been removed.) The command
below prints the exports that are in that position today, in the same shared module
and elsewhere.

**Fix.** Before treating a green mutation as evidence, check that the mutation site
appears on the exercised path — by reading the import graph, or simply by confirming
that some test would fail if the *caller's* expectation changed. Run mutations
against a scratch copy of the repository so the audit cannot leave anything behind.

**Why it is more insidious than it looks.** A mutation that is never executed
produces a *green* result, and a green result is exactly the artifact a mutation
audit is looking for. Two conclusions are available — "the suite is strong" and "my
mutation was not reachable" — and only one of them is true. This is the single most
self-deceiving step in the whole method.

**Reproduce.**

```bash
node --input-type=module -e "import fs from 'node:fs';const R='dsh-adjudication/domains/';const all=[];const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=d+'/'+e.name;if(e.isDirectory())walk(q);else if(e.name.endsWith('.js')||e.name.endsWith('.mjs'))all.push(q)}};walk(R);const src=all.map((f)=>({f,t:fs.readFileSync(f,'utf8')}));for(const {f,t} of src){if(!f.endsWith('.js'))continue;for(const line of t.split(String.fromCharCode(10))){if(!line.startsWith('export function '))continue;const n=line.slice(16).split('(')[0].trim();let hits=0;for(const o of src)hits+=o.t.split(n).length-1;if(hits<=1)console.log('  '+f.replace(R,'')+': export function '+n+' — the name occurs nowhere else under domains/')}}"
```

#### The companion discipline

**A mutation audit must report the un-red cells and explain them.** A table of
mutations with only the caught ones listed is not an audit; it is a summary of
successes. For every mutation that stayed green, the audit has to say which of the
two worlds it is in:

* the suite is weak there (a finding), or
* the mutation did not land on the executed path (a defect in the audit — the
  mutation point was unreachable, the file was not loaded, the flag was not passed).

Both are results, and they call for opposite actions. Record them separately, and
never let an unexplained green cell stand as evidence of strength.

---

### 4.2 Green on the wrong path

**The sentence to ask.** "Which path did this assertion run — the real one, or a degraded
branch the harness fell back to? Would this test still pass if the component it names had
never been reachable at all?"

**Real example.** The plugin acquires its optional reasoning services by injecting them and
then reading the service **as a property of the context it was handed**:

```js
// index.js:420 — optionalInject
ctx.inject([serviceName], (serviceCtx) => {
  if (serviceCtx?.[serviceName] === undefined) return   // index.js:425
  serviceSlots[serviceName].value = serviceCtx[serviceName]   // index.js:426
})
optionalInject('subagents')   // index.js:438
optionalInject('llm')         // index.js:439
```

That is the same convention the real host uses: `mount-test.mjs:97` registers the tools
service with `app.provide('tools', { … })` and the plugin reads `ctx.tools` from then on.
There are exactly **two** such injection sites (`subagents` and `llm`), and both read the
callback's own context — never a registry, never a `get`. A mock whose `provide`/`set` only
fill a `Map` — `smoke-test.mjs:135-136`, and eighteen of the nineteen
`domains/*/test.mjs` mocks — therefore makes **"provide a service" unobservable to the
plugin**: the service is in the mock's Map and nowhere the plugin looks.

Measured with one domain pack, one fixture, and the same test body under two mock shapes:

| the mock's `provide`/`set` | P6 children started | `out.review.verify.mode` | `ran` | `assert.equal(children, 1)` |
|---|---|---|---|---|
| also set `ctx[name]` | **1** | `'subagents'` | `true` | passes |
| only fill a `Map` | **0** | `'none'` | `false` | fails with `0 !== 1` |

The second row is the whole form: the run is *green everywhere else*, the plugin answered
every call, a report came back, and the only thing that ever says anything is a **count**
that happens to be asserted.

**Fix.** Make the mock expose a provided service the way the host does — write the
property, not only the Map:

```js
// domains/requirement-alignment/test.mjs:1568-1574
provide(name, value) { services.set(name, value); ctx[name] = value },
set(name, value) { services.set(name, value); ctx[name] = value },
```

The checklist that comes with it:

* **Both channels or neither.** Keep the Map (mock-internal bookkeeping) *and* set the
  property (what the plugin reads). Setting only the property breaks a mock that uses its
  own `get`.
* **Provide before `apply()`** in a mock that does not re-run inject callbacks for services
  that appear later — the real host does re-run them, asynchronously, so a mock that fires
  callbacks only at apply time can only support services provided up front.
* **Check what `inject` hands to its callback**, not just `provide`/`set`. A mock that
  builds a fresh object for the callback (`lib/kernel-test.mjs:159-167` does:
  `mounted[name] = services[name]`, then `callback({ ...mounted, effect })`) is faithful
  even though its own `provide`/`set` fill a Map, because the plugin reads the *callback's*
  context.

**Why it is worse than a test that is merely too weak.** A weak test fails to catch
something; this one **catches the wrong thing and files the result as coverage**. The green
is not accidental — it is the green of a *different, real* path (a documented degradation:
`mode: 'none'`, `ran: false`, `E_NO_REASONER`), so every artefact the test produces is
consistent and the report reads as if the main path had been exercised. The defining
property is that **there is no red light**: you find out from an unrelated assertion — a
count, a mode, a prompt file's name — never from the assertion that was supposed to be
about the path.

**How you find out you stepped in it.** Nothing goes red, so the discovery has to be
engineered:

1. **Assert something only the real path can produce.** "The service was started exactly
   once", "the mode is the service's name", "the prompt came from this domain's
   `prompts.js`" — `domains/requirement-alignment/test.mjs:1814` `assert.equal(handedToP6.length, 1, …)`
   and `:1823` `assert.equal(out.review.verify.mode, 'subagents')` are exactly that pair.
2. **Read the diagnosis that came back.** `mode: 'none'`, `ran: false`, `E_NO_REASONER` in
   the object the test just asserted about means the run was degraded, whatever the test
   says about itself.
3. **Mutate the mock, not the code.** Delete the property assignment (or the `provide`
   call) and re-run: a test that stays green when the service disappears was never using
   it. This is the only mutation that distinguishes "the suite is strong" from "the service
   was invisible" — and it belongs in the same table as every other mutation (4.1, Face B).
4. **Drive the real host at least once.** A mock cannot report what the host does; the
   mount test exists because a mock built from the same assumptions as the code can never
   find this class at all. Where a mock is unavoidable, make it *differ* from the code in
   the one way that matters and assert the difference.

**Who is exposed.** The trap is narrow, and knowing the discriminator saves a rewrite:
**only a test driven through `apply()` + `ctx.provide(service)` can be bitten.** Thirteen
domains construct the reasoner directly — `createReasoner({ subagents: { … } }, …)`, e.g.
`domains/code-review/test.mjs:883-923` — which never touches the plugin's injection and is
therefore immune. The one domain that drives the plugin's real P6 path
(`domains/requirement-alignment/test.mjs:1759-1825`) is the one that had to fix its mock.
The audit below tells you which group a file is in.

The package-level mock is worth reading as a worked case of **latent, not live**:
`smoke-test.mjs:118-133` fires its `inject` callback only for `systemPrompt`, and hands it
over as a property (`{ systemPrompt: { section() { … } } }`) — faithful for the one service
it simulates, which is why the prompt-section assertions around it are honest. But nothing
in that file provides or asserts `subagents`/`llm`, so the Map-only `provide`/`set` two
lines below has never mattered. It is one `ctx.set('subagents', …)` away from being this
form's next instance, and no test in the file would go red when that happens — which is the
whole reason the audit exists.

**Reproduce.**

```bash
node --input-type=module -e "import fs from 'node:fs';const files=['dsh-adjudication/smoke-test.mjs'];for(const d of fs.readdirSync('dsh-adjudication/domains')){const f='dsh-adjudication/domains/'+d+'/test.mjs';if(fs.existsSync(f))files.push(f)}const idx=fs.readFileSync('dsh-adjudication/index.js','utf8').split(String.fromCharCode(10));console.log('  the plugin reads an injected service at index.js:'+(idx.findIndex((l)=>l.includes('serviceCtx?.['))+1)+'  '+idx.find((l)=>l.includes('serviceCtx?.[')).trim());let host=0,map=0;for(const f of files){const L=fs.readFileSync(f,'utf8').split(String.fromCharCode(10));let found=0,exposes=0;for(let i=0;i<L.length;i++){const t=L[i].trim();const isDef=t.startsWith('provide(name')||t.startsWith('set(name')||t.startsWith('provide(key')||t.startsWith('set(key');if(!isDef)continue;found++;const body=L.slice(i,i+5).join(' ');if(body.includes('[name] = value')||body.includes('[key] = value'))exposes++}const short=f.replace('dsh-adjudication/','');if(found===0){console.log('  no mock    '+short)}else if(exposes===found){host++;console.log('  matches host  '+short+'  ('+exposes+'/'+found+' provide/set also set ctx[name])')}else{map++;console.log('  DIVERGES   '+short+'  ('+(found-exposes)+'/'+found+' provide/set only fill a Map)')}}console.log('  '+files.length+' mock contexts: '+host+' expose a provided service as ctx[name], '+map+' do not')"
```

It prints the line the plugin actually reads, so the comparison is against the real
requirement rather than against a remembered one. A `DIVERGES` line is not automatically a
bug — it is a file that *cannot see a service*, which matters only if that file drives the
plugin (see **Who is exposed**).

---

## Appendix A — a glob in a block comment

**The rule.** Never write a glob that contains `**/` inside a `/* … */` comment. Write it
`experiments/<run>/*.json`, or describe it in words.

**Why.** The closing delimiter of a block comment is `*` followed by `/`, and `**/`
contains exactly that pair. The comment ends in the middle of the glob, and the rest of
the glob becomes code:

```bash
node --input-type=module -e "import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const dir=fs.mkdtempSync(join(os.tmpdir(),'glob-trap-'));const f=join(dir,'trapped.mjs');const NL=String.fromCharCode(10);fs.writeFileSync(f,'/* reads experiments/**/*.json exports */'+NL+'export const ok = true'+NL);console.log('  file content: '+JSON.stringify(fs.readFileSync(f,'utf8')));try{await import(pathToFileURL(f).href);console.log('  imported — the trap did NOT fire')}catch(e){console.log('  '+e.constructor.name+': '+e.message.split(NL)[0])}"
```

```text
  file content: "/* reads experiments/**/*.json exports */\nexport const ok = true\n"
  SyntaxError: Unexpected token '*'
```

**What makes it expensive rather than merely annoying** is where it surfaces. The module
does not load at all, so the domain it belongs to is reported as having no verifier — the
same sentence the plugin uses for a domain that has not been migrated yet. A broken file
therefore reads as unfinished work, and the search goes to the domain list instead of to
the comment. The package's import check does catch it, precisely and early:

```text
FAIL domains/trap/index.js:1: importing "./source.js" threw — Unexpected token '*'
```

**Three times in this codebase**, and the respelled form is what each site carries today:

* `domains/requirement-research/index.js:36` — the pattern itself lives in the gate's
  `exclude` array (a string) and the prose above it is a `//` line comment;
* `domains/requirement-alignment/index.js:110` — same shape:
  `exclude: ['**/.git/**','**/archived/**']`, described in prose without the raw glob;
* `domains/requirement-alignment/source.js:197` — inside a block comment the glob is
  written `experiments/<run>/*.json`.

A glob in a **string** is fine: `domains/requirement-alignment/source.js:273` contains
`experiments/**/*.json` in a message and loads perfectly. The prohibition is about comments.

**The guard existing is not the same as the trap not having fired.** A check that runs
after the edit only tells you what you already did; the three sites above are in a package
whose import check catches exactly this, and it catches it only for modules that something
imports. The habit is cheaper than the check: when a comment wants to name a path pattern,
spell it with `<…>` placeholders.

---

## Appendix B — `import()` is not free

**The rule.** Never import a module just to look at it, and never import a directory tree.
In an ES module, **top-level code is the module's body**: `import()` runs it. A test file is
a program; a generator is a program with side effects; a scanner that a human runs on
purpose is a program that no other program should be able to start by accident.

**Why it belongs next to 4.2.** Both make *"I ran it"* and *"I ran the thing I meant"*
different claims. 4.2 runs the right test down the wrong path; this one runs a different
program entirely and reports success, because an import that throws nothing looks like an
import that did nothing.

**Measured on this package** — 129 modules, classified by what happens when they are
imported:

| group | meaning | count |
|---|---|---|
| 1 | contains a filesystem writer | **1** — `domains/user-feedback/_generate-util.mjs` (and importing it writes nothing; see below) |
| 2 | executes top-level statements | **24** — the 19 `domains/*/test.mjs`, `lib/imports-check.mjs`, `lib/kernel-test.mjs`, the two `user-feedback` generators, plus one data module the scan over-reports |
| 3 | neither | 104 |

Group 2 is the one that bites: those modules have **no named exports a caller wants**, but
`import()` runs the whole suite and can leave `process.exitCode = 1` behind in the
importing process. Two of the twenty-four (`user-feedback`'s generator scripts) call an
entry guard at top level, which is the correct shape for a script that must live in the
tree — the guard is `isEntryPoint`, `domains/user-feedback/_generate-util.mjs:32-36`:

```js
return pathToFileURL(resolve(entry)).href.toLowerCase() === moduleUrl.toLowerCase()
```

A program that cannot tell "run me" from "load me" will do the wrong one. Measured after
that guard landed: importing both generators directly changed **0 of the 31** files they
generate. The companion mechanism is a `--check` mode that re-renders and compares instead
of writing — a generator nobody can run by accident still needs a way to notice that its
output and the committed files have drifted apart.

**How you find out you stepped in it.** As with 4.2, nothing goes red — the damage is a
green line. Three checks, in order of cheapness:

1. **Hash before and after.** Import what you were about to import, then compare a hash
   manifest of everything the package owns. Zero differences is the only acceptable answer.
2. **Watch the exit code of the *importer*.** A suite that ran as a side effect can set
   `process.exitCode = 1` while your own script keeps going; a green log line is not a
   green process.
3. **Forbid the enumeration in review.** If a probe needs to look at N modules, it reads
   their **source text**, not their module objects. Every check in this document is written
   that way, including the one below.

**Reproduce.**

```bash
node --input-type=module -e "import fs from 'node:fs';import {join} from 'node:path';const R='dsh-adjudication/';const NL=String.fromCharCode(10);const BS=String.fromCharCode(92);const Q1=String.fromCharCode(39);const Q2=String.fromCharCode(34);const BT=String.fromCharCode(96);const W=['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','copyFileSync','renameSync'];const P=['.',',',')',']','[','{','(','?',':','*','&','|','}',';','@','+','-'];const K=['import','export','function','class','const','let','var','async','return','if','for','while','switch','try','catch','else','do','throw','new','await','typeof'];const strip=(s)=>{let o='';let i=0;while(i<s.length){const c=s[i];const d=s[i+1];if(c==='/'&&d==='/'){while(i<s.length&&s[i]!==NL){o+=' ';i+=1}continue}if(c==='/'&&d==='*'){while(i<s.length&&!(s[i]==='*'&&s[i+1]==='/')){o+=s[i]===NL?NL:' ';i+=1}o+='  ';i+=2;continue}if(c===Q1||c===Q2||c===BT){const q=c;o+=' ';i+=1;while(i<s.length&&s[i]!==q){if(s[i]===BS){o+='  ';i+=2;continue}o+=s[i]===NL?NL:' ';i+=1}o+=' ';i+=1;continue}o+=c;i+=1}return o};const walk=(d,acc)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const q=d+'/'+e.name;if(e.isDirectory())walk(q,acc);else if(e.name.endsWith('.js')||e.name.endsWith('.mjs')||e.name.endsWith('.cjs'))acc.push(q)}return acc};const files=[R+'index.js',...walk(R+'lib',[]),...walk(R+'domains',[])];const g1=[],g2=[],g3=[];for(const f of files){const src=strip(fs.readFileSync(f,'utf8'));const writes=W.some((w)=>src.includes(w+'('));let depth=0,exec=false,why='';for(const raw of src.split(NL)){const t=raw.trim();if(depth===0&&t!==''){const cont=P.some((p)=>t.startsWith(p));const decl=K.some((w)=>t===w||t.startsWith(w+' ')||t.startsWith(w+'(')||t.startsWith(w+'.')||t.startsWith(w+'[')||t.startsWith(w+';'));if(!cont&&!decl&&exec===false){exec=true;why=t.slice(0,58)}}for(const ch of raw){if(ch==='{')depth+=1;else if(ch==='}')depth-=1}}const short=f.slice(R.length);if(writes)g1.push(short);else if(exec)g2.push(short+'   <- '+why);else g3.push(short)}console.log('  '+files.length+' modules scanned');console.log('  group 1 - contains a filesystem writer: '+g1.length+'  '+JSON.stringify(g1));console.log('  group 2 - executes top-level statements: '+g2.length);for(const x of g2)console.log('      '+x);console.log('  group 3 - neither: '+g3.length)"
```

Two details of the scan are load-bearing, and both were learned the hard way:

* **Comments and strings are blanked before nesting is computed.** A glob documented inside
  a string, or a brace written in prose, otherwise moves the "am I at top level?" answer for
  every following line.
* **The scan over-reports on purpose** — it prints the first top-level statement it saw for
  each candidate (`  <- console.log(…`), so a data module is dismissed in one glance rather
  than triggering an investigation. A detector that hides its reason cannot be audited.

**The rule that survives the specifics.** When you want to know something *about* modules,
read the files. Reach for `import` only when you want the module's behaviour, and then know
which programs you just started.

---

## Closing

None of the fifteen is "writing the test badly". Every one of them is the same thing:
**the test describes what the author believed was happening rather than what must
happen.** The author was competent; the belief was reasonable; the code was green.
That is why these patterns are found by asking questions rather than by reviewing
style — and why each one is worth a command that answers it mechanically.

**Honesty note, unchanged.** The rule libraries under `domains/*/rules/` are
agent-drafted drafts. Every rule document carries `needs-expert-review: true`, and no
part of this package — rules, verdicts, or the checks in this document — has been
reviewed or validated by a domain expert. Nothing in this repository may be described
as expert-validated.

