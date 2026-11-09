#!/usr/bin/env node
/**
 * scripts/sync-upstream.mjs — copy the *published* skill set of
 * https://github.com/mattpocock/skills into this package, byte for byte, and
 * regenerate `catalog.json`.
 *
 * The manifest of truth is the upstream Claude Code plugin manifest
 * (`.claude-plugin/plugin.json`): its `skills` array names exactly the skills
 * the official plugin ships. Whatever is not in that array is not copied.
 *
 * Nothing here rewrites skill prose. The whole point of this package is that
 * the model reads the same Markdown Matt Pocock ships — no renames, no
 * "helpful" deletions, no slash-command translation.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs [--from <path-to-upstream-clone>]
 *
 * Defaults to `../clone/skills` relative to this package.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')
const CATALOG = join(ROOT, 'catalog.json')
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

/**
 * Parse the YAML subset upstream uses: a flat block mapping of scalars, plus
 * nested block mappings (e.g. `metadata.credits`). Block scalars, flow
 * collections, anchors, aliases and tags are rejected loudly instead of being
 * guessed at — a silent mis-parse here would ship a wrong `description` to
 * the model.
 * @param raw - whole SKILL.md text.
 * @param file - path used in error messages.
 */
function parseFrontmatter(raw, file) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) {
    throw new Error(`${file}: frontmatter must open with a "---" line`)
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error(`${file}: frontmatter is never closed`)
  const block = text.slice(4, end)
  const data = {}
  const stack = [{ indent: -1, value: data }]
  const lines = block.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (line.includes('\t')) {
      throw new Error(`${file}:${index + 2}: tabs are not supported in frontmatter`)
    }
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (body.startsWith('- ')) {
      throw new Error(`${file}:${index + 2}: sequences are not supported in frontmatter`)
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ ](.*))?$/.exec(body)
    if (match === null) {
      throw new Error(`${file}:${index + 2}: unsupported frontmatter line ${JSON.stringify(line)}`)
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    if (stack.length === 1 && indent !== 0) {
      throw new Error(`${file}:${index + 2}: unexpected indentation (top-level keys start at column 0)`)
    }
    const parent = stack[stack.length - 1].value
    const key = match[1]
    const rawValue = (match[2] ?? '').trim()
    if (rawValue === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, value: child })
      continue
    }
    parent[key] = parseScalar(rawValue, file, index + 2, key)
  }
  return { data, body: text.slice(end + 4) }
}

