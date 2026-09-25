import { randomBytes, randomUUID } from 'crypto'
import { constants, promises as fs } from 'fs'
import type { BigIntStats } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'

export const PRIVATE_STORE_MARKER = '.loop-private-store.json'
export const MAX_STORE_MARKER_BYTES = 256
export const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOFOLLOW = constants.O_NOFOLLOW || 0

export class PrivateStorageError extends Error {
  readonly status = 503
  constructor() { super('Private file storage is temporarily unavailable') }
}

/** Format-only validation: safe for startup, and deliberately independent of DB/I/O. */
export function privateStorageConfigIssues(env: NodeJS.ProcessEnv) {
  const issues: { key: string; message: string }[] = []
  const strict = env.NODE_ENV === 'production' || env.PRIVATE_FILES_STORAGE_MODE !== undefined
  if (strict) {
    if (env.PRIVATE_FILES_STORAGE_MODE !== 'shared-filesystem') issues.push({ key: 'PRIVATE_FILES_STORAGE_MODE', message: 'Explicit shared-filesystem mode is required' })
    if (!env.PRIVATE_FILES_DIR || !path.isAbsolute(env.PRIVATE_FILES_DIR) || env.PRIVATE_FILES_DIR.includes('\0')) issues.push({ key: 'PRIVATE_FILES_DIR', message: 'An absolute private storage directory is required' })
    if (!STORE_ID.test(env.PRIVATE_FILES_STORE_ID || '')) issues.push({ key: 'PRIVATE_FILES_STORE_ID', message: 'A canonical lowercase RFC UUID is required' })
  }
  const minimum = env.PRIVATE_FILES_MIN_FREE_BYTES
  if (minimum !== undefined && (!/^(0|[1-9][0-9]*)$/.test(minimum) || !Number.isSafeInteger(Number(minimum)))) {
    issues.push({ key: 'PRIVATE_FILES_MIN_FREE_BYTES', message: 'A nonnegative safe integer byte count is required' })
  }
  return issues
}

function config(env: NodeJS.ProcessEnv) {
  if (privateStorageConfigIssues(env).length) throw new PrivateStorageError()
  return {
    strict: env.NODE_ENV === 'production' || env.PRIVATE_FILES_STORAGE_MODE !== undefined,
    root: path.resolve(env.PRIVATE_FILES_DIR || path.join(process.cwd(), 'data', 'private-files')),
    id: env.PRIVATE_FILES_STORE_ID,
    minFreeBytes: BigInt(env.PRIVATE_FILES_MIN_FREE_BYTES ?? DEFAULT_MIN_FREE_BYTES),
  }
}

async function canonicalDirectory(root: string) {
  const stat = await fs.lstat(root, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw new PrivateStorageError()
  return stat
}

/** Read at most limit+1 bytes even if a file grows after fstat. */
export async function readBoundedFile(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
    if (!bytesRead) break
    length += bytesRead
  }
  return buffer.subarray(0, length)
}

async function verifyMarker(namespace: PrivateNamespace, id: string) {
  const stat = await namespace.lstat(PRIVATE_STORE_MARKER)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_STORE_MARKER_BYTES) throw new PrivateStorageError()
  const handle = await namespace.open(PRIVATE_STORE_MARKER, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_STORE_MARKER_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new PrivateStorageError()
    const bytes = await readBoundedFile(handle, MAX_STORE_MARKER_BYTES)
    if (bytes.length !== opened.size) throw new PrivateStorageError()
    const marker = JSON.parse(bytes.toString('utf8'))
    if (!marker || Object.keys(marker).sort().join(',') !== 'id,version' || marker.version !== 1 || marker.id !== id) throw new PrivateStorageError()
  } finally { await handle.close() }
}

type Identity = Pick<BigIntStats, 'dev' | 'ino'>
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino

/** Operation-scoped capability; never retain it after withPrivateStorage returns.
 * Linux keeps the original directory fd alive and uses procfs for every leaf
 * syscall (including cleanup), so rename/mount replacement cannot retarget it.
 * Missing procfs fails closed. The configured name must still identify that fd
 * before results/publication are allowed, even if a replacement copies the marker.
 *
 * Node on Windows cannot supply equivalent openat/unlinkat guarantees. Its
 * pre/post identity checks detect persistent replacement, but cannot make a
 * privileged mount swap atomic or detect swap-and-restore between checks.
 * Windows requires stable trusted ancestors and quiesced mount changes for the
 * entire operation. All platforms require trusted namespace contents/ancestors;
 * filesystem identity checks cannot transact atomically with a DB commit.
 */
