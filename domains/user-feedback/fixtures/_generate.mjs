// Generator for domains/user-feedback/fixtures/*.json.
//
// Kept so the fixture set is reproducible and so the `anchors` blocks — the part a
// reader is least likely to get right by hand — all use the same shape. The generated
// `.json` files are the deliverable.
//
// ── WHY IMPORTING THIS FILE IS SAFE (t42) ────────────────────────────────────
// This generator used to write its six files from module top level, so merely
// `import()`-ing it — which a probe that "imports every module under domains/ to check
// they all parse" does naturally — overwrote six committed fixtures as a side effect.
// The top level now only builds an in-memory map; the filesystem is touched only when
// this file is the process entry point AND is asked explicitly:
//
//   node domains/user-feedback/fixtures/_generate.mjs            # --check (default): no writes
//   node domains/user-feedback/fixtures/_generate.mjs --write    # regenerate
//
// Unlike the sibling `rules/_generate.mjs`, this one has no extension set to keep in
// sync — the fixtures carry whole ledgers, not `match` globs — so it has nothing to
// derive and no second source of truth to collapse.
//
// `lib/domain-loader.js` auto-lists `fixtures/*.json`, so this `.mjs` is invisible to
// the loader and cannot be mistaken for a fixture.

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runEntry } from '../_generate-util.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DOMAIN = 'user-feedback'
const FORMAT = 'feedback-ledger'

/**
 * The expectation keys `lib/contracts.js` recognises.
 *
 * Anything else a fixture wants to pin — bundle keys, both rank orderings, the gap
 * count — has to live OUTSIDE `expect`, because `validateFixture` rejects an
 * unrecognised expectation key outright. Putting them in a top-level `observations`
 * object keeps the extra evidence honest (it is still asserted by `test.mjs`) without
 * smuggling a key past a gate designed to catch exactly that kind of drift.
 */
const RECOGNISED_EXPECT_KEYS = ['candidates', 'paths', 'admitted', 'excludedByPredicate', 'bounded', 'truncated', 'notes', 'throws']

/** name -> exact file text. Built at import time; nothing is written here. */
const rendered = new Map()

const write = (name, object) => {
  const expect = {}
  const observations = { ...(object.observations ?? {}) }
  for (const [key, value] of Object.entries(object.expect ?? {})) {
    if (RECOGNISED_EXPECT_KEYS.includes(key)) expect[key] = value
    else observations[key] = value
  }
  const fixture = { ...object, expect, ...(Object.keys(observations).length === 0 ? {} : { observations }) }
  rendered.set(`${name}.json`, `${JSON.stringify(fixture, null, 2).replace(/\n/gu, '\r\n')}`)
}

/** Wrap one ledger payload as the single-document input the P0 source expects. */
const single = (path, payload, meta = {}) => ({ documents: [{ path, type: 'feedback-ledger', meta, payload }] })

/** A claim of this domain's anchor kind, against a named ledger. */
const claim = (path, locator, extra = {}) => ({ kind: 'feedback-and-quote', path, locator, ...extra })

/**
 * One anchor case.
 *
 * The bucket a case sits in says WHAT it demonstrates — that the verifier can confirm
 * a relation, or cannot — and is deliberately independent of the status: the `empty`
 * fixture's only "positive" case is a demonstration that an empty corpus still yields
 * a refuse-with-reason rather than a crash. So the status is derived from the TIER
 * instead: every terminal-refusal tier means `unanchored`, and only the three trusted
 * tiers can be `anchored`. Deriving it removes the chance of writing a case whose
 * bucket and expectation contradict each other.
 */
const REFUSAL_TIERS = ['no-documents', 'no-match', 'empty-excerpt', 'kind-mismatch', 'locator-mismatch', 'relocation-ambiguous']

const positive = (note, claimSpec, subject, tier, path) => {
  const anchored = !REFUSAL_TIERS.includes(tier)
  return {
    note, claim: claimSpec, subject,
    expectStatus: anchored ? 'anchored' : 'unanchored',
    expectTier: tier,
    ...(anchored && path !== undefined ? { expectPath: path } : {}),
  }
}
const refusal = (note, claimSpec, subject, tier) => ({
  note, claim: claimSpec, subject, expectStatus: 'unanchored', expectTier: tier,
})
const ambiguous = (note, claimSpec, subject, competitors) => ({
  note, claim: claimSpec, subject, expectStatus: 'unanchored', expectTier: 'relocation-ambiguous', expectAmbiguousIn: competitors,
})

