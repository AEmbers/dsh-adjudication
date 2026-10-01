/**
 * dsh-adjudication — the domain directory loader (contract v2, §4).
 *
 * WHAT THIS SOLVES
 * ----------------
 * v1 put all nineteen packs in one 868-line file (`lib/domains.js`). Nineteen
 * owners editing one file is a write-conflict generator, and a domain could not
 * ship its own source, anchor, evidence, prompts, rules or fixtures.
 *
 * v2 gives each domain a directory. This module is the mechanism that finds and
 * loads them:
 *
 *   domains/<id>/index.js      the v2 pack (default export)
 *   domains/<id>/source.js     candidateSource   (P0)
 *   domains/<id>/anchor.js     anchorVerifier    (P5)
 *   domains/<id>/evidence.js   evidenceTools     (P7)
 *   domains/<id>/prompts.js    reviewPrompts     (P4/P6)
 *   domains/<id>/rules/*.md    ruleLibrary       (P3, >= 20 documents)
 *   domains/<id>/fixtures/     inputs + expectations
 *   domains/<id>/test.mjs      P0 -> P7 assertions
 *
 * WHY IT TAKES AN `io` OBJECT
 * ---------------------------
 * This package has zero runtime DEPENDENCIES, and that is not stylistic: a
 * plugin installed from a local path is `link:`-ed by pnpm and its dependencies
 * are never installed.
 *
 * Precisely, so nobody has to guess: this module has exactly ONE static import,
 * `./contracts.js` — a relative sibling with no imports of its own. It does NOT
 * import a third-party package, and it does NOT statically import `node:fs`
 * (or `node:path`, or `node:url`); a host that lacks those can still load this
 * file. Filesystem access arrives as an injected four-method `io`:
 *
 *   io.readDir(path) -> Array<{ name, isDirectory }>   // [] when absent
 *   io.readFile(path) -> string | undefined            // undefined when absent
 *   io.exists(path) -> boolean
 *   io.toUrl(path) -> string                           // for `import()`
 *
 * Two implementations ship here:
 *   • {@link createMemoryIo} — a pure in-memory io; the kernel tests use it, so
 *     the discovery mechanism is proven without touching a real filesystem.
 *   • {@link createNodeIo}   — lazily acquires `node:fs`/`node:path`/`node:url`
 *     through dynamic import INSIDE the factory, only when a host actually asks
 *     for a real directory scan.
 *
 * Module loading is injected the same way (`options.loadModule`), which is what
 * lets a test drive the whole discovery path with crafted module namespaces.
 *
 * REPORTED SHAPES
 * ---------------
 * Every skip — at the directory-scan level and at the domain-package level — is
 * the SAME shape, {@link SKIPPED_ENTRY_KEYS}: `{ id, reason }`. There is one
 * vocabulary, not two, because a domain owner writing `test.mjs` should never
 * have to ask which level produced an entry.
 *
 *   { id: string, reason: string }              // ↳ `skipped`
 *   { id: string, problems: string[] }          // ↳ `problems` (a list, by design)
 */

import {
  CONTRACT_VERSION,
  ERROR_CODES,
  MIN_RULES_PER_DOMAIN,
  contractError,
  parseRuleDocument,
  ruleFromDocument,
  validateDomainPackV2,
  validateRuleDocument,
} from './contracts.js'

/** Where domain directories live, relative to the package root. */
export const DEFAULT_DOMAIN_ROOT = 'domains'

/**
 * The one and only key set a `skipped` entry carries, at every level.
 *
 * `id` is the directory name for a scan-level skip and the declared domain id
 * for a package-level one; `reason` is a short human-readable cause. Both levels
 * share it so `result.skipped.map((entry) => entry.id)` is always meaningful.
 */
export const SKIPPED_ENTRY_KEYS = Object.freeze(['id', 'reason'])

/**
 * Does `value` have exactly the {@link SKIPPED_ENTRY_KEYS} shape?
 * Exported so a domain's `test.mjs` can lock the shape in one line instead of
 * re-deriving it from prose.
 *
 * @returns {string[]} problems, empty when the entry is well-formed
 */
