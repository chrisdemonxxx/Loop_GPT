#!/usr/bin/env node
/**
 * Build the desktop shell's Windows icon from the product's brand SVG
 * (apps/web/public/icon.svg). Emits a multi-size PNG-in-ICO (256/48/32/16 —
 * the Vista+ PNG-compressed container electron-builder and Windows expect)
 * at apps/desktop/build/icon.ico.
 *
 * Run: node apps/desktop/scripts/build-icon.mjs   (needs sharp from apps/web)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SVG = path.resolve(APP, '..', 'web', 'public', 'icon.svg')
const OUT_DIR = path.join(APP, 'build')
const OUT = path.join(OUT_DIR, 'icon.ico')

const SIZES = [256, 48, 32, 16]

const { default: sharp } = await import('sharp')

const svg = readFileSync(SVG)
const pngs = []
for (const size of SIZES) {
  const buf = await sharp(svg, { density: 288 })
    .resize(size, size)
    .png()
    .toBuffer()
  pngs.push({ size, buf })
}

// ── ICO assembly (PNG-compressed entries) ────────────────────────────────────
const count = pngs.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)      // reserved
header.writeUInt16LE(1, 2)      // type: icon
header.writeUInt16LE(count, 4) // image count

const entries = []
const data = []
let offset = 6 + 16 * count
for (const { size, buf } of pngs) {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
  entry.writeUInt8(0, 2)                     // color count
  entry.writeUInt8(0, 3)                      // reserved
  entry.writeUInt16LE(1, 4)                   // color planes
  entry.writeUInt16LE(32, 6)                  // bits per pixel
  entry.writeUInt32LE(buf.length, 8)          // image size
  entry.writeUInt32LE(offset, 12)             // image offset
  entries.push(entry)
  data.push(buf)
  offset += buf.length
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, Buffer.concat([header, ...entries, ...data]))
console.log(`icon built: ${path.relative(APP, OUT)} (${SIZES.join('/')}px, ${count} images)`)