/**
 * Install-contract tests for the published package.
 *
 * A DSH bundle only installs when the manifest declares a bundle patch, the
 * patch inserts the plugin row, and the client half is exported under
 * `./client`. These assertions guard what `npm pack` ships, so a release
 * cannot silently lose its install path.
 *
 * Run with: node tests/manifest.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let failures = 0

/**
 * Run one named check.
 * @param {string} label - test name.
 * @param {() => void} body - assertions.
 * @returns {void}
 */
function test(label, body) {
  try {
    body()
    console.log(`ok   package: ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL package: ${label}\n${error?.stack ?? error}`)
  }
}

/**
 * Read a repository-relative file.
 * @param {string} relative - path below the package root.
 * @returns {string} file contents.
 */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

/**
 * Tell whether the npm `files` list ships a path, matching directories.
 * @param {string} relative - a shipped file path.
 * @returns {boolean} whether `npm pack` includes it.
 */
function ships(relative) {
  // npm always packs package.json, whether or not it is listed in `files`.
  if (relative === 'package.json') return true
  const target = normalize(relative).split(sep).join('/')
  return manifest.files.some((entry) => {
    const prefix = normalize(entry).split(sep).join('/').replace(/\/+$/u, '')
    return target === prefix || target.startsWith(`${prefix}/`)
  })
}

test('is a public, versioned package that does not set private', () => {
  assert.equal(manifest.private, undefined)
  assert.match(manifest.name, /^dsh-[a-z0-9-]+$/u)
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.publishConfig?.access, 'public')
  assert.match(manifest.repository?.url ?? '', /github\.com\/HUSTforever\/dsh-thinking-summary/u)
})

test('declares the DSH bundle and client halves', () => {
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-chat'])
  assert.match(manifest.engines?.dsh ?? '', /^>=/u)
  assert.match(manifest.engines?.node ?? '', /22\.19/u)
  assert.ok(manifest.keywords.includes('dsh-plugin'))
})

test('exports the host half, client half and manifest', () => {
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports?.['.'], './lib/index.js')
  assert.equal(manifest.exports?.['./client'], './lib/client.js')
  assert.equal(manifest.exports?.['./package.json'], './package.json')
  assert.ok(existsSync(join(root, manifest.exports['.'])))
  assert.ok(existsSync(join(root, manifest.exports['./client'])))
})

test('ships every runtime file through npm files', () => {
  for (const required of [
    'lib/index.js',
    'lib/client.js',
    'cordis.patch.yml',
    'README.md',
    'README.zh.md',
    'CHANGELOG.md',
    'LICENSE',
    'package.json',
  ]) {
    assert.ok(existsSync(join(root, required)), `${required} missing from the checkout`)
    assert.ok(ships(required), `${required} is not in npm files`)
  }
})

test('bundle patch inserts the plugin row with safe defaults', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^- insert:$/mu)
  assert.match(patch, /^\s+- id: thinking-summary$/mu)
  assert.match(patch, /^\s+name: dsh-thinking-summary$/mu)
  for (const key of [
    'provider', 'model', 'language', 'thinking', 'maxChars',
    'maxOutputTokens', 'minReasoningChars', 'maxInputChars', 'timeoutMs', 'cacheSize',
  ]) {
    assert.match(patch, new RegExp(`^ {8}${key}:`, 'mu'), `${key} missing from the bundle patch`)
  }
  assert.match(patch, /^ {8}language: auto$/mu)
  assert.match(patch, /^ {8}thinking: 'off'$/mu)
})

test('client bundle registers itself through the module loader', () => {
  const client = read('lib/client.js')
  assert.match(client, /window\.__ModuleLoader__\.load\(/u)
  assert.match(client, /id: 'dsh-thinking-summary'/u)
  assert.match(client, /require\('react'\)/u)
  assert.doesNotMatch(client, /require\(['"](?!react['"])[^'"]+['"]\)/u)
  assert.match(client, /plugins\.bundle\.config/u)
})

test('host half imports only Node built-ins', () => {
  const host = read('lib/index.js')
  const specifiers = [...host.matchAll(/^import[^\n]*from\s+'([^']+)'/gmu)].map((match) => match[1])
  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) assert.match(specifier, /^node:/u, `${specifier} is not a Node built-in`)
})

console.log(failures === 0 ? '\nall package manifest tests passed' : `\n${failures} package manifest test(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
