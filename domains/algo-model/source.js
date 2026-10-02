/**
 * algo-model — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `experiment-record` (see `DOMAIN_INPUT_FORMATS` in
 * `lib/contracts.js`):
 *
 *   {
 *     experiments: [{
 *       id, name, seed,
 *       dataset: { train, valid, test, splitsHash },
 *       metrics: [{ name, value, definition, ci? }],
 *       baseline?: { id, metrics: [{ name, value }] },
 *       hyperparams: {}, budget: { steps, gpuHours },
 *       status?,                       // optional: 'finished' | 'cancelled' | …
 *     }],
 *   }
 *
 * TWO OPTIONAL FIELDS BEYOND THE DECLARED SHAPE, and why they are read:
 * `experiment.status` and `metric.kind` ('scalar' | 'artifact'). The contract's
 * gate mapping for this domain is "cancelled runs -> deleted; weights/artifacts
 * -> binary" — those signals have to come from the export somewhere, and a
 * tracker export does carry them. Both are optional: absent means "finished" and
 * "scalar".
 *
 * CANDIDATES: one per (experiment, metric). That granularity is the domain's
 * whole point — 「单题分数高不等于整体好转」: a review that only looks at the
 * aggregate can miss a metric that regressed while the headline number rose.
 *
 * WHAT THIS FILE REFUSES TO DO
 * ----------------------------
 * It never compares metrics and declares a winner. It enumerates, and it records
 * two structural facts the reviewer needs to make that judgement at all:
 *
 *   • `meta.hasBaseline` — an experiment with no baseline cannot support any
 *     claim of improvement, and the absence is reported as a note;
 *   • `meta.definitionDrift` — the same metric name carrying a DIFFERENT
 *     definition in another experiment. Any cross-experiment comparison of that
 *     metric is 口径不一致 until someone reconciles it.
 *
 * `candidate.path` is the experiment's record artifact
 * (`experiments/<id>/metrics.json`), so the P2 bundle key — "one experiment" —
 * is derivable from the candidate as the engine hands it over (see the same
 * note in `domains/data-engineering/source.js`: `toCandidates()` drops `meta`).
 * An artifact-kind metric lives at `experiments/<id>/<name>.<ext>` so the gate's
 * extension predicate can remove a weights file instead of reviewing it.
 *
 * HONESTY: this module only *enumerates*; the P1 gate decides reviewability, and
 * `empty` / `all-gated-out` prove the two boundaries stay distinguishable.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const PATH_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/u
const CHAIN_ROOT = 'experiments'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** The path segment an experiment id becomes: lowercase, `/` kept as hierarchy. */
function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/\\/gu, '/')
    .replace(/[^a-z0-9._/-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/\/+$/u, '')
}

/** The record artifact for one experiment — the bundle/chain identity. */
function recordPath(experimentId, metric) {
  const base = `${CHAIN_ROOT}/${slug(experimentId) || 'unknown'}`
  if (metric?.kind === 'artifact') {
    const name = slug(metric.name) || 'artifact'
    const dot = name.lastIndexOf('.')
    const candidate = dot > 0 ? `${base}/${name}` : `${base}/${name}.bin`
    if (PATH_PATTERN.test(candidate)) return candidate
    return `${base}/artifact.bin`
  }
  const candidate = `${base}/metrics.json`
  return PATH_PATTERN.test(candidate) ? candidate : `${CHAIN_ROOT}/unknown/metrics.json`
}

/**
 * The bundle key a candidate path encodes: ONE EXPERIMENT.
 *
 *   experiments/vision/model-v1/metrics.json -> vision/model-v1
 *   anything else                            -> the path itself
 */
export function chainKeyFromPath(path) {
  const value = String(path ?? '').replace(/\\/gu, '/')
  const match = new RegExp(`^${CHAIN_ROOT}/(.+)/[^/]+\\.[a-z0-9]+$`, 'u').exec(value)
  return match === null ? value : match[1]
}

/** The key a candidate bundles under (P2): one experiment. */
export function chainKey(candidate) {
  const id = candidate?.meta?.experimentId
  if (typeof id === 'string' && id !== '') return id
  return chainKeyFromPath(candidate?.path)
}

