/**
 * A deliberately narrow, fail-closed ISO-BMFF admission check, NOT a decoder.
 * Supported: self-contained, non-fragmented MP4 with 1..8 AVC (avc1) video
 * tracks (progressive 8-bit 4:2:0), one description per track, length-prefixed
 * NALs, ordinary sample tables, optional composition offsets and rate-1 edits. Audio, encrypted
 * tracks, avc3, other codecs, fragments (moof/mvex), external data references,
 * in-band parameter-set changes, FMO, and unknown structural extensions are
 * explicitly unsupported and rejected. Sync samples must be IDR pictures.
 *
 * Container integrity and plausible AVC framing do not prove that the codec
 * bitstream decodes, or establish visual quality/content. No codec is executed.
 * Work is bounded by input bytes, boxes, table entries, samples and NAL units;
 * nesting follows the finite grammar below (including bounded metadata depth).
 */
const MAX_BYTES = 50 * 1024 * 1024
const MAX_BOXES = 4096
const MAX_TRACKS = 8
const MAX_TABLE_ENTRIES = 400_000
const MAX_SAMPLES = 200_000
const MAX_NALS = 400_000
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024
const MAX_SECONDS = 24 * 60 * 60
const MAX_DIMENSION = 16384
const INVALID = 'Invalid MP4 video'

interface Box { type: string; start: number; data: number; end: number }
interface Clock { scale: number; duration: number }
interface Span { start: number; end: number }
interface Sps { macroblocks: number; frameBits: number }
interface Avc { nalWidth: number; pictures: Map<number, Sps> }

function requireValid(value: unknown): asserts value {
  if (!value) throw new Error(INVALID)
}

/** Lazy RBSP prefix reader: never copies/scans an entire compressed sample. */
class Bits {
  private remaining = 0
  private byte = 0
  private zeros = 0
  private readCount = 0

  constructor(private readonly buffer: Buffer, private cursor: number, private readonly end: number) {}

  read(count = 1): number {
    this.readCount += count
    requireValid(this.readCount <= 32768)
    let result = 0
    for (let i = 0; i < count; i++) {
      if (this.remaining === 0) {
        requireValid(this.cursor < this.end)
        let byte = this.buffer[this.cursor++]
        if (this.zeros >= 2 && byte === 3) {
          requireValid(this.cursor < this.end && this.buffer[this.cursor] <= 3)
          byte = this.buffer[this.cursor++]
          this.zeros = 0
        }
        this.zeros = byte === 0 ? this.zeros + 1 : 0
        this.byte = byte
        this.remaining = 8
      }
      result = result * 2 + ((this.byte >>> --this.remaining) & 1)
    }
    return result
  }

  ue(max: number): number {
    let zeros = 0
    while (this.read() === 0) requireValid(++zeros <= 30)
    const value = 2 ** zeros - 1 + this.read(zeros)
    requireValid(value <= max)
    return value
  }

  se(max: number): number {
    const value = this.ue(max * 2)
    return value % 2 ? (value + 1) / 2 : -value / 2
  }
}

class Validator {
  private boxCount = 0
  private tableEntries = 0
  private sampleCount = 0
  private nalCount = 0
  private readonly occupied: Span[] = []
  private readonly trackIds = new Set<number>()

  constructor(private readonly bytes: Buffer) {}

  private u32(at: number): number { return this.bytes.readUInt32BE(at) }

  private u64(at: number): number {
    const high = this.u32(at)
    requireValid(high <= 0x1fffff)
    return high * 0x100000000 + this.u32(at + 4)
  }

