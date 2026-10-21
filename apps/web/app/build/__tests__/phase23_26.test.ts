import { describe, expect, it } from 'vitest'
import type { BuildTemplate, DomainClaim, GitSyncStatus, ProjectVisibility, PublicShare } from '@loop/loopit-client'

describe('Phase 2.3–2.6 client contracts', () => {
  it('accepts git sync status shapes', () => {
    const unbound: GitSyncStatus = { bound: false, mode: 'fake', provider: 'fake' }
    const bound: GitSyncStatus = {
      bound: true,
      mode: 'fake',
      owner: 'acme',
      name: 'demo',
      clone_url: 'https://example.invalid/acme/demo.git',
      auto_push: true,
    }
    expect(unbound.bound).toBe(false)
    expect(bound.owner).toBe('acme')
  })

  it('accepts domain claim challenge payload', () => {
    const claim: DomainClaim = {
      claim_id: 'claim_1',
      hostname: 'app.example.test',
      status: 'pending',
      challenge_name: '_loopit-verify.app.example.test',
      challenge_value: 'loopit-verify-abc',
      expires_at: new Date().toISOString(),
      project_id: 'proj_1',
      challenge_type: 'TXT',
      cname_target: 'apps.loopit.local',
    }
    expect(claim.challenge_name.startsWith('_loopit-verify.')).toBe(true)
  })

  it('models visibility and public remix', () => {
    const visibilities: ProjectVisibility[] = ['private', 'link', 'public_remix']
    expect(visibilities).toContain('public_remix')
    const share: PublicShare = {
      share_id: 'share_x',
      project_id: 'proj_1',
      title: 'Demo',
      visibility: 'public_remix',
      remix_allowed: true,
      production_url: '/api/loopit/projects/proj_1/site/t/tok/index.html',
    }
    expect(share.remix_allowed).toBe(true)
  })

  it('models template gallery entries', () => {
    const template: BuildTemplate = {
      id: 'landing-page',
      title: 'Landing page',
      description: 'Marketing landing',
      stack: 'react',
      prompt_seed: 'Build a landing page',
      source: 'curated',
      tags: ['marketing'],
    }
    expect(template.id).toBe('landing-page')
  })
})
