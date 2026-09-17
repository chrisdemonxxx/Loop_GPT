import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import type { Plugin } from 'vite'

export function buildWorker(paths: string[], revision: string): string {
  if (paths.some((path) => !/^\/(?:index\.html|icon\.svg|manifest\.webmanifest|apple-touch-icon\.png|icon-(?:192|512)\.png|assets\/[\w.-]+\.(?:js|css))$/.test(path))) {
    throw new Error('Non-shell resource in precache')
  }
  return `/* Generated app-shell-only worker. No runtime response caching. */
const CACHE = ${JSON.stringify(`loop-owned-shell-${revision}`)};
const SHELL = ${JSON.stringify(paths)};
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of SHELL) {
      const response = await fetch(new Request(path, { credentials: 'omit', cache: 'reload', redirect: 'error' }));
      if (!response.ok || response.type === 'opaque') throw new Error('Shell installation failed');
      await cache.put(path, response);
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('loop-owned-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.headers.has('authorization') ||
      url.origin !== self.location.origin || url.search || url.hash) return;
  const path = url.pathname === '/' && request.mode === 'navigate' ? '/index.html' : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(path) || fetch(request);
  })());
});
`
}

// Small deterministic raster app icon, generated locally without graphics dependencies.
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
export function iconPng(size: number): Buffer {
  const bytes = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size; const ny = y / size
      const ring = [0.39, 0.61].some((cx) => Math.abs(Math.hypot(nx - cx, ny - 0.5) - 0.14) < 0.03)
      const offset = y * (size * 4 + 1) + 1 + x * 4
      bytes.set(ring ? [184, 237, 188, 255] : [16, 42, 42, 255], offset)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))])
}

export function shellPwa(): Plugin {
  return {
    name: 'loop-shell-only', apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
        this.emitFile({ type: 'asset', fileName, source: iconPng(size) })
      }
      const assets = Object.keys(bundle).filter((name) => /^assets\/[\w.-]+\.(js|css)$/.test(name))
      const paths = ['/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', ...assets.map((name) => `/${name}`)]
      // HTML edits must also invalidate the shell. Vite HTML is available in this late hook.
      const hash = createHash('sha256').update(JSON.stringify(paths))
      for (const item of Object.values(bundle)) hash.update(item.type === 'chunk' ? item.code : item.source)
      for (const name of ['icon.svg', 'manifest.webmanifest']) hash.update(readFileSync(new URL(`../public/${name}`, import.meta.url)))
      const revision = hash.digest('hex').slice(0, 16)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: buildWorker(paths, revision) })
    },
  }
}
