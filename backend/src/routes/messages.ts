import express from 'express'
import type OpenAI from 'openai'
import { prisma } from '../services/prisma'
import { authenticateToken } from './auth'
import { imageApiService } from '../services/imageApi'
import { ToolDetector } from '../services/toolDetector'
import { memoryStore } from '../services/memoryStore'
import { validate, validationSchemas } from '../middleware/validation'
import { getOrCreateConversation, getHistory } from '../services/chatStore'
import { readOwnedImage, FileAccessError } from '../services/privateFiles'
import { fileErrorResponse } from './files'
import { createClient } from '../agent/llmClient'
import { resolveHostedModelRequest } from '../services/hostedModelRequest'
import { saveArtifact } from '../agent/artifacts'
import { reserveDailyCredits, dailyDispatch, cleanupDailyReservation, DailyCreditError } from '../services/dailyReservations'
import { recordUsage, estimateTokens } from '../services/billing'

const router = express.Router()
const USE_MEMORY_STORE = !prisma
type HostedTarget = ReturnType<typeof resolveHostedModelRequest>
class HostedMessageError extends Error {}

async function hostedAnswer(target: HostedTarget, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], signal: AbortSignal, maxTokens: number, beforeDispatch: () => Promise<void>) {
  let client: ReturnType<typeof createClient>
  try { client = createClient(target.provider, target.apiKey, target.baseUrl) }
  catch { throw new HostedMessageError('Model request failed') }
  if (signal.aborted) throw new Error('Request cancelled before dispatch')
  await beforeDispatch()
  try {
    const result = await client.chat.completions.create({
      model: target.model, messages, temperature: 0.7, max_tokens: maxTokens,
    }, { signal })
    const answer = result.choices[0]?.message?.content
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('Missing model response')
    return answer
  } catch { throw new HostedMessageError('Model request failed') }
}

// Get messages for an owned conversation; legacy workspace lifecycle is unchanged.
router.get('/:conversationId/messages', authenticateToken, validate(validationSchemas.getMessages), async (req, res) => {
  try {
    const userId = (req as any).userId
    const { conversationId } = req.params
    if (USE_MEMORY_STORE) {
      const conversation = memoryStore.getConversation(conversationId)
      if (!conversation || conversation.userId !== userId) return res.status(404).json({ error: 'Conversation not found' })
      return res.json(memoryStore.getMessages(conversationId).map(msg => ({ ...msg, imagePath: null, createdAt: msg.createdAt.toISOString() })))
    }
    const conversation = await prisma!.conversation.findFirst({ where: { id: conversationId, userId } })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const messages = await prisma!.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true, messageType: true, imageUrl: true, imagePath: false, toolUsed: true, metadata: true } })
    res.json(messages)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Inspect raw JSON BEFORE validation strips unknown fields such as baseUrl.
