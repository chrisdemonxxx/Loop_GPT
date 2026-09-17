import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPrivateStorageReadiness, initializePrivateStorage, MAX_STORE_MARKER_BYTES,
  PRIVATE_STORE_MARKER, privateStorageConfigIssues, resolveRoot } from '../privateStorage'

let parent: string, root: string, env: NodeJS.ProcessEnv
const unavailable = { status: 503, message: 'Private file storage is temporarily unavailable' }
beforeEach(async () => {
  parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-storage-unit-')))
  root = path.join(parent, 'store'); await fs.mkdir(root)
  env = { NODE_ENV: 'production', PRIVATE_FILES_STORAGE_MODE: 'shared-filesystem', PRIVATE_FILES_DIR: root, PRIVATE_FILES_STORE_ID: randomUUID() }
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(parent, { recursive: true, force: true }) })
const marker = () => path.join(root, PRIVATE_STORE_MARKER)

describe('private filesystem configuration and namespace', () => {
  it.each(['PRIVATE_FILES_STORAGE_MODE', 'PRIVATE_FILES_DIR', 'PRIVATE_FILES_STORE_ID'])('fails closed without %s', async key => {
    delete env[key]
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual([])
  })
  it.each(['relative', '', '   '])('rejects nonabsolute production roots (%s)', async dir => {
    env.PRIVATE_FILES_DIR = dir
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
  })
  it.each(['-1', '1.2', '', 'Infinity', '1e9', '9007199254740992'])('rejects invalid headroom %s', value => {
    expect(privateStorageConfigIssues({ ...env, PRIVATE_FILES_MIN_FREE_BYTES: value }).map(x => x.key)).toContain('PRIVATE_FILES_MIN_FREE_BYTES')
  })
  it('keeps unconfigured dev local creation and enforces explicit modes in test', async () => {
    const local = path.join(parent, 'local')
    expect(await resolveRoot({ createLocal: true }, { NODE_ENV: 'test', PRIVATE_FILES_DIR: local })).toBe(local)
    await expect(resolveRoot({}, { NODE_ENV: 'test', PRIVATE_FILES_DIR: local, PRIVATE_FILES_STORAGE_MODE: '' })).rejects.toMatchObject(unavailable)
  })
  it('never auto-initializes or creates a production directory', async () => {
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual([])
    env.PRIVATE_FILES_DIR = path.join(root, 'missing')
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual([])
  })
  it('initializes an empty root and is byte-for-byte idempotent with existing data', async () => {
    await initializePrivateStorage(env)
    const original = await fs.readFile(marker())
    await fs.writeFile(path.join(root, 'existing-user-data'), 'keep')
    await initializePrivateStorage(env)
    expect(await fs.readFile(marker())).toEqual(original)
    expect(await fs.readFile(path.join(root, 'existing-user-data'), 'utf8')).toBe('keep')
    expect(await resolveRoot({}, env)).toBe(root)
  })
  it('refuses nonempty unidentified roots, even a hidden file', async () => {
    await fs.writeFile(path.join(root, '.keep'), 'important')
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual(['.keep'])
  })
  it('refuses wrong IDs without overwriting the marker', async () => {
    await initializePrivateStorage(env)
    const original = await fs.readFile(marker())
    env.PRIVATE_FILES_STORE_ID = randomUUID()
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    expect(await fs.readFile(marker())).toEqual(original)
  })
  it.each(['', '{}', 'null', '{"version":2}', 'x'.repeat(MAX_STORE_MARKER_BYTES + 1)])('rejects malformed/bounded markers', async text => {
    await fs.writeFile(marker(), text)
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
    expect(await fs.readFile(marker(), 'utf8')).toBe(text)
  })
  it('rejects extra marker fields and directories as markers', async () => {
    await fs.writeFile(marker(), JSON.stringify({ version: 1, id: env.PRIVATE_FILES_STORE_ID, extra: true }))
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    await fs.unlink(marker()); await fs.mkdir(marker())
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
  })
  it('rejects symlink/junction roots and canonicalizes no ancestor aliases', async () => {
    await initializePrivateStorage(env)
    const link = path.join(parent, 'alias')
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveRoot({}, { ...env, PRIVATE_FILES_DIR: link })).rejects.toMatchObject(unavailable)
    await fs.mkdir(path.join(root, 'nested'))
    await expect(initializePrivateStorage({ ...env, PRIVATE_FILES_DIR: path.join(link, 'nested') })).rejects.toMatchObject(unavailable)
  })
  it('rejects symlink markers', async context => {
    const target = path.join(parent, 'marker-target')
    await fs.writeFile(target, JSON.stringify({ version: 1, id: env.PRIVATE_FILES_STORE_ID }))
    try { await fs.symlink(target, marker()) } catch (error: any) {
      if (process.platform === 'win32' && error.code === 'EPERM') { context.skip(); return }; throw error
    }
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    await expect(initializePrivateStorage(env)).rejects.toMatchObject(unavailable)
  })
  it('checks post-open fstat bounds before reading any marker bytes', async () => {
    await initializePrivateStorage(env)
    const open = fs.open.bind(fs), read = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (path.basename(String(args[0])) === PRIVATE_STORE_MARKER) {
        const stat = await handle.stat()
        vi.spyOn(handle, 'stat').mockResolvedValue({ ...stat, size: MAX_STORE_MARKER_BYTES + 1, isFile: () => true } as any)
        vi.spyOn(handle, 'read').mockImplementation(read)
      }
      return handle
    })
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    expect(read).not.toHaveBeenCalled()
  })
  it('bounds reads even when the marker grows after fstat', async () => {
    await initializePrivateStorage(env)
    const open = fs.open.bind(fs), reads: number[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (path.basename(String(args[0])) === PRIVATE_STORE_MARKER) {
        const stat = handle.stat.bind(handle), read = handle.read.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          const original = await stat(); await fs.appendFile(marker(), Buffer.alloc(4096)); return original
        })
        vi.spyOn(handle, 'read').mockImplementation((async (...values: any[]) => {
          reads.push(values[2]); return (read as any)(...values)
        }) as any)
      }
      return handle
    })
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    expect(reads.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(MAX_STORE_MARKER_BYTES + 1)
  })
})