export function validateSkippedEntry(value, where = 'skipped entry') {
  const problems = []
  if (value === null || typeof value !== 'object') return [`${where} is not an object`]
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== [...SKIPPED_ENTRY_KEYS].sort().join(',')) {
    problems.push(`${where} must carry exactly ${SKIPPED_ENTRY_KEYS.join(' + ')} (got ${keys.join(',') || 'nothing'})`)
  }
  if (typeof value.id !== 'string' || value.id === '') problems.push(`${where}.id must be a non-empty string`)
  if (typeof value.reason !== 'string' || value.reason === '') problems.push(`${where}.reason must be a non-empty string`)
  return problems
}

/** Validate a whole `skipped` list. @returns {string[]} problems */
export function validateSkippedEntries(entries, where = 'skipped') {
  if (!Array.isArray(entries)) return [`${where} must be an array`]
  return entries.flatMap((entry, index) => validateSkippedEntry(entry, `${where}[${index}]`))
}

/** Extension-point file inside a domain directory, keyed by pack field. */
export const EXTENSION_FILES = Object.freeze({
  candidateSource: 'source.js',
  anchorVerifier: 'anchor.js',
  evidenceTools: 'evidence.js',
  reviewPrompts: 'prompts.js',
})

/** Directory names that are never domains. */
export const IGNORED_DIRECTORY_NAMES = Object.freeze(['index.js', 'node_modules'])

const ID_PATTERN = /^[a-z][a-z0-9-]*$/u

const normalisePath = (path) => String(path ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '')

// ---------------------------------------------------------------------------
// io implementations
// ---------------------------------------------------------------------------

/**
 * Build a pure in-memory io from a flat `{ path: contents }` map.
 *
 * Directories are derived from the keys, so `{ 'domains/a/index.js': '…' }`
 * yields `readDir('domains') -> [{ name: 'a', isDirectory: true }]`.
 * This is what makes the discovery mechanism testable with no filesystem at all.
 */