/** Scalar decoding for the value half of a `key: value` line. */
function parseScalar(value, file, line, key) {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new Error(`${file}:${line}: unterminated double-quoted value for "${key}"`)
    }
    try {
      return JSON.parse(value)
    } catch (error) {
      throw new Error(`${file}:${line}: invalid double-quoted value for "${key}": ${String(error)}`)
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`${file}:${line}: unterminated single-quoted value for "${key}"`)
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[>|]/.test(value)) {
    throw new Error(`${file}:${line}: block scalars are not supported for "${key}"`)
  }
  if (/^[[{&*!]/.test(value)) {
    throw new Error(`${file}:${line}: flow collections, anchors and tags are not supported for "${key}"`)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * Rewrite CRLF to LF in place.
 *
 * A Windows checkout can hand us CRLF for files git stores as LF. Shipping that
 * would make the bytes — and the body hash — depend on the checkout, so the
 * package normalizes once at sync time; `verify.mjs` normalizes the same way.
 * @returns whether the file was rewritten.
 */
async function normalizeLineEndings(path) {
  const text = await readFile(path, 'utf8')
  if (!text.includes('\r\n')) return false
  await writeFile(path, text.replace(/\r\n/g, '\n'))
  return true
}

/** Every file under `dir`, as forward-slash relative paths, sorted. */
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

/** Read git HEAD / exact tag without spawning a subprocess. */
async function readGitInfo(repo) {
  const gitDir = join(repo, '.git')
  const info = { commit: null, tag: null, dirty: null }
  if (!existsSync(gitDir)) return info
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim()
      const loose = join(gitDir, ref)
      if (existsSync(loose)) info.commit = (await readFile(loose, 'utf8')).trim()
      else if (existsSync(join(gitDir, 'packed-refs'))) {
        for (const line of (await readFile(join(gitDir, 'packed-refs'), 'utf8')).split('\n')) {
          const [sha, name] = line.trim().split(' ')
          if (sha !== undefined && name === ref) info.commit = sha
        }
      }
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      info.commit = head
    }
    const tagsDir = join(gitDir, 'refs', 'tags')
    if (info.commit !== null && existsSync(tagsDir)) {
      for (const tag of await readdir(tagsDir)) {
        if ((await readFile(join(tagsDir, tag), 'utf8')).trim() === info.commit) info.tag = tag
      }
    }
  } catch {
    // A worktree without readable refs still syncs; provenance stays partial.
  }
  return info
}

function parseArgs(argv) {
  const args = { from: resolve(ROOT, '..', 'clone', 'skills') }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--from') args.from = resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/sync-upstream.mjs [--from <upstream-clone>]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
const upstream = args.from
const upstreamManifestPath = join(upstream, '.claude-plugin', 'plugin.json')
if (!existsSync(upstreamManifestPath)) {
  throw new Error(
    `no upstream checkout at ${upstream} (missing .claude-plugin/plugin.json). ` +
      'Clone https://github.com/mattpocock/skills and pass --from <path>.'
  )
}

const upstreamManifest = JSON.parse(await readFile(upstreamManifestPath, 'utf8'))
const entries = upstreamManifest.skills
if (!Array.isArray(entries) || entries.length === 0) {
  throw new Error(`${upstreamManifestPath}: "skills" must be a non-empty array`)
}

await mkdir(SKILLS_DIR, { recursive: true })

const skills = []
const seen = new Set()
const normalized = []
for (const entry of entries) {
  const sourceDir = resolve(upstream, entry)
  const name = basename(sourceDir)
  const sourceFile = join(sourceDir, 'SKILL.md')
  if (!existsSync(sourceFile)) throw new Error(`${sourceFile}: missing SKILL.md`)
  if (!NAME_PATTERN.test(name)) throw new Error(`${sourceFile}: invalid skill name "${name}"`)
  if (seen.has(name)) throw new Error(`duplicate skill name "${name}"`)
  seen.add(name)

  const raw = await readFile(sourceFile, 'utf8')
  const { data, body } = parseFrontmatter(raw, sourceFile)
  if (data.name !== name) {
    throw new Error(`${sourceFile}: frontmatter name "${data.name}" does not match directory "${name}"`)
  }
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    throw new Error(`${sourceFile}: frontmatter requires a non-empty description`)
  }
  if (data['disable-model-invocation'] !== undefined && typeof data['disable-model-invocation'] !== 'boolean') {
    throw new Error(`${sourceFile}: disable-model-invocation must be a boolean`)
  }
  if (data['user-invocable'] !== undefined && typeof data['user-invocable'] !== 'boolean') {
    throw new Error(`${sourceFile}: user-invocable must be a boolean`)
  }

  const targetDir = join(SKILLS_DIR, name)
  await rm(targetDir, { recursive: true, force: true })
  await cp(sourceDir, targetDir, { recursive: true })

  const files = {}
  for (const rel of await listFiles(targetDir)) {
    if (await normalizeLineEndings(join(targetDir, rel))) normalized.push(`${name}/${rel}`)
    files[rel] = sha256(await readFile(join(targetDir, rel)))
  }
  if (files['SKILL.md'] !== sha256(raw.replace(/\r\n/g, '\n'))) {
    throw new Error(`${targetDir}: copied SKILL.md does not match the upstream bytes`)
  }

  skills.push({
    name,
    description: data.description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse !== '' ? { whenToUse: data.whenToUse } : {}),
    invocation: {
      modelInvocable: data['disable-model-invocation'] !== true,
      userInvocable: data['user-invocable'] !== false
    },
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    frontmatter: data,
    contentSha: sha256(body.trim()),
    files
  })
}

// Drop skill directories that upstream no longer publishes.
const published = new Set(skills.map((skill) => skill.name))
for (const entry of await readdir(SKILLS_DIR, { withFileTypes: true })) {
  if (entry.isDirectory() && !published.has(entry.name)) {
    await rm(join(SKILLS_DIR, entry.name), { recursive: true, force: true })
    console.log(`removed stale skill directory: ${entry.name}`)
  }
}

const git = await readGitInfo(upstream)
const catalog = {
  upstream: {
    repo: 'https://github.com/mattpocock/skills',
    version: upstreamManifest.version ?? null,
    commit: git.commit,
    tag: git.tag
  },
  skills
}
await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`)

const modelOnly = skills.filter((skill) => !skill.invocation.modelInvocable).length
console.log(`synced ${skills.length} skills from ${upstream}`)
console.log(`  upstream version ${catalog.upstream.version ?? '?'} @ ${git.commit ?? '?'}${git.tag ? ` (tag ${git.tag})` : ''}`)
console.log(`  model-invocable ${skills.length - modelOnly}, user-only ${modelOnly}`)
if (normalized.length > 0) console.log(`  normalized CRLF -> LF in ${normalized.length} file(s)`)
console.log(`  wrote ${relative(ROOT, CATALOG).split('\\').join('/')}`)
