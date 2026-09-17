// Repoint the DSH dev dependencies at another published version or dist-tag
// (used by the canary CI job): node scripts/use-dsh-version.mjs next
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const spec = process.argv[2]
if (!spec) { console.error('usage: node scripts/use-dsh-version.mjs <version|dist-tag>'); process.exit(2) }
const shell = process.platform === 'win32'
const resolved = spawnSync(shell ? 'npm.cmd' : 'npm', ['view', `@deepseek-ai/dsh-tools@${spec}`, 'version', '--json'], { encoding: 'utf8', shell })
if (resolved.status !== 0) { console.error(`cannot resolve @deepseek-ai/dsh-tools@${spec}: ${resolved.stderr}`); process.exit(1) }
const parsed = JSON.parse(resolved.stdout)
const version = Array.isArray(parsed) ? parsed.at(-1) : parsed
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of Object.keys(manifest.devDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`DSH dev dependencies set to ${version}. Next: npm install --no-package-lock && DITTO_DSH_VERSION=${version} npm test`)