export function createMemoryIo(files = {}) {
  const contents = new Map()
  for (const [key, value] of Object.entries(files)) contents.set(normalisePath(key), value)

  const directories = new Set([''])
  for (const key of contents.keys()) {
    const parts = key.split('/')
    parts.pop()
    for (let depth = 1; depth <= parts.length; depth += 1) directories.add(parts.slice(0, depth).join('/'))
  }

  return {
    readDir(path) {
      const dir = normalisePath(path)
      const prefix = dir === '' ? '' : `${dir}/`
      const entries = new Map()
      for (const key of contents.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [head, ...tail] = rest.split('/')
        entries.set(head, tail.length > 0)
      }
      for (const candidate of directories) {
        if (candidate === '' || !candidate.startsWith(prefix)) continue
        const rest = candidate.slice(prefix.length)
        if (rest === '' || rest.includes('/')) continue
        entries.set(rest, true)
      }
      return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
    readFile(path) {
      return contents.get(normalisePath(path))
    },
    exists(path) {
      const key = normalisePath(path)
      return contents.has(key) || directories.has(key)
    },
    toUrl(path) {
      return `memory:///${normalisePath(path)}`
    },
  }
}

/**
 * Build a real filesystem io. The three `node:` modules are acquired through a
 * dynamic import *inside* this factory, so this module still has no load-time
 * dependencies at all.
 *
 * @param {object} [options] `{ root, baseUrl }` — `baseUrl` is a `file:` URL
 *   (what `new URL('.', import.meta.url)` gives a caller) and wins over `root`.
 */
export async function createNodeIo(options = {}) {
  const [fs, path, url] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ])
  const root = typeof options.baseUrl === 'string' && options.baseUrl !== ''
    ? url.fileURLToPath(options.baseUrl)
    : path.resolve(options.root ?? process.cwd())
  const absolute = (target) => path.resolve(root, normalisePath(target))

  return {
    root,
    readDir(target) {
      const directory = absolute(target)
      if (!fs.existsSync(directory)) return []
      try {
        return fs.readdirSync(directory, { withFileTypes: true })
          .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      } catch {
        return []
      }
    },
    readFile(target) {
      const file = absolute(target)
      try {
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
      } catch {
        return undefined
      }
    },
    exists(target) {
      return fs.existsSync(absolute(target))
    },
    toUrl(target) {
      return url.pathToFileURL(absolute(target)).href
    },
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan the domain root. **Synchronous and total**: a missing root is an empty
 * result, never a throw — a host without a `domains/` directory is the normal
 * case while the nineteen v1 packs are still the shipping library.
 *
 * @returns {{
 *   root: string,
 *   found: Array<{ id: string, dir: string }>,
 *   skipped: Array<{ id: string, reason: string }>,
 *   problems: Array<{ id: string, problems: string[] }>,
 * }}
 */
export function discoverDomains(io, options = {}) {
  const root = normalisePath(options.root ?? DEFAULT_DOMAIN_ROOT)
  const ignored = new Set(options.ignored ?? IGNORED_DIRECTORY_NAMES)
  const found = []
  const skipped = []
  const problems = []

  let listing
  try {
    listing = io.readDir(root) ?? []
  } catch (error) {
    return { root, found, skipped, problems: [{ id: '(root)', problems: [`cannot read "${root}": ${error?.message ?? String(error)}`] }] }
  }

  for (const entry of listing) {
    const name = entry?.name
    if (typeof name !== 'string' || name === '') continue
    if (ignored.has(name)) continue
    if (!entry.isDirectory) {
      skipped.push({ id: name, reason: 'not a directory' })
      continue
    }
    if (name.startsWith('.') || name.startsWith('_')) {
      skipped.push({ id: name, reason: 'ignored (dot/underscore prefix)' })
      continue
    }
    if (!ID_PATTERN.test(name)) {
      skipped.push({ id: name, reason: 'directory name is not lowercase kebab-case' })
      continue
    }
    if (!io.exists(`${root}/${name}/index.js`)) {
      skipped.push({ id: name, reason: 'missing index.js' })
      continue
    }
    found.push({ id: name, dir: `${root}/${name}` })
  }

  found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { root, found, skipped, problems }
}

// ---------------------------------------------------------------------------
// Rule library loading
// ---------------------------------------------------------------------------

/**
 * Load `rules/*.md` through the injected io. Files are read in sorted order so
 * rule selection (first matching glob wins, declaration order) is deterministic.
 *
 * @returns {{ rules: object[], problems: string[] }}
 */
export function loadRules(io, directory) {
  const rules = []
  const problems = []

  let listing
  try {
    listing = io.readDir(directory) ?? []
  } catch (error) {
    return { rules, problems: [`cannot read "${directory}": ${error?.message ?? String(error)}`] }
  }

  const files = listing
    .filter((entry) => entry?.isDirectory === false && typeof entry.name === 'string' && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()

  if (files.length === 0) {
    problems.push(`no rule documents found in "${directory}" (need >= ${MIN_RULES_PER_DOMAIN} .md files)`)
    return { rules, problems }
  }

  for (const file of files) {
    const text = io.readFile(`${directory}/${file}`)
    if (typeof text !== 'string') {
      problems.push(`${file}: unreadable`)
      continue
    }
    const documentProblems = validateRuleDocument(text, file)
    if (documentProblems.length > 0) {
      problems.push(...documentProblems)
      continue
    }
    try {
      rules.push(ruleFromDocument(text, file))
    } catch (error) {
      problems.push(`${file}: ${error?.message ?? String(error)}`)
    }
  }

  return { rules, problems }
}

// ---------------------------------------------------------------------------
// Domain loading
// ---------------------------------------------------------------------------

/**
 * Load ONE domain directory.
 *
 * @param {object} io
 * @param {{ id: string, dir: string }} entry
 * @param {object} [options] `{ loadModule }`
 * @returns {Promise<{ pack?: object, problems: string[], files: string[] }>}
 */
export async function loadDomain(io, entry, options = {}) {
  const loadModule = typeof options.loadModule === 'function' ? options.loadModule : (url) => import(url)
  const url = (path) => (typeof io.toUrl === 'function' ? io.toUrl(path) : path)
  const problems = []
  const files = []

  const namespace = await loadModule(url(`${entry.dir}/index.js`))
  files.push('index.js')
  const declared = namespace?.default ?? namespace?.pack
  if (declared === null || typeof declared !== 'object') {
    return { problems: ['index.js must default-export a domain pack object'], files }
  }

  // A shallow copy: the loader fills extension points the pack left to its
  // sibling files, and it must never mutate the imported namespace.
  const pack = { contractVersion: CONTRACT_VERSION, ...declared }

  // Sibling extension-point files are imported only when the pack does not
  // already carry that point inline (index.js declarations win).
  for (const [field, file] of Object.entries(EXTENSION_FILES)) {
    if (pack[field] !== undefined) continue
    if (namespace?.[field] !== undefined) {
      pack[field] = namespace[field]
      continue
    }
    if (!io.exists(`${entry.dir}/${file}`)) continue
    const module = await loadModule(url(`${entry.dir}/${file}`))
    files.push(file)
    if (module?.default === undefined) {
      problems.push(`${file}: must default-export the ${field} value`)
      continue
    }
    pack[field] = module.default
  }

  // Rule library: `rules/*.md` unless the pack declares its own library.
  if (pack.ruleLibrary === undefined) {
    const rulesDirectory = `${entry.dir}/${options.rulesDir ?? 'rules'}`
    if (io.exists(rulesDirectory)) {
      const loaded = loadRules(io, rulesDirectory)
      pack.ruleLibrary = { __contract: CONTRACT_VERSION, dir: options.rulesDir ?? 'rules', rules: loaded.rules }
      problems.push(...loaded.problems)
      if (loaded.rules.length > 0) files.push(`${options.rulesDir ?? 'rules'}/*.md`)
    }
  } else if (typeof pack.ruleLibrary?.load === 'function' && !Array.isArray(pack.ruleLibrary.rules)) {
    // A domain-supplied loader receives the SAME io, so it still imports nothing.
    try {
      const loaded = await pack.ruleLibrary.load(io)
      pack.ruleLibrary = { ...pack.ruleLibrary, rules: Array.isArray(loaded) ? loaded : [] }
    } catch (error) {
      problems.push(`ruleLibrary.load() failed: ${error?.message ?? String(error)}`)
    }
  }

  // Fixtures travel with the domain and are declared by name in the pack.
  if (pack.fixtures === undefined && io.exists(`${entry.dir}/fixtures`)) {
    const fixtures = (io.readDir(`${entry.dir}/fixtures`) ?? [])
      .filter((item) => !item.isDirectory && typeof item.name === 'string' && item.name.endsWith('.json'))
      .map((item) => item.name.slice(0, -'.json'.length))
      .sort()
    if (fixtures.length > 0) pack.fixtures = fixtures
  }

  // The directory name is the identity; a mismatch is a real conflict, not a
  // stylistic nit, because tool names derive from the id.
  if (pack.id !== entry.id) {
    problems.push(`declared id "${String(pack.id)}" must equal the directory name "${entry.id}"`)
  }

  const packProblems = validateDomainPackV2(pack)
  if (packProblems.length > 0) problems.push(...packProblems)

  return { pack: problems.length > 0 ? undefined : pack, problems, files }
}

/**
 * Discover and load every domain directory.
 *
 * Failure semantics (the three paths the acceptance calls for):
 *   • discovered + valid      -> included in `packs`
 *   • discovered + invalid    -> reported in `problems`, listed in `skipped`, NOT loaded
 *   • duplicate declared id   -> rejected loudly, second occurrence skipped
 * `strict: true` throws on the first invalid pack instead (built-in library
 * semantics); the default is lenient (third-party semantics), matching the
 * existing registry contract.
 *
 * Every `skipped` entry — scan-level and package-level alike — is exactly
 * `{ id, reason }` ({@link SKIPPED_ENTRY_KEYS}). Validate a whole list with
 * {@link validateSkippedEntries}.
 *
 * @param {object} [options] `{ root, strict, loadModule, claimed, rulesDir }`
 *   `claimed` is a `Map<id, source>` a caller may share across several roots;
 *   a second root declaring an id already claimed is rejected rather than
 *   silently shadowing the first.
 * @returns {Promise<{ root: string, packs: object[], problems: Array<{id:string,problems:string[]}>, skipped: Array<{id:string,reason:string}>, loaded: Array<{id:string,files:string[]}> }>}
 */
export async function loadDomains(io, options = {}) {
  const discovery = discoverDomains(io, options)
  const loadModule = typeof options.loadModule === 'function' ? options.loadModule : (url) => import(url)
  const packs = []
  const problems = [...discovery.problems]
  const skipped = [...discovery.skipped]
  const loaded = []
  const claimed = options.claimed instanceof Map ? options.claimed : new Map()

  for (const entry of discovery.found) {
    let result
    try {
      result = await loadDomain(io, entry, { ...options, loadModule })
    } catch (error) {
      problems.push({ id: entry.id, problems: [`failed to load: ${error?.message ?? String(error)}`] })
      skipped.push({ id: entry.id, reason: 'module load failed' })
      continue
    }

    if (result.problems.length > 0) {
      if (options.strict === true) {
        throw contractError(ERROR_CODES.E_CONTRACT, `invalid domain directory "${entry.id}": ${result.problems.join('; ')}`, result.problems)
      }
      problems.push({ id: entry.id, problems: result.problems })
      skipped.push({ id: entry.id, reason: `invalid v2 pack (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'})` })
      continue
    }

    const id = result.pack.id
    if (claimed.has(id)) {
      // `id` is the DECLARED id here, not the directory: the id is what is
      // duplicated, and a caller filtering `skipped` by id must see the same
      // value it would see in the registry. The paths live in the reason.
      problems.push({ id, problems: [`duplicate domain id: declared by both "${claimed.get(id)}" and "${entry.dir}"`] })
      skipped.push({ id, reason: `duplicate domain id rejected (already declared by "${claimed.get(id)}")` })
      continue
    }
    claimed.set(id, entry.dir)
    packs.push(result.pack)
    loaded.push({ id, files: result.files })
  }

  return { root: discovery.root, packs, problems, skipped, loaded }
}

/**
 * Register loaded directory packs into a registry, v2 packs replacing a
 * same-id v1 pack (that is the migration path a domain owner walks).
 *
 * @returns {{ disposers: Function[], replaced: string[], added: string[] }}
 */
export function registerLoadedDomains(registry, result, options = {}) {
  const disposers = []
  const replaced = []
  const added = []
  for (const pack of result?.packs ?? []) {
    const existed = typeof registry.has === 'function' && registry.has(pack.id)
    try {
      disposers.push(registry.register(pack))
      ;(existed ? replaced : added).push(pack.id)
    } catch (error) {
      options.onError?.({ id: pack.id, problems: [error?.message ?? String(error)] })
    }
  }
  return { disposers, replaced, added }
}

/** Render loader diagnostics for the model-facing `adjudication_domains` tool. */
export function describeDomainDirectory(result) {
  if (result === null || result === undefined) return '领域目录：尚未扫描。'
  const lines = [`领域目录 \`${result.root}/\`：装载 ${result.packs.length} 个，跳过 ${result.skipped.length} 个。`]
  for (const entry of result.loaded ?? []) lines.push(`- ✅ ${entry.id}（${entry.files.join(', ')}）`)
  for (const entry of result.skipped ?? []) lines.push(`- ⏭ ${entry.id} — ${entry.reason}`)
  for (const entry of result.problems ?? []) lines.push(`- ⚠️ ${entry.id} — ${entry.problems.join('; ')}`)
  return lines.join('\n')
}

/**
 * Convenience: parse (but do not load) a single rule document. Exported so a
 * domain's own `test.mjs` can validate its rules without re-implementing the
 * front-matter grammar.
 */
export function inspectRuleDocument(text, filename = '(rule)') {
  const { frontMatter, body } = parseRuleDocument(text)
  return { frontMatter, body, problems: validateRuleDocument(text, filename) }
}
