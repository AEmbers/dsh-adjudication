/**
 * risk-compliance — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `clause-and-surface`
 * ---------------------------------------------
 *   {
 *     clauses: [{ id, title, text, appliesTo?: string[] }],
 *     surface: [{ id, type, path?, description, evidence?, redacted?, retired?, bytes? }]
 *   }
 *
 * ONE CANDIDATE PER (clause, surface) BINDING whose clause `appliesTo` admits the
 * surface path. The pair — not the clause, not the surface — is the unit of work
 * here, because a compliance finding is always "THIS instrument clause about
 * THIS surface".
 *
 * `appliesTo` is a glob list; an absent or empty one means `['**']` (an
 * instrument clause with no scope restriction applies everywhere). A clause
 * whose globs match no surface at all is NOT silently dropped: it goes into
 * `excluded` with the reason, because "this clause governs nothing we can see"
 * is itself a finding a compliance reviewer wants (`unmatched-clause` fixture).
 *
 * WHY THE SOURCE DOES NOT APPLY THE GATE
 * --------------------------------------
 * It only reports what it saw. "P0 enumerated nothing" and "P1 removed
 * everything" must stay distinguishable in the plan — that is the whole point of
 * the `empty` and `all-gated-out` boundary fixtures.
 *
 * WHERE THE GATE'S EXCLUSION SIGNALS COME FROM
 * --------------------------------------------
 * `redacted` -> binary (a redacted surface item is not reviewable as text),
 * `retired`  -> deleted  (a withdrawn surface must leave the reviewable set),
 * `path`     -> globbed by the pack's Markdown exclusion rule and by the engine
 *               defaults (vendor, node_modules, lockfiles, ...).
 * The source sets these; it never sets `secretMatch` (the gate's own pre-pass
 * does that, per `GATE_FIELD_MAPPING`).
 *
 * `globToRegExp` is reproduced here rather than imported so the source's
 * `appliesTo` semantics are readable next to the code that uses them; it is a
 * byte-for-byte match of `lib/engine.js`'s gate glob (the same one the P1 gate
 * will use on the paths these candidates carry).
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/** Mirrors `lib/engine.js globToRegExp` — `**` spans separators, `*` does not. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  const body = escaped
    .replace(/\*\*\//gu, '\u0000')
    .replace(/\*\*/gu, '\u0001')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '[^/]')
    .replace(/\u0000/gu, '(?:.*/)?')
    .replace(/\u0001/gu, '.*')
  return new RegExp(`^${body}$`, 'u')
}

/** The scope a clause with no explicit `appliesTo` gets. */
const DEFAULT_APPLIES_TO = Object.freeze(['**'])

const byteLength = (value) => new TextEncoder().encode(String(value)).length

