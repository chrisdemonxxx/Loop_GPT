import { randomUUID } from 'crypto'
import { constants, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ privateFile: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() } }))
vi.mock('../prisma', () => ({ prisma: db }))
import { deleteOwnedFile, findOwnedFile, readOwnedFile, stagePrivateArtifact, storePrivateFile, verifyStagedArtifact } from '../privateFiles'
import { initializePrivateStorage, PRIVATE_STORE_MARKER } from '../privateStorage'

let parent: string, root: string
const bytes = Buffer.from('immutable staged artifact fixture')
const unavailable = { status: 503, message: 'Private file storage is temporarily unavailable' }
beforeEach(async () => {
  vi.clearAllMocks()
  parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-private-operations-')))
  root = path.join(parent, 'store'); await fs.mkdir(root)
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PRIVATE_FILES_DIR', root)
  vi.stubEnv('PRIVATE_FILES_STORAGE_MODE', 'shared-filesystem'); vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
  vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', '67108864')
  await initializePrivateStorage()
  db.privateFile.create.mockImplementation(async ({ data }) => data)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(parent, { recursive: true, force: true }) })
const store = () => storePrivateFile({ userId: 'fixture-owner', name: 'fixture', mimeType: 'application/octet-stream', purpose: 'artifact', buffer: bytes })
async function replaceRoot(id?: string) {
  const marker = await fs.readFile(path.join(root, PRIVATE_STORE_MARKER))
  await fs.rename(root, path.join(parent, 'original'))
  await fs.mkdir(root)
  // Copy the valid marker deliberately: identity must not be reduced to store ID.
  await fs.writeFile(path.join(root, PRIVATE_STORE_MARKER), marker)
  if (id) await fs.writeFile(path.join(root, id), 'replacement sentinel')
}

