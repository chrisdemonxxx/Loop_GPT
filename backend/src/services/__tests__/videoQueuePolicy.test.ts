import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccountedVideoJob, createDailyVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, videoWorkerOptions } from '../videoJobWorker'
import { videoQueuePolicySchema, videoQueueLimitProjection, VideoQueueLimitError } from '../videoQueuePolicy'

const policy = { id: 1, version: 1, revision: 1, globalOutstanding: 64, userOutstanding: 8, globalActive: 8, userActive: 2 }
afterEach(() => vi.unstubAllEnvs())
describe('video queue policy fail-closed contracts', () => {
  it.each([undefined, null, {}, { ...policy, version: 2 }, { ...policy, revision: 0 },
    { ...policy, userActive: 9 }, { ...policy, globalActive: 65 }, { ...policy, userOutstanding: 65 },
    { ...policy, userActive: 1.5 }, { ...policy, globalActive: '8' }, { ...policy, userOutstanding: 0 },
    { ...policy, globalOutstanding: 10001 }, { ...policy, extra: 1 }])('rejects malformed policy %#', value => {
    expect(videoQueuePolicySchema.safeParse(value).success).toBe(false)
  })
  it('accepts low DB fixture limits without environment configuration', () => {
    expect(videoQueuePolicySchema.parse({ ...policy, globalOutstanding: 1, userOutstanding: 1, globalActive: 1, userActive: 1 })).toBeTruthy()
  })
  it.each(['video_user_limit', 'video_global_limit', 'video_queue_config'] as const)('projects %s without capacity data', code => {
    expect(videoQueueLimitProjection(new VideoQueueLimitError(code))).toEqual({
      code, status: code === 'video_user_limit' ? 429 : 503,
      message: code === 'video_user_limit' ? 'Your video queue limit has been reached.' : 'Video queue temporarily unavailable.',
    })
    expect(videoQueueLimitProjection(new Error('secret driver message'))).toBeNull()
  })
  it('rejects batch sizes over 100 and invalid local concurrency', () => {
    expect(() => videoWorkerOptions({ batchSize: 101 })).toThrow()
    expect(() => videoWorkerOptions({ concurrency: 0 })).toThrow()
  })
  it('requires the DB for both admission pools and claiming', async () => {
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'true')
    vi.stubEnv('HF_TOKEN', 'hf_queue_fixture'); vi.stubEnv('HF_VIDEO_ENDPOINT', 'https://video.provider.example.com/generate')
    await expect(createAccountedVideoJob({ userId: 'fixture', apiKeyId: 'fixture' }, { prompt: 'Fixture' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(createDailyVideoJob('fixture', { prompt: 'Fixture' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(claimVideoJobs()).rejects.toMatchObject({ code: 'unavailable' })
  })
})
