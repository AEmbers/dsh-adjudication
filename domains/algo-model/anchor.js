/**
 * algo-model — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT AN ANCHOR IS IN THIS DOMAIN
 * --------------------------------
 * 「指标名 + 实验 ID」 — and the structured half runs first:
 *
 *   1. the experiment must exist in the tracker records;
 *   2. the metric must exist IN THAT EXPERIMENT (a metric name that only exists
 *      in a sibling experiment is the classic mis-attribution);
 *   3. if the claim states a value, it must equal the recorded value — a
 *      transcription that "looks about right" is refused, because 「单题分数高不
 *      等于整体好转」 starts from numbers that were actually read correctly;
 *   4. if the claim states a definition, it must equal the recorded one —
 *      otherwise the claim is comparing different 口径;
 *   5. only then is the quoted line located verbatim in the experiment's record
 *      card, with the line number recomputed by the engine.
 *
 * HOW THE RECORDS REACH THE VERIFIER
 * ----------------------------------
 * `subject.experiments` (library callers) or a document whose content is the
 * tracker export under the domain's convention `experiments/records.json` — the
 * engine's recompute path (`recomputeAnchor()` in `index.js`) can only hand a
 * verifier `{path, content, document, documents}`, and `adjudication_submit`
 * recomputes every finding. The records therefore travel as a document, which
 * also means the model cannot invent a metric: the export it is checked against
 * is the one the plan was given.
 *
 * A claim with no locator at all can only confirm the EXPERIMENT (that is what
 * `adjudication_anchor` can reach today, its parameters carry no domain locator)
 * and says so in `detail` — never presenting it as a confirmed metric.
 *
 * Refusal codes map onto the contract's DECLARED tiers; the reason travels in
 * `code`/`detail` (an undeclared tier would fail `validateAnchorVerdict`).
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import { allMatches, matchesAt } from '../code-review/anchor.js'
import { chainKeyFromPath, recordPath, renderExperiment } from './source.js'

/** Same literal comparison rule as every migrated domain (see code-review/anchor.js). */
const normalizeLine = (line) => String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

const KIND = 'experiment-metric'

/** The document convention that carries the tracker export. */
const RECORDS_DOCUMENT = /^experiments\/[a-z0-9._-]*\.json$/u

const lineCount = (content) => String(content).split(/\r?\n/u).length

const unanchored = (tier, code, detail, extra = {}) => ({
  status: 'unanchored', tier, code, path: null, start: null, end: null, detail, ...extra,
})

const anchored = (path, start, end, tier, code, detail) => ({
  status: 'anchored', tier, code, path, start, end, detail,
})

function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content })
  }
  return documents
}

/**
 * The experiment records, from `subject.experiments`, from a records DOCUMENT, or
 * from the subject's own `content` (the self-folded form).
 *
 * WHY THE THIRD FORM EXISTS: through `adjudication_anchor` the engine collapses
 * whatever the caller supplied into `{ path, content, document, documents }` — a
 * structured `subject.experiments` field does not survive that trip. A caller
 * that hands the tracker EXPORT back as the subject document (path
 * `experiments/*.json`, content the JSON text) is handing back exactly the input
 * material the review was based on, so the domain must be able to read it back
 * out of `content`. Not a bypass: the parsed records go through the SAME metric
 * / value / definition recomputation, and an unconfirmed metric still produces
 * `metric-unconfirmed`.
 */
function toExperiments(subject) {
  const direct = subject?.experiments ?? subject?.records?.experiments
  if (Array.isArray(direct)) return { experiments: direct, source: 'subject.experiments' }
  for (const document of toDocuments(subject)) {
    if (!RECORDS_DOCUMENT.test(document.path)) continue
    let parsed = null
    try {
      parsed = JSON.parse(document.content)
    } catch {
      continue
    }
    if (Array.isArray(parsed?.experiments)) return { experiments: parsed.experiments, source: document.path }
  }
  // Shape-checked, so a record card whose text happens to be valid JSON is safe.
  if (typeof subject?.content === 'string' && subject.content.trim() !== '') {
    try {
      const parsed = JSON.parse(subject.content)
      if (Array.isArray(parsed?.experiments)) return { experiments: parsed.experiments, source: 'subject.content' }
    } catch {
      return null
    }
  }
  return null
}

function isStructuredDocument(document) {
  if (!RECORDS_DOCUMENT.test(document.path)) return false
  try {
    return Array.isArray(JSON.parse(document.content)?.experiments)
  } catch {
    return false
  }
}