class PrivateNamespace {
  constructor(readonly root: string, private readonly identity: Identity,
    private readonly directory: FileHandle | undefined, private readonly settings: ReturnType<typeof config>) {}

  private leaf(name: string) {
    if (!STORE_ID.test(name.toLowerCase()) && name !== PRIVATE_STORE_MARKER && !/^\.loop-private-probe-[0-9a-f-]{36}$/.test(name)) throw new PrivateStorageError()
    return path.join(this.directory ? `/proc/self/fd/${this.directory.fd}` : this.root, name)
  }

  private async checkIdentity() {
    try {
      if (!sameIdentity(this.identity, await canonicalDirectory(this.root))) throw new PrivateStorageError()
      if (this.directory && !sameIdentity(this.identity, await this.directory.stat({ bigint: true }))) throw new PrivateStorageError()
    } catch { throw new PrivateStorageError() }
  }

  async assertCurrent() {
    try {
      await this.checkIdentity()
      if (this.settings.strict) await verifyMarker(this, this.settings.id!)
      await this.checkIdentity()
    } catch { throw new PrivateStorageError() }
  }

  async lstat(name: string) {
    await this.checkIdentity()
    try { return await fs.lstat(this.leaf(name)) }
    finally { await this.checkIdentity() }
  }

  async open(name: string, flags: number, mode?: number) {
    await this.checkIdentity()
    let handle: FileHandle | undefined
    try {
      handle = await fs.open(this.leaf(name), flags | NOFOLLOW, mode)
      await this.checkIdentity()
      return handle
    } catch (error) {
      // In particular, close a successfully opened leaf if post-open validation
      // fails. Never attempt pathname cleanup in the newly observed namespace.
      if (handle) await handle.close().catch(() => undefined)
      await this.checkIdentity()
      throw error
    }
  }

  async unlink(name: string, owned?: Identity) {
    await this.assertCurrent()
    try {
      if (owned && !sameIdentity(owned, await fs.lstat(this.leaf(name), { bigint: true }))) throw new PrivateStorageError()
      await this.checkIdentity()
      await fs.unlink(this.leaf(name))
    } finally { await this.checkIdentity() }
  }

  async sync() {
    await this.checkIdentity()
    if (this.directory) await this.directory.sync()
    await this.checkIdentity()
  }

  private async headroom(bytes: number) {
    await this.checkIdentity()
    await headroom(this.directory ? `/proc/self/fd/${this.directory.fd}` : this.root, bytes, this.settings.minFreeBytes)
    await this.checkIdentity()
  }

  async readiness(bytes: number) {
    try {
      await this.headroom(bytes + 32)
      const name = `.loop-private-probe-${randomUUID()}`, expected = randomBytes(32)
      const handle = await this.open(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600)
      let owned: Identity | undefined
      try {
        owned = await handle.stat({ bigint: true })
        await handle.writeFile(expected)
        await handle.sync()
        if (!(await handle.stat()).isFile() || !(await readBoundedFile(handle, expected.length)).equals(expected)) throw new PrivateStorageError()
        await this.sync()
      } finally {
        try { await handle.close() } finally { if (owned) await this.unlink(name, owned) }
      }
      await this.sync()
      await this.assertCurrent()
      await this.headroom(bytes)
    } catch { throw new PrivateStorageError() }
  }