// ---------------------------------------------------------------------------
// empty
// ---------------------------------------------------------------------------

write('empty', {
  name: 'empty',
  domain: DOMAIN,
  format: FORMAT,
  description: '空台账：没有任何反馈、决策或主题。P0 必须产出空集（合法结论），P1 全空，工作单必须说「空集本身就是结论」，而不是让模型凭空评审一份不存在的台账。',
  input: { format: FORMAT, payload: { ledgerPath: 'feedback/ledger.json', feedback: [], decisions: [], themes: [] } },
  expect: { candidates: 0, paths: [], admitted: 0, excludedByPredicate: {}, bounded: true, truncated: false },
  anchors: {
    positive: [
      positive('空语料下唯一成立的锚点是「拒绝」：没有台账就没有可重算的关系。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: 'fb-1001', decisionId: 'dec-20' }),
        { path: 'feedback/ledger.json' }, 'no-documents'),
    ],
    negative: [
      refusal('引文为空字符串永远不是锚点——没有任何可逐字比对的内容。',
        claim('feedback/ledger.json', { kind: 'quote-anchor', feedbackId: 'fb-1001', quote: '' }),
        { path: 'feedback/ledger.json', documents: [{ path: 'feedback/ledger.json', payload: { feedback: [], decisions: [] } }] },
        'empty-excerpt'),
      refusal('闭环节点为空时同样没有可核验的内容。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: '', decisionId: '' }),
        { path: 'feedback/ledger.json', documents: [{ path: 'feedback/ledger.json', payload: { feedback: [], decisions: [] } }] },
        'empty-excerpt'),
    ],
  },
})

// ---------------------------------------------------------------------------
// all-gated-out
// ---------------------------------------------------------------------------

write('all-gated-out', {
  name: 'all-gated-out',
  domain: DOMAIN,
  format: FORMAT,
  description: 'P0 枚举出候选、P1 把每一条都排除：五份台账分别命中 deleted / binary / extension / user-exclude 四个闸门谓词，准入 0。用来证明「枚举到空」与「被闸门清空」在 plan 里是两个可分辨的状态。',
  input: {
    format: FORMAT,
    payload: {
      documents: [
        { path: 'feedback/legacy-ledger.json', type: 'feedback-ledger', meta: { bytes: 2048, deleted: true }, payload: { feedback: [{ id: 'fb-9001', quote: '旧版导入的一条反馈原话内容' }, { id: 'fb-9002', quote: '另一条来自旧版的数据记录' }], decisions: [] } },
        { path: 'feedback/attachments/screenshot-media.json', type: 'feedback-ledger', meta: { bytes: 1024, binary: true }, payload: { feedback: [{ id: 'fb-9003', quote: '截图附件的占位记录内容' }], decisions: [] } },
        { path: 'feedback/notes/raw-export.txt', type: 'feedback-ledger', meta: { bytes: 512 }, payload: { feedback: [{ id: 'fb-9004', quote: '尚未结构化的一份导出内容' }], decisions: [] } },
        { path: 'node_modules/feedback-tool/export.json', type: 'feedback-ledger', meta: { bytes: 8192 }, payload: { feedback: [{ id: 'fb-9005', quote: '第三方工具生成的缓存记录' }], decisions: [] } },
        { path: 'archived/2024-ledger.json', type: 'feedback-ledger', meta: { bytes: 8192 }, payload: { feedback: [{ id: 'fb-9006', quote: '已归档年份的一条反馈' }], decisions: [] } },
      ],
    },
  },
  expect: {
    candidates: 6,
    paths: [
      'feedback/legacy-ledger-fb-9001.json',
      'feedback/legacy-ledger-fb-9002.json',
      'feedback/attachments/screenshot-media-fb-9003.json',
      'feedback/notes/raw-export-fb-9004.txt',
      'node_modules/feedback-tool/export-fb-9005.json',
      'archived/2024-ledger-fb-9006.json',
    ],
    admitted: 0,
    excludedByPredicate: {
      deleted: ['feedback/legacy-ledger-fb-9001.json', 'feedback/legacy-ledger-fb-9002.json'],
      binary: ['feedback/attachments/screenshot-media-fb-9003.json'],
      extension: ['feedback/notes/raw-export-fb-9004.txt'],
      'user-exclude': ['archived/2024-ledger-fb-9006.json', 'node_modules/feedback-tool/export-fb-9005.json'],
    },
    bounded: true,
    truncated: false,
  },
  anchors: {
    positive: [
      positive('闸门把这份文档排除了，但验证器只按台账事实裁决——被排除不等于不成立，这条确实是无人处理的。',
        claim('feedback/notes/raw-export.txt', { kind: 'unclosed-feedback', feedbackId: 'fb-9004' }),
        { path: 'feedback/notes/raw-export.txt', documents: [{ path: 'feedback/notes/raw-export.txt', payload: { feedback: [{ id: 'fb-9004', quote: '尚未结构化的一份导出内容' }], decisions: [] } }] },
        'declared-locator'),
    ],
    negative: [
      refusal('fb-9004 在台账里是有记录的，声称它是失效链接与事实相反。',
        claim('feedback/notes/raw-export.txt', { kind: 'unregistered-reference', referencedId: 'fb-9004', referrerId: 'fb-9004' }),
        { path: 'feedback/notes/raw-export.txt', documents: [{ path: 'feedback/notes/raw-export.txt', payload: { feedback: [{ id: 'fb-9004', quote: '尚未结构化的一份导出内容' }], decisions: [] } }] },
        'locator-mismatch'),
      refusal('被闸门排除的候选照样可以问：这个 ID 不在这份台账里。',
        claim('feedback/legacy-ledger.json', { kind: 'unclosed-feedback', feedbackId: 'fb-9999' }),
        { path: 'feedback/legacy-ledger.json', documents: [{ path: 'feedback/legacy-ledger.json', payload: { feedback: [], decisions: [] } }] },
        'no-match'),
    ],
  },
})

