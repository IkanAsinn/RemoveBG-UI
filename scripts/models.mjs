#!/usr/bin/env node
// Build-time model handling.
//   node scripts/models.mjs fetch   download each manifest model into public/models and verify it
//   node scripts/models.mjs check   licence guard + presence + sha256 (runs before dev and build)
// The check fails the build if any model is not MIT/Apache-2.0 or its bytes do not match the manifest.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'src/model/manifest.json'), 'utf8'))
const ALLOWED = ['MIT', 'Apache-2.0'] // keep in sync with ALLOWED_MODEL_LICENSES in src/model/manifest.ts
const outDir = join(root, 'public')

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })

function guardLicences() {
  for (const [tier, m] of Object.entries(manifest)) {
    if (!ALLOWED.includes(m.license)) {
      throw new Error(`[models] ${tier} model "${m.id}" is licensed "${m.license}"; only ${ALLOWED.join(' / ')} may ship`)
    }
  }
}

async function verify(tier, m) {
  const file = join(outDir, m.path)
  if (!existsSync(file)) return `${tier}: missing ${m.path} (run \`npm run models:fetch\`)`
  if (statSync(file).size !== m.bytes) return `${tier}: ${m.path} is ${statSync(file).size} bytes, expected ${m.bytes}`
  const digest = await sha256(file)
  if (digest !== m.sha256) return `${tier}: ${m.path} sha256 ${digest} does not match manifest`
  return null
}

async function fetchAll() {
  for (const [tier, m] of Object.entries(manifest)) {
    if ((await verify(tier, m)) === null) {
      console.log(`[models] ${tier}: ${m.file} already present and verified`)
      continue
    }
    const file = join(outDir, m.path)
    mkdirSync(dirname(file), { recursive: true })
    console.log(`[models] ${tier}: downloading ${m.source}`)
    const res = await fetch(m.source)
    if (!res.ok) throw new Error(`[models] ${tier}: HTTP ${res.status} from ${m.source}`)
    await writeFile(file + '.part', Buffer.from(await res.arrayBuffer()))
    renameSync(file + '.part', file)
    const problem = await verify(tier, m)
    if (problem) throw new Error(`[models] ${problem}`)
    console.log(`[models] ${tier}: ${m.file} verified`)
  }
}

async function checkAll() {
  const problems = (await Promise.all(Object.entries(manifest).map(([t, m]) => verify(t, m)))).filter(Boolean)
  if (problems.length) throw new Error(`[models] ${problems.join('\n[models] ')}`)
  console.log(`[models] licences OK (${Object.values(manifest).map((m) => `${m.id}: ${m.license}`).join(', ')}); files verified`)
}

const cmd = process.argv[2]
try {
  guardLicences()
  if (cmd === 'fetch') await fetchAll()
  else if (cmd === 'check') await checkAll()
  else throw new Error('usage: node scripts/models.mjs <fetch|check>')
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
