import { describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { twoCaptchaAdapter } from '../captchaSolver'

vi.mock('axios')

describe('captchaSolver 2captcha adapter', () => {
  it('validates key balance successfully', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { status: 1, request: '15.40' },
    } as any)

    const res = await twoCaptchaAdapter.validateKey('valid-key')
    expect(res.ok).toBe(true)
    expect(res.balance).toBe(15.40)
  })

  it('rejects invalid key', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { status: 0, request: 'ERROR_KEY_DOES_NOT_EXIST' },
    } as any)

    const res = await twoCaptchaAdapter.validateKey('bad-key')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('ERROR_KEY_DOES_NOT_EXIST')
  })

  it('rejects zero balance key', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { status: 1, request: '0.00' },
    } as any)

    const res = await twoCaptchaAdapter.validateKey('empty-key')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Out of balance')
  })
})