const metricName = (metric) => String(metric?.name ?? '').trim()
const metricValueText = (metric) => (typeof metric?.value === 'string' ? metric.value : JSON.stringify(metric?.value ?? null))

/** Does `line` mention `token` as a standalone token? */
function mentions(line, token) {
  if (typeof token !== 'string' || token === '') return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}([^A-Za-z0-9_.]|$)`, 'u').test(String(line))
}

/**
 * The canonical per-experiment record card. HOW A REVIEWER QUOTES A METRIC.
 *
 * Exported (and used by the fixtures) so that the document a verifier looks at and
 * the text a candidate carries can never drift apart: the candidate's text IS a
 * line of this rendering.
 */
export function renderExperiment(experiment) {
  const id = String(experiment?.id ?? '')
  const dataset = experiment?.dataset ?? {}
  const lines = [
    `# experiment ${id} (${String(experiment?.name ?? '(unnamed)')})`,
    `seed = ${String(experiment?.seed ?? '(unset)')}`,
    `dataset = train:${String(dataset.train ?? '?')} valid:${String(dataset.valid ?? '?')} test:${String(dataset.test ?? '?')} splits:${String(dataset.splitsHash ?? '(none)')}`,
  ]
  for (const metric of Array.isArray(experiment?.metrics) ? experiment.metrics : []) {
    if (metric === null || typeof metric !== 'object') continue
    const name = metricName(metric)
    if (name === '') continue
    lines.push(`metric ${name} = ${metricValueText(metric)}`)
    if (typeof metric.definition === 'string' && metric.definition !== '') {
      lines.push(`metric ${name}.definition = ${metric.definition}`)
    }
    if (metric.ci !== undefined && metric.ci !== null) {
      lines.push(`metric ${name}.ci = ${typeof metric.ci === 'string' ? metric.ci : JSON.stringify(metric.ci)}`)
    }
  }
  const baselineId = String(experiment?.baseline?.id ?? '')
  lines.push(baselineId === '' ? 'baseline = (none)' : `baseline = ${baselineId}`)
  return lines.join('\n')
}

/** The exact line a candidate for (experiment, metric) quotes. */
export function metricLine(experiment, metric) {
  const rendered = renderExperiment({ ...experiment, metrics: [metric], baseline: undefined })
  return rendered.split('\n').find((line) => mentions(line, metricName(metric)) && line.startsWith('metric ') && !line.includes('.definition') && !line.includes('.ci')) ?? ''
}

