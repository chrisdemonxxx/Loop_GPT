import { describe, expect, it } from 'vitest'
import {
  CREDITS_PER_TURN_HINT,
  EFFORT_OPTIONS,
  effortOption,
  formatCreditEstimate,
  shouldEstimateBeforeRun,
  type ProjectAnalytics,
  type ProjectCollab,
  type ProjectConnector,
} from '@loop/loopit-client'

describe('Phase 3.5–3.9 client surfaces', () => {
  it('maps Quick/Standard/Deep effort onto engine tiers', () => {
    expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual(['quick', 'standard', 'deep'])
    expect(effortOption('quick').iterations).toBe(8)
    expect(effortOption('standard').iterations).toBe(14)
    expect(effortOption('deep').iterations).toBe(24)
    expect(effortOption(undefined).id).toBe('standard')
  })

  it('estimates before deep / plan runs', () => {
    expect(shouldEstimateBeforeRun('deep')).toBe(true)
    expect(shouldEstimateBeforeRun('standard', 'plan')).toBe(true)
    expect(shouldEstimateBeforeRun('quick', 'build')).toBe(false)
    expect(formatCreditEstimate(0.14)).toBe('0.140')
    expect(CREDITS_PER_TURN_HINT).toBeGreaterThan(0)
  })

  it('models connector catalog rows', () => {
    const row: ProjectConnector = {
      kind: 'stripe',
      label: 'Stripe',
      enabled: true,
      status: 'stub',
      source: 'offline',
      secret_names: ['STRIPE_SECRET_KEY'],
    }
    expect(row.kind).toBe('stripe')
  })

  it('models analytics and collab payloads', () => {
    const analytics: ProjectAnalytics = {
      project_id: 'proj_1',
      page_views: 12,
      html_views: 10,
      source: 'sidecar',
      by_path: { 'index.html': 10 },
    }
    expect(analytics.page_views).toBe(12)

    const collab: ProjectCollab = {
      project_id: 'proj_1',
      online_count: 1,
      presence: [{ actor_id: 'u1', display_name: 'Ada', role: 'owner' }],
      messages: [{
        message_id: 'msg_1',
        actor_id: 'u1',
        display_name: 'Ada',
        text: 'ship it',
        created_at: new Date().toISOString(),
      }],
    }
    expect(collab.online_count).toBe(1)
    expect(collab.messages[0]?.text).toBe('ship it')
  })
})
