import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { hasDb, prisma } from '../services/prisma'
import { createDailyVideoJob, cancelAccountedVideoJob, VideoJobError } from '../services/accountedVideoJobs'
import { DailyCreditError } from '../services/dailyReservations'
import { videoQueueLimitProjection } from '../services/videoQueuePolicy'

const router = express.Router()

function serialize(job: {
  id: string
  kind: string
  prompt: string
  status: string
  progress: number
  outputUrl: string | null
  error: string | null
  metadata: unknown
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}) {
  const metadata = (job.metadata && typeof job.metadata === 'object' ? job.metadata : {}) as Record<string, unknown>
  return {
    id: job.id,
    kind: job.kind,
    prompt: job.prompt,
    status: job.status,
    progress: job.progress,
    outputUrl: job.outputUrl,
    error: job.error,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    numFrames: metadata.numFrames,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  }
}

router.post('/video-jobs', authenticateToken, asyncHandler(async (req, res) => {
  try {
    const job = await createDailyVideoJob((req as any).userId, req.body)
    return res.status(202).json(serialize(job))
  } catch (error) {
    const limit = videoQueueLimitProjection(error)
    if (limit) return res.status(limit.status).json({ code: limit.code, error: limit.message })
    const status = error instanceof DailyCreditError ? error.status : error instanceof VideoJobError && error.code === 'invalid_request' ? 400 : 503
    return res.status(status).json({ code: error instanceof DailyCreditError ? error.code : status === 400 ? 'INVALID_VIDEO_REQUEST' : 'DAILY_VIDEO_JOBS_UNAVAILABLE',
      error: status === 402 ? 'Out of daily credits' : status === 400 ? 'Invalid video request' : 'Daily video creation unavailable' })
  }
}))

router.get('/jobs', authenticateToken, asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Media jobs require a configured database' })
  const jobs = await prisma.mediaJob.findMany({
    where: { userId: (req as any).userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json(jobs.map(serialize))
}))

router.get('/jobs/:id', authenticateToken, asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Media jobs require a configured database' })
  const job = await prisma.mediaJob.findFirst({ where: { id: req.params.id, userId: (req as any).userId } })
  if (!job) return res.status(404).json({ error: 'Media job not found' })
  res.json(serialize(job))
}))

router.post('/jobs/:id/cancel', authenticateToken, asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Media jobs require a configured database' })
  const accounted = await prisma.accountedVideoJob.findUnique({ where: { jobId: req.params.id }, select: { jobId: true } })
  if (accounted) {
    try { await cancelAccountedVideoJob(req.params.id, { userId: (req as any).userId }); return res.json({ ok: true }) }
    catch (error) { return res.status(error instanceof VideoJobError && error.code === 'not_found' ? 404 : 503).json({ error: 'Video job cancellation unavailable' }) }
  }
  const job = await prisma.mediaJob.updateMany({
    where: { id: req.params.id, userId: (req as any).userId, accountedVideo: { is: null }, status: { in: ['queued', 'processing'] } },
    data: { status: 'cancelled', completedAt: new Date() },
  })
  if (!job.count) return res.status(404).json({ error: 'Active media job not found' })
  res.json({ ok: true })
}))

export default router
