/**
 * tech-test — domain package v2.
 *
 * MIGRATED FROM `lib/domains.js`. The v1 pack declared its candidate set,
 * anchor, criticism shape, gate and bundle key in prose; this directory is the
 * same domain with all five extension points actually implemented. The v1
 * entry is untouched — when the loader discovers `domains/tech-test/`, this pack
 * REPLACES the same-id entry, and nothing shared had to be edited.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is an agent-drafted rule library. Every document carries
 * `needs-expert-review: true`, `RULE_PROVENANCE.expertValidated` stays `false`,
 * and the prompt text tells the model so. The v1 pack shipped four seed rules;
 * this is not an expert standard either. The difference is that the gap is
 * visible instead of implicit.
 *
 * BEHAVIOURAL REMINDER: `lossOrientation` is `recall-first`. `coverage()`
 * therefore reports `required: true`, and an incomplete coverage proof is a
 * FAILURE in `adjudication_submit`'s output — not a percentage to be read past.
 * `criticism.kind` must stay `triage` to match; the contract validator rejects a
 * mismatch, because one of the two declarations would be wrong.
 */

/** First `depth` path segments of a path — the module a coverage gap belongs to. */
function moduleRoot(path, depth = 2) {
  const parts = String(path ?? '').replace(/\\/gu, '/').split('/')
  parts.pop()
  if (parts.length === 0) return '.'
  return parts.slice(0, Math.min(depth, parts.length)).join('/')
}

export default {
  contractVersion: 2,

  id: 'tech-test',
  title: '技术测试',
  category: 'A',
  keywords: ['test', 'qa', 'coverage', 'case', 'regression', 'assertion'],
  summary: '对测试覆盖与用例质量做审定。锚点是「用例 ID + 被覆盖的代码行」。**默认 recall-first**：漏测是不可见风险。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'cases-and-covered-lines',
    inputFormat: 'test-inventory-and-coverage',
    bounded: true,
    description: '用例清单 + 覆盖报告 + 源码快照。候选是「被报告为 0 命中的行区间」「从未走到的分支」「弱断言用例」三类。',
  },

  // --- P1 ------------------------------------------------------------------
  // This domain's candidates live in BOTH places: a coverage gap is in the
  // source tree, a weak assertion is in the test file. So the gate must NOT
  // exclude test paths — doing that would delete half the candidate set before
  // any reviewer saw it.
  //
  // Kept deliberately short, mirroring the code-review reference domain: the
  // first three patterns are restatements of `DEFAULT_EXCLUDE_PATTERNS` entries.
  // Restating them does not change which paths are admitted (the engine's
  // `default-path` predicate already covers them); it changes only the reason
  // text the report shows.
  //
  // CHANGED (t23): `**/generated/**` USED TO live only in the `all-gated-out`
  // fixture, "as a test-only narrowing". That made the boundary claim circular:
  // the suite proved "pack ∪ fixture drains the fixture", while the thing a
  // boundary must prove is "the PACK alone drains it". Measured through the real
  // plugin — where the fixture's gate does not exist — `config/generated.ts` was
  // admitted, i.e. generated test scaffolding reached the reviewer. The pattern
  // therefore belongs here, in the pack, and the fixture no longer carries a gate
  // of its own.
  gate: {
    exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
  },

  // --- P2 ------------------------------------------------------------------
  // v1 declared the private string 'module'. The contract's v2 gate rejects a
  // string strategy that is not one of the four generic ones — and it is right
  // to: mapping 'module' onto `directory`/`path` would either be a lie about the
  // semantics or a no-op that leaves every candidate in its own bundle. So the
  // declaration keeps its honest name and supplies the implementation.
  //
  // The resolver reads ONLY `path`: `index.js toCandidates()` copies a fixed
  // field set off each candidate, so anything not derivable from `path` would
  // silently vanish before the grouping ever ran.
  bundleKey: {
    strategy: 'module',
    resolve: (candidate) => moduleRoot(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'case-and-covered-line',
    verify: 'engine-recomputable',
    description: '锚点是「用例 ID + 代码行」。引擎逐字重算该行位置，并用覆盖报告核验它确实没有被任何用例命中；行号与原文矛盾、或被覆盖数据正面否定时，一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '只删除被覆盖报告正面否定的发现（原文不存在，或覆盖数据显示该区间已有命中）；「查不到覆盖数据」属于不知道，一律保留并标注待人工确认。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是测试评审者。你的损失取向是 recall-first：未被覆盖的风险必须暴露。',
    instruction: '每条发现给出用例 ID 或明确标注「无用例覆盖」，并逐字抄写具体代码行（不要输出行号）。',
  },
}