describe('all private file entry points use the identified storage root', () => {
  it('guards read, metadata, delete, upload and stage against a changed namespace', async () => {
    const file = await store()
    const staged = await stagePrivateArtifact('prepared.mp4', 'video/mp4', bytes)
    db.privateFile.findFirst.mockResolvedValue(file)
    vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
    for (const operation of [() => readOwnedFile('fixture-owner', file.id), () => findOwnedFile('fixture-owner', file.id),
      () => deleteOwnedFile('fixture-owner', file.id), store, () => stagePrivateArtifact('new.mp4', 'video/mp4', bytes), () => verifyStagedArtifact(staged)]) {
      await expect(operation()).rejects.toMatchObject(unavailable)
    }
    expect(db.privateFile.updateMany).not.toHaveBeenCalled()
    expect(db.privateFile.create).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(path.join(root, file.id))).toEqual(bytes)
  })
  it('requires readiness/headroom for both ordinary and staged writes', async () => {
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096n, bavail: 0n } as any)
    await expect(store()).rejects.toMatchObject(unavailable)
    await expect(stagePrivateArtifact('a.mp4', 'video/mp4', bytes)).rejects.toMatchObject(unavailable)
    expect(db.privateFile.create).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })
  it('fails closed if storage turns read-only after readiness; reads still work without probes', async () => {
    const file = await store(); db.privateFile.findFirst.mockResolvedValue(file)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (/^[0-9a-f-]{36}$/.test(path.basename(String(args[0]))) &&
          typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
        throw Object.assign(new Error(`read-only private root ${root}`), { code: 'EROFS' })
      }
      return open(...args)
    })
    await expect(store()).rejects.toMatchObject(unavailable)
    await expect(stagePrivateArtifact('a.mp4', 'video/mp4', bytes)).rejects.toMatchObject(unavailable)
    expect(db.privateFile.create).toHaveBeenCalledTimes(1)
    expect((await readOwnedFile('fixture-owner', file.id)).buffer).toEqual(bytes)
    expect((await fs.readdir(root)).sort()).toEqual([PRIVATE_STORE_MARKER, file.id].sort())
  })
  it('retains staged identity/integrity checks on repeated recovery and corruption', async () => {
    const staged = await stagePrivateArtifact('a.mp4', 'video/mp4', bytes)
    expect(await verifyStagedArtifact(staged)).toEqual(staged)
    expect(await verifyStagedArtifact(JSON.parse(JSON.stringify(staged)))).toEqual(staged)
    expect(db.privateFile.create).not.toHaveBeenCalled()
    for (const invalid of [{ ...staged, id: '../escape' }, { ...staged, size: -1 }, { ...staged, sha256: 'invalid' }, { ...staged, name: '../escape' }]) {
      await expect(verifyStagedArtifact(invalid)).rejects.toMatchObject({ status: 409 })
    }
    await fs.writeFile(path.join(root, staged.id), Buffer.alloc(bytes.length))
    await expect(verifyStagedArtifact(staged)).rejects.toMatchObject({ status: 409 })
    await fs.writeFile(path.join(root, staged.id), Buffer.alloc(bytes.length + 1))
    await expect(verifyStagedArtifact(staged)).rejects.toMatchObject({ status: 409 })
    await fs.unlink(path.join(root, staged.id))
    await expect(verifyStagedArtifact(staged)).rejects.toMatchObject({ status: 409 })
  })
  it('reads verified bytes without write probes and rejects stored-byte corruption', async () => {
    const file = await store(); db.privateFile.findFirst.mockResolvedValue(file)
    vi.spyOn(fs, 'statfs').mockRejectedValue(new Error('reads must not probe headroom'))
    expect((await readOwnedFile('fixture-owner', file.id)).buffer).toEqual(bytes)
    await fs.writeFile(path.join(root, file.id), Buffer.alloc(bytes.length))
    await expect(readOwnedFile('fixture-owner', file.id)).rejects.toMatchObject({ status: 409 })
  })
  it('rejects staged symlink leaves', async context => {
    const staged = await stagePrivateArtifact('a.mp4', 'video/mp4', bytes)
    const target = path.join(root, 'target')
    await fs.rename(path.join(root, staged.id), target)
    try { await fs.symlink(target, path.join(root, staged.id)) } catch (error: any) {
      if (process.platform === 'win32' && error.code === 'EPERM') { context.skip(); return } throw error
    }
    await expect(verifyStagedArtifact(staged)).rejects.toMatchObject({ status: 409 })
  })
  it('sanitizes underlying filesystem errors on reads and deletes', async () => {
    const file = await store(); db.privateFile.findFirst.mockResolvedValue(file)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === file.id) throw new Error(`private-credential ${root}`)
      return open(...args)
    })
    await expect(readOwnedFile('fixture-owner', file.id)).rejects.toMatchObject(unavailable)
    vi.spyOn(fs, 'unlink').mockRejectedValue(new Error(`private-credential ${root}`))
    await expect(deleteOwnedFile('fixture-owner', file.id)).rejects.toMatchObject(unavailable)
  })
})

