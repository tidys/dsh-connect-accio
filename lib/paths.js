/**
 * Where Accio keeps its state on disk.
 *
 * Two roots matter and they are NOT the same directory:
 *   - the Electron user-data root (`%APPDATA%\Accio`) holds `Local State` and
 *     `credentials.enc` — the encrypted, per-Windows-user credential store.
 *   - the app config root (`%USERPROFILE%\.accio`) holds `utdid`, the device
 *     identifier every gateway request must present.
 *
 * Electron ignores the install location for user data: installing to D:\ still
 * writes credentials under %APPDATA%. Each root is probed across the spellings
 * seen in the wild, and a miss is harmless because callers try every candidate.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `%APPDATA%` (Roaming), falling back to the conventional path under $HOME. */
function roamingRoot(env = process.env, home = homedir()) {
  const fromEnv = typeof env.APPDATA === 'string' && env.APPDATA !== '' ? env.APPDATA : undefined
  return fromEnv ?? join(home, 'AppData', 'Roaming')
}

/**
 * Candidate Electron user-data directories, in probe order.
 *
 * Windows filenames are case-insensitive, so the variants `Accio` / `accio`
 * resolve to the same directory and the dedupe below drops the duplicate rather
 * than probing twice.
 */
export function userDataCandidates(env = process.env, home = homedir()) {
  const roots = [roamingRoot(env, home), join(home, 'AppData', 'Roaming')]
  const names = ['Accio', 'accio']
  const seen = new Set()
  const out = []
  for (const root of roots) {
    for (const name of names) {
      const dir = join(root, name)
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir
      if (seen.has(key)) continue
      seen.add(key)
      out.push(dir)
    }
  }
  return out
}

/** Candidate app config roots (`~/.accio`). */
export function configRootCandidates(env = process.env, home = homedir()) {
  const roots = []
  if (typeof env.ACCIO_APP_CONFIG_DIR === 'string' && env.ACCIO_APP_CONFIG_DIR !== '') {
    roots.push(env.ACCIO_APP_CONFIG_DIR)
  }
  roots.push(join(home, '.accio'))
  const seen = new Set()
  return roots.filter((dir) => {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The first candidate that actually contains `Local State` — the file the DPAPI
 * unwrap needs, and therefore the only honest test of "Accio is installed here".
 */
export function resolveUserDataDir(explicit, env = process.env, home = homedir()) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const candidates = userDataCandidates(env, home)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'Local State'))) return dir
  }
  return candidates[0]
}

/** The app config root, preferring one that already has a `utdid` file. */
export function resolveConfigRoot(explicit, env = process.env, home = homedir()) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const candidates = configRootCandidates(env, home)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'utdid'))) return dir
  }
  return candidates[0]
}

/** Every path this plugin reads, for diagnostics without touching secrets. */
export function describePaths(userDataDir, configRoot) {
  return {
    userDataDir,
    configRoot,
    localState: join(userDataDir, 'Local State'),
    credentials: join(userDataDir, 'credentials.enc'),
    utdid: join(configRoot, 'utdid'),
  }
}
