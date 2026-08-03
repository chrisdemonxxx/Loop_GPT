import { z } from 'zod'

/**
 * Environment variable validation schema
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().optional(),
  
  // JWT
  JWT_SECRET: z.string().min(10, 'JWT_SECRET must be at least 10 characters').optional(),
  
  // Hugging Face Inference Endpoint (primary backend)
  HF_ENDPOINT_URL: z.string().url('HF_ENDPOINT_URL must be a valid URL').optional(),
  HF_TOKEN: z.string().optional(),
  HF_MODEL: z.string().optional(),
  HF_IMAGE_MODEL: z.string().optional(),
  DEFAULT_PROVIDER: z.string().optional(),
  DEFAULT_MODEL: z.string().optional(),

  // Deep research / background jobs
  TAVILY_API_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),

  // Other AI Providers
  ANTHROPIC_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  
  // Server
  PORT: z.string().regex(/^\d+$/).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  
  // Frontend
  FRONTEND_URL: z.string().url().optional(),
  
  // Image API
  IMAGE_API_URL: z.string().url().optional(),
  
  // Dev mode
  ENABLE_DEV_MODE: z.string().optional(),
})

/**
 * Validate environment variables on startup
 */
export function validateEnv() {
  try {
    envSchema.parse(process.env)
    console.log('✅ Environment variables validated')
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn('⚠️  Environment variable validation warnings:')
      error.errors.forEach(err => {
        console.warn(`  - ${err.path.join('.')}: ${err.message}`)
      })
      console.warn('  Some features may not work correctly without proper configuration.')
    }
  }
}

/**
 * Get validated environment variable
 */
export function getEnv(key: keyof z.infer<typeof envSchema>): string | undefined {
  return process.env[key]
}

