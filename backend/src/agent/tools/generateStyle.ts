import type { ToolDefinition } from '../types'
import { createClient, completeOnce } from '../llmClient'
import { resolveChatTarget } from '../../services/chatModels'
import { prisma } from '../../services/prisma'

/** Analyse a writing sample and create a named style preset. */
export const generateStyleTool: ToolDefinition = {
  name: 'generate_style',
  source: 'builtin',
  description: 'Analyse a writing sample and create a named style preset with a system prompt that reproduces the tone, structure, vocabulary, and sentence length of the sample.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short, memorable name for this style (e.g. "professional", "friendly", "academic").' },
      sample: { type: 'string', description: 'A sample of the desired writing style (at least 100 characters).' },
    },
    required: ['name', 'sample'],
  },
  async handler(args, ctx) {
    const name = String(args.name || '').trim()
    const sample = String(args.sample || '').trim()
    if (!name || name.length > 100) return { content: 'Style name must be 1-100 characters.', isError: true }
    if (!sample || sample.length < 100) return { content: 'Sample must be at least 100 characters.', isError: true }

    try {
      // Use the fast tier to analyse the sample.
      const target = resolveChatTarget('standard')
      const client = createClient('huggingface', undefined, target.baseUrl)
      const prompt = `Analyse the following writing sample and generate a concise system prompt (max 300 characters, one paragraph) that would make an LLM reproduce this STYLE: tone, sentence length, vocabulary level, use of examples, formatting preferences, and any distinctive patterns.\n\nOUTPUT ONLY the system prompt — no labels, no explanation.\n\nSample:\n"""\n${sample.slice(0, 5000)}\n"""`
      const result = await completeOnce(client, target.model, [{ role: 'user', content: prompt }], 0.3, 600, ctx.signal)
      const systemPrompt = result.trim().slice(0, 5000)

      // Save the style.
      if (prisma) {
        await prisma.userStyle.create({
          data: { userId: ctx.userId, name, systemPrompt, temperature: 0.7 },
        })
      }
      return { content: `Style "${name}" created:\n\n${systemPrompt}\n\nUse 'set_style ${name}' to activate it.` }
    } catch (e: any) {
      return { content: `Style generation failed: ${e?.message || e}`, isError: true }
    }
  },
}
