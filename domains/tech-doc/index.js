/**
 * tech-doc — domain package v2.
 *
 * MIGRATED FROM `lib/domains.js`. The v1 pack declared its candidate set,
 * anchor, criticism shape, gate and bundle key in prose; this directory is the
 * same domain with all five extension points actually implemented. The v1 entry
 * is untouched — when the loader discovers `domains/tech-doc/`, this pack
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
 * `lossOrientation` is `precision-first`, so `criticism.kind` must be
 * `fact-checker`: this domain exists to stop a plausible-sounding documentation
 * complaint that the source can disprove. A reviewer that keeps "I could not
 * verify it" findings would invert the domain's whole purpose.
 */

/** The document a claim belongs to. */
function documentKey(path) {
  return String(path ?? '').replace(/\\/gu, '/')
}

export default {
  contractVersion: 2,

  id: 'tech-doc',
  title: '技术文档',
  category: 'A',
  keywords: ['doc', 'readme', 'api-doc', 'tutorial', 'changelog'],
  summary: '对文档与实现的一致性做审定。锚点是「段落锚 + API 签名」。每处不一致都能被源码验证。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'doc-claims',
    inputFormat: 'doc-corpus-and-api-surface',
    bounded: true,
    description: '文档中每个可验证的断言（签名、示例、链接）与 API surface 的比对。候选是「一个段落里的一处可验证断言」。',
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
  // fixture's gate does not exist, the generated doc was admitted. Generated
  // documentation is machine-written, so a doc claim about it is not a claim
  // anyone maintains; the pattern belongs in the pack.
  gate: {
    exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
  },

  // --- P2 ------------------------------------------------------------------
  // v1 declared the private string 'document'. The contract's v2 gate rejects a
  // string strategy that is not one of the four generic ones — and it is right
  // to: mapping 'document' onto `file` or `directory` would either be a lie
  // about the semantics or a no-op that leaves every candidate in its own
  // bundle. So the declaration keeps its honest name and supplies the
  // implementation.
  //
  // The resolver reads ONLY `path`: `index.js toCandidates()` copies a fixed
  // field set off each candidate, so anything not derivable from `path` would
  // silently vanish before the grouping ever ran.
  bundleKey: {
    strategy: 'document',
    resolve: (candidate) => documentKey(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'section-and-signature',
    verify: 'engine-recomputable',
    description: '锚点是「文档段落锚 + 源码 API 签名」。引擎用滑窗在源码/文档中定位该签名，并把文档写出的签名与 API surface 里重算出来的签名逐字比对；两者不一致、或声明了签名却没有 API surface 可比对时，一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只保留源码能证明的文档不一致；无法由源码证实的属于风格建议，删除。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是技术文档评审者，评审的是文档与实现的一致性，不是文笔。',
    instruction: '每条发现必须给出源码侧的验证点（文件与签名），否则属于风格建议，不要提出。',
  },
}
