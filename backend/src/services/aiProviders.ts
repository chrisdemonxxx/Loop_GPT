/**
 * AI Provider Service - Supports multiple AI providers
 */

import OpenAI from 'openai'
import axios from 'axios'

export type AIProvider = 'openai' | 'anthropic' | 'local' | 'groq' | 'together' | 'ollama' | 'xai' | 'perplexity' | 'nvidia' | 'huggingface'

/**
 * Base URL for the Hugging Face Inference Endpoint (llama.cpp / TGI, OpenAI-compatible).
 * The endpoint exposes /v1/chat/completions and is authenticated with an HF token.
 */
export function getHFBaseUrl(baseUrl?: string): string {
  const raw = baseUrl || process.env.HF_ENDPOINT_URL || ''
  const trimmed = raw.replace(/\/+$/, '')
  // Accept the endpoint root or a URL already ending in /v1
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

export function getHFModel(model?: string): string {
  return model || process.env.HF_MODEL || 'tgi'
}

export interface ProviderConfig {
  name: string
  apiKey?: string
  model?: string
  baseUrl?: string
}

export class AIProviderService {
  private providerConfigs: Map<AIProvider, ProviderConfig> = new Map()
  private modelCache: Map<AIProvider, { models: string[]; timestamp: number }> = new Map()
  private CACHE_DURATION = 60 * 60 * 1000 // 1 hour cache

  /**
   * Set provider configuration
   */
  setProviderConfig(provider: AIProvider, config: ProviderConfig) {
    this.providerConfigs.set(provider, config)
  }

  /**
   * Get provider configuration
   */
  getProviderConfig(provider: AIProvider): ProviderConfig | undefined {
    return this.providerConfigs.get(provider)
  }

  /**
   * Get chat completion from OpenAI
   */
  async getOpenAIChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'gpt-3.5-turbo',
    apiKey?: string
  ): Promise<string> {
    const openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    })

    const completion = await openai.chat.completions.create({
      model,
      messages: messages as any,
      temperature: 0.7,
      max_tokens: 2000,
    })

    return completion.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from Anthropic Claude
   */
  async getAnthropicChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'claude-3-haiku-20240307',
    apiKey?: string
  ): Promise<string> {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model,
        max_tokens: 2000,
        messages: messages.map(msg => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        })),
      },
      {
        headers: {
          'x-api-key': apiKey || process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.content[0]?.text || ''
  }

  /**
   * Get chat completion from Groq
   */
  async getGroqChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'llama3-8b-8192',
    apiKey?: string
  ): Promise<string> {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.GROQ_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from Together AI
   */
  async getTogetherChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'meta-llama/Llama-3-8b-chat-hf',
    apiKey?: string
  ): Promise<string> {
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model,
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.TOGETHER_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from Ollama (local)
   */
  async getOllamaChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'llama2',
    baseUrl: string = 'http://localhost:11434'
  ): Promise<string> {
    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        messages: messages as any,
        stream: false,
      }
    )

    return response.data.message?.content || ''
  }

  /**
   * Get chat completion from local OpenAI-compatible API
   */
  async getLocalChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'gpt-3.5-turbo',
    baseUrl: string = 'http://localhost:1234/v1'
  ): Promise<string> {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from x.ai (Grok)
   */
  async getXAIChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'grok-beta',
    apiKey?: string
  ): Promise<string> {
    const response = await axios.post(
      'https://api.x.ai/v1/chat/completions',
      {
        model,
        messages: messages.map(msg => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        })),
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.XAI_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from Perplexity AI (z.ai)
   */
  async getPerplexityChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'llama-3.1-sonar-large-32k-online',
    apiKey?: string
  ): Promise<string> {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model,
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.PERPLEXITY_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from NVIDIA NIM API
   */
  async getNvidiaChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string = 'meta/llama-3.1-8b-instruct',
    apiKey?: string,
    baseUrl: string = 'https://integrate.api.nvidia.com/v1'
  ): Promise<string> {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 2000,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.NVIDIA_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return response.data.choices[0]?.message?.content || ''
  }

  /**
   * Get chat completion from a Hugging Face Inference Endpoint.
   *
   * The endpoint runs an OpenAI-compatible server (llama.cpp / TGI) so we reuse
   * the OpenAI SDK, only swapping the baseURL and using the HF token as the key.
   * Endpoints with scale-to-zero can take 30-120s to cold-start, so we use a
   * long timeout and retry once on gateway/timeout errors.
   */
  async getHFEndpointChatCompletion(
    messages: Array<{ role: string; content: any }>,
    model?: string,
    apiKey?: string,
    baseUrl?: string
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: apiKey || process.env.HF_TOKEN || 'sk-no-key',
      baseURL: getHFBaseUrl(baseUrl),
      timeout: Number(process.env.HF_REQUEST_TIMEOUT_MS) || 300_000,
      maxRetries: 0,
    })

    const doCall = async () => {
      const completion = await client.chat.completions.create({
        model: getHFModel(model),
        messages: messages as any,
        temperature: Number(process.env.AGENT_TEMPERATURE) || 0.7,
        max_tokens: Number(process.env.HF_MAX_TOKENS) || 8192,
      })
      return completion.choices[0]?.message?.content || ''
    }

    try {
      return await doCall()
    } catch (error: any) {
      // Cold-start / gateway hiccup — retry once after a short wait.
      const status = error?.status || error?.response?.status
      const retriable = status === 502 || status === 503 || status === 504 || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET'
      if (retriable) {
        await new Promise((r) => setTimeout(r, 3000))
        return doCall()
      }
      throw error
    }
  }

  /**
   * Get chat completion from any provider
   */
  async getChatCompletion(
    provider: AIProvider,
    messages: Array<{ role: string; content: string }>,
    model?: string,
    apiKey?: string,
    baseUrl?: string
  ): Promise<string> {
    const config = this.getProviderConfig(provider)
    const finalModel = model || config?.model || this.getDefaultModel(provider)
    const finalApiKey = apiKey || config?.apiKey
    const finalBaseUrl = baseUrl || config?.baseUrl

    switch (provider) {
      case 'openai':
        return this.getOpenAIChatCompletion(messages, finalModel, finalApiKey)
      case 'anthropic':
        return this.getAnthropicChatCompletion(messages, finalModel, finalApiKey)
      case 'groq':
        return this.getGroqChatCompletion(messages, finalModel, finalApiKey)
      case 'together':
        return this.getTogetherChatCompletion(messages, finalModel, finalApiKey)
      case 'ollama':
        return this.getOllamaChatCompletion(messages, finalModel, finalBaseUrl)
      case 'local':
        return this.getLocalChatCompletion(messages, finalModel, finalBaseUrl)
      case 'xai':
        return this.getXAIChatCompletion(messages, finalModel, finalApiKey)
      case 'perplexity':
        return this.getPerplexityChatCompletion(messages, finalModel, finalApiKey)
      case 'nvidia':
        return this.getNvidiaChatCompletion(messages, finalModel, finalApiKey, finalBaseUrl)
      case 'huggingface':
        return this.getHFEndpointChatCompletion(messages, finalModel, finalApiKey, finalBaseUrl)
      default:
        throw new Error(`Unsupported provider: ${provider}`)
    }
  }

  /**
   * Get default model for provider
   */
  getDefaultModel(provider: AIProvider): string {
    const defaults: Record<AIProvider, string> = {
      openai: 'gpt-3.5-turbo',
      anthropic: 'claude-3-haiku-20240307',
      groq: 'llama3-8b-8192',
      together: 'meta-llama/Llama-3-8b-chat-hf',
      ollama: 'llama2',
      local: 'gpt-3.5-turbo',
      xai: 'grok-beta',
      perplexity: 'llama-3.1-sonar-large-32k-online',
      nvidia: 'meta/llama-3.1-8b-instruct',
      huggingface: process.env.HF_MODEL || 'tgi',
    }
    return defaults[provider] || 'gpt-3.5-turbo'
  }

  /**
   * Get available models for provider - fetches from API if available
   */
  async getAvailableModels(provider: AIProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
    // Check cache first
    const cached = this.modelCache.get(provider)
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.models
    }

    try {
      const models = await this.fetchModelsFromAPI(provider, apiKey, baseUrl)
      // Cache the results
      this.modelCache.set(provider, { models, timestamp: Date.now() })
      return models
    } catch (error: any) {
      console.error(`Failed to fetch models from ${provider}:`, error.message)
      // Return fallback models if API fetch fails
      return this.getFallbackModels(provider)
    }
  }

  /**
   * Fetch models from provider API
   */
  private async fetchModelsFromAPI(provider: AIProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
    const config = this.getProviderConfig(provider)
    const finalApiKey = apiKey || config?.apiKey
    const finalBaseUrl = baseUrl || config?.baseUrl

    switch (provider) {
      case 'openai':
        return this.fetchOpenAIModels(finalApiKey)
      case 'anthropic':
        return this.fetchAnthropicModels(finalApiKey)
      case 'groq':
        return this.fetchGroqModels(finalApiKey)
      case 'together':
        return this.fetchTogetherModels(finalApiKey)
      case 'ollama':
        return this.fetchOllamaModels(finalBaseUrl)
      case 'xai':
        return this.fetchXAIModels(finalApiKey)
      case 'perplexity':
        return this.fetchPerplexityModels(finalApiKey)
      case 'nvidia':
        return this.fetchNvidiaModels(finalApiKey, finalBaseUrl)
      case 'local':
        // For local APIs, try to fetch but fallback to defaults
        return this.fetchLocalModels(finalBaseUrl)
      case 'huggingface':
        return this.getFallbackModels('huggingface')
      default:
        return this.getFallbackModels(provider)
    }
  }

  /**
   * Fetch OpenAI models
   */
  private async fetchOpenAIModels(apiKey?: string): Promise<string[]> {
    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.OPENAI_API_KEY || ''}`,
        },
      })
      // Filter for chat models
      return response.data.data
        .filter((model: any) => 
          model.id.includes('gpt') && 
          (model.id.includes('chat') || model.id.includes('turbo') || model.id.includes('gpt-4'))
        )
        .map((model: any) => model.id)
        .sort()
    } catch (error) {
      throw new Error('Failed to fetch OpenAI models')
    }
  }

  /**
   * Fetch Anthropic models
   */
  private async fetchAnthropicModels(apiKey?: string): Promise<string[]> {
    // Anthropic doesn't have a public models endpoint, return known models
    return this.getFallbackModels('anthropic')
  }

  /**
   * Fetch Groq models
   */
  private async fetchGroqModels(apiKey?: string): Promise<string[]> {
    try {
      const response = await axios.get('https://api.groq.com/openai/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.GROQ_API_KEY || ''}`,
        },
      })
      return response.data.data
        .map((model: any) => model.id)
        .filter((id: string) => id.includes('llama') || id.includes('mixtral') || id.includes('gemma'))
        .sort()
    } catch (error) {
      throw new Error('Failed to fetch Groq models')
    }
  }

  /**
   * Fetch Together AI models
   */
  private async fetchTogetherModels(apiKey?: string): Promise<string[]> {
    try {
      const response = await axios.get('https://api.together.xyz/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.TOGETHER_API_KEY || ''}`,
        },
      })
      return response.data
        .filter((model: any) => model.type === 'chat' || model.name.includes('instruct') || model.name.includes('chat'))
        .map((model: any) => model.name)
        .sort()
    } catch (error) {
      throw new Error('Failed to fetch Together AI models')
    }
  }

  /**
   * Fetch Ollama models
   */
  private async fetchOllamaModels(baseUrl?: string): Promise<string[]> {
    try {
      const url = baseUrl || 'http://localhost:11434'
      const response = await axios.get(`${url}/api/tags`)
      return response.data.models
        .map((model: any) => model.name)
        .sort()
    } catch (error) {
      throw new Error('Failed to fetch Ollama models - make sure Ollama is running')
    }
  }

  /**
   * Fetch x.ai models
   */
  private async fetchXAIModels(apiKey?: string): Promise<string[]> {
    try {
      const response = await axios.get('https://api.x.ai/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.XAI_API_KEY || ''}`,
        },
      })
      return response.data.data
        .map((model: any) => model.id)
        .filter((id: string) => id.includes('grok'))
        .sort()
    } catch (error) {
      throw new Error('Failed to fetch x.ai models')
    }
  }

  /**
   * Fetch Perplexity models
   */
  private async fetchPerplexityModels(apiKey?: string): Promise<string[]> {
    try {
      const response = await axios.get('https://api.perplexity.ai/models', {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.PERPLEXITY_API_KEY || ''}`,
        },
      })
      return response.data.data?.map((model: any) => model.id).sort() || []
    } catch (error) {
      // Perplexity might not have a models endpoint, try alternate
      try {
        const response = await axios.get('https://api.perplexity.ai/chat/completions', {
          method: 'OPTIONS',
          headers: {
            Authorization: `Bearer ${apiKey || process.env.PERPLEXITY_API_KEY || ''}`,
          },
        })
        // If that doesn't work, return fallback
        return this.getFallbackModels('perplexity')
      } catch {
        return this.getFallbackModels('perplexity')
      }
    }
  }

  /**
   * Fetch NVIDIA NIM models
   */
  private async fetchNvidiaModels(apiKey?: string, baseUrl?: string): Promise<string[]> {
    try {
      const url = baseUrl || 'https://integrate.api.nvidia.com/v1'
      const response = await axios.get(`${url}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey || process.env.NVIDIA_API_KEY || ''}`,
        },
      })
      return response.data.data
        ?.map((model: any) => model.id)
        .filter((id: string) => id.includes('instruct') || id.includes('chat'))
        .sort() || []
    } catch (error) {
      throw new Error('Failed to fetch NVIDIA NIM models')
    }
  }

  /**
   * Fetch local OpenAI-compatible API models
   */
  private async fetchLocalModels(baseUrl?: string): Promise<string[]> {
    try {
      const url = (baseUrl || 'http://localhost:1234/v1').replace(/\/v1$/, '')
      const response = await axios.get(`${url}/v1/models`)
      return response.data.data?.map((model: any) => model.id).sort() || []
    } catch (error) {
      return this.getFallbackModels('local')
    }
  }

  /**
   * Get fallback models if API fetch fails
   */
  private getFallbackModels(provider: AIProvider): string[] {
    const models: Record<AIProvider, string[]> = {
      openai: [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo',
      ],
      anthropic: [
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ],
      groq: [
        'llama-3.3-70b-versatile',
        'llama-3.1-70b-versatile',
        'llama-3.1-8b-instruct',
        'mixtral-8x7b-32768',
        'gemma-7b-it',
      ],
      together: [
        'meta-llama/Llama-3-70b-chat-hf',
        'meta-llama/Llama-3-8b-chat-hf',
        'mistralai/Mixtral-8x7B-Instruct-v0.1',
      ],
      ollama: [
        'llama3.2',
        'llama3.1',
        'llama2',
        'mistral',
        'codellama',
      ],
      local: [
        'gpt-3.5-turbo',
        'gpt-4',
        'llama-2',
        'custom',
      ],
      xai: [
        'grok-2-1212',
        'grok-beta',
        'grok-vision-beta',
      ],
      perplexity: [
        'llama-3.1-sonar-large-32k-online',
        'llama-3.1-sonar-small-32k-online',
        'llama-3.1-sonar-large-32k-chat',
        'llama-3.1-sonar-small-32k-chat',
      ],
      nvidia: [
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.1-8b-instruct',
        'meta/llama-3-70b-instruct',
        'mistralai/mistral-7b-instruct',
        'mistralai/mixtral-8x7b-instruct-v0.1',
      ],
      huggingface: [process.env.HF_MODEL || 'tgi'],
    }
    return models[provider] || []
  }

  /**
   * Clear model cache for a provider (useful when API key changes)
   */
  clearModelCache(provider?: AIProvider) {
    if (provider) {
      this.modelCache.delete(provider)
    } else {
      this.modelCache.clear()
    }
  }
}

export const aiProviderService = new AIProviderService()

