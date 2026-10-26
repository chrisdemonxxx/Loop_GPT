import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SRC_DIR = path.join(__dirname, 'src')
const README_SRC = path.join(__dirname, 'README.md')

const TARGETS = [
  {
    name: 'chromium',
    dir: path.join(ROOT, 'apps/extension'),
    host: {
      family: 'chromium',
      packageKind: 'chromium',
      driver: 'chromium',
      browserName: 'Chrome',
      version: '1.0.0',
      pageWaitMs: 8000,
      actionTimeoutMs: 20000,
    },
    manifest: {
      manifest_version: 3,
      name: 'Loop GPT',
      version: '1.0.0',
      description: 'Drive a visible tab group from Loop Chat, Build, and Loop Bot.',
      permissions: ['debugger', 'tabs', 'tabGroups', 'scripting', 'storage', 'alarms'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'background.js', type: 'module' },
      action: { default_popup: 'popup.html', default_title: 'Loop GPT' },
    },
  },
  {
    name: 'firefox',
    dir: path.join(ROOT, 'apps/extension-firefox'),
    host: {
      family: 'firefox',
      packageKind: 'firefox',
      driver: 'firefox',
      browserName: 'Firefox',
      version: '1.0.0',
      pageWaitMs: 8000,
      actionTimeoutMs: 20000,
    },
    manifest: {
      manifest_version: 3,
      name: 'Loop GPT',
      version: '1.0.0',
      description: 'Drive a visible window from Loop Chat, Build, and Loop Bot.',
      browser_specific_settings: {
        gecko: { id: 'loop-gpt@loop-gpt.cyou', strict_min_version: '128.0' },
      },
      permissions: ['tabs', 'scripting', 'storage', 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse', 'alarms'],
      host_permissions: ['<all_urls>'],
      background: { scripts: ['background.js'], type: 'module' },
      action: { default_popup: 'popup.html', default_title: 'Loop GPT' },
    },
  },
  {
    name: 'tor',
    dir: path.join(ROOT, 'apps/extension-tor'),
    host: {
      family: 'tor',
      packageKind: 'tor',
      driver: 'firefox',
      browserName: 'Tor Browser',
      version: '1.0.0',
      pageWaitMs: 20000,
      actionTimeoutMs: 60000,
    },
    manifest: {
      manifest_version: 3,
      name: 'Loop GPT for Tor Browser',
      version: '1.0.0',
      description: 'Drive a visible Tor Browser window. Built for Firefox ESR 128.',
      browser_specific_settings: {
        gecko: { id: 'loop-gpt-tor@loop-gpt.cyou', strict_min_version: '128.0' },
      },
      permissions: ['tabs', 'scripting', 'storage', 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse', 'alarms'],
      host_permissions: ['<all_urls>'],
      background: { scripts: ['background.js'], type: 'module' },
      action: { default_popup: 'popup.html', default_title: 'Loop GPT' },
    },
  },
]

export function buildExtensions() {
  const srcFiles = fs.readdirSync(SRC_DIR).filter((f) => f !== 'manifest.json' && f !== 'host.js')

  for (const target of TARGETS) {
    fs.mkdirSync(target.dir, { recursive: true })

    // Copy common source files
    for (const file of srcFiles) {
      fs.copyFileSync(path.join(SRC_DIR, file), path.join(target.dir, file))
    }

    // Copy README.md
    if (fs.existsSync(README_SRC)) {
      fs.copyFileSync(README_SRC, path.join(target.dir, 'README.md'))
    }

    // Write target host.js
    const hostContent = `export const PACKAGE = ${JSON.stringify(target.host, null, 2)}\n`
    fs.writeFileSync(path.join(target.dir, 'host.js'), hostContent, 'utf8')

    // Write target manifest.json
    fs.writeFileSync(path.join(target.dir, 'manifest.json'), JSON.stringify(target.manifest, null, 2) + '\n', 'utf8')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildExtensions()
  console.log('Successfully synchronized extensions to apps/extension, apps/extension-firefox, and apps/extension-tor')
}
