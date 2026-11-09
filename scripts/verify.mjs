#!/usr/bin/env node
/**
 * scripts/verify.mjs — prove this package still ships upstream, unchanged.
 *
 * Three independent checks:
 *
 *   1. Bytes. Every file recorded in `catalog.json` exists on disk with the
 *      recorded SHA-256, and `skills/` contains no file the catalog does not
 *      know about. This is what catches "someone hand-edited a SKILL.md".
 *   2. Bodies. Each `SKILL.md` body, sliced with a delimiter algorithm written
 *      separately from the provider's, hashes to the recorded `contentSha` and
 *      is non-empty. This is what catches a wrong frontmatter parse.
 *   3. Protocol. The provider is mounted on a fake `ctx.skills`, exactly as the
 *      registry would, and every candidate/definition is checked against the
 *      registry's own contract (provider name match, finite rank, string
 *      source, kebab-case name, directory resource base).
 *
 * Usage:
 *   node scripts/verify.mjs                      # self-contained checks
 *   node scripts/verify.mjs --upstream <clone>   # also diff against a checkout
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_ROOT = join(ROOT, 'skills')
const CATALOG_PATH = join(ROOT, 'catalog.json')
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const failures = []
const notes = []
const fail = (message) => failures.push(message)
const note = (message) => notes.push(message)

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const rel = (path) => relative(ROOT, path).split('\\').join('/')

/** Hash a shipped file the way `sync-upstream.mjs` recorded it: text, LF only. */
async function fileSha(path) {
  return sha256((await readFile(path, 'utf8')).replace(/\r\n/g, '\n'))
}

function parseArgs(argv) {
  const args = { upstream: null }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--upstream') args.upstream = resolve(argv[++index] ?? '')
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('usage: node scripts/verify.mjs [--upstream <upstream-clone>]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  return args
}

/** Body extraction written independently of `lib/index.js` (split on the
 * closing delimiter), so a shared bug cannot hide. */
function bodyText(raw) {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return undefined
  return normalized.slice(end + 4).trim()
}

async function listFiles(dir) {
  const found = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.push(relative(dir, full).split('\\').join('/'))
    }
  }
  await walk(dir)
  return found.sort()
}

const args = parseArgs(process.argv.slice(2))
const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))

if (!Array.isArray(catalog.skills) || catalog.skills.length === 0) {
  console.error('FAIL: catalog.json has no skills')
  process.exit(1)
}

// --- 1. bytes --------------------------------------------------------------

const catalogued = new Set()
for (const skill of catalog.skills) {
  catalogued.add(skill.name)
  const dir = join(SKILLS_ROOT, skill.name)
  if (!existsSync(dir)) {
    fail(`${skill.name}: directory missing at ${rel(dir)}`)
    continue
  }
  for (const [file, expected] of Object.entries(skill.files)) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      fail(`${skill.name}: missing ${file}`)
      continue
    }
    const actual = await fileSha(path)
    if (actual !== expected) fail(`${skill.name}: ${file} differs from the synced bytes`)
  }
  for (const file of await listFiles(dir)) {
    if (skill.files[file] === undefined) fail(`${skill.name}: unexpected file ${file}`)
  }
}

for (const entry of await readdir(SKILLS_ROOT, { withFileTypes: true })) {
  if (entry.isDirectory() && !catalogued.has(entry.name)) {
    fail(`skills/${entry.name}: directory not present in catalog.json`)
  }
}

// --- 2. bodies + frontmatter contract -------------------------------------

for (const skill of catalog.skills) {
  const path = join(SKILLS_ROOT, skill.name, 'SKILL.md')
  if (!existsSync(path)) continue
  const raw = await readFile(path, 'utf8')
  const body = bodyText(raw)
  if (body === undefined) {
    fail(`${skill.name}: SKILL.md has no readable frontmatter block`)
    continue
  }
  if (body === '') fail(`${skill.name}: SKILL.md body is empty`)
  if (sha256(body) !== skill.contentSha) fail(`${skill.name}: body differs from contentSha`)
  if (!NAME_PATTERN.test(skill.name)) fail(`${skill.name}: not a kebab-case skill name`)
  if (typeof skill.description !== 'string' || skill.description.trim() === '') {
    fail(`${skill.name}: empty description`)
  }
  if (
    typeof skill.invocation?.modelInvocable !== 'boolean' ||
    typeof skill.invocation?.userInvocable !== 'boolean'
  ) {
    fail(`${skill.name}: invocation policy must carry two booleans`)
  }

  // Every shipped support file should be named by the body. Two upstream
  // artifacts are not (`pr/CREDITS.md`, `teach/GLOSSARY-FORMAT.md`), so this is
  // reported rather than enforced — deleting them would break byte fidelity.
  const support = Object.keys(skill.files).filter(
    (file) => file !== 'SKILL.md' && !file.startsWith('agents/')
  )
  for (const file of support) {
    const basename = file.split('/').pop()
    if (!body.includes(basename)) note(`${skill.name}: ships ${file}, which SKILL.md never names`)
  }
}

// --- upstream comparison (optional) ---------------------------------------

