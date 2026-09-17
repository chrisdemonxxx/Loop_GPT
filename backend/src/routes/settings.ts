import express from 'express'
import { z } from 'zod'
import { authenticateToken, requireAdmin } from './auth'
import { aiProviderService, AIProvider } from '../services/aiProviders'

const router = express.Router()
const providerSchema = z.enum(['openai', 'anthropic', 'local', 'groq', 'together', 'ollama', 'xai', 'perplexity', 'nvidia', 'huggingface'])
const apiKeySchema = z.string().max(4096).regex(/^[\x20-\x7e]*$/).optional()
const discoverySchema = z.object({ apiKey: apiKeySchema }).strict()
const configSchema = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
  model: z.string().max(512).optional(),
  baseUrl: z.string().max(2048).optional(),
}).strict()

// Process-wide provider configuration is operator-only, including development.
router.use(authenticateToken, requireAdmin)

// Credentials are provider-specific; GET discovery accepts no query overrides.
router.get('/providers', async (req, res) => {
  if (Object.keys(req.query).length) return res.status(400).json({ error: 'Invalid discovery request.' })
  res.setHeader('Cache-Control', 'no-store')
  try {
    // Each provider resolves only its own configured/server credentials.
    const providers = await Promise.all([
      aiProviderService.getAvailableModels('openai').then(models => ({
        id: 'openai',
        name: 'OpenAI',
        models,
      })),
      aiProviderService.getAvailableModels('anthropic').then(models => ({
        id: 'anthropic',
        name: 'Anthropic Claude',
        models,
      })),
      aiProviderService.getAvailableModels('groq').then(models => ({
        id: 'groq',
        name: 'Groq',
        models,
      })),
      aiProviderService.getAvailableModels('together').then(models => ({
        id: 'together',
        name: 'Together AI',
        models,
      })),
      aiProviderService.getAvailableModels('ollama').then(models => ({
        id: 'ollama',
        name: 'Ollama (Local)',
        models,
      })),
      aiProviderService.getAvailableModels('local').then(models => ({
        id: 'local',
        name: 'Local API',
        models,
      })),
      aiProviderService.getAvailableModels('xai').then(models => ({
        id: 'xai',
        name: 'x.ai (Grok)',
        models,
      })),
      aiProviderService.getAvailableModels('perplexity').then(models => ({
        id: 'perplexity',
        name: 'Perplexity AI',
        models,
      })),
      aiProviderService.getAvailableModels('nvidia').then(models => ({
        id: 'nvidia',
        name: 'NVIDIA NIM',
        models,
      })),
    ])

    res.json(providers)
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch providers' })
  }
})

// Get models for a specific provider (requires API key in body for authenticated fetch)
router.post('/providers/:providerId/models', async (req, res) => {
  const provider = providerSchema.safeParse(req.params.providerId)
  const parsed = discoverySchema.safeParse(req.body ?? {})
  if (!provider.success || !parsed.success || Object.keys(req.query).length) {
    return res.status(400).json({ error: 'Invalid discovery request.' })
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    const models = await aiProviderService.getAvailableModels(
      provider.data,
      parsed.data.apiKey,
    )

    res.json({ provider: provider.data, models })
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch models.' })
  }
})

// Update provider configuration
router.post('/provider', async (req, res) => {
  const parsed = configSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid provider configuration.' })
  try {
    const { provider, apiKey, model, baseUrl } = parsed.data

    aiProviderService.setProviderConfig(provider as AIProvider, {
      name: provider,
      apiKey,
      model,
      baseUrl,
    })

    // Optionally refresh models when API key is provided
    let models: string[] = []
    if (apiKey) {
      try {
        models = await aiProviderService.getAvailableModels(
          provider as AIProvider,
          apiKey,
          baseUrl
        )
      } catch (error) {
        // Continue even if model fetch fails
      }
    }

    res.json({ 
      success: true, 
      message: 'Provider configuration updated',
      models: models.length > 0 ? models : undefined,
    })
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update provider configuration' })
  }
})

// Get current provider configuration
router.get('/provider/:providerId', (req, res) => {
  if (!providerSchema.safeParse(req.params.providerId).success) {
    return res.status(400).json({ error: 'Invalid provider request.' })
  }
  res.setHeader('Cache-Control', 'no-store')
  const { providerId } = req.params
  const config = aiProviderService.getProviderConfig(providerId as AIProvider)

  if (!config) {
    return res.json({
      provider: providerId,
      model: aiProviderService.getDefaultModel(providerId as AIProvider),
      apiKey: '',
      baseUrl: '',
    })
  }

  res.json({
    provider: providerId,
    ...config,
    // Don't send full API key for security
    apiKey: config.apiKey ? '***' : '',
  })
})

export default router