describe('operation-bound namespace races', () => {
  it.each(['store', 'stage'])('rejects replacement between validation and %s leaf open, without DB publication', async operation => {
    const open = fs.open.bind(fs)
    let leaf = '', opened: Awaited<ReturnType<typeof fs.open>> | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const name = path.basename(String(args[0]))
      if (!leaf && /^[0-9a-f-]{36}$/.test(name)) {
        leaf = name
        await replaceRoot()
        opened = await open(...args)
        return opened
      }
      return open(...args)
    })
    await expect(operation === 'store' ? store() : stagePrivateArtifact('a.mp4', 'video/mp4', bytes)).rejects.toMatchObject(unavailable)
    expect(leaf).not.toBe('')
    expect(opened!.fd).toBe(-1)
    expect(db.privateFile.create).not.toHaveBeenCalled()
    if (process.platform === 'linux') {
      expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
    } else {
      // Windows detects the swap after open; no payload is written/published.
      // A just-created empty orphan may remain rather than unsafe cleanup.
      expect(await fs.readFile(path.join(root, leaf))).toHaveLength(0)
    }
  })

  it('revalidates the original identity after writing and before DB publication', async () => {
    const open = fs.open.bind(fs)
    let leaf = ''
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args), name = path.basename(String(args[0]))
      if (/^[0-9a-f-]{36}$/.test(name)) {
        leaf = name
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); await replaceRoot(name) })
      }
      return handle
    })
    await expect(store()).rejects.toMatchObject(unavailable)
    expect(db.privateFile.create).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(root, leaf), 'utf8')).toBe('replacement sentinel')
  })

  it.each(['findFirst', 'updateMany'])('never unlinks the replacement same-UUID file after delete %s awaits', async method => {
    const file = await store()
    db.privateFile.findFirst.mockResolvedValue(file)
    db.privateFile[method].mockImplementationOnce(async () => { await replaceRoot(file.id); return method === 'findFirst' ? file : { count: 1 } })
    await expect(deleteOwnedFile('fixture-owner', file.id)).rejects.toMatchObject(unavailable)
    expect(await fs.readFile(path.join(root, file.id), 'utf8')).toBe('replacement sentinel')
    expect(await fs.readFile(path.join(parent, 'original', file.id))).toEqual(bytes)
    if (method === 'findFirst') expect(db.privateFile.updateMany).not.toHaveBeenCalled()
  })

  it('does not retarget DB-failure cleanup to a replacement with a valid marker', async () => {
    let leaf = ''
    const failure = new Error('fixture DB failure')
    db.privateFile.create.mockImplementationOnce(async ({ data }) => {
      leaf = data.id
      await replaceRoot(leaf)
      throw failure
    })
    await expect(store()).rejects.toBe(failure)
    expect(await fs.readFile(path.join(root, leaf), 'utf8')).toBe('replacement sentinel')
    expect(await fs.readFile(path.join(parent, 'original', leaf))).toEqual(bytes)
  })

  it('cleans up its own bytes on DB failure while the namespace remains stable', async () => {
    db.privateFile.create.mockRejectedValueOnce(new Error('fixture DB failure'))
    await expect(store()).rejects.toThrow('fixture DB failure')
    expect(await fs.readdir(root)).toEqual([PRIVATE_STORE_MARKER])
  })

  it.each(['metadata', 'read'])('rejects namespace changes across %s DB lookup', async operation => {
    const file = await store()
    db.privateFile.findFirst.mockImplementationOnce(async () => { await replaceRoot(file.id); return file })
    await expect(operation === 'metadata' ? findOwnedFile('fixture-owner', file.id) : readOwnedFile('fixture-owner', file.id)).rejects.toMatchObject(unavailable)
    expect(await fs.readFile(path.join(root, file.id), 'utf8')).toBe('replacement sentinel')
  })

  it.each(['read', 'verify'])('rejects a root replacement just before %s opens a leaf and closes the handle', async operation => {
    const file = await store(), staged = await stagePrivateArtifact('a.mp4', 'video/mp4', bytes)
    db.privateFile.findFirst.mockResolvedValue(file)
    const id = operation === 'read' ? file.id : staged.id, open = fs.open.bind(fs)
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === id) {
        await replaceRoot(id)
        // Identical valid bytes in the replacement must not bypass root identity.
        await fs.writeFile(path.join(root, id), bytes)
        opened = await open(...args)
        return opened
      }
      return open(...args)
    })
    await expect(operation === 'read' ? readOwnedFile('fixture-owner', id) : verifyStagedArtifact(staged)).rejects.toMatchObject(unavailable)
    expect(opened!.fd).toBe(-1)
  })

  it.runIf(process.platform === 'linux')('anchors the unlink syscall itself even if root changes after its final check', async () => {
    const file = await store(); db.privateFile.findFirst.mockResolvedValue(file)
    const unlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink').mockImplementationOnce(async filename => {
      expect(String(filename)).toMatch(/^\/proc\/self\/fd\/\d+\//)
      await replaceRoot(file.id)
      await unlink(filename)
    })
    await expect(deleteOwnedFile('fixture-owner', file.id)).rejects.toMatchObject(unavailable)
    expect(await fs.readFile(path.join(root, file.id), 'utf8')).toBe('replacement sentinel')
    await expect(fs.stat(path.join(parent, 'original', file.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