if (args.upstream !== null) {
  const manifestPath = join(args.upstream, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`--upstream: ${rel(manifestPath)} is not an upstream checkout`)
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const expected = manifest.skills.map((entry) => resolve(args.upstream, entry))
    if (expected.length !== catalog.skills.length) {
      fail(`upstream publishes ${expected.length} skills, catalog has ${catalog.skills.length}`)
    }
    for (const sourceDir of expected) {
      const name = sourceDir.split(/[\\/]/).pop()
      if (!catalogued.has(name)) {
        fail(`upstream publishes ${name}, which this package does not ship`)
        continue
      }
      const mine = join(SKILLS_ROOT, name)
      const theirs = await listFiles(sourceDir)
      const ours = await listFiles(mine)
      for (const file of theirs) {
        if (!ours.includes(file)) {
          fail(`${name}: upstream ships ${file}, this package does not`)
          continue
        }
        if ((await fileSha(join(sourceDir, file))) !== (await fileSha(join(mine, file)))) {
          fail(`${name}: ${file} is not byte-identical to upstream (after LF normalization)`)
        }
      }
      for (const file of ours) {
        if (!theirs.includes(file)) fail(`${name}: ${file} is not in upstream`)
      }
    }
  }
}

// --- 3. provider protocol --------------------------------------------------

const module = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = module
if (typeof apply !== 'function') {
  console.error('FAIL: lib/index.js must export apply(ctx)')
  process.exit(1)
}

const CONTROL = { signal: new AbortController().signal, invalidate: () => {} }
let provider
const ctx = {
  skills: {
    registerProvider(factory) {
      provider = factory(CONTROL)
      return () => {}
    }
  },
  logger: { warn: (message) => note(message) }
}

apply(ctx)

if (provider === undefined) {
  console.error('FAIL: apply() did not register a provider')
  process.exit(1)
}
if (typeof provider.name !== 'string' || provider.name === '') fail('provider.name must be a string')
if (provider.name === 'runtime') fail('provider.name "runtime" is reserved')

const candidates = await provider.list({})
if (!Array.isArray(candidates)) fail('list() must return an array (or an observation)')
if (candidates.length !== catalog.skills.length) {
  fail(`list() returned ${candidates.length} candidates, catalog has ${catalog.skills.length}`)
}

let modelInvocable = 0
for (const candidate of candidates) {
  const label = `candidate ${candidate.name}`
  if (!NAME_PATTERN.test(candidate.name)) fail(`${label}: invalid kebab-case name`)
  if (typeof candidate.description !== 'string' || candidate.description === '') {
    fail(`${label}: missing description`)
  }
  if (typeof candidate.source !== 'string') fail(`${label}: source must be a string`)
  if (candidate.provider !== provider.name) fail(`${label}: provider must equal "${provider.name}"`)
  if (!Number.isFinite(candidate.rank)) fail(`${label}: rank must be a finite number`)
  if (typeof candidate.path !== 'string') fail(`${label}: path must be a string`)
  if (candidate.invocation?.modelInvocable === true) modelInvocable++

  const definition = await provider.get(candidate, {})
  if (definition === undefined) {
    fail(`${label}: get() returned undefined`)
    continue
  }
  if (definition.name !== candidate.name) fail(`${label}: get() returned another name`)
  if (typeof definition.content !== 'string' || definition.content === '') {
    fail(`${label}: get() returned no content`)
  } else if (sha256(definition.content) !== catalog.skills.find((s) => s.name === candidate.name)?.contentSha) {
    fail(`${label}: get() content differs from the synced body`)
  }
  if (definition.resourceBase?.kind !== 'directory') fail(`${label}: resourceBase must be a directory`)
  if (definition.resourceBase?.path !== join(SKILLS_ROOT, candidate.name)) {
    fail(`${label}: resourceBase must point at the skill directory`)
  }
  if (definition.provider !== provider.name) fail(`${label}: definition provider mismatch`)
}

// Abort must not throw, it must settle.
const aborted = new AbortController()
aborted.abort()
const cancelled = await provider.list({ signal: aborted.signal })
if (!Array.isArray(cancelled) || cancelled.length !== 0) {
  fail('list() must return nothing once its signal is aborted')
}

// Zero runtime dependencies: only node: builtins may be imported.
const libSource = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
for (const match of libSource.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
  if (!match[1].startsWith('node:')) fail(`lib/index.js imports "${match[1]}", but must stay dependency-free`)
}

// --- report ----------------------------------------------------------------

const upstream = catalog.upstream
console.log('dsh-mattpocock-skills — verification')
console.log(`  upstream   ${upstream.repo} @ ${upstream.version ?? '?'}`)
console.log(`  commit     ${upstream.commit ?? 'unknown'}${upstream.tag ? ` (tag ${upstream.tag})` : ''}`)
console.log(`  skills     ${catalog.skills.length} (${modelInvocable} model-invocable, ${candidates.length - modelInvocable} user-only)`)
console.log('')
for (const skill of catalog.skills) {
  const policy = skill.invocation.modelInvocable ? 'model+user' : 'user-only'
  const refs = Object.keys(skill.files).length - 1
  console.log(`  ${skill.name.padEnd(30)} ${policy.padEnd(11)} ${refs} reference file(s)`)
}
for (const message of notes) console.log(`\n[note] ${message}`)

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem(s):`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('\nOK — bytes, bodies and provider protocol all match the sync record')
