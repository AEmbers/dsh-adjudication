/**
 * reverse-engineering — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `artifact-and-observations` (see
 * `DOMAIN_INPUT_FORMATS` in `lib/contracts.js`, the authority this file follows):
 *
 *   {
 *     artifact: {
 *       id, kind?, sha256, size?, path?,
 *       tool?: { name, version }, environment?, notes?,
 *     },
 *     observations: [{
 *       id, kind: 'observation' | 'inference', statement, lead?,
 *       reproducibility?: { steps: string[], tool?, version?, expected? },
 *       evidence?: { offset?, bytes?, sample?, hash? },
 *       verified?: boolean,
 *       path?, binary?, deleted?,
 *     }],
 *   }
 *
 * WHAT THIS DOMAIN REFUSES TO PRETEND
 * -----------------------------------
 * C (exploration) domain, and the honest cost model is part of the deliverable:
 *
 * **候选集不可先验枚举、成本无上界。**
 *
 * A target artifact does not come with a list of the questions worth asking. What
 * this function enumerates is what the caller already CLAIMS to have observed; the
 * real candidate set is whatever further observation the artifact still has in
 * it — a second decompiler pass, a packed region nobody noticed, a protocol
 * behaviour that only shows up under load. So the sentence is emitted as a NOTE
 * on every run — including the empty one, which is exactly the run that would
 * otherwise read as "nothing to see here" — and `bounded` is `false`.
 *
 * THE SECOND LAW: AN OBSERVATION IS ONLY AN OBSERVATION IF IT REPRODUCES
 * ---------------------------------------------------------------------
 * "The blob is AES-128-CBC" is a fine hypothesis and a lie as an observation.
 * Every statement is therefore enumerated together with its REPRODUCTION STATUS,
 * and `anchor.js` refuses a claim that presents an unreproduced inference as a
 * verified observation. The registry is the seed's own account of which claims
 * have steps and which do not; the verifier checks the claim against it rather
 * than against the confidence of whoever wrote the claim.
 *
 * CANDIDATES: one per target artifact (its identity line — the hash every
 * observation is relative to), plus, per observation, its statement line and its
 * reproduction line.
 *
 * WHY `candidate.path` IS THE LEAD'S NOTE FILE
 * --------------------------------------------
 * P2's bundle key must be derivable from the candidate as the ENGINE hands it to
 * `bundleKey.resolve`, and through `adjudication_plan` the engine normalises
 * candidates to a fixed shape that keeps only `{path, bytes, additions,
 * deletions, binary, deleted, key}` — `meta` does not survive `toCandidates()`
 * (`lib/` is out of this domain's scope). So the candidate's `path` IS the note
 * file, by a convention that makes "one bundle = one LEAD against one artifact"
 * fall out of the path:
 *
 *     re/<artifact-slug>/observations/<lead-slug>.md
 *
 * Observations of one lead share that path, which is the point: a hypothesis and
 * the observation that supports or kills it belong in the same bundle, because
 * judging either one alone is exactly how an inference gets promoted to a fact.
 *
 * HONESTY: rules are drafted by an agent and marked `needs-expert-review`. This
 * file enumerates; it does not decide what is reviewable (the P1 gate does).
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/** `candidate.path` must satisfy the contract's id pattern or the gate cannot glob it. */
const PATH_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/u

/** The note-file convention this domain's candidates use. */
const NOTE_ROOT = 're'

/** How a statement appears in the note file — the line a reviewer must copy. */
export const statementLine = (observation) => `statement ${String(observation?.id ?? '')} :: ${String(observation?.statement ?? '')}`

/** The identity line of the target artifact. */
export const artifactLine = (artifact) => `artifact.sha256 = ${String(artifact?.sha256 ?? '')}`

/**
 * The reproduction status of an observation, as one line.
 *
 * `steps=0` is not "no steps needed" — it is "not reproduced". A statement whose
 * steps are empty is a HYPOTHESIS (猜想) no matter how confident it sounds, and
 * this line is what the verifier compares a claim against.
 */
export function reproductionLine(observation) {
  const steps = Array.isArray(observation?.reproducibility?.steps) ? observation.reproducibility.steps.filter((step) => String(step ?? '').trim() !== '') : []
  const tool = String(observation?.reproducibility?.tool ?? '').trim()
  const version = String(observation?.reproducibility?.version ?? '').trim()
  const verified = steps.length > 0 && observation?.verified !== false
  const kind = observation?.kind === 'inference' ? 'inference' : 'observation'
  const label = verified ? 'verified=true' : (kind === 'inference' ? 'verified=false (推断，未复现)' : 'verified=false (缺少可复现步骤)')
  return `repro ${String(observation?.id ?? '')} :: steps=${steps.length}${tool === '' ? '' : ` tool=${tool}${version === '' ? '' : ` ${version}`}`} ${label}`
}