describe('private storage readiness', () => {
  beforeEach(async () => { await initializePrivateStorage(env) })
  it('probes real writes/reads/sync/cleanup and never probes ordinary root reads', async () => {
    const open = vi.spyOn(fs, 'open')
    expect(await checkPrivateStorageReadiness(1024, env)).toBe(root)
    expect(open.mock.calls.some(call => String(call[0]).includes('.loop-private-probe-'))).toBe(true)
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
    open.mockClear()
    await resolveRoot({}, env)
    expect(open.mock.calls.some(call => String(call[0]).includes('.loop-private-probe-'))).toBe(false)
  })
  it('uses available-to-user blocks and reserves incoming write bytes plus headroom', async () => {
    const stats = vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 1n, bavail: 1063n, bfree: 999999n } as any)
    env.PRIVATE_FILES_MIN_FREE_BYTES = '1000'
    await expect(checkPrivateStorageReadiness(32, env)).rejects.toMatchObject(unavailable)
    stats.mockResolvedValue({ bsize: 1n, bavail: 1064n } as any)
    await expect(checkPrivateStorageReadiness(32, env)).resolves.toBe(root)
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })
  it('fails closed if statfs is unavailable', async () => {
    vi.spyOn(fs, 'statfs').mockRejectedValue(new Error(`secret root ${root}`))
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
  })
  it.each(['open', 'sync', 'read', 'unlink'])('sanitizes probe %s failures', async operation => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const probe = String(args[0]).includes('.loop-private-probe-')
      if (probe && operation === 'open') throw new Error(`private-credential ${root}`)
      const handle = await open(...args)
      if (probe && ['sync', 'read'].includes(operation)) vi.spyOn(handle, operation as 'sync').mockRejectedValue(new Error(`private-credential ${root}`))
      return handle
    })
    if (operation === 'unlink') vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error(`private-credential ${root}`))
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    if (operation !== 'unlink') expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })
  it.runIf(process.platform === 'linux')('requires Linux directory fsync', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === root) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('unsupported directory sync'))
      return handle
    })
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })
  it('never removes a replacement-namespace probe sentinel during cleanup', async () => {
    const open = fs.open.bind(fs), original = path.join(parent, 'original')
    const markerBytes = await fs.readFile(marker())
    let probe = ''
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]).includes('.loop-private-probe-')) {
        probe = path.basename(String(args[0]))
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close()
          await fs.rename(root, original); await fs.mkdir(root)
          await fs.writeFile(marker(), markerBytes)
          await fs.writeFile(path.join(root, probe), 'replacement sentinel')
        })
      }
      return handle
    })
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    expect(probe).not.toBe('')
    expect(await fs.readFile(path.join(root, probe), 'utf8')).toBe('replacement sentinel')
    expect(await fs.readFile(marker())).toEqual(markerBytes)
    expect(await fs.readFile(path.join(original, probe))).toHaveLength(32)
  })
  it('still cleans its own canary when close reports a failure', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]).includes('.loop-private-probe-')) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw new Error(`private root ${root}`) })
      }
      return handle
    })
    await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })
  it.each(['success', 'marker', 'probe', 'post-open'])('closes every acquired handle on %s', async failure => {
    const open = fs.open.bind(fs), handles: Awaited<ReturnType<typeof fs.open>>[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      handles.push(handle)
      if (failure === 'marker' && path.basename(String(args[0])) === PRIVATE_STORE_MARKER) {
        vi.spyOn(handle, 'read').mockRejectedValue(new Error('fixture marker read failure'))
      }
      if (String(args[0]).includes('.loop-private-probe-')) {
        if (failure === 'probe') vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('fixture probe write failure'))
        if (failure === 'post-open') {
          // Replace the observed root identity at precisely the post-open check.
          const lstat = fs.lstat.bind(fs)
          vi.spyOn(fs, 'lstat').mockImplementation((async (...values: Parameters<typeof fs.lstat>) => {
            const stat = await lstat(...values)
            if (values[0] === root) return Object.assign(stat, { ino: typeof stat.ino === 'bigint' ? stat.ino + 1n : stat.ino + 1 })
            return stat
          }) as typeof fs.lstat)
        }
      }
      return handle
    })
    if (failure === 'success') await checkPrivateStorageReadiness(0, env)
    else await expect(checkPrivateStorageReadiness(0, env)).rejects.toMatchObject(unavailable)
    expect(handles.length).toBeGreaterThan(0)
    expect(handles.every(handle => handle.fd === -1)).toBe(true)
  })
  it.runIf(process.platform === 'linux')('closes the directory fd when acquisition fstat fails', async () => {
    const open = fs.open.bind(fs)
    let directory: Awaited<ReturnType<typeof fs.open>> | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === root) {
        directory = handle
        vi.spyOn(handle, 'stat').mockRejectedValue(new Error(`private root ${root}`))
      }
      return handle
    })
    await expect(resolveRoot({}, env)).rejects.toMatchObject(unavailable)
    expect(directory!.fd).toBe(-1)
  })
})