  private boxes(start: number, end: number): Box[] {
    const result: Box[] = []
    while (start < end) {
      requireValid(++this.boxCount <= MAX_BOXES && end - start >= 8)
      let size = this.u32(start)
      const type = this.bytes.toString('latin1', start + 4, start + 8)
      let header = 8
      if (size === 1) {
        requireValid(end - start >= 16)
        size = this.u64(start + 8)
        header = 16
      } else if (size === 0) {
        // Only a final top-level mdat may extend to EOF.
        requireValid(type === 'mdat' && end === this.bytes.length && start >= 0)
        size = end - start
      }
      requireValid(size >= header && size <= end - start)
      result.push({ type, start, data: start + header, end: start + size })
      start += size
    }
    requireValid(start === end)
    return result
  }

  private children(box: Box, allowed: string[], repeat: string[] = []): Box[] {
    const children = this.boxes(box.data, box.end)
    this.allowed(children, allowed, repeat)
    return children
  }

  private allowed(boxes: Box[], allowed: string[], repeat: string[] = []): void {
    const seen = new Set<string>()
    for (const box of boxes) {
      // In particular moof/mfra/mvex and recursively misplaced containers fail.
      requireValid(allowed.includes(box.type))
      requireValid(!seen.has(box.type) || repeat.includes(box.type))
      seen.add(box.type)
    }
  }

  private one(boxes: Box[], type: string): Box {
    const box = boxes.find(candidate => candidate.type === type)
    requireValid(box)
    return box
  }

  private length(box: Box, length: number): void {
    requireValid(box.end - box.data === length)
  }

  private full(box: Box, versions = [0], flags = 0): number {
    requireValid(box.end - box.data >= 4)
    const version = this.bytes[box.data]
    requireValid(versions.includes(version) && this.bytes.readUIntBE(box.data + 1, 3) === flags)
    return version
  }

  private table(box: Box, stride: number, versions = [0]): number {
    this.full(box, versions)
    requireValid(box.end - box.data >= 8)
    const count = this.u32(box.data + 4)
    this.budget(count)
    this.length(box, 8 + count * stride)
    return count
  }

  private budget(count: number): void {
    this.tableEntries += count
    requireValid(this.tableEntries <= MAX_TABLE_ENTRIES)
  }

  private clock(box: Box, movie: boolean): Clock {
    const version = this.full(box, [0, 1])
    this.length(box, (movie ? 100 : 24) + (version === 1 ? 12 : 0))
    const scale = this.u32(box.data + (version === 1 ? 20 : 12))
    const duration = version === 1 ? this.u64(box.data + 24) : this.u32(box.data + 16)
    requireValid(scale > 0 && scale <= 1_000_000_000)
    requireValid(duration > 0 && duration <= scale * MAX_SECONDS)
    return { scale, duration }
  }

  private metadata(box: Box): void {
    const udta = this.children(box, ['meta'])
    const meta = this.one(udta, 'meta')
    this.full(meta)
    const children = this.boxes(meta.data + 4, meta.end)
    this.allowed(children, ['hdlr', 'ilst'])
    this.handler(this.one(children, 'hdlr'), 'mdir')
    const ilst = this.one(children, 'ilst')
    const items = this.boxes(ilst.data, ilst.end)
    this.allowed(items, ['©too', '©nam', '©ART', '©alb', '©day', '©cmt', '©gen', 'desc', 'ldes', 'cprt'])
    for (const item of items) {
      const data = this.one(this.children(item, ['data']), 'data')
      requireValid(data.end - data.data >= 8)
      // Metadata payload is opaque text/data, never interpreted as nested boxes.
    }
  }

  private handler(box: Box, type: string): void {
    this.full(box)
    requireValid(box.end - box.data >= 24)
    requireValid(this.bytes.toString('latin1', box.data + 8, box.data + 12) === type)
  }

  private dataReferences(box: Box): void {
    const dref = this.one(this.children(box, ['dref']), 'dref')
    this.full(dref)
    requireValid(dref.end - dref.data >= 8 && this.u32(dref.data + 4) === 1)
    const refs = this.boxes(dref.data + 8, dref.end)
    requireValid(refs.length === 1 && refs[0].type === 'url ')
    this.full(refs[0], [0], 1) // self-contained; never follow a URL
    this.length(refs[0], 4)
  }

