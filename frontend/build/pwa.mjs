#!/usr/bin/env node
/**
 * Post-build PWA shell generator for the Next.js static export.
 * Adapted from web/build/pwa.ts (the hardened shell-only worker):
 * precaches ONLY the app shell (html/manifest/icons/static assets),
 * never authenticated API responses, never opaque responses, and
 * refuses any non-shell resource in the precache list.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'

const outDir = path.resolve('out')
const indexHtml = path.join(outDir, 'index.html')
if (!statSync(indexHtml, { throwIfNoEntry: false })?.isFile()) {
  console.error('out/index.html missing: run `next build` first')
  process.exit(1)
}
const staticDir = path.join(outDir, '_next', 'static')
const assets = []
for (const entry of readdirSync(staticDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  for (const file of readdirSync(path.join(staticDir, entry.name))) {
    if (/\.(?:js|css)$/.test(file)) assets.push(`/_next/static/${entry.name}/${file}`)
  }
}
const shellPaths = ['/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', ...assets]
for (const p of shellPaths) {
  if (!/^\/(?:index\.html|manifest\.webmanifest|icon\.svg|apple-touch-icon\.png|icon-(?:192|512)\.png|_next\/static\/[\w./-]+\.(?:js|css))$/.test(p)) {
    console.error(`Non-shell resource in precache: ${p}`)
    process.exit(1)
  }
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
function iconPng(size) {
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
const worker = `/* Generated app-shell-only worker. No runtime response caching. */
const CACHE = ${JSON.stringify(`loop-owned-shell-${createHash('sha256').update(shellPaths.join(',')).update(readFileSync(indexHtml)).update(readFileSync(path.resolve('public/icon.svg'))).update(readFileSync(path.resolve('public/manifest.webmanifest'))).digest('hex').slice(0, 16)}`)};
const SHELL = ${JSON.stringify(shellPaths)};
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
for (const [fileName, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(path.join(outDir, fileName), iconPng(size))
}
writeFileSync(path.join(outDir, 'sw.js'), worker)
console.log(`PWA shell generated: ${shellPaths.length} shell paths, ${assets.length} static assets`)