describe('standalone private-storage CLI (compiled, no DB)', () => {
  function cli(arg: string, settings: NodeJS.ProcessEnv = env) {
    // Explicit allowlist: no credentials/providers or DB inherited by the child.
    return spawnSync(process.execPath, [path.resolve('scripts/private-storage.mjs'), arg], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...settings }, encoding: 'utf8', timeout: 10000,
    })
  }
  it('prints help without configuration or a database', () => {
    const result = cli('--help', { NODE_ENV: 'production' })
    expect(result.status).toBe(0); expect(result.stdout).toContain('--init'); expect(result.stderr).toBe('')
  })
  it('rejects bad arguments/configuration with safe exits', () => {
    expect(cli('--invalid').status).toBe(2)
    const result = cli('--check', { NODE_ENV: 'production', PRIVATE_FILES_DIR: 'secret-private-path' })
    expect(result.status).toBe(1); expect(result.stderr).not.toContain('secret-private-path')
  })
  it('checks without initialization and explicitly initializes idempotently', async () => {
    expect(cli('--check').status).toBe(1)
    expect(await fs.readdir(root)).toEqual([])
    expect(cli('--init').status).toBe(0)
    expect(cli('--init').status).toBe(0)
    const result = cli('--check')
    expect(result.status, result.stderr).toBe(0)
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
    expect(cli('--init', { ...env, PRIVATE_FILES_STORE_ID: randomUUID() }).status).toBe(1)
  })
})
