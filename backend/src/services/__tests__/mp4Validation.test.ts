import { describe, expect, it } from 'vitest'
import { validateVideoMp4 } from '../mp4Validation'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'
import { createTinyAudioMp4 } from './fixtures/tinyAudioMp4'
import { createTinyHighVideoMp4 } from './fixtures/tinyHighVideoMp4'

const TRACK = ['moov', 'trak']
const MDIA = [...TRACK, 'mdia']
const STBL = [...MDIA, 'minf', 'stbl']
const AVC = [...STBL, 'stsd', 'avc1', 'avcC']
const ERROR = 'Invalid MP4 video'

interface Located { start: number; data: number; end: number; parents: number[] }

function locate(buffer: Buffer, path: string[]): Located {
  let start = 0
  let end = buffer.length
  const parents: number[] = []
  for (let depth = 0; depth < path.length; depth++) {
    let found = false
    while (start + 8 <= end) {
      const size32 = buffer.readUInt32BE(start)
      const size = size32 === 1 ? Number(buffer.readBigUInt64BE(start + 8)) : size32 || end - start
      const data = start + (size32 === 1 ? 16 : 8)
      if (buffer.toString('latin1', start + 4, start + 8) === path[depth]) {
        end = start + size
        if (depth === path.length - 1) return { start, data, end, parents }
        parents.push(start)
        start = data + (path[depth] === 'stsd' || path[depth] === 'dref' ? 8 : path[depth] === 'avc1' ? 78 : 0)
        found = true
        break
      }
      if (size < 8) throw new Error('Broken test fixture')
      start += size
    }
    if (!found) throw new Error(`Missing test box ${path.join('/')}`)
  }
  throw new Error('Empty test path')
}

function atom(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length)
  header.write(type, 4, 4, 'latin1')
  return Buffer.concat([header, payload])
}

function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => result.writeUInt32BE(value, index * 4))
  return result
}

function change(path: string[], offset: number, value: number): Buffer {
  const buffer = createTinyVideoMp4()
  buffer.writeUInt32BE(value, locate(buffer, path).data + offset)
  return buffer
}

/** Resize a box, fix ancestor sizes, and relocate the fixture's one chunk. */
function replace(buffer: Buffer, path: string[], replacement: Buffer, offsetType = 'stco'): Buffer {
  const target = locate(buffer, path)
  const delta = replacement.length - (target.end - target.start)
  const result = Buffer.concat([buffer.subarray(0, target.start), replacement, buffer.subarray(target.end)])
  for (const parent of target.parents) result.writeUInt32BE(buffer.readUInt32BE(parent) + delta, parent)
  const offsets = locate(result, [...STBL, offsetType])
  if (offsetType === 'co64') {
    const old = Number(result.readBigUInt64BE(offsets.data + 8))
    if (old >= target.end) result.writeBigUInt64BE(BigInt(old + delta), offsets.data + 8)
  } else {
    const old = result.readUInt32BE(offsets.data + 8)
    if (old >= target.end) result.writeUInt32BE(old + delta, offsets.data + 8)
  }
  return result
}

function invalid(buffer: Buffer): void {
  expect(() => validateVideoMp4(buffer)).toThrowError(new Error(ERROR))
}

