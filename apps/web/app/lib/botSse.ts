'use client'

/**
 * Shim: the SSE run-feed reader + hook live in @loop/api-client. This path
 * stays so every existing import keeps working.
 */
export { readBotRunStream, useBotRunFeed } from '@loop/api-client'
export type { BotFeedEvent } from '@loop/shared'