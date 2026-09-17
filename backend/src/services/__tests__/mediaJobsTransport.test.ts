import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoJob, processVideoJob, resumeMediaJobs } from '../mediaJobs'
import { videoConfiguration, videoInputSchema } from '../accountedVideoJobs'
import { videoWorkerOptions } from '../videoJobWorker'

afterEach(() => vi.unstubAllEnvs())
describe('durable video configuration and retired unaccounted dispatch', () => {
  it('never starts the legacy worker or creates unaccounted work', async () => {
    await expect(processVideoJob('historical')).resolves.toBeUndefined()
    await expect(resumeMediaJobs()).resolves.toBeUndefined()
    await expect(createVideoJob('owner', { prompt: 'test', width: 960, height: 544, fps: 24, numFrames: 96 })).rejects.toThrow('unavailable')
  })
  it('fails closed without explicit operator opt-in', () => {
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', '')
    expect(() => videoConfiguration()).toThrow('unavailable')
  })
  it.each(['http://127.0.0.1/generate', 'https://user:pass@example.test/generate',
    'https://example.test/generate?token=secret', 'https://example.test/#fragment'])('rejects unsafe endpoint %s', endpoint => {
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('HF_TOKEN', 'fixture-token')
    vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint)
    expect(() => videoConfiguration()).toThrow('unavailable')
  })
  it('bounds parameters, model, provider configuration and worker options', () => {
    expect(videoInputSchema.parse({ prompt: ' test ' })).toMatchObject({ prompt: 'test', model: 'loop-video', width: 960, height: 544, fps: 24, numFrames: 96 })
    for (const body of [{ model: 'arbitrary' }, { numFrames: 121 }, { fps: 31 }, { width: 257 }, { endpoint: 'https://attacker.test' }, { cost: 0 }]) {
      expect(videoInputSchema.safeParse({ prompt: 'fixture', ...body }).success).toBe(false)
    }
    for (const options of [{ concurrency: 17 }, { batchSize: 101 }, { leaseMs: 999 }, { pollMs: NaN }]) expect(() => videoWorkerOptions(options)).toThrow()
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('HF_TOKEN', 'fixture-token')
    vi.stubEnv('HF_VIDEO_ENDPOINT', 'https://video.example.com/generate'); vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '1800001')
    expect(() => videoConfiguration()).toThrow('unavailable')
  })
  it('ships standalone help and rejects bad flags without database/provider access', () => {
    const script = path.resolve('scripts/video-job-worker.mjs')
    expect(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } })).toContain('NOT idempotent')
    expect(() => execFileSync(process.execPath, [script, '--concurrency', '99'], { stdio: 'pipe' })).toThrow()
  })
})
