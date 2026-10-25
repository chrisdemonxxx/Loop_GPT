import { describe, expect, it } from 'vitest'
import { conversationCreateBody } from '../hooks'

describe('conversationCreateBody', () => {
  it('omits incognito on a normal chat', () => {
    expect(conversationCreateBody('Hello', false)).toEqual({ title: 'Hello' })
  })

  it('sends incognito: true when the composer is private', () => {
    expect(conversationCreateBody('New Chat', true)).toEqual({ title: 'New Chat', incognito: true })
  })
})