/** Is this statement reproducible according to the seed itself? */
export function isReproduced(observation) {
  const steps = Array.isArray(observation?.reproducibility?.steps) ? observation.reproducibility.steps.filter((step) => String(step ?? '').trim() !== '') : []
  return steps.length > 0 && observation?.verified !== false
}

const byteLength = (value) => new TextEncoder().encode(String(value)).length

const asText = (value, fallback = '') => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

function slug(value, fallback = 'unknown') {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return text === '' ? fallback : text
}

/** The note path of a lead: `re/<artifact>/observations/<lead>.md`. */
export function notePath(artifact, lead, declaredPath) {
  const declared = String(declaredPath ?? '').replace(/\\/gu, '/').trim()
  if (declared !== '' && PATH_PATTERN.test(declared) && declared.startsWith(`${NOTE_ROOT}/`)) return declared
  const folder = slug(artifact?.id, 'artifact')
  const file = slug(lead, 'general')
  const derived = `${NOTE_ROOT}/${folder}/observations/${file}.md`
  return PATH_PATTERN.test(derived) ? derived : `${NOTE_ROOT}/${folder}/observations/general.md`
}

/**
 * The bundle key a candidate path encodes: one LEAD against one artifact.
 *
 *   re/fw123/observations/auth-flow.md  ->  re/fw123/observations/auth-flow
 *   something else                      ->  the path itself
 *
 * Exported because the pack's `bundleKey.resolve` must agree with it exactly.
 */
export function leadKeyFromPath(path) {
  const value = String(path ?? '').replace(/\\/gu, '/')
  return new RegExp(`^${NOTE_ROOT}/.+\\.md$`, 'u').test(value) ? value.replace(/\.md$/u, '') : value
}

/** The note file a lead's candidates share (rendered by `anchor.js` the same way). */
export function renderNote(artifact, lead, observations) {
  const lines = [
    `# lead ${asText(lead, 'general')} — artifact ${asText(artifact?.id, 'unknown')}`,
    artifactLine(artifact),
    `artifact.tool = ${asText(artifact?.tool?.name, '(unknown)')}${asText(artifact?.tool?.version, '') === '' ? '' : ` ${asText(artifact.tool.version)}`}`,
    `artifact.environment = ${asText(artifact?.environment, '(unknown)')}`,
  ]
  if (asText(artifact?.kind, '') !== '') lines.push(`artifact.kind = ${asText(artifact.kind)}`)
  lines.push('--- observations ---')
  for (const observation of observations) {
    lines.push(statementLine(observation))
    lines.push(reproductionLine(observation))
  }
  return `${lines.join('\n')}\n`
}

/** The leads present in the seed, in first-seen order. */
export function leadsOf(observations) {
  const leads = []
  for (const observation of Array.isArray(observations) ? observations : []) {
    const lead = asText(observation?.lead, 'general')
    if (!leads.includes(lead)) leads.push(lead)
  }
  return leads
}

