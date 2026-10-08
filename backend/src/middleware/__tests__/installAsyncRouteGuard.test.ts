import { describe, expect, it } from 'vitest'
import express from 'express'
import '../installAsyncRouteGuard'

describe('async route guard', () => {
  it('forwards a rejected async handler to next', async () => {
    const router = express.Router()
    router.get('/boom', async () => { throw new Error('boom') })
    const err = await new Promise<Error | null>((resolve) => {
      const req: any = { method: 'GET', url: '/boom', headers: {} }
      const res: any = { headersSent: false, statusCode: 200, setHeader() { return this }, getHeader() { return undefined }, end() {}, json() {} }
      router(req, res, (caught?: Error) => resolve(caught || null))
    })
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toBe('Request operation failed')
  })
})
