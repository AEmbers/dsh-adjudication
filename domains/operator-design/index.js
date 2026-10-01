/**
 * operator-design — domain package v2.
 *
 * MIGRATED FROM `lib/domains.js`. The v1 pack declared its candidate set,
 * anchor, criticism shape, gate and bundle key in prose; this directory is the
 * same domain with all five extension points actually implemented. The v1 entry
 * is untouched — when the loader discovers `domains/operator-design/`, this pack
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
 * BEHAVIOURAL REMINDER: `lossOrientation` is `recall-first`. An operator form
 * (backend × dtype × shape branch) that no numeric test exercises is an
 * invisible correctness risk — it does not fail until someone calls it. So an
 * incomplete coverage proof is a FAILURE in `adjudication_submit`'s output, not
 * a percentage to be read past. `criticism.kind` must stay `triage` to match;
 * the contract validator rejects a mismatch, because one of the two
 * declarations would be wrong.
 */

/** The operator's implementation file, verbatim — the only field the grouping may read. */
function operatorFileKey(path) {
  return String(path ?? '').replace(/\\/gu, '/')
}

export default {
  contractVersion: 2,

  id: 'operator-design',
  title: '算子设计',
  category: 'A',
  keywords: ['operator', 'kernel', 'numerics', 'gpu', 'tolerance', 'performance'],
  summary: '对算子实现做审定。锚点是「算子签名 + 数值容差」。核心是数值正确性与边界形态。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'operator-implementations',
    inputFormat: 'operator-registry-and-tests',
    bounded: true,
    description: '算子注册表的每个形态（后端 × dtype × shape 分支），加上数值测试清单。候选是「一个没有被任何数值测试覆盖的形态」，以及「有测试但没有容差断言」的形态。',
  },

  // --- P1 ------------------------------------------------------------------
  // Kept deliberately short, mirroring the code-review reference domain: the
  // first three patterns restate `DEFAULT_EXCLUDE_PATTERNS` entries, so the set
  // of admitted paths is unchanged by declaring them.
  //
  // CHANGED (t23): `**/generated/**` USED TO live only in the `all-gated-out`
  // fixture, "as a test-only narrowing". That made the boundary claim circular —
  // the suite proved "pack ∪ fixture drains the fixture", while a boundary must
  // prove "the PACK alone drains it". Measured through the real plugin, where the
  // fixture's gate does not exist, the generated kernel was admitted. A generated
  // kernel is not a hand-written implementation with a declared form, so a form
  // gap claimed against it is not actionable; the pattern belongs in the pack.
  gate: {
    exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
  },

  // --- P2 ------------------------------------------------------------------
  // v1 declared the private string 'operator'. The contract's v2 gate rejects a
  // string strategy that is not one of the four generic ones — and it is right
  // to. All the forms of one operator live in the operator's implementation
  // file, so that file IS the operator's identity for grouping purposes, and
  // supplying `resolve` says so instead of pretending `directory` means it.
  //
  // The resolver reads ONLY `path`: `index.js toCandidates()` copies a fixed
  // field set off each candidate, so anything not derivable from `path` would
  // silently vanish before the grouping ever ran.
  bundleKey: {
    strategy: 'operator',
    resolve: (candidate) => operatorFileKey(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'signature-and-tolerance',
    verify: 'engine-recomputable',
    description: '锚点是「算子签名 + 数值容差断言」。引擎重算三件事：抄写的签名确实在实现里、声明的形态（后端/dtype/shape 分支）确实在注册表里、以及该形态的数值测试状态确实如发现所述。三者任一与输入矛盾，一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '只删除被数值测试清单正面否定的发现（某个形态其实已有带容差的测试）；「测试清单里查不到这个形态」属于不知道，一律保留并标注待人工确认。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是算子评审者。你的损失取向是 recall-first：未被数值测试覆盖的形态必须暴露。',
    instruction: '每条发现给出算子签名与具体形态（后端/dtype/shape 分支），并逐字抄写实现里的那一行（不要输出行号）。',
  },
}
