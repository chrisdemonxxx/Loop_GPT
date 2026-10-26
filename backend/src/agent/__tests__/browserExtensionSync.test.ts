import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

function hashFile(filepath: string): string {
  return createHash('sha256').update(fs.readFileSync(filepath)).digest('hex')
}

const root = path.resolve(__dirname, '../../../..')
const srcDir = path.join(root, 'packages/browser-extension/src')
const hasMonorepoRoot = fs.existsSync(srcDir)

describe.skipIf(!hasMonorepoRoot)('extension packaging drift test (Decision 2)', () => {
  const srcFiles = hasMonorepoRoot
    ? fs.readdirSync(srcDir).filter((f) => f !== 'manifest.json' && f !== 'host.js')
    : []

  const targetDirs = [
    path.join(root, 'apps/extension'),
    path.join(root, 'apps/extension-firefox'),
    path.join(root, 'apps/extension-tor'),
  ]

  it('ensures all common source files in apps/ match packages/browser-extension/src', () => {
    for (const dir of targetDirs) {
      for (const file of srcFiles) {
        const srcPath = path.join(srcDir, file)
        const targetPath = path.join(dir, file)
        expect(fs.existsSync(targetPath), `File ${targetPath} must exist`).toBe(true)
        expect(hashFile(targetPath), `File ${file} in ${dir} has drifted from source`).toBe(hashFile(srcPath))
      }
    }
  })

  it('validates Firefox and Tor manifests use background.scripts and webRequestFilterResponse', () => {
    const ffManifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/extension-firefox/manifest.json'), 'utf8'))
    const torManifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/extension-tor/manifest.json'), 'utf8'))

    expect(ffManifest.background.scripts).toEqual(['background.js'])
    expect(ffManifest.permissions).toContain('webRequestFilterResponse')

    expect(torManifest.background.scripts).toEqual(['background.js'])
    expect(torManifest.permissions).toContain('webRequestFilterResponse')
  })
})