export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'artifact-and-observations 输入必须是对象 { artifact, observations }')
  }
  if (input.artifact === null || typeof input.artifact !== 'object' || Array.isArray(input.artifact)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少对象字段 `artifact`（目标产物，必须带 id 与 sha256）')
  }
  if (!Array.isArray(input.observations)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `observations`（观察与推断）')
  }
  if (asText(input.artifact.sha256, '') === '') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`artifact.sha256` 必填：没有样本哈希，任何观察都无法复现，也无法证明它说的是同一个产物')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const artifactId = asText(input.artifact.id, 'artifact')
  const notes = []
  const excluded = []
  const candidates = []
  let truncated = false

  // --- the honest statement of the cost model, on EVERY run ------------------
  notes.push(
    '候选集不可先验枚举、成本无上界：本域是 C 探索型，下面列出的只是 seed 里已经提出的观察与推断；'
    + '一个目标产物还能被问出多少问题由进一步的观察决定，任何覆盖率分母都不代表分析已经做完。',
  )
  const artifactItem = { ...input.artifact, id: artifactId }
  const observations = input.observations.filter((observation) => observation !== null && typeof observation === 'object')

  const byId = new Map()
  for (const observation of observations) {
    const id = asText(observation.id)
    if (id === '') {
      notes.push('一条观察没有 id，已跳过（无法归属到具体观察，也无法被锚点复核）')
      continue
    }
    if (byId.has(id)) {
      notes.push(`观察 id "${id}" 重复出现；只保留第一个（重复的 id 会让锚点指向哪一条变成猜测）`)
      continue
    }
    if (asText(observation.statement, '') === '') {
      // No text, nothing to verify against: it is not an observation, it is a
      // placeholder. Recall-first keeps it in the report rather than dropping it
      // silently — but it cannot become a candidate.
      excluded.push({
        id,
        reason: `陈述 "${id}" 没有 statement 正文：没有可逐字核对的原文，不构成观察（它可能是一条待补写的推断）`,
      })
      continue
    }
    byId.set(id, observation)
  }

  const leads = byId.size === 0 ? [] : leadsOf([...byId.values()])

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  const clipped = (text) => {
    const lines = String(text).split(/\r?\n/u)
    if (lines.length <= maxExcerptLines) return String(text)
    truncated = true
    notes.push(`一段证据文本超过 maxExcerptLines ${maxExcerptLines}，已截断`)
    return lines.slice(0, maxExcerptLines).join('\n')
  }

  let unreproduced = 0
  for (const lead of leads) {
    const own = [...byId.values()].filter((observation) => asText(observation.lead, 'general') === lead)
    const declared = own.map((observation) => observation.path).find((path) => asText(path, '') !== '')
    const path = notePath(artifactItem, lead, declared ?? input.artifact.path)
    const reproduced = own.filter((observation) => isReproduced(observation)).length
    unreproduced += own.length - reproduced

    // `bytes` is a FILE-level fact in the engine (`too-large` is a file-level
    // predicate), so every candidate of one note file reports the same size — and
    // the same file-level flags: an observation that marks the note deleted or
    // binary makes the ARTIFACT candidate on that note deleted or binary too.
    // Otherwise the artifact row would survive a gate its own note did not.
    const bytes = byteLength(renderNote(artifactItem, lead, own))
    const fileFacts = {
      bytes,
      deleted: input.artifact.deleted === true || own.some((observation) => observation.deleted === true),
      binary: input.artifact.binary === true || own.some((observation) => observation.binary === true),
    }

    // --- one candidate per artifact, per lead -------------------------------
    push({
      id: `${artifactId}#artifact#${slug(lead)}`,
      path,
      locator: { artifactId, sha256: asText(artifactItem.sha256), kind: 'artifact', lead },
      text: clipped(artifactLine(artifactItem)),
      ...fileFacts,
      meta: { kind: 'artifact', artifactId, lead, sha256: asText(artifactItem.sha256), sourceKind: 'artifact' },
    })

    // --- one candidate per observation: statement and reproduction ----------
    for (const observation of own) {
      const id = asText(observation.id)
      const reproduced = isReproduced(observation)
      const observationKind = observation.kind === 'inference' ? 'inference' : 'observation'
      const base = {
        path,
        bytes,
        deleted: observation.deleted === true || input.artifact.deleted === true,
        binary: observation.binary === true || input.artifact.binary === true,
      }
      push({
        id: `${id}#statement`,
        locator: { artifactId, sha256: asText(artifactItem.sha256), kind: 'statement', observationId: id, observationKind, verified: reproduced, lead },
        text: clipped(statementLine(observation)),
        ...base,
        meta: { kind: 'statement', artifactId, observationId: id, observationKind, verified: reproduced, lead, sourceKind: 'statement' },
      })
      push({
        id: `${id}#repro`,
        locator: { artifactId, sha256: asText(artifactItem.sha256), kind: 'repro', observationId: id, observationKind, verified: reproduced, lead },
        text: clipped(reproductionLine(observation)),
        ...base,
        meta: { kind: 'repro', artifactId, observationId: id, observationKind, verified: reproduced, lead, sourceKind: 'repro' },
      })
    }

    if (own.length > 0 && own.every((observation) => !isReproduced(observation))) {
      notes.push(`线索 "${lead}" 下的 ${own.length} 条陈述全部没有可复现步骤：它们只能作为猜想提出，不得被写成已验证的观察`)
    }
  }

  const inferences = [...byId.values()].filter((observation) => observation.kind === 'inference')
  if (inferences.length > 0) {
    notes.push(`${inferences.length} 条陈述自称是「推断」（inference）：锚点复核要求它们保留猜想标注，把推断写成观察即判未锚定`)
  }
  if (unreproduced > 0 && inferences.length !== unreproduced) {
    notes.push(`${unreproduced} 条陈述缺少可复现步骤（steps=0 或 verified=false）：未复现不等于不成立，但不得当成已验证的观察引用`)
  }
  if (byId.size === 0) {
    notes.push('seed 里没有任何观察 —— 这不是「这个产物没有问题」，而是「还没开始看」。空集本身不是通过。')
  }

  return { candidates, excluded, notes, bounded: false, truncated }
}

export default defineCandidateSource({
  kind: 'artifact-observations',
  inputFormat: 'artifact-and-observations',
  // The contract (`checkContractIntegrity`) only lets a C domain declare this.
  bounded: false,
  describe: '目标产物 + 观察/推断 → 每条线索（lead）一组候选：产物身份行一个，每条陈述的「原文行」与「可复现性行」各一个。候选路径是线索笔记 re/<artifact>/observations/<lead>.md，因此「一条线索的陈述 + 它的复现状态」必然同捆，而不会被拆开单独评判。候选集不可先验枚举、成本无上界，这一点写进每次的 notes。',
  enumerate,
})
