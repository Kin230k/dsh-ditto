// Real-launcher smoke, in an isolated DSH_HOME (your ~/.dsh is never touched):
//   1. `dsh plugin --profile ditto-smoke add <packed tarball>` — the documented install command
//   2. the profile manifest lists dsh-ditto as a bundle
//   3. `dsh --profile ditto-smoke --dump-config` composes the dsh-ditto/dsh entry
//   4. `dsh --profile ditto-smoke` boots: a plugin that fails to import or throws in its
//      constructor makes the launcher exit non-zero with "plugin tree failed to load";
//      a healthy tree keeps running, so we wait, then stop it
//   5. `dsh plugin --profile ditto-smoke exec dsh-ditto doctor` passes inside the profile
// Needs `dsh` and `pnpm` on PATH.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const BOOT_GRACE_MS = Number(process.env.DITTO_BOOT_GRACE_MS ?? 25_000)

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell, ...options })
  return { ...result, ok: result.status === 0 }
}
function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`)
  return result
}

/** Boot the profile; resolve 'booted' if it is still running after the grace period, or reject with the launcher's error. */
function bootProfile(profile, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('dsh', ['--profile', profile], { env, shell, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => { stop(child); resolvePromise({ booted: true, output }) }, BOOT_GRACE_MS)
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolvePromise({ booted: true, output }); else reject(new Error(`dsh --profile ${profile} exited ${code}:\n${output.slice(0, 3000)}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
function stop(child) {
  if (shell && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const dsh = capture('dsh', ['--version'])
if (!dsh.ok) { console.error('dsh is not on PATH; install it first: npm install -g @deepseek-ai/dsh@0.1.5-rc.1'); process.exit(process.env.CI ? 1 : 0) }
const pnpm = capture('pnpm', ['--version'])
if (!pnpm.ok) { console.error('pnpm is not on PATH; dsh plugin needs it (npm install -g pnpm)'); process.exit(process.env.CI ? 1 : 0) }
console.log(`dsh ${dsh.stdout.trim()} · pnpm ${pnpm.stdout.trim()}`)

const packed = JSON.parse(must(capture(npm, ['pack', '--json', '--pack-destination', tmpdir()]), 'npm pack').stdout)
const tarball = join(tmpdir(), packed[0].filename)
const home = mkdtempSync(join(tmpdir(), 'dsh-ditto-profile-home-'))
const profile = 'ditto-smoke'
const env = { ...process.env, DSH_HOME: home }
try {
  console.log(`Isolated DSH_HOME: ${home}`)
  must(capture('dsh', ['plugin', '--profile', profile, 'add', tarball], { env }), 'dsh plugin add')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if (!manifest.dependencies?.['dsh-ditto']) throw new Error('profile manifest does not list dsh-ditto as a dependency')
  if (!manifest.dsh?.profile?.bundles?.includes('dsh-ditto')) throw new Error(`profile bundles do not include dsh-ditto: ${JSON.stringify(manifest.dsh?.profile?.bundles)}`)
  console.log(`1. dsh plugin add          profile "${profile}" bundles = ${JSON.stringify(manifest.dsh.profile.bundles)}`)
  const dump = must(capture('dsh', ['--profile', profile, '--dump-config'], { env }), 'dsh --dump-config')
  if (!/dsh-ditto\/dsh/.test(dump.stdout)) throw new Error(`composed config does not contain the Ditto entry:\n${dump.stdout.slice(0, 2000)}`)
  console.log('2. dsh --dump-config       composed plugin tree contains the dsh-ditto/dsh entry')

  // Negative control: a broken entry must fail the boot loudly, otherwise a silent boot proves nothing.
  const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')
  writeFileSync(patchFile, "- insert:\n    - id: ditto-smoke-broken\n      name: 'dsh-ditto/does-not-exist'\n")
  let brokenFailedLoudly = false
  try { await bootProfile(profile, env) } catch (error) { brokenFailedLoudly = /plugin tree failed to load/.test(String(error.message)) }
  if (!brokenFailedLoudly) throw new Error('negative control failed: a broken plugin entry did not fail the boot')
  writeFileSync(patchFile, '[]\n')
  console.log('3. negative control        a broken plugin entry fails the boot with "plugin tree failed to load"')

  const boot = await bootProfile(profile, env)
  if (!boot.booted) throw new Error('profile did not boot')
  console.log(`4. dsh --profile           booted with dsh-ditto in the tree and stayed up for ${BOOT_GRACE_MS / 1000}s (no plugin load error)`)

  const doctor = capture('dsh', ['plugin', '--profile', profile, 'exec', 'dsh-ditto', 'doctor'], { env })
  const summary = doctor.stdout.split('\n').filter(line => /^[✓!✗]/.test(line)).join('\n    ')
  console.log(`5. doctor inside profile\n    ${summary}`)
  if (!doctor.ok || !/14 of 14 tools registered/.test(doctor.stdout) || !new RegExp(`installed in profile "${profile}"`).test(doctor.stdout)) throw new Error(`doctor inside the profile did not pass:\n${doctor.stdout}\n${doctor.stderr}`)
  console.log('Profile smoke passed.')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