// ---------------------------------------------------------------------------
// happy-path — the main sample, deliberately built so the two rankings disagree
// ---------------------------------------------------------------------------

const HAPPY_LEDGER = {
  feedback: [
    { id: 'fb-1001', quote: '结账时优惠券没有生效，钱白花了', source: '客服工单', severity: 'blocker', reach: 'all', frequency: 2, theme: 'checkout', status: 'closed', closedBy: 'dec-20', closeReason: '优惠券校验逻辑已修复并在 2.4 发版' },
    { id: 'fb-1002', quote: '结算页加载要等好几秒，购物车内容是空的', source: '应用商店', severity: 'critical', reach: 'many', frequency: 1, theme: 'checkout', status: 'open' },
    { id: 'fb-1003', quote: '导出报表会丢掉最后一行数据', source: '客服工单', severity: 'high', reach: 'some', frequency: 3, theme: 'report', status: 'open', closedBy: 'dec-77' },
    { id: 'fb-1004', quote: '首页推荐位重复出现了两次', source: '应用商店', severity: 'low', reach: 'few', frequency: 30, theme: 'ui', status: 'open', closedBy: 'dec-22' },
    { id: 'fb-1005', quote: '图标颜色不太对，和设计稿不一致', source: '应用商店', severity: 'low', reach: 'some', frequency: 40, theme: 'ui', status: 'open' },
    { id: 'fb-1006', quote: '设置页的开关点了没有反应', source: '客服工单', severity: 'medium', reach: 'few', frequency: 12, theme: 'ui', status: 'open' },
    { id: 'fb-1007', quote: '历史订单里有一条记录金额显示为负数', source: '客服工单', severity: 'critical', reach: 'few', frequency: 1, theme: 'report', status: 'open' },
  ],
  decisions: [
    { id: 'dec-20', title: '结算页优惠券校验修复', rationale: '优惠券在并发场景下被重复消费', addresses: ['fb-1001'], status: 'shipped', owner: 'alice' },
    { id: 'dec-21', title: '结算页性能优化', rationale: '首屏数据串行加载', addresses: ['fb-1002'], status: 'shipped', owner: 'bob' },
    { id: 'dec-22', title: '推荐位去重', rationale: '推荐流未去重', addresses: [], status: 'planned', owner: 'carol' },
    { id: 'dec-23', title: '内部工具重构', rationale: '与用户反馈无关的工程改造', addresses: [], status: 'shipped', owner: 'dave' },
    { id: 'dec-24', title: '批量问题归集', rationale: '把若干条反馈归到一起处理', addresses: ['fb-9999'], status: 'planned', owner: 'alice' },
  ],
  themes: [
    { id: 'checkout', name: '结算流程', members: ['fb-1001'] },
    { id: 'report', name: '报表导出', members: [] },
    { id: 'ui', name: '界面细节', members: ['fb-1005', 'fb-1006'] },
  ],
}
const HAPPY_DOC = { path: 'feedback/ledger.json', type: 'feedback-ledger', meta: { bytes: 6144 }, payload: HAPPY_LEDGER }
const HAPPY_SUBJECT = { path: 'feedback/ledger.json', documents: [HAPPY_DOC] }
const HAPPY_ONLY = (payload) => ({ path: 'feedback/ledger.json', documents: [{ path: 'feedback/ledger.json', payload }] })