  async writeBytes(id: string, buffer: Buffer) {
    try {
      if (!STORE_ID.test(id)) throw new PrivateStorageError()
      await this.readiness(buffer.length)
      const handle = await this.open(id, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      let owned: Identity | undefined
      try {
        try {
          const stat = await handle.stat({ bigint: true })
          if (!stat.isFile()) throw new PrivateStorageError()
          owned = stat
          await handle.writeFile(buffer)
          await handle.sync()
        } finally { await handle.close() }
        await this.sync()
        await this.assertCurrent()
        return owned
      } catch (error) {
        if (owned) await this.unlink(id, owned).catch(() => undefined)
        throw error
      }
    } catch { throw new PrivateStorageError() }
  }

  async initialize() {
    const name = PRIVATE_STORE_MARKER
    let exists = true
    try { await this.lstat(name) } catch (error: any) { if (error?.code !== 'ENOENT') throw error; exists = false }
    if (exists) { await this.assertCurrent(); return }
    await this.checkIdentity()
    const directory = await fs.opendir(this.directory ? `/proc/self/fd/${this.directory.fd}` : this.root)
    try { if (await directory.read()) throw new PrivateStorageError() } finally { await directory.close() }
    const handle = await this.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await handle.writeFile(JSON.stringify({ version: 1, id: this.settings.id }) + '\n')
      await handle.sync()
    } finally { await handle.close() }
    // Never unlink/overwrite a marker, even after a partial initialization.
    await this.sync()
    await this.assertCurrent()
  }
}

async function inNamespace<T>(settings: ReturnType<typeof config>, initialize: boolean, operation: (namespace: PrivateNamespace) => Promise<T>) {
  let directory: FileHandle | undefined
  try {
    let namespace: PrivateNamespace
    try {
      const identity = await canonicalDirectory(settings.root)
      if (process.platform === 'linux') {
        directory = await fs.open(settings.root, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
        const opened = await directory.stat({ bigint: true })
        if (!opened.isDirectory() || !sameIdentity(identity, opened)) throw new PrivateStorageError()
      }
      namespace = new PrivateNamespace(settings.root, identity, directory, settings)
      if (!initialize) await namespace.assertCurrent()
    } catch { throw new PrivateStorageError() }
    return await operation(namespace)
  } finally {
    if (directory) {
      // eslint-disable-next-line no-unsafe-finally -- fail-closed by design: a failed cleanup surfaces as PrivateStorageError and never leaks the raw cause.
      try { await directory.close() } catch { throw new PrivateStorageError() }
    }
  }
}

export async function withPrivateStorage<T>(operation: (namespace: PrivateNamespace) => Promise<T>,
  options: { createLocal?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const settings = config(env)
  if (!settings.strict && options.createLocal) {
    try { await fs.mkdir(settings.root, { recursive: true, mode: 0o700 }) } catch { throw new PrivateStorageError() }
  }
  return inNamespace(settings, false, operation)
}

/** Compatibility/configuration preflight only: the returned pathname is NOT a
 * capability. Filesystem consumers must keep a withPrivateStorage scope alive.
 * Only unconfigured dev/test writers may create a local directory.
 */
export async function resolveRoot(options: { createLocal?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return withPrivateStorage(async namespace => namespace.root, options, env)
}

async function headroom(root: string, bytes: number, minimum: bigint) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new PrivateStorageError()
  const stat = await fs.statfs(root, { bigint: true })
  if (stat.bsize <= 0n || stat.bavail < 0n || stat.bavail * stat.bsize < minimum + BigInt(bytes)) throw new PrivateStorageError()
}

/** Proves current create/read/fsync/unlink capability, not backup/replica durability.
 * statfs is advisory headroom: concurrent writers can race; this is not a quota.
 * Called for writes and worker preflight, never for ordinary reads.
 */
export async function checkPrivateStorageReadiness(bytes = 0, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return withPrivateStorage(async namespace => {
    await namespace.readiness(bytes)
    return namespace.root
  }, { createLocal: true }, env)
}

/** Only the explicit operator CLI calls this. Run with writers stopped. Never
 * adopts a populated unidentified root or replaces an existing marker/data.
 */
export async function initializePrivateStorage(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const settings = config(env)
    if (!settings.strict || env.PRIVATE_FILES_STORAGE_MODE !== 'shared-filesystem') throw new PrivateStorageError()
    await inNamespace(settings, true, namespace => namespace.initialize())
  } catch { throw new PrivateStorageError() }
}

/** Immutable, private leaf write, including staged bytes. Never replaces a leaf.
 * The returned path is informational, not a lease for subsequent filesystem I/O.
 */
export async function writePrivateBytes(id: string, buffer: Buffer): Promise<string> {
  return withPrivateStorage(async namespace => {
    await namespace.writeBytes(id, buffer)
    return path.join(namespace.root, id)
  }, { createLocal: true })
}
