/**
 * Accio credential access.
 *
 * Accio stores `credentials.enc` as a Chromium OSCrypt blob — `v10` followed by
 * a 12-byte nonce, AES-256-GCM ciphertext and a 16-byte tag — under a key that
 * Chromium wraps with DPAPI and parks in `Local State` at
 * `os_crypt.encrypted_key`. This is the same envelope Qoder uses, so the
 * primitives are shared; the only Accio-specific parts are the paths.
 *
 * The DPAPI unwrap is inherently Windows-only: it is scoped to the logged-in
 * Windows user, which is exactly why it cannot be done offline from a copied
 * file. It runs in a PowerShell child that P/Invokes `CryptUnprotectData`, and
 * the resulting key is handed back through a temp file that is removed in
 * `finally` — the plaintext key must never outlive the call on disk.
 */
import { execFile } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Unwrap `os_crypt.encrypted_key` with DPAPI.
 *
 * The key file is created by the child, written once, and read immediately by
 * the caller; `FileShare.None` on the write keeps another local process from
 * reading a partially written key.
 */
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AccioDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$statePath = Join-Path $env:ACCIO_APP_DIR 'Local State'
$json = Get-Content $statePath -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ($raw.Length -le 5) { throw 'encrypted_key too short' }
$prefix = [System.Text.Encoding]::ASCII.GetString($raw[0..4])
if ($prefix -ne 'DPAPI') { throw "unexpected key prefix: $prefix" }
$key = [AccioDpapi]::U($raw[5..($raw.Length - 1)])
[System.IO.File]::WriteAllText($env:ACCIO_KEY_OUT, [Convert]::ToBase64String($key))
`

/**
 * Decrypt one Chromium OSCrypt blob.
 *
 * @param blob - raw stored bytes, including the `v10` prefix.
 * @param key - the 32-byte AES key.
 * @returns the plaintext, or undefined when the prefix or GCM tag is wrong.
 *   Authentication failure returns undefined rather than throwing: a wrong key
 *   and a corrupt file are indistinguishable here, and both mean "cannot read".
 */
export function decryptOscrypt(blob, key) {
  if (blob.length < 3 + 12 + 16) return undefined
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') return undefined
  const body = blob.subarray(3)
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ciphertext = body.subarray(12, body.length - 16)
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Unwrap the app's OSCrypt key via DPAPI.
 *
 * @param userDataDir - Accio's Electron user-data directory.
 * @returns the 32-byte AES key.
 * @throws when `Local State` is missing, or DPAPI refuses (a different Windows
 *   user, or a profile that has not logged in to Accio).
 */
export async function oscryptKeyFor(userDataDir) {
  const statePath = join(userDataDir, 'Local State')
  statSync(statePath)
  const dir = mkdtempSync(join(tmpdir(), 'accio-oscrypt-'))
  try {
    const keyOut = join(dir, 'key.b64')
    const scriptPath = join(dir, 'unwrap.ps1')
    writeFileSync(scriptPath, DPAPI_SCRIPT, 'utf8')
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], {
      env: { ...process.env, ACCIO_APP_DIR: userDataDir, ACCIO_KEY_OUT: keyOut },
      timeout: 30_000,
      windowsHide: true,
    })
    return Buffer.from(readFileSync(keyOut, 'utf8').trim(), 'base64')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Load and decrypt `credentials.enc`.
 *
 * @returns `{ accessToken, refreshToken, expiresAt, sgcookie, user, revision }`.
 */
export async function loadCredentials(userDataDir) {
  const key = await oscryptKeyFor(userDataDir)
  const plaintext = decryptOscrypt(readFileSync(join(userDataDir, 'credentials.enc')), key)
  if (plaintext === undefined) {
    throw new Error('accio: credentials.enc failed to decrypt (wrong Windows user, or the file was rewritten mid-read)')
  }
  return JSON.parse(plaintext)
}

/** The account id Accio bills, used as the gateway `empid` for diagnostics. */
export function accountIdOf(credentials) {
  const id = credentials?.user?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}