describe('validateVideoMp4: bounded non-fragmented AVC container admission', () => {
  it('accepts the genuine locally encoded two-frame video, without mutating it', () => {
    const buffer = createTinyVideoMp4()
    expect(buffer.length).toBe(1462)
    const before = Buffer.from(buffer)
    expect(validateVideoMp4(buffer)).toBeUndefined()
    expect(buffer.equals(before)).toBe(true)
  })

  it('rejects the 12-byte ftyp fake and a complete ftyp without movie/media', () => {
    invalid(Buffer.from('0000000c6674797069736f6d', 'hex'))
    invalid(createTinyVideoMp4().subarray(0, 32))
    invalid(Buffer.alloc(0))
    invalid(null as unknown as Buffer)
    invalid(new Uint8Array(32) as unknown as Buffer)
  })

  it('accepts genuine High-profile B-frames with cropping, composition offsets and edits', () => {
    expect(() => validateVideoMp4(createTinyHighVideoMp4())).not.toThrow()
  })

  it('accepts version-1 clocks/track headers and rejects 64-bit duration overflow', () => {
    let buffer = createTinyVideoMp4()
    for (const path of [['moov', 'mvhd'], [...MDIA, 'mdhd']]) {
      const clock = locate(buffer, path)
      const payload = buffer.subarray(clock.data, clock.end)
      buffer = replace(buffer, path, atom(path[path.length - 1], Buffer.concat([
        words(0x01000000), Buffer.alloc(16), payload.subarray(12, 16), words(0), payload.subarray(16),
      ])))
    }
    const tkhd = locate(buffer, [...TRACK, 'tkhd'])
    const payload = buffer.subarray(tkhd.data, tkhd.end)
    buffer = replace(buffer, [...TRACK, 'tkhd'], atom('tkhd', Buffer.concat([
      words(0x01000003), Buffer.alloc(16), payload.subarray(12, 20), words(0), payload.subarray(20),
    ])))
    expect(() => validateVideoMp4(buffer)).not.toThrow()
    buffer.writeBigUInt64BE(0x20000000000000n, locate(buffer, [...MDIA, 'mdhd']).data + 24)
    invalid(buffer)
  })

  it('validates multi-run stsc mapping and sample counts', () => {
    let buffer = createTinyVideoMp4()
    buffer = replace(buffer, [...STBL, 'stsc'], atom('stsc', words(0, 2, 1, 1, 1, 2, 1, 1)))
    const old = locate(buffer, ['mdat']).data
    buffer = replace(buffer, [...STBL, 'stco'], atom('stco', words(0, 2, old, old + 634)))
    // replace() relocates the first entry; this fixture now has a second entry.
    const stco = locate(buffer, [...STBL, 'stco'])
    buffer.writeUInt32BE(locate(buffer, ['mdat']).data + 634, stco.data + 12)
    expect(() => validateVideoMp4(buffer)).not.toThrow()
    const stsc = locate(buffer, [...STBL, 'stsc'])
    buffer.writeUInt32BE(1, stsc.data + 20) // non-increasing first_chunk
    invalid(buffer)
  })

  it('rejects audio-only handlers even with otherwise valid sample tables', () => {
    invalid(createTinyAudioMp4())
    const buffer = createTinyVideoMp4()
    buffer.write('soun', locate(buffer, [...MDIA, 'hdlr']).data + 8)
    invalid(buffer)
  })

  it('rejects every truncated prefix of the genuine fixture', () => {
    const buffer = createTinyVideoMp4()
    for (let length = 1; length < buffer.length; length++) invalid(buffer.subarray(0, length))
  })

  it.each([0, 2, 7, 0xffffffff])('rejects invalid nested box length %i', size => {
    const buffer = createTinyVideoMp4()
    buffer.writeUInt32BE(size, locate(buffer, STBL).start)
    invalid(buffer)
  })

  it('rejects trailing garbage, empty mdat, and top-level length overruns', () => {
    invalid(Buffer.concat([createTinyVideoMp4(), Buffer.from([0])]))
    const buffer = createTinyVideoMp4()
    const mdat = locate(buffer, ['mdat'])
    invalid(Buffer.concat([buffer.subarray(0, mdat.start), atom('mdat')]))
    buffer.writeUInt32BE(buffer.length + 1, 0)
    invalid(buffer)
  })

  it('accepts a final size-zero mdat and a correctly sized extended mdat', () => {
    const zero = createTinyVideoMp4()
    const mdat = locate(zero, ['mdat'])
    zero.writeUInt32BE(0, mdat.start)
    expect(() => validateVideoMp4(zero)).not.toThrow()
    const source = createTinyVideoMp4()
    const header = Buffer.alloc(16)
    header.writeUInt32BE(1)
    header.write('mdat', 4)
    header.writeBigUInt64BE(BigInt(mdat.end - mdat.start + 8), 8)
    const extended = Buffer.concat([source.subarray(0, mdat.start), header, source.subarray(mdat.data)])
    extended.writeUInt32BE(mdat.data + 8, locate(extended, [...STBL, 'stco']).data + 8)
    expect(() => validateVideoMp4(extended)).not.toThrow()
  })

  it('rejects truncated and overflowing extended box sizes', () => {
    invalid(Buffer.concat([words(1), Buffer.from('mdat')]))
    invalid(Buffer.concat([words(1), Buffer.from('mdat'), words(0x200000, 0)]))
    invalid(Buffer.concat([words(1), Buffer.from('mdat'), words(0, 15)]))
  })

  it.each([
    ['movie timescale', ['moov', 'mvhd'], 12, 0],
    ['movie duration', ['moov', 'mvhd'], 16, 0],
    ['movie duration mismatch', ['moov', 'mvhd'], 16, 1001],
    ['media timescale', [...MDIA, 'mdhd'], 12, 0],
    ['media duration', [...MDIA, 'mdhd'], 16, 0],
    ['media duration mismatch', [...MDIA, 'mdhd'], 16, 16385],
    ['track duration', [...TRACK, 'tkhd'], 20, 0],
    ['track width', [...TRACK, 'tkhd'], 76, 0],
    ['track height', [...TRACK, 'tkhd'], 80, 0],
    ['track identity', [...TRACK, 'tkhd'], 12, 0],
    ['zero delta', [...STBL, 'stts'], 12, 0],
    ['time count mismatch', [...STBL, 'stts'], 8, 1],
    ['time count overflow', [...STBL, 'stts'], 8, 0xffffffff],
    ['too many table rows', [...STBL, 'stts'], 4, 0xffffffff],
    ['sample count overflow', [...STBL, 'stsz'], 8, 0xffffffff],
    ['zero sample size', [...STBL, 'stsz'], 12, 0],
    ['oversized sample', [...STBL, 'stsz'], 12, 0xffffffff],
    ['bad first chunk', [...STBL, 'stsc'], 8, 2],
    ['zero chunk samples', [...STBL, 'stsc'], 12, 0],
    ['too many chunk samples', [...STBL, 'stsc'], 12, 3],
    ['bad description reference', [...STBL, 'stsc'], 16, 2],
    ['offset before mdat', [...STBL, 'stco'], 8, 0],
    ['offset into mdat header', [...STBL, 'stco'], 8, 793],
    ['offset past file', [...STBL, 'stco'], 8, 0xffffffff],
    ['sample past mdat end', [...STBL, 'stco'], 8, 802],
  ] as [string, string[], number, number][])('rejects %s', (_label, path, offset, value) => {
    invalid(change(path, offset, value))
  })

  it('rejects sample ranges crossing adjacent mdat boundaries even if bytes remain in file', () => {
    const source = createTinyVideoMp4()
    const mdat = locate(source, ['mdat'])
    const split = Buffer.concat([
      source.subarray(0, mdat.start),
      atom('mdat', source.subarray(mdat.data, mdat.data + 10)),
      atom('mdat', source.subarray(mdat.data + 10)),
    ])
    invalid(split)
  })

  it('accepts co64 offsets and rejects unsafe integers and offsets outside mdat', () => {
    const source = createTinyVideoMp4()
    const old = source.readUInt32BE(locate(source, [...STBL, 'stco']).data + 8)
    const wide = replace(source, [...STBL, 'stco'], atom('co64', words(0, 1, 0, old)), 'co64')
    expect(() => validateVideoMp4(wide)).not.toThrow()
    const at = locate(wide, [...STBL, 'co64']).data + 8
    wide.writeBigUInt64BE(0x20000000000000n, at)
    invalid(wide)
    wide.writeBigUInt64BE(0xffffffffffn, at)
    invalid(wide)
  })

  it('accepts fixed-size stsz when it accurately describes a genuine sample', () => {
    // Keep the second encoded frame, removing the first frame and its SEI.
    let buffer = createTinyVideoMp4()
    const mdat = locate(buffer, ['mdat'])
    const second = buffer.subarray(mdat.end - 27)
    buffer = Buffer.concat([buffer.subarray(0, mdat.start), atom('mdat', second)])
    buffer = replace(buffer, [...STBL, 'stsz'], atom('stsz', words(0, 27, 1)))
    buffer.writeUInt32BE(1, locate(buffer, [...STBL, 'stsc']).data + 12)
    buffer.writeUInt32BE(1, locate(buffer, [...STBL, 'stts']).data + 8)
    buffer.writeUInt32BE(16384, locate(buffer, [...STBL, 'stts']).data + 12)
    expect(() => validateVideoMp4(buffer)).not.toThrow()
  })

  it('rejects repeated singleton boxes and simultaneous stco/co64', () => {
    const source = createTinyVideoMp4()
    const stco = locate(source, [...STBL, 'stco'])
    const original = source.subarray(stco.start, stco.end)
    invalid(replace(source, [...STBL, 'stco'], Buffer.concat([original, original])))
    invalid(replace(source, [...STBL, 'stco'], Buffer.concat([original, atom('co64', words(0, 1, 0, 801))])))
  })

  it('rejects malicious nesting, oversized box lists, and repeated tracks', () => {
    const source = createTinyVideoMp4()
    let nested = atom('free')
    for (let i = 0; i < 1000; i++) nested = atom('moov', nested)
    invalid(Buffer.concat([source.subarray(0, 32), nested]))
    invalid(Buffer.concat([source, ...Array.from({ length: 4097 }, () => atom('free'))]))
    const trak = locate(source, TRACK)
    const copy = source.subarray(trak.start, trak.end)
    invalid(replace(source, TRACK, Buffer.concat([copy, copy])))
    invalid(replace(source, TRACK, Buffer.concat(Array.from({ length: 9 }, () => copy))))
  })

  it('explicitly rejects fragmented movie structures', () => {
    invalid(Buffer.concat([createTinyVideoMp4(), atom('moof')]))
    const source = createTinyVideoMp4()
    const moov = locate(source, ['moov'])
    invalid(replace(source, ['moov'], atom('moov', Buffer.concat([source.subarray(moov.data, moov.end), atom('mvex')]))))
  })

  it('rejects missing AVC configuration, unsupported codecs and external data references', () => {
    const source = createTinyVideoMp4()
    source.write('hvc1', locate(source, [...STBL, 'stsd', 'avc1']).start + 4)
    invalid(source)
    const config = createTinyVideoMp4()
    config.write('free', locate(config, AVC).start + 4)
    invalid(config)
    const external = createTinyVideoMp4()
    external.writeUInt32BE(0, locate(external, [...MDIA, 'minf', 'dinf', 'dref', 'url ']).data)
    invalid(external)
  })

  it.each([
    [0, 0], // configurationVersion
    [1, 255], // unsupported profile
    [4, 254], // reserved three-byte NAL prefix
    [5, 224], // missing SPS
    [6, 255], // overflowing SPS length
    [8, 104], // PPS presented as SPS
    [29, 0], // missing PPS
  ])('rejects corrupt avcC byte %i', (offset, value) => {
    const buffer = createTinyVideoMp4()
    buffer[locate(buffer, AVC).data + offset] = value
    invalid(buffer)
  })

  it('rejects malformed NAL framing and samples with no coded picture', () => {
    const oversized = createTinyVideoMp4()
    oversized.writeUInt32BE(0xffffffff, locate(oversized, ['mdat']).data)
    invalid(oversized)
    const empty = createTinyVideoMp4()
    empty.writeUInt32BE(0, locate(empty, ['mdat']).data)
    invalid(empty)
    const nonvideo = createTinyVideoMp4()
    nonvideo[nonvideo.length - 23] = 6 // last frame's IDR -> SEI
    invalid(nonvideo)
    const forbidden = createTinyVideoMp4()
    forbidden[forbidden.length - 23] |= 0x80
    invalid(forbidden)
    const nonsense = createTinyVideoMp4()
    nonsense.fill(0, nonsense.length - 22) // preserve IDR header but destroy slice header
    invalid(nonsense)
  })

  it('rejects declared dimensions that contradict the AVC sequence parameter set', () => {
    const buffer = createTinyVideoMp4()
    buffer.writeUInt32BE(32 * 65536, locate(buffer, [...TRACK, 'tkhd']).end - 8)
    buffer.writeUInt16BE(32, locate(buffer, [...STBL, 'stsd', 'avc1']).data + 24)
    invalid(buffer)
  })

  it('accepts consistent ctts/stss and rejects inconsistent counts, sync markers and edit durations', () => {
    const source = createTinyVideoMp4()
    const stbl = locate(source, STBL)
    const payload = source.subarray(stbl.data, stbl.end)
    const valid = replace(source, STBL, atom('stbl', Buffer.concat([
      payload, atom('ctts', words(0, 1, 2, 0)), atom('stss', words(0, 2, 1, 2)),
    ])))
    expect(() => validateVideoMp4(valid)).not.toThrow()
    const count = Buffer.from(valid)
    count.writeUInt32BE(3, locate(count, [...STBL, 'ctts']).data + 8)
    invalid(count)
    const sync = Buffer.from(valid)
    sync.writeUInt32BE(1, locate(sync, [...STBL, 'stss']).data + 12)
    invalid(sync)
    invalid(change([...TRACK, 'edts', 'elst'], 8, 1001))
    invalid(change([...TRACK, 'edts', 'elst'], 12, 16384))
    invalid(change([...TRACK, 'edts', 'elst'], 16, 0x00020000))
  })

  it('rejects overlapping chunk ranges, even when each range is inside mdat', () => {
    let buffer = createTinyVideoMp4()
    const offset = locate(buffer, ['mdat']).data
    buffer = replace(buffer, [...STBL, 'stsc'], atom('stsc', words(0, 1, 1, 1, 1)))
    buffer = replace(buffer, [...STBL, 'stco'], atom('stco', words(0, 2, offset, offset)))
    // Make both ranges point at the independently valid second IDR frame.
    const end = locate(buffer, ['mdat']).end
    const offsets = locate(buffer, [...STBL, 'stco']).data
    buffer.writeUInt32BE(end - 27, offsets + 8)
    buffer.writeUInt32BE(end - 27, offsets + 12)
    const sizes = locate(buffer, [...STBL, 'stsz']).data
    buffer.writeUInt32BE(27, sizes + 12)
    invalid(buffer)
  })

  it('enforces the 50 MiB input budget before inspecting content', () => {
    invalid(Buffer.alloc(50 * 1024 * 1024 + 1))
  })

  it('returns only the generic error for deterministic arbitrary inputs and mutations', () => {
    let state = 0x12345678
    const random = (): number => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      return state >>> 0
    }
    for (let i = 0; i < 500; i++) {
      const buffer = i % 2 ? createTinyVideoMp4() : Buffer.alloc(random() % 2048)
      for (let j = 0; j < 8 && buffer.length; j++) buffer[random() % buffer.length] = random() & 255
      try { validateVideoMp4(buffer) } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(ERROR)
      }
    }
  })
})