router.post('/:conversationId/messages', authenticateToken, (req, res, next) => {
  try { res.locals.hostedTarget = resolveHostedModelRequest(req.body) }
  catch { return res.status(400).json({ code: 'HOSTED_MODEL_REQUIRED', error: 'Invalid hosted model selection or unsupported provider override' }) }
  if ((req.body.interactionMode !== undefined && req.body.interactionMode !== 'ask') ||
      Object.prototype.hasOwnProperty.call(req.body, 'schedule')) {
    return res.status(400).json({ code: 'LEGACY_MODE_RETIRED', error: 'Legacy planning, agentic and automation modes are unavailable on this endpoint' })
  }
  next()
}, validate(validationSchemas.sendMessage), async (req, res) => {
  const abort = new AbortController()
  const onClose = () => abort.abort()
  res.on('close', onClose)
  if (res.destroyed) abort.abort()
  let reservation: Awaited<ReturnType<typeof reserveDailyCredits>> | undefined
  try {
    const userId = (req as any).userId
    const { conversationId } = req.params
    const { content, attachmentId, tool } = req.body
    const target = res.locals.hostedTarget as HostedTarget
    const detection = tool ? { tool, parameters: { model: undefined } } : ToolDetector.detect(content || '', !!attachmentId)
    const toolType = attachmentId && detection.tool === 'chat' ? 'vision-chat' : detection.tool
    if (!['chat', 'generate-image', 'analyze-image', 'vision-chat'].includes(toolType)) {
      return res.status(400).json({ code: 'LEGACY_TOOL_RETIRED', error: 'Requested legacy tool is unavailable' })
    }
    if (['analyze-image', 'vision-chat'].includes(toolType) && !attachmentId) return res.status(400).json({ error: 'Image attachment required' })
    if (attachmentId && conversationId === 'new') return res.status(400).json({ error: 'Use the conversation ID returned by image upload' })
    try { reservation = await reserveDailyCredits(userId, toolType === 'generate-image' ? 'image' : 'chat',
      toolType === 'generate-image' ? detection.parameters?.model || 'flux-schnell' : target.model) }
    catch (error) {
      if (error instanceof DailyCreditError) throw error
      throw new DailyCreditError(503, 'DAILY_ACCOUNTING_UNAVAILABLE', 'Daily credit accounting unavailable')
    }
    const beforeDispatch = dailyDispatch(reservation.id, abort.signal)
    const conversation = await getOrCreateConversation(userId, conversationId, content || 'New Chat')
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const image = attachmentId ? await readOwnedImage(userId, conversation.id, attachmentId) : null

    const userData = { role: 'user' as const, content: content || '', conversationId: conversation.id,
      messageType: image ? 'mixed' : 'text', imageUrl: image?.reference.url || null, toolUsed: toolType }
    const userMessage = USE_MEMORY_STORE
      ? memoryStore.addMessage(conversation.id, { ...userData, imageUrl: image?.reference.url })
      : await prisma!.message.create({ data: userData })

    let assistantResponse: any
    if (toolType === 'generate-image') {
      if (abort.signal.aborted) throw new Error('Request cancelled before dispatch')
      if (!process.env.IMAGE_API_URL) throw new Error('Image generation not configured')
      await beforeDispatch()
      const result = await imageApiService.generateImage({ prompt: ToolDetector.extractPrompt(content || ''),
        model: (detection.parameters?.model || 'flux-schnell') as any, return_base64: true }, abort.signal)
      if (!result.image_base64) throw new Error('Image provider returned no image bytes')
      const contentText = `Here's your generated image using ${result.model}:`
      await recordUsage(userId, 'image', { reservationId: reservation.id, images: 1,
        tokensIn: estimateTokens(content || ''), tokensOut: estimateTokens(contentText) })
      const artifact = await saveArtifact('generated.png', Buffer.from(result.image_base64.replace(/^data:[^,]+,/, ''), 'base64'),
        { userId, conversationId: conversation.id })
      assistantResponse = { role: 'assistant', content: contentText,
        messageType: 'image', imageUrl: artifact.url, imagePath: null, toolUsed: toolType,
        metadata: { model: result.model, generationTime: result.generation_time, artifacts: [artifact] } }
    } else {
      let answer: string
      if (image) {
        answer = await hostedAnswer(target, [{ role: 'user', content: [
          { type: 'text', text: content || 'Describe this image accurately.' },
          { type: 'image_url', image_url: { url: image.dataUri } },
        ] }], abort.signal, 2048, beforeDispatch)
      } else {
        const history = await getHistory(conversation.id, 20)
        const messages = history.filter(msg => msg.role === 'user' || msg.role === 'assistant')
          .map(msg => ({ role: msg.role as 'user' | 'assistant', content: msg.content }))
        answer = await hostedAnswer(target, messages, abort.signal, 2000, beforeDispatch)
      }
      assistantResponse = { role: 'assistant', content: answer, messageType: 'text', toolUsed: toolType }
      await recordUsage(userId, 'chat', { reservationId: reservation.id,
        tokensIn: estimateTokens(content || ''), tokensOut: estimateTokens(answer) })
    }

    // A disconnected caller should not cause a late assistant-result write.
    if (abort.signal.aborted) return
    let assistantMessage: any
    if (USE_MEMORY_STORE) {
      assistantMessage = memoryStore.addMessage(conversation.id, { ...assistantResponse, conversationId: conversation.id })
      memoryStore.updateConversation(conversation.id, { updatedAt: new Date() })
    } else {
      assistantMessage = await prisma!.message.create({ data: { ...assistantResponse, conversationId: conversation.id } })
      await prisma!.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
    }
    const responseMessage = (message: any) => ({ id: message.id, role: message.role, content: message.content,
      createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
      messageType: message.messageType, imageUrl: message.imageUrl || null, imagePath: null, toolUsed: message.toolUsed })
    res.json({ userMessage: responseMessage(userMessage),
      assistantMessage: { ...responseMessage(assistantMessage), metadata: assistantMessage.metadata },
      conversationId: conversation.id, toolUsed: toolType })
  } catch (error) {
    if (res.destroyed) return
    if (error instanceof DailyCreditError) return res.status(error.status).json({ error: error.message, code: error.code })
    if (error instanceof FileAccessError) return fileErrorResponse(error, res)
    if (error instanceof HostedMessageError) return res.status(502).json({ error: 'Model request failed' })
    res.status(500).json({ error: 'Message request failed' })
  } finally {
    await cleanupDailyReservation(reservation?.id)
    res.off('close', onClose)
    abort.abort()
  }
})

export default router