  private sequence(start: number, end: number, width: number, height: number): { id: number; sps: Sps } {
    const bits = new Bits(this.bytes, start + 1, end)
    const profile = bits.read(8)
    requireValid((bits.read(8) & 3) === 0) // reserved constraint bits
    bits.read(8) // level, already checked against avcC
    const id = bits.ue(31)
    if ([100, 110, 122, 244].includes(profile)) {
      requireValid(bits.ue(3) === 1) // supported chroma_format_idc: 4:2:0
      requireValid(bits.ue(6) === 0 && bits.ue(6) === 0) // 8-bit luma/chroma
      requireValid(bits.read() === 0) // no transform bypass
      if (bits.read()) {
        for (let i = 0; i < 8; i++) {
          if (bits.read()) {
            let last = 8
            let next = 8
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) next = (last + bits.se(128) + 256) % 256
              if (next !== 0) last = next
            }
          }
        }
      }
    }
    const frameBits = bits.ue(12) + 4
    const order = bits.ue(2)
    if (order === 0) bits.ue(12)
    else if (order === 1) {
      bits.read()
      bits.se(0x3fffffff)
      bits.se(0x3fffffff)
      const cycle = bits.ue(255)
      for (let i = 0; i < cycle; i++) bits.se(0x3fffffff)
    }
    bits.ue(16) // max_num_ref_frames
    bits.read()
    const mbWidth = bits.ue(MAX_DIMENSION / 16 - 1) + 1
    const mbHeight = bits.ue(MAX_DIMENSION / 16 - 1) + 1
    requireValid(bits.read() === 1) // progressive frame_mbs_only_flag
    bits.read()
    let horizontalCrop = 0
    let verticalCrop = 0
    if (bits.read()) {
      horizontalCrop = (bits.ue(MAX_DIMENSION) + bits.ue(MAX_DIMENSION)) * 2
      verticalCrop = (bits.ue(MAX_DIMENSION) + bits.ue(MAX_DIMENSION)) * 2
    }
    requireValid(mbWidth * 16 - horizontalCrop === width && mbHeight * 16 - verticalCrop === height)
    bits.read() // vui_parameters_present_flag; VUI and entropy data are not decoded
    return { id, sps: { macroblocks: mbWidth * mbHeight, frameBits } }
  }

  private picture(start: number, end: number, sequences: Map<number, Sps>): { id: number; sps: Sps } {
    const bits = new Bits(this.bytes, start + 1, end)
    const id = bits.ue(255)
    const sps = sequences.get(bits.ue(31))
    requireValid(sps)
    bits.read(2)
    requireValid(bits.ue(7) === 0) // no flexible macroblock ordering/slice groups
    bits.ue(31)
    bits.ue(31)
    bits.read()
    requireValid(bits.read(2) <= 2)
    requireValid(bits.se(26) <= 25)
    requireValid(bits.se(26) <= 25)
    bits.se(12)
    bits.read(3)
    return { id, sps }
  }

  private avcConfig(box: Box, width: number, height: number): Avc {
    const p = box.data
    requireValid(box.end - p >= 7 && this.bytes[p] === 1)
    const profile = this.bytes[p + 1]
    requireValid([66, 77, 88, 100, 110, 122, 244].includes(profile))
    requireValid(this.bytes[p + 3] > 0 && (this.bytes[p + 4] & 0xfc) === 0xfc)
    const nalWidth = (this.bytes[p + 4] & 3) + 1
    requireValid(nalWidth !== 3 && (this.bytes[p + 5] & 0xe0) === 0xe0)
    const sequences = new Map<number, Sps>()
    const pictures = new Map<number, Sps>()
    let cursor = p + 6
    const parameterSets = (count: number, type: number, minimum: number): void => {
      requireValid(count > 0)
      for (let i = 0; i < count; i++) {
        requireValid(++this.nalCount <= MAX_NALS && box.end - cursor >= 2)
        const length = this.bytes.readUInt16BE(cursor)
        cursor += 2
        requireValid(length >= minimum && length <= box.end - cursor)
        requireValid((this.bytes[cursor] & 0x9f) === type)
        requireValid((this.bytes[cursor] & 0x60) !== 0)
        if (type === 7) {
          requireValid(this.bytes[cursor + 1] === profile && this.bytes[cursor + 2] === this.bytes[p + 2])
          requireValid(this.bytes[cursor + 3] === this.bytes[p + 3])
          const sequence = this.sequence(cursor, cursor + length, width, height)
          requireValid(!sequences.has(sequence.id))
          sequences.set(sequence.id, sequence.sps)
        } else if (type === 8) {
          const picture = this.picture(cursor, cursor + length, sequences)
          requireValid(!pictures.has(picture.id))
          pictures.set(picture.id, picture.sps)
        }
        cursor += length
      }
    }
    parameterSets(this.bytes[p + 5] & 31, 7, 5)
    requireValid(cursor < box.end)
    parameterSets(this.bytes[cursor++], 8, 2)
    if (cursor < box.end) {
      requireValid([100, 110, 122, 244].includes(profile) && box.end - cursor >= 4)
      requireValid(this.bytes[cursor] === 0xfd) // chroma agrees with supported SPS
      requireValid(this.bytes[cursor + 1] === 0xf8 && this.bytes[cursor + 2] === 0xf8)
      const count = this.bytes[cursor + 3]
      cursor += 4
      requireValid(count === 0) // sequence parameter set extensions unsupported
    }
    requireValid(cursor === box.end)
    return { nalWidth, pictures }
  }

  private description(box: Box, width: number, height: number): Avc {
    this.full(box)
    requireValid(box.end - box.data >= 8 && this.u32(box.data + 4) === 1)
    const entries = this.boxes(box.data + 8, box.end)
    requireValid(entries.length === 1 && entries[0].type === 'avc1')
    const entry = entries[0]
    requireValid(entry.end - entry.data >= 78)
    const p = entry.data
    requireValid(this.bytes.subarray(p, p + 6).every(value => value === 0))
    requireValid(this.bytes.readUInt16BE(p + 6) === 1)
    requireValid(this.bytes.readUInt16BE(p + 24) === width && this.bytes.readUInt16BE(p + 26) === height)
    requireValid(this.bytes.readUInt16BE(p + 40) === 1 && this.bytes.readUInt16BE(p + 74) === 24)
    const children = this.boxes(p + 78, entry.end)
    this.allowed(children, ['avcC', 'pasp', 'btrt', 'colr'])
    for (const child of children) {
      if (child.type === 'pasp') {
        this.length(child, 8)
        requireValid(this.u32(child.data) > 0 && this.u32(child.data + 4) > 0)
      } else if (child.type === 'btrt') {
        this.length(child, 12)
      } else if (child.type === 'colr') {
        requireValid(child.end - child.data >= 4)
        const kind = this.bytes.toString('latin1', child.data, child.data + 4)
        requireValid(kind === 'nclx' || kind === 'nclc')
        this.length(child, kind === 'nclx' ? 11 : 10)
      }
    }
    return this.avcConfig(this.one(children, 'avcC'), width, height)
  }

  private sizes(box: Box): number[] {
    this.full(box)
    requireValid(box.end - box.data >= 12)
    const fixed = this.u32(box.data + 4)
    const count = this.u32(box.data + 8)
    this.sampleCount += count
    requireValid(count > 0 && this.sampleCount <= MAX_SAMPLES)
    this.budget(count)
    this.length(box, 12 + (fixed ? 0 : count * 4))
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const size = fixed || this.u32(box.data + 12 + i * 4)
      requireValid(size > 0 && size <= MAX_SAMPLE_BYTES)
      sizes.push(size)
    }
    return sizes
  }

  private timing(stts: Box, ctts: Box | undefined, count: number, clock: Clock): Span {
    const entries = this.table(stts, 8)
    requireValid(entries > 0)
    let samples = 0
    let time = 0
    const deltas: number[] = []
    for (let i = 0; i < entries; i++) {
      const p = stts.data + 8 + i * 8
      const run = this.u32(p)
      const delta = this.u32(p + 4)
      requireValid(run > 0 && run <= count - samples && delta > 0 && delta <= clock.scale * 60)
      time += run * delta
      requireValid(Number.isSafeInteger(time) && time <= clock.duration)
      for (let j = 0; j < run; j++) deltas.push(delta)
      samples += run
    }
    requireValid(samples === count && time === clock.duration)
    if (!ctts) return { start: 0, end: time }
    const compositionEntries = this.table(ctts, 8, [0, 1])
    requireValid(compositionEntries > 0)
    let sample = 0
    let dts = 0
    let first = Infinity
    let last = -Infinity
    for (let i = 0; i < compositionEntries; i++) {
      const p = ctts.data + 8 + i * 8
      const run = this.u32(p)
      const offset = this.bytes[ctts.data] === 1 ? this.bytes.readInt32BE(p + 4) : this.u32(p + 4)
      requireValid(run > 0 && run <= count - sample && Math.abs(offset) <= clock.duration)
      for (let j = 0; j < run; j++) {
        const pts = dts + offset
        first = Math.min(first, pts)
        last = Math.max(last, pts + deltas[sample])
        dts += deltas[sample++]
      }
    }
    requireValid(sample === count && last > first)
    return { start: first, end: last }
  }

  private edits(edts: Box | undefined, duration: number, movie: Clock, media: Clock, presentation: Span): void {
    const tolerance = Math.max(1, media.scale / movie.scale)
    if (!edts) {
      requireValid(Math.abs(duration - media.duration / media.scale * movie.scale) <= 1)
      requireValid(presentation.start >= 0 && presentation.end <= media.duration + tolerance)
      return
    }
    const elst = this.one(this.children(edts, ['elst']), 'elst')
    const version = this.full(elst, [0, 1])
    const count = this.table(elst, version ? 20 : 12, [0, 1])
    requireValid(count > 0 && count <= 8)
    let total = 0
    let nonempty = 0
    for (let i = 0; i < count; i++) {
      const p = elst.data + 8 + i * (version ? 20 : 12)
      const segment = version ? this.u64(p) : this.u32(p)
      const at = p + (version ? 8 : 4)
      const empty = this.u32(at) === 0xffffffff && (!version || this.u32(at + 4) === 0xffffffff)
      const start = empty ? -1 : version ? this.u64(at) : this.bytes.readInt32BE(at)
      const rate = at + (version ? 8 : 4)
      requireValid(this.bytes.readInt16BE(rate) === 1 && this.bytes.readInt16BE(rate + 2) === 0)
      requireValid(segment > 0 && segment <= duration - total)
      total += segment
      if (empty) requireValid(i === 0 && count > 1)
      else {
        nonempty++
        requireValid(start >= 0 && start >= presentation.start - tolerance)
        requireValid(start + segment / movie.scale * media.scale <= presentation.end + tolerance)
      }
    }
    requireValid(nonempty > 0 && total === duration)
  }

  private syncSamples(stss: Box | undefined, count: number): Set<number> | undefined {
    if (!stss) return undefined // absence means every sample is a random access point
    const entries = this.table(stss, 4)
    requireValid(entries > 0 && entries <= count)
    const sync = new Set<number>()
    let previous = 0
    for (let i = 0; i < entries; i++) {
      const sample = this.u32(stss.data + 8 + i * 4)
      requireValid(sample > previous && sample <= count)
      sync.add(sample)
      previous = sample
    }
    requireValid(sync.has(1))
    return sync
  }

  private sample(start: number, end: number, avc: Avc, sync: boolean): void {
    let vcl = false
    let idr = false
    let pictureId = -1
    let frame = -1
    let previousMb = -1
    const { nalWidth } = avc
    while (start < end) {
      requireValid(++this.nalCount <= MAX_NALS && end - start >= nalWidth)
      const length = this.bytes.readUIntBE(start, nalWidth)
      start += nalWidth
      requireValid(length >= 2 && length <= end - start)
      const header = this.bytes[start]
      const type = header & 31
      requireValid((header & 0x80) === 0 && [1, 5, 6, 9, 12].includes(type))
      if (type === 1 || type === 5) {
        requireValid(length >= 3)
        const bits = new Bits(this.bytes, start + 1, start + length)
        const firstMb = bits.ue(MAX_DIMENSION * MAX_DIMENSION / 256 - 1)
        const sliceType = bits.ue(9) % 5
        const pps = bits.ue(255)
        const sps = avc.pictures.get(pps)
        requireValid(sps && firstMb < sps.macroblocks)
        const frameNum = bits.read(sps.frameBits)
        if (type === 5) {
          requireValid((header & 0x60) !== 0 && (sliceType === 2 || sliceType === 4))
          bits.ue(65535) // idr_pic_id
        }
        requireValid(vcl ? firstMb > previousMb && pps === pictureId && frameNum === frame && idr === (type === 5) : firstMb === 0)
        previousMb = firstMb
        pictureId = pps
        frame = frameNum
        vcl = true
        idr ||= type === 5
      }
      start += length
    }
    requireValid(start === end && vcl && sync === idr)
  }

  private chunks(stsc: Box, offsets: Box, sizes: number[], mdats: Span[], avc: Avc, sync?: Set<number>): void {
    const entries = this.table(stsc, 12)
    const wide = offsets.type === 'co64'
    const chunks = this.table(offsets, wide ? 8 : 4)
    requireValid(entries > 0 && entries <= chunks && chunks > 0 && chunks <= sizes.length)
    const runs: { first: number; samples: number }[] = []
    for (let i = 0; i < entries; i++) {
      const p = stsc.data + 8 + i * 12
      const first = this.u32(p)
      const samples = this.u32(p + 4)
      requireValid(first <= chunks && (i === 0 ? first === 1 : first > runs[i - 1].first))
      requireValid(samples > 0 && samples <= sizes.length && this.u32(p + 8) === 1)
      runs.push({ first, samples })
    }
    let run = 0
    let sample = 0
    for (let i = 1; i <= chunks; i++) {
      if (run + 1 < runs.length && i === runs[run + 1].first) run++
      const p = offsets.data + 8 + (i - 1) * (wide ? 8 : 4)
      const start = wide ? this.u64(p) : this.u32(p)
      const count = runs[run].samples
      requireValid(count <= sizes.length - sample)
      let end = start
      for (let j = 0; j < count; j++) end += sizes[sample + j]
      requireValid(Number.isSafeInteger(end) && end <= this.bytes.length)
      requireValid(mdats.some(mdat => start >= mdat.start && end <= mdat.end))
      this.occupied.push({ start, end })
      let cursor = start
      for (let j = 0; j < count; j++) {
        const next = cursor + sizes[sample]
        this.sample(cursor, next, avc, sync ? sync.has(sample + 1) : true)
        cursor = next
        sample++
      }
    }
    requireValid(sample === sizes.length)
  }

  private track(box: Box, movie: Clock, mdats: Span[]): number {
    const children = this.children(box, ['tkhd', 'edts', 'mdia'])
    const tkhd = this.one(children, 'tkhd')
    requireValid(tkhd.end - tkhd.data >= 4)
    const flags = this.bytes.readUIntBE(tkhd.data + 1, 3)
    requireValid((flags & 1) === 1 && flags <= 7)
    const version = this.full(tkhd, [0, 1], flags)
    this.length(tkhd, version ? 96 : 84)
    const id = this.u32(tkhd.data + (version ? 20 : 12))
    requireValid(id > 0 && !this.trackIds.has(id))
    this.trackIds.add(id)
    const duration = version ? this.u64(tkhd.data + 28) : this.u32(tkhd.data + 20)
    requireValid(duration > 0 && duration <= movie.duration)
    const width = this.u32(tkhd.end - 8) / 65536
    const height = this.u32(tkhd.end - 4) / 65536
    requireValid(Number.isInteger(width) && width > 0 && width <= MAX_DIMENSION)
    requireValid(Number.isInteger(height) && height > 0 && height <= MAX_DIMENSION)
    const mdia = this.children(this.one(children, 'mdia'), ['mdhd', 'hdlr', 'minf'])
    this.handler(this.one(mdia, 'hdlr'), 'vide')
    const media = this.clock(this.one(mdia, 'mdhd'), false)
    const minf = this.children(this.one(mdia, 'minf'), ['vmhd', 'dinf', 'stbl'])
    const vmhd = this.one(minf, 'vmhd')
    this.full(vmhd, [0], 1)
    this.length(vmhd, 12)
    this.dataReferences(this.one(minf, 'dinf'))
    const stbl = this.children(this.one(minf, 'stbl'), ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'ctts', 'stss'])
    requireValid(stbl.filter(child => child.type === 'stco' || child.type === 'co64').length === 1)
    const avc = this.description(this.one(stbl, 'stsd'), width, height)
    const sizes = this.sizes(this.one(stbl, 'stsz'))
    const presentation = this.timing(this.one(stbl, 'stts'), stbl.find(child => child.type === 'ctts'), sizes.length, media)
    this.edits(children.find(child => child.type === 'edts'), duration, movie, media, presentation)
    const sync = this.syncSamples(stbl.find(child => child.type === 'stss'), sizes.length)
    this.chunks(this.one(stbl, 'stsc'), stbl.find(child => child.type === 'stco' || child.type === 'co64')!, sizes, mdats, avc, sync)
    return duration
  }

  validate(): void {
    const top = this.boxes(0, this.bytes.length)
    this.allowed(top, ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'], ['mdat', 'free', 'skip', 'wide'])
    const ftyp = this.one(top, 'ftyp')
    requireValid(top[0] === ftyp && ftyp.end - ftyp.data >= 8 && (ftyp.end - ftyp.data) % 4 === 0)
    requireValid(ftyp.end - ftyp.data <= 256)
    const brands: string[] = []
    for (let p = ftyp.data; p < ftyp.end; p += 4) {
      if (p !== ftyp.data + 4) brands.push(this.bytes.toString('latin1', p, p + 4))
    }
    requireValid(brands.some(brand => ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand)))
    const mdats = top.filter(box => box.type === 'mdat').map(box => ({ start: box.data, end: box.end }))
    requireValid(mdats.length > 0 && mdats.length <= 32 && mdats.every(span => span.end > span.start))
    const moov = this.children(this.one(top, 'moov'), ['mvhd', 'trak', 'udta'], ['trak'])
    const movie = this.clock(this.one(moov, 'mvhd'), true)
    const tracks = moov.filter(box => box.type === 'trak')
    requireValid(tracks.length > 0 && tracks.length <= MAX_TRACKS)
    const metadata = moov.find(box => box.type === 'udta')
    if (metadata) this.metadata(metadata)
    let longest = 0
    for (const track of tracks) longest = Math.max(longest, this.track(track, movie, mdats))
    requireValid(longest === movie.duration)
    this.occupied.sort((a, b) => a.start - b.start)
    for (let i = 1; i < this.occupied.length; i++) {
      requireValid(this.occupied[i].start >= this.occupied[i - 1].end)
    }
  }
}

/** Returns normally on the supported profile; otherwise throws Error('Invalid MP4 video'). */
export function validateVideoMp4(buffer: Buffer): void {
  requireValid(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= MAX_BYTES)
  new Validator(buffer).validate()
}
