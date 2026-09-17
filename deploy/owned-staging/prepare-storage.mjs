// Explicit ONE-OFF PVC directory preparation, run as root with writers stopped.
// Does not create a marker or chown recursively. The existing CLI owns --init.
import { lstat, realpath, readdir, mkdir, chmod, chown } from 'node:fs/promises'
const root = '/private-store', files = `${root}/files`
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 0) throw new Error()
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error()
  // ext4 PVCs can contain lost+found. Do not silently adopt arbitrary old data.
  if ((await readdir(root)).some((name) => !['files', 'lost+found'].includes(name))) throw new Error()
  await mkdir(files, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
  const target = await lstat(files)
  if (!target.isDirectory() || target.isSymbolicLink() || await realpath(files) !== files) throw new Error()
  if ((await readdir(files)).length) throw new Error()
  await chown(files, 1000, 1000)
  await chmod(files, 0o700)
  console.log('Empty namespace directory prepared. Run private-storage.mjs --init as node explicitly.')
} catch {
  console.error('PVC preparation refused. Requires root, canonical mount, and an empty files directory; inspect existing data manually.')
  process.exitCode = 1
}