export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'experiment-record 输入必须是对象 { experiments: [...] }')
  }
  if (!Array.isArray(input.experiments)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'experiment-record 输入缺少数组字段 `experiments`（实验记录表）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const notes = []
  const excluded = []
  const candidates = []
  let truncated = false

  const experiments = []
  const seenIds = new Set()
  for (const experiment of input.experiments) {
    if (experiment === null || typeof experiment !== 'object') continue
    const id = String(experiment.id ?? '').trim()
    if (id === '') {
      notes.push('一条实验记录没有 id，已跳过（指标无法归属到一个没有 id 的实验）')
      continue
    }
    // CHANGED (input-format): a `baseline` that is NOT an object used to be read
    // as "this experiment has no baseline" — which is a MEANINGFUL state here,
    // and it produced a real finding ("没有 baseline … 不得作为有提升的证据")
    // for what was in fact a malformed field. A string like
    // `"纯噪声 0.978 / 合成光栅 0.509"` therefore bought you a false accusation
    // instead of an error. `null`/absent still mean "none"; anything else that
    // is not `{ id, metrics? }` is rejected the way the sibling diff domains
    // reject a non-string `diff`.
    if (experiment.baseline !== undefined && experiment.baseline !== null) {
      const shape = Array.isArray(experiment.baseline) ? 'array' : typeof experiment.baseline
      if (typeof experiment.baseline !== 'object' || Array.isArray(experiment.baseline)) {
        throw contractError(
          ERROR_CODES.E_INPUT_FORMAT,
          `实验 "${id}" 的 baseline 必须是对象 { id, metrics? }，收到 ${shape}`
          + ' —— 基线名不要写成字符串：一个非法的 baseline 会被读成「没有 baseline」，'
          + '而那是一条假发现（该实验会被判定为「不得作为有提升的证据」）',
        )
      }
    }
    if (seenIds.has(id)) {
      notes.push(`实验 id "${id}" 重复出现；只保留第一条（重复的实验会让指标的归属变成猜测）`)
      continue
    }
    seenIds.add(id)
    experiments.push({ ...experiment, id })
  }

  // Metric-definition drift: the same metric name, a different definition in
  // another experiment. Cross-experiment numbers are not comparable until it is
  // reconciled, and the reviewer must see that BEFORE comparing them.
  const definitionsByName = new Map()
  for (const experiment of experiments) {
    for (const metric of Array.isArray(experiment.metrics) ? experiment.metrics : []) {
      const name = metricName(metric)
      if (name === '') continue
      const definition = typeof metric?.definition === 'string' && metric.definition !== '' ? metric.definition : '(未声明)'
      if (!definitionsByName.has(name)) definitionsByName.set(name, new Set())
      definitionsByName.get(name).add(definition)
    }
  }
  const drifted = new Set()
  for (const [name, definitions] of definitionsByName) {
    if (definitions.size > 1) {
      drifted.add(name)
      notes.push(`指标 "${name}" 在不同实验里有 ${definitions.size} 种定义（口径不一致）：${[...definitions].join(' ｜ ')} —— 跨实验比较前必须先对齐口径`)
    }
  }

  const withoutBaseline = []
  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  for (const experiment of experiments) {
    const id = experiment.id
    const metrics = (Array.isArray(experiment.metrics) ? experiment.metrics : []).filter((metric) => metric !== null && typeof metric === 'object' && metricName(metric) !== '')
    const hasBaseline = experiment.baseline !== null && typeof experiment.baseline === 'object' && String(experiment.baseline?.id ?? '') !== ''
    const cancelled = String(experiment.status ?? '') === 'cancelled'
    if (!hasBaseline) withoutBaseline.push(id)
    const chain = id

    if (metrics.length === 0) {
      excluded.push({
        id,
        reason: `实验 "${id}" 没有任何指标（metrics 为空）—— 没有可判定的分数，也就没有可复核的结论`,
      })
      continue
    }

    for (const metric of metrics) {
      const name = metricName(metric)
      const text = metricLine(experiment, metric)
      const clipped = text.split(/\r?\n/u).length > maxExcerptLines
      push({
        id: `${id}#metric#${name}`,
        path: recordPath(id, metric),
        locator: { experimentId: id, metricName: name, value: metric.value ?? null },
        text: clipped ? text.split(/\r?\n/u).slice(0, maxExcerptLines).join('\n') : text,
        bytes: byteLength(text),
        deleted: cancelled,
        meta: {
          kind: 'metric',
          experimentId: id,
          metricName: name,
          metricKind: metric.kind === 'artifact' ? 'artifact' : 'scalar',
          value: metric.value ?? null,
          definition: typeof metric.definition === 'string' ? metric.definition : null,
          ci: metric.ci ?? null,
          hasBaseline,
          baselineId: hasBaseline ? String(experiment.baseline.id) : null,
          definitionDrift: drifted.has(name),
          splitsHash: experiment?.dataset?.splitsHash ?? null,
          seed: experiment.seed ?? null,
          steps: experiment?.budget?.steps ?? null,
          gpuHours: experiment?.budget?.gpuHours ?? null,
          chain,
          status: String(experiment.status ?? 'finished'),
        },
      })
    }
  }

  if (withoutBaseline.length > 0) {
    notes.push(`实验 ${withoutBaseline.map((id) => `"${id}"`).join('、')} 没有 baseline —— 单题分数高不等于整体好转，没有基线的实验不得作为「有提升」的证据`)
  }
  // Stated every run, not only when something is wrong: the reviewer's job in
  // this domain is per-metric, and a note that only appears on suspicion would
  // let the aggregate reading through on the quiet runs.
  notes.push('本领域逐题复核：单题分数高不等于整体好转 —— 每条结论都必须指出它覆盖了哪些指标、漏了哪些。')

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'experiment-metrics',
  inputFormat: 'experiment-record',
  bounded: true,
  describe: '实验记录 + 指标注册表 → 每个 (实验, 指标) 一个候选；候选路径是实验的记录产物（experiments/<id>/metrics.json），链键是实验 id。没有基线的实验与口径不一致的指标都在 notes 里点名。',
  enumerate,
})