function locateText(claim, subject, preferred, fallbackDocument = null) {
  const needle = normalizeExcerpt(claim.excerpt ?? '')
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  // A document NAMED by the claim wins over the subject's own content: when the
  // caller folds the tracker export into `content` (self-folded subject) and hands
  // the record card back inside `documents`, the prose to search is the card. The
  // `content` fallback applies only when the subject's own document IS the one the
  // claim names (or names nothing); otherwise the claim points at a file nobody
  // handed back, which is what the relocation ladder below exists for.
  const subjectIsNamed = subjectContent !== null
    && (subject?.path === undefined || subject?.path === null || subject.path === preferred)
  const named = documents.find((document) => document.path === preferred)
    ?? (subjectIsNamed ? { path: preferred, content: subjectContent } : null)
  const others = documents.filter((document) => document.path !== preferred && !isStructuredDocument(document))
  // A structured payload document is DATA, never prose: the filter above is what
  // makes `a structured payload document … an excerpt never relocates into it`
  // true, and `test.mjs` pins it with the export's OWN line as the needle so it
  // cannot pass for the wrong reason. But the refusal that follows must not claim
  // "no document contains this text" when one demonstrably does. That message is
  // false, and a false reason sends the caller hunting for a typo that is not
  // there instead of quoting the card. So the structured holders are found here
  // and named in the refusal.
  const structuredHolders = documents
    .filter((document) => document.path !== preferred && isStructuredDocument(document))
    .filter((document) => allMatches(document.content, needle).length > 0)
    .map((document) => document.path)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', 'no-documents', '没有提供任何可比对的文档内容 —— 无法重算锚点')
  }
  if (named !== null) {
    const declared = claim.locator?.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator', 'quoted-line-at-declared-line',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）`)
      }
      return unanchored('locator-mismatch', 'locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique', 'quoted-line-recomputed',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', 'no-match',
        `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁（转述不是抄写）`)
    }
    return unanchored('relocation-ambiguous', 'relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) hits.push({ path: document.path, start: hit.start, end: hit.end })
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique', 'quoted-line-relocated',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous', 'relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对文档中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  // ADDED (anchor-preview): LAST RESORT — the card the DOMAIN renders for the
  // experiment. The line the work order asks the caller to quote
  // (`metric accuracy = 0.912`) is rendered FROM the JSON record: it is not a
  // line of any file on disk, and the tracker export cannot contain it either, so
  // before this the loop was unclosable — the plan printed a line, `submit`
  // demanded it back verbatim, and no document could ever hold it (measured: six
  // `no-match` refusals, zero anchored findings, P6 never running because there
  // was nothing anchored to re-check).
  //
  // It is tried LAST on purpose: an ambiguity has to stay an ambiguity. A caller
  // that hands back a real card still wins, and a quote that matches two places
  // in the handed-back documents is still refused above. Not a bypass either:
  // the metric name, value and definition were recomputed from the export
  // immediately before this point, so a quote that does not match the confirmed
  // record still fails.
  if (fallbackDocument !== null && fallbackDocument !== undefined) {
    const inCard = allMatches(fallbackDocument.content, needle)
    if (inCard.length === 1) {
      return anchored(fallbackDocument.path, inCard[0].start, inCard[0].end, 'recomputed-unique', 'quoted-line-recomputed',
        `在 ${fallbackDocument.path} 唯一命中（第 ${inCard[0].start}-${inCard[0].end} 行，该记录卡由本域按已验证的 tracker 记录渲染），未采信模型行号`)
    }
    if (inCard.length > 1) {
      return unanchored('relocation-ambiguous', 'relocation-ambiguous',
        `抄写原文在渲染出的记录卡里出现 ${inCard.length} 次，位置不唯一 —— 拒绝猜测`,
        { ambiguousIn: inCard.map((hit) => `${fallbackDocument.path}:${hit.start}`) })
    }
  }
  if (structuredHolders.length > 0) {
    return unanchored('no-match', 'no-match',
      `抄写原文逐字出现在结构化导出 ${structuredHolders.join('、')} 里，但结构化导出是 DATA 而不是 prose：本域只从它重算记录，不拿它当可引用原文（一条 JSON 行永远不等于一张记录卡）。`
      + `请引用工作单打印的那一行记录卡（形如 metric <name> = <value>）—— 本域会按已验证的 tracker 记录渲染出该卡并据此定位。`)
  }
  return unanchored('no-match', 'no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
}

const valueText = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<object>,experiments?:Array<object>}} subject
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }
  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', 'kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', 'empty-excerpt',
      '抄写的原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const records = toExperiments(subject)
  if (records === null) {
    return unanchored('no-documents', 'no-records',
      '没有提供实验记录 —— 指标锚点必须与 tracker 导出比对，不能只靠一段文本。'
      + '请把导出作为文档传进来（约定路径 experiments/records.json），或通过 subject.experiments 直接给出。')
  }
  const experiments = records.experiments.filter((entry) => entry !== null && typeof entry === 'object')

  const experimentId = String(locator.experimentId ?? '')
  if (experimentId === '') {
    // Chain-level: only the EXPERIMENT can be confirmed without a locator.
    const wanted = chainKeyFromPath(claim.path)
    const found = experiments.find((entry) => String(entry.id ?? '') === wanted) ?? null
    if (found === null) {
      return unanchored('locator-mismatch', 'unknown-experiment',
        `locator 缺少 experimentId，且路径 "${claim.path}" 指向的实验 "${wanted}" 不在记录里 —— 拒绝猜测`)
    }
    const cardPath = recordPath(wanted, null)
    const card = claim.path === cardPath ? { path: cardPath, content: renderExperiment(found) } : null
    const result = locateText(claim, subject, claim.path, card)
    if (result.status === 'anchored') {
      result.code = 'experiment-confirmed'
      result.detail = `${result.detail}；实验 "${wanted}" 在记录中存在，但这次没有声明具体指标 —— 指标未确认`
      result.experimentId = wanted
    }
    return result
  }

  const experiment = experiments.find((entry) => String(entry.id ?? '') === experimentId) ?? null
  if (experiment === null) {
    return unanchored('locator-mismatch', 'unknown-experiment',
      `实验记录里没有 "${experimentId}" —— 声明与输入矛盾`, { experimentId })
  }
  const name = String(locator.metricName ?? '')
  if (name === '') {
    return unanchored('locator-mismatch', 'incomplete-locator',
      '指标锚点的 locator 必须给出 experimentId 与 metricName —— 缺一个就无法与记录比对')
  }
  const metrics = (Array.isArray(experiment.metrics) ? experiment.metrics : []).filter((metric) => metric !== null && typeof metric === 'object')
  const metric = metrics.find((entry) => String(entry.name ?? '') === name) ?? null
  if (metric === null) {
    return unanchored('locator-mismatch', 'metric-unconfirmed',
      `实验 "${experimentId}" 里没有指标 "${name}"（它有：${metrics.map((entry) => String(entry.name ?? '')).join(', ') || '(无)'}）`
      + ' —— 指标名必须出现在它被归属的那个实验里，别的实验有同名指标也不算',
      { experimentId, knownMetrics: metrics.map((entry) => String(entry.name ?? '')) })
  }
  if (locator.value !== undefined && locator.value !== null && valueText(locator.value) !== valueText(metric.value)) {
    return unanchored('locator-mismatch', 'value-mismatch',
      `声明的 "${name}" = ${valueText(locator.value)} 与记录里的 ${valueText(metric.value)} 不符 —— 数字必须逐字对齐，不做四舍五入`,
      { experimentId, metricName: name, recordedValue: metric.value })
  }
  if (typeof locator.definition === 'string' && locator.definition !== '' && locator.definition !== String(metric.definition ?? '')) {
    return unanchored('locator-mismatch', 'definition-mismatch',
      `声明的口径与记录里的口径不同：声明 ${JSON.stringify(locator.definition)}，记录 ${JSON.stringify(String(metric.definition ?? ''))}`
      + ' —— 口径不一致的指标不能与别的实验比较',
      { experimentId, metricName: name, recordedDefinition: metric.definition ?? null })
  }

  const cardPath = recordPath(experimentId, metric)
  const card = claim.path === cardPath ? { path: cardPath, content: renderExperiment(experiment) } : null
  const result = locateText(claim, subject, claim.path, card)
  if (result.status === 'anchored') {
    result.code = 'metric-confirmed'
    result.detail = `${result.detail}；指标 ${experimentId}.${name} = ${valueText(metric.value)} 已在记录中确认`
    result.experimentId = experimentId
    result.metricName = name
  }
  return result
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '实验指标锚点：先在 tracker 记录里重算「这个实验真的有这个指标、值也对得上」，再在实验记录卡里逐字定位抄写的原文；指标不存在、值不符、口径不符一律未锚定 —— 单题分数必须真的读对。',
  verify,
})

export { allMatches, matchesAt }