write('happy-path', {
  name: 'happy-path',
  domain: DOMAIN,
  format: FORMAT,
  description: '主样本：三条主题（checkout / report / ui）共 7 条反馈与 5 个决策。刻意造成两个排序相互矛盾——`fb-1001`（阻断级、影响全量、只被报 2 次）与 `fb-1002`（严重级、影响多量、只被报 1 次）的损失排名最前、频次排名倒数；`fb-1005`（轻微、被报 40 次）恰好相反。这正是「低频高损不得被高频低损淹没」要检验的形态。同时含：一对双侧互证闭环、一条单边闭环、一条悬空闭环（closedBy 指向不存在的决策）、一个孤儿决策、一条失效引用（dec-24 指向不存在的 fb-9999）。',
  input: { format: FORMAT, payload: { documents: [HAPPY_DOC] } },
  expect: {
    candidates: 20,
    paths: [
      'feedback/ledger-fb-1001-dec-20.json',
      'feedback/ledger-fb-1002-dec-21.json',
      'feedback/ledger-fb-1004-dec-22.json',
      'feedback/ledger-fb-1003-dec-77.json',
      'feedback/ledger-fb-9999-dec-24.json',
      'feedback/ledger-fb-1001.json',
      'feedback/ledger-fb-1002.json',
      'feedback/ledger-fb-1003.json',
      'feedback/ledger-fb-1004.json',
      'feedback/ledger-fb-1005.json',
      'feedback/ledger-fb-1006.json',
      'feedback/ledger-fb-1007.json',
      'feedback/ledger-dec-20.json',
      'feedback/ledger-dec-21.json',
      'feedback/ledger-dec-22.json',
      'feedback/ledger-dec-23.json',
      'feedback/ledger-dec-24.json',
      'feedback/ledger-theme-checkout.json',
      'feedback/ledger-theme-report.json',
      'feedback/ledger-theme-ui.json',
    ],
    admitted: 20,
    excludedByPredicate: {},
    bounded: true,
    truncated: false,
    bundleKeys: ['doc/feedback/ledger.json', 'theme/checkout', 'theme/report', 'theme/ui'],
    rankChecks: {
      byLoss: ['fb-1001', 'fb-1002', 'fb-1003', 'fb-1007', 'fb-1005', 'fb-1006', 'fb-1004'],
      byFrequency: ['fb-1005', 'fb-1004', 'fb-1006', 'fb-1003', 'fb-1001', 'fb-1002', 'fb-1007'],
      drownRisk: ['fb-1001', 'fb-1002'],
    },
  },
  anchors: {
    positive: [
      positive('双侧互证：决策的 addresses 与反馈的 closedBy 都指向对方——这是唯一算数的闭环形态。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: 'fb-1001', decisionId: 'dec-20' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
      positive('无人处理的反馈：fb-1005 没有 closedBy，也没有任何决策在 addresses 里提到它。',
        claim('feedback/ledger.json', { kind: 'unclosed-feedback', feedbackId: 'fb-1005' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
      positive('孤儿决策：dec-23 不声明处理任何反馈，也没有任何反馈指向它。',
        claim('feedback/ledger.json', { kind: 'orphan-decision', decisionId: 'dec-23' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
      positive('逐字引文成立：这段文字与记录的原话完全一致。',
        claim('feedback/ledger.json', { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表会丢掉最后一行数据' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
      positive('locator 只给引文、不给 feedbackId：引擎从引文重算出唯一包含它的那条记录，tier 是 recomputed-unique。这条用例是 recomputed-unique 在本域真实可达的证明。',
        claim('feedback/ledger.json', { kind: 'quote-anchor', quote: '导出报表会丢掉最后一行数据' }),
        HAPPY_SUBJECT, 'recomputed-unique', 'feedback/ledger.json'),
      positive('主题双侧一致：fb-1005 的 theme 是 ui，主题 ui 的 members 里也有它。',
        claim('feedback/ledger.json', { kind: 'theme-membership', themeId: 'ui', feedbackId: 'fb-1005' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
      positive('失效链接：dec-24 在 addresses 里引用了 fb-9999，而台账的任何 population 里都没有这个 ID。',
        claim('feedback/ledger.json', { kind: 'unregistered-reference', referencedId: 'fb-9999', referrerId: 'dec-24' }),
        HAPPY_SUBJECT, 'declared-locator', 'feedback/ledger.json'),
    ],
    negative: [
      refusal('单边闭环不算闭环：dec-21 声明处理了 fb-1002，但 fb-1002 没有 closedBy。这条正是本域最典型的缺陷，必须判未锚定。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: 'fb-1002', decisionId: 'dec-21' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('悬空闭环：fb-1003 的 closedBy 指向 dec-77，而 dec-77 在 decisions 里不存在——两侧都不到位。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: 'fb-1003', decisionId: 'dec-77' }),
        HAPPY_SUBJECT, 'no-match'),
      refusal('转述不锚定：这句话说的是同一件事，但改写了措辞——引文一旦被改写就不再是证据。',
        claim('feedback/ledger.json', { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表时最后一行数据会丢失' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('角色错位：dec-20 是决策 ID，不能当作反馈 ID 来验证闭环。',
        claim('feedback/ledger.json', { kind: 'closure-link', feedbackId: 'dec-20', decisionId: 'dec-20' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('主题只有单边：fb-1007 的 theme 是 report，但主题 report 的 members 是空的。',
        claim('feedback/ledger.json', { kind: 'theme-membership', themeId: 'report', feedbackId: 'fb-1007' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('fb-1001 是有闭环的，声称它无人处理与台账矛盾。',
        claim('feedback/ledger.json', { kind: 'unclosed-feedback', feedbackId: 'fb-1001' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('fb-1001 在台账里是有记录的，声称它是失效链接与事实相反。',
        claim('feedback/ledger.json', { kind: 'unregistered-reference', referencedId: 'fb-1001', referrerId: 'dec-20' }),
        HAPPY_SUBJECT, 'locator-mismatch'),
      refusal('声明的台账不在语料里，而这条声明在语料里的那份台账上也不成立（这个 ID 根本不存在）——既不搬迁也不矛盾。',
        claim('feedback/other.json', { kind: 'unclosed-feedback', feedbackId: 'fb-8888' }),
        HAPPY_SUBJECT, 'no-match'),
    ],
  },
})

// ---------------------------------------------------------------------------
// unclosed-only — the recall-first work list
// ---------------------------------------------------------------------------

const UNCLOSED_LEDGER = {
  feedback: [
    { id: 'fb-2001', quote: '支付成功后订单状态没有更新', source: '客服工单', severity: 'blocker', reach: 'all', frequency: 1, theme: 'payment', status: 'open' },
    { id: 'fb-2002', quote: '退款到账时间比说明的晚了三天', source: '客服工单', severity: 'high', reach: 'many', frequency: 2, theme: 'payment', status: 'open' },
    { id: 'fb-2003', quote: '搜索结果里出现了已下架的商品', source: '应用商店', severity: 'medium', reach: 'some', frequency: 5, theme: 'search', status: 'open' },
    { id: 'fb-2004', quote: '夜间模式下弹窗文字看不清', source: '应用商店', severity: 'low', reach: 'few', frequency: 18, theme: 'ui', status: 'open' },
  ],
  decisions: [
    { id: 'dec-31', title: '支付网关升级', rationale: '与反馈台账无关的基础设施改造', addresses: [], status: 'shipped', owner: 'erin' },
  ],
  themes: [
    { id: 'payment', name: '支付', members: [] },
    { id: 'search', name: '搜索', members: [] },
    { id: 'ui', name: '界面细节', members: ['fb-2004'] },
  ],
}
const UNCLOSED_DOC = { path: 'feedback/unclosed.json', type: 'feedback-ledger', meta: { bytes: 3072 }, payload: UNCLOSED_LEDGER }
const UNCLOSED_SUBJECT = { path: 'feedback/unclosed.json', documents: [UNCLOSED_DOC] }

write('unclosed-only', {
  name: 'unclosed-only',
  domain: DOMAIN,
  format: FORMAT,
  description: '一条闭环都没有的台账：4 条反馈全部没有 closedBy、没有任何决策在 addresses 里提到它们，另有 1 个孤儿决策。recall-first 下这份台账的覆盖率必然不完整，报告必须把 5 项缺口逐条列出而不是给一个计数——这份 fixture 就是用来钉住「清单而非计数」的。',
  input: { format: FORMAT, payload: { documents: [UNCLOSED_DOC] } },
  expect: {
    candidates: 8,
    paths: [
      'feedback/unclosed-fb-2001.json',
      'feedback/unclosed-fb-2002.json',
      'feedback/unclosed-fb-2003.json',
      'feedback/unclosed-fb-2004.json',
      'feedback/unclosed-dec-31.json',
      'feedback/unclosed-theme-payment.json',
      'feedback/unclosed-theme-search.json',
      'feedback/unclosed-theme-ui.json',
    ],
    admitted: 8,
    excludedByPredicate: {},
    bounded: true,
    truncated: false,
    bundleKeys: ['doc/feedback/unclosed.json', 'theme/payment', 'theme/search', 'theme/ui'],
    rankChecks: {
      byLoss: ['fb-2001', 'fb-2002', 'fb-2003', 'fb-2004'],
      byFrequency: ['fb-2004', 'fb-2003', 'fb-2002', 'fb-2001'],
      drownRisk: ['fb-2001'],
    },
    gapCount: 4,
    gapFeedbackIds: ['fb-2001', 'fb-2002', 'fb-2003', 'fb-2004'],
    orphanDecisionIds: ['dec-31'],
  },
  anchors: {
    positive: [
      positive('这个台账里每条反馈都无人处理——这正是它要证明的事。',
        claim('feedback/unclosed.json', { kind: 'unclosed-feedback', feedbackId: 'fb-2001' }),
        UNCLOSED_SUBJECT, 'declared-locator', 'feedback/unclosed.json'),
      positive('四个反馈都不属于任何决策，所以孤儿决策成立。',
        claim('feedback/unclosed.json', { kind: 'orphan-decision', decisionId: 'dec-31' }),
        UNCLOSED_SUBJECT, 'declared-locator', 'feedback/unclosed.json'),
      positive('主题 ui 两侧一致（members 里有 fb-2004，fb-2004 的 theme 也是 ui），但 payment 只有单边——两种都要能分辨。',
        claim('feedback/unclosed.json', { kind: 'theme-membership', themeId: 'ui', feedbackId: 'fb-2004' }),
        UNCLOSED_SUBJECT, 'declared-locator', 'feedback/unclosed.json'),
    ],
    negative: [
      refusal('payment 主题只被记录侧声明、目录侧 members 为空——单边不算成立。',
        claim('feedback/unclosed.json', { kind: 'theme-membership', themeId: 'payment', feedbackId: 'fb-2001' }),
        UNCLOSED_SUBJECT, 'locator-mismatch'),
      refusal('声称某条反馈已闭环，但台账里根本没有任何闭环——与事实相反。',
        claim('feedback/unclosed.json', { kind: 'closure-link', feedbackId: 'fb-2001', decisionId: 'dec-31' }),
        UNCLOSED_SUBJECT, 'no-match'),
    ],
  },
})

// ---------------------------------------------------------------------------
// dangling-and-collision — the ambiguity and role-collision fixture
// ---------------------------------------------------------------------------

const COLLIDE_LEDGER = {
  feedback: [
    { id: 'fb-3001', quote: '导出账单里多出一笔重复扣款', source: '客服工单', severity: 'blocker', reach: 'many', frequency: 1, theme: 'billing', status: 'open' },
    { id: 'fb-3002', quote: '导出账单里多出一笔重复扣款', source: '应用商店', severity: 'medium', reach: 'few', frequency: 4, theme: 'billing', status: 'open' },
    { id: 'fb-3003', quote: '发票抬头无法修改', source: '客服工单', severity: 'low', reach: 'few', frequency: 9, theme: 'billing', status: 'open' },
  ],
  decisions: [
    { id: 'fb-3004', title: '账单重复扣款排查', rationale: '两条同样的原话来自两个渠道', addresses: ['fb-3003'], status: 'planned', owner: 'erin' },
  ],
  themes: [{ id: 'billing', name: '账单', members: ['fb-3001'] }],
}

write('dangling-and-collision', {
  name: 'dangling-and-collision',
  domain: DOMAIN,
  format: FORMAT,
  description: '两个歧义源：其一，fb-3001 与 fb-3002 记录了逐字相同的原话，所以「引文」本身不能确定说的是哪一条——裸引文必须判 relocation-ambiguous 并列出竞争位置；其二，决策 ID `fb-3004` 与反馈 ID 前缀相同、且它不指向任何东西，用于检验角色判定与「与台账无关的决策」。',
  input: { format: FORMAT, payload: { documents: [{ path: 'feedback/billing.json', type: 'feedback-ledger', meta: { bytes: 2048 }, payload: COLLIDE_LEDGER }] } },
  expect: {
    candidates: 6,
    paths: [
      'feedback/billing-fb-3003-fb-3004.json',
      'feedback/billing-fb-3001.json',
      'feedback/billing-fb-3002.json',
      'feedback/billing-fb-3003.json',
      'feedback/billing-dec-fb-3004.json',
      'feedback/billing-theme-billing.json',
    ],
    admitted: 6,
    excludedByPredicate: {},
    bounded: true,
    truncated: false,
  },
  anchors: {
    positive: [
      positive('引文出现在两条记录里，但声明同时给了 feedbackId——身份是确定的，逐字也成立。',
        claim('feedback/billing.json', { kind: 'quote-anchor', feedbackId: 'fb-3002', quote: '导出账单里多出一笔重复扣款' }),
        { path: 'feedback/billing.json', documents: [{ path: 'feedback/billing.json', payload: COLLIDE_LEDGER }] },
        'declared-locator', 'feedback/billing.json'),
    ],
    negative: [
      refusal('决策 fb-3004 声明处理 fb-3003，而 fb-3003 没有 closedBy——单边闭环。',
        claim('feedback/billing.json', { kind: 'closure-link', feedbackId: 'fb-3003', decisionId: 'fb-3004' }),
        { path: 'feedback/billing.json', documents: [{ path: 'feedback/billing.json', payload: COLLIDE_LEDGER }] },
        'locator-mismatch'),
    ],
    ambiguous: [
      ambiguous('同一段原话出现在两条反馈里，而声明只给了引文、没给 feedbackId——引文不能确定身份，引擎拒绝挑一条。',
        claim('feedback/billing.json', { kind: 'quote-anchor', quote: '导出账单里多出一笔重复扣款' }),
        { path: 'feedback/billing.json', documents: [{ path: 'feedback/billing.json', payload: COLLIDE_LEDGER }] },
        ['feedback/billing.json#feedback:fb-3001', 'feedback/billing.json#feedback:fb-3002']),
    ],
  },
})

// ---------------------------------------------------------------------------
// two-ledgers — relocation
// ---------------------------------------------------------------------------

write('two-ledgers', {
  name: 'two-ledgers',
  domain: DOMAIN,
  format: FORMAT,
  description: '两份台账共同组成语料，用于搬迁阶梯：声明指向的 `feedback/absent.json` 不在语料里，而该声明在一份台账里成立、在另一处不成立（relocated-unique）；另一条声明在两份台账里都成立（relocation-ambiguous，必须列出全部竞争位置）。',
  input: {
    format: FORMAT,
    payload: {
      documents: [
        { path: 'feedback/alpha.json', type: 'feedback-ledger', meta: { bytes: 1024 }, payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6, theme: 'notify' }], decisions: [], themes: [] } },
        { path: 'feedback/beta.json', type: 'feedback-ledger', meta: { bytes: 1024 }, payload: { feedback: [{ id: 'fb-4002', quote: '通知中心的消息重复推送', severity: 'low', reach: 'few', frequency: 6, theme: 'notify' }], decisions: [], themes: [] } },
      ],
    },
  },
  expect: {
    candidates: 2,
    paths: [
      'feedback/alpha-fb-4001.json',
      'feedback/beta-fb-4002.json',
    ],
    admitted: 2,
    excludedByPredicate: {},
    bounded: true,
    truncated: false,
  },
  anchors: {
    positive: [
      positive('声明指向的台账不存在，而这条引文只在 alpha.json 里逐字出现。tier 是 recomputed-unique 而不是 relocated-unique，这个区别是有意的：locator 里根本没给 feedbackId，所以缺的是**定位信息**，引擎是从引文把身份重算出来的——先走重算、就不会再走搬迁阶梯。`detail` 里写明了它落在哪份台账上。',
        claim('feedback/absent.json', { kind: 'quote-anchor', quote: '通知中心的消息重复推送' }),
        { path: 'feedback/absent.json', documents: [
          { path: 'feedback/alpha.json', payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6 }], decisions: [] } },
          { path: 'feedback/other.json', payload: { feedback: [{ id: 'fb-5001', quote: '完全不相干的一条原话内容', severity: 'low', reach: 'few', frequency: 1 }], decisions: [] } },
        ] },
        'recomputed-unique', 'feedback/alpha.json'),
      positive('同一个 ID 在一份台账里成立、在另一份里不被声明时，搬迁是唯一的——这条走的是真正的搬迁阶梯（locator 给全了 ID，所以不是重算）。',
        claim('feedback/absent.json', { kind: 'unclosed-feedback', feedbackId: 'fb-4001' }),
        { path: 'feedback/absent.json', documents: [
          { path: 'feedback/alpha.json', payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6 }], decisions: [] } },
          { path: 'feedback/other.json', payload: { feedback: [{ id: 'fb-5001', quote: '完全不相干的一条原话内容', severity: 'low', reach: 'few', frequency: 1 }], decisions: [] } },
        ] },
        'relocated-unique', 'feedback/alpha.json'),
    ],
    negative: [
      refusal('搬迁不允许挑一个：声明的台账不存在，而两份台账里都有一条叫 fb-400x 的反馈无人处理——竞争位置必须列出。',
        claim('feedback/absent.json', { kind: 'unclosed-feedback', feedbackId: 'fb-4001' }),
        { path: 'feedback/absent.json', documents: [
          { path: 'feedback/alpha.json', payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6 }], decisions: [] } },
          { path: 'feedback/beta.json', payload: { feedback: [{ id: 'fb-4001', quote: '另一条同名记录的原话内容', severity: 'low', reach: 'few', frequency: 3 }], decisions: [] } },
        ] },
        'relocation-ambiguous'),
      refusal('ID 在两份台账里都被声明，身份本身就不唯一——此后任何关于它的关系都无法确认。',
        claim('feedback/alpha.json', { kind: 'unclosed-feedback', feedbackId: 'fb-4001' }),
        { path: 'feedback/alpha.json', documents: [
          { path: 'feedback/alpha.json', payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6 }], decisions: [] } },
          { path: 'feedback/beta.json', payload: { feedback: [{ id: 'fb-4001', quote: '另一条同名记录的原话内容', severity: 'low', reach: 'few', frequency: 3 }], decisions: [] } },
        ] },
        'relocation-ambiguous'),
    ],
    ambiguous: [
      ambiguous('同一句原话在两份台账里各出现一次，声明只给了引文——竞争位置必须全部列出。',
        claim('feedback/alpha.json', { kind: 'quote-anchor', quote: '通知中心的消息重复推送' }),
        { path: 'feedback/alpha.json', documents: [
          { path: 'feedback/alpha.json', payload: { feedback: [{ id: 'fb-4001', quote: '通知中心的消息重复推送', severity: 'medium', reach: 'some', frequency: 6 }], decisions: [] } },
          { path: 'feedback/beta.json', payload: { feedback: [{ id: 'fb-4002', quote: '通知中心的消息重复推送', severity: 'low', reach: 'few', frequency: 6 }], decisions: [] } },
        ] },
        ['feedback/alpha.json#feedback:fb-4001', 'feedback/beta.json#feedback:fb-4002']),
    ],
  },
})

/**
 * Every fixture this generator would produce, as `name -> text`. A copy, so a caller
 * cannot mutate the module's own state through the returned map.
 */
export function renderFixtures() {
  return new Map(rendered)
}

runEntry({ moduleUrl: import.meta.url, label: 'fixtures/_generate', here, render: renderFixtures })
