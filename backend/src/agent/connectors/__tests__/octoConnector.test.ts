import { describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { OctoClient } from '../octoConnector'

vi.mock('axios')

describe('OctoClient cloud API', () => {
  it('validates API token against /profiles', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: { data: [] } } as any)
    const client = new OctoClient('test-token')
    const res = await client.validateToken()
    expect(res.ok).toBe(true)
  })

  it('rejects unauthorized token', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 401 } })
    const client = new OctoClient('bad-token')
    const res = await client.validateToken()
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Invalid API token')
  })

  it('never exports cookie secret values (Decision 6)', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        data: [
          { domain: '.example.com', name: 'session_id', value: 'SECRET_PLAINTEXT_COOKIE' },
          { domain: '.test.com', name: 'jwt', value: 'SECRET_JWT_TOKEN' },
        ],
      },
    } as any)

    const client = new OctoClient('test-token')
    const inspected = await client.inspectCookies('fake-uuid')
    expect(inspected.count).toBe(2)
    expect(inspected.items).toEqual([
      { domain: '.example.com', name: 'session_id' },
      { domain: '.test.com', name: 'jwt' },
    ])
    expect(JSON.stringify(inspected)).not.toContain('SECRET_PLAINTEXT_COOKIE')
    expect(JSON.stringify(inspected)).not.toContain('SECRET_JWT_TOKEN')
  })
})