function normalisePath(value) {
  const text = String(value ?? '').trim().replace(/\\/gu, '/')
  return text === '' ? '' : text.replace(/^\.\//u, '')
}

/**
 * The clause-scope segment of a candidate's identity.
 *
 * WHY THE CANDIDATE PATH IS `<clause-scope>/<surface-path>` AND NOT JUST THE
 * SURFACE PATH
 * ---------------------------------------------------------------------------
 * This domain's unit of work is the (clause, surface) BINDING, not the surface:
 * one regulated surface is governed by several instruments at once, and a
 * finding must say which one it violates. So the binding's identity carries the
 * clause scope as its first segment, and the regulated surface's own path stays
 * intact as the suffix (it is also kept verbatim in `meta.surfacePath`).
 *
 * That choice is what makes P2 real. `GATE_FIELD_MAPPING.path` explicitly allows
 * a synthetic identity ("synthetic ids like `surface/data-flow-3` are fine"), and
 * because the first segment is the clause scope, grouping by that segment IS
 * grouping by "one instrument clause" — which is the domain's true bundle
 * semantics, and it survives any downstream normalisation that keeps `path`.
 * Globbing still works, because the surface path is preserved as the suffix:
 * `**` matches `all-00/vendor/legacy/sync.ts`, and so does `**&#47;vendor/**`.
 */
export function clauseScope(clauseId) {
  const scope = String(clauseId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return scope === '' ? 'clause' : scope
}

/**
 * The path this surface contributes to the candidate — and therefore the string
 * the P1 gate globs. A declared path is used verbatim (lower-cased so the
 * contract's candidate-path pattern admits it); without one the surface gets a
 * synthetic, stable, lowercase id `surface/<surface-id>`.
 */
export function surfacePath(surface, index) {
  const declared = normalisePath(surface?.path)
  if (declared !== '') return declared.toLowerCase()
  const id = String(surface?.id ?? `surface-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]/gu, '-')
  return `surface/${id === '' ? `surface-${index + 1}` : id}`
}

/** Which clause globs admit this surface path. */
export function clauseAdmits(clause, path) {
  const declared = Array.isArray(clause?.appliesTo) ? clause.appliesTo : []
  const patterns = declared.length > 0 ? declared.map(String) : [...DEFAULT_APPLIES_TO]
  return patterns.some((pattern) => globToRegExp(pattern).test(String(path).replace(/\\/gu, '/')))
}

/**
 * Render the material a bounded reviewer would put in context for one binding.
 * The evidence paragraph is reproduced VERBATIM: it is what the model copies
 * into an anchor claim, and a paraphrase is rejected by `anchor.js`.
 */
export function bindingText(clause, surface, path, maxLines) {
  const lines = [
    `条款 ${String(clause?.id ?? '(无 id)')}《${String(clause?.title ?? '(无标题)')}》`,
    `受监管面 ${String(surface?.id ?? '(无 id)')}（${String(surface?.type ?? '未分类')}）`,
    `路径 ${path}`,
    '',
    '条款正文：',
    String(clause?.text ?? '(未给出)'),
    '',
    '受监管面描述：',
    String(surface?.description ?? '(未给出)'),
    '',
    '可抄写证据：',
    String(surface?.evidence ?? surface?.description ?? '(未给出)'),
  ]
  if (!(Number(maxLines) > 0) || lines.length <= Number(maxLines)) return { text: lines.join('\n'), clipped: false }
  return { text: lines.slice(0, Number(maxLines)).join('\n'), clipped: true }
}

/**
 * The domain's documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source: `{ maxCandidates,
 * maxExcerptLines, include, exclude, extensions }`.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'clause-and-surface 输入必须是对象 { clauses, surface }')
  }
  if (input.clauses !== undefined && !Array.isArray(input.clauses)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`clauses` 必须是数组（可省略）')
  }
  if (input.surface !== undefined && !Array.isArray(input.surface)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`surface` 必须是数组（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const clauses = input.clauses ?? []
  const surfaces = input.surface ?? []
  const candidates = []
  const excluded = []
  const notes = []
  let truncated = false

  // Normalise the surfaces once. A malformed entry is REPORTED, never dropped
  // quietly: a compliance reviewer must be able to see that item #3 was junk.
  const items = []
  for (const [index, surface] of surfaces.entries()) {
    if (surface === null || typeof surface !== 'object') {
      excluded.push({ id: `surface#${index + 1}`, reason: '受监管面条目不是对象' })
      continue
    }
    const id = String(surface.id ?? '').trim()
    if (id === '') {
      excluded.push({ id: `surface#${index + 1}`, reason: '受监管面缺少 id —— 无法稳定引用' })
      continue
    }
    items.push({ surface, id, path: surfacePath(surface, index), index })
  }

  const seenIds = new Set()
  const scopeOwner = new Map()
  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (seenIds.has(candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过（条款 id 或受监管面 id 不唯一？）`)
      return false
    }
    seenIds.add(candidate.id)
    candidates.push(candidate)
    return true
  }

  /**
   * Deterministic scope disambiguation: two DIFFERENT clause ids must never
   * share a scope segment, or P2 would merge two instruments into one bundle.
   * First one keeps the plain scope; later collisions get `-2`, `-3`, …
   */
  const scopeFor = (clauseId) => {
    const base = clauseScope(clauseId)
    const owner = scopeOwner.get(base)
    if (owner === undefined) { scopeOwner.set(base, clauseId); return base }
    if (owner === clauseId) return base
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${suffix}`
      const held = scopeOwner.get(candidate)
      if (held === undefined) { scopeOwner.set(candidate, clauseId); return candidate }
      if (held === clauseId) return candidate
    }
    notes.push(`条款 "${clauseId}" 的作用域段无法与 "${owner}" 区分，已退回完整 id`)
    return clauseScope(clauseId) + '-' + candidates.length
  }

  for (const [index, clause] of clauses.entries()) {
    if (clause === null || typeof clause !== 'object') {
      excluded.push({ id: `clause#${index + 1}`, reason: '条款条目不是对象' })
      continue
    }
    const clauseId = String(clause.id ?? '').trim()
    if (clauseId === '') {
      excluded.push({ id: `clause#${index + 1}`, reason: '条款缺少 id —— 规则侧锚点将无法重算' })
      continue
    }

    const patterns = Array.isArray(clause.appliesTo) && clause.appliesTo.length > 0
      ? clause.appliesTo.map(String)
      : [...DEFAULT_APPLIES_TO]
    const admitted = items.filter((item) => clauseAdmits(clause, item.path))

    if (admitted.length === 0) {
      // Not a reason to drop the clause — a reason to SURFACE it.
      excluded.push({ id: clauseId, reason: `条款 appliesTo [${patterns.join(', ')}] 未匹配任何受监管面 —— 该条款管辖不到任何可取证的面` })
      continue
    }

    for (const item of admitted) {
      const rendered = bindingText(clause, item.surface, item.path, maxExcerptLines)
      if (rendered.clipped) {
        truncated = true
        notes.push(`${item.path} 的候选正文超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      }
      const declaredBytes = Number(item.surface.bytes)
      const scope = scopeFor(clauseId)
      push({
        id: `${clauseId}@${item.id}`,
        // The binding's identity: `<clause-scope>/<surface-path>`. The scope is
        // the first segment (so grouping by it IS grouping by instrument
        // clause), and the surface path is preserved as the suffix (so the P1
        // gate's globs still see the file they were written for). Neither a
        // synthetic `clause#surface` id nor a bare surface path would do both.
        path: `${scope}/${item.path}`,
        locator: { clauseId, surfaceId: item.id, surfacePath: item.path, clauseScope: scope },
        text: rendered.text,
        bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : byteLength(rendered.text),
        // The gate's own signals. `binary`/`deleted` are booleans or absent, so
        // the engine's predicates fire on exactly what the input declared.
        ...(item.surface.redacted === true ? { binary: true } : {}),
        ...(item.surface.retired === true ? { deleted: true } : {}),
        meta: {
          clauseId,
          clauseTitle: clause.title ?? null,
          clauseScope: scope,
          surfaceId: item.id,
          surfacePath: item.path,
          surfaceType: item.surface.type ?? null,
          appliesTo: patterns,
        },
      })
    }
  }

  return {
    candidates,
    excluded,
    notes,
    bounded: true,
    truncated,
  }
}

export default defineCandidateSource({
  kind: 'regulated-surface',
  inputFormat: 'clause-and-surface',
  bounded: true,
  describe: '制度条款清单 + 受监管面清单 -> 每个 (条款, 受监管面) 绑定一个候选；条款 appliesTo 决定管辖范围，未匹配到任何面的条款进 excluded。',
  enumerate,
})
