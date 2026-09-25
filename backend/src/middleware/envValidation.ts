import { z } from 'zod'
import { privateStorageConfigIssues } from '../services/privateStorage'

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

  // HF Search endpoint (dedicated search pipeline)
  HF_SEARCH_ENDPOINT_URL: z.string().url().optional(),

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
  PRIVATE_FILES_STORAGE_MODE: z.string().optional(),
  PRIVATE_FILES_DIR: z.string().optional(),
  PRIVATE_FILES_STORE_ID: z.string().optional(),
  PRIVATE_FILES_MIN_FREE_BYTES: z.string().optional(),
  
  // Frontend
  FRONTEND_URL: z.string().optional(),
  
  // Image API
  IMAGE_API_URL: z.string().url().optional(),
  
  // Dev mode
  ENABLE_DEV_MODE: z.string().optional(),
}).superRefine((env, ctx) => {
  const issue = (key: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message })
  for (const problem of privateStorageConfigIssues(env)) issue(problem.key, problem.message)
  const origins = (env.FRONTEND_URL || '').split(',').map((value) => value.trim()).filter(Boolean)
  for (const origin of origins) {
    try {
      const url = new URL(origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        issue('FRONTEND_URL', 'Entries must be HTTP(S) origins without credentials, paths, queries, or fragments')
      } else if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
        issue('FRONTEND_URL', 'Production origins must use HTTPS')
      }
    } catch {
      issue('FRONTEND_URL', 'Each comma-separated entry must be a valid HTTP(S) origin')
    }
  }
  if (env.NODE_ENV !== 'production') return
  if (!origins.length) issue('FRONTEND_URL', 'An explicit production origin allowlist is required')
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 32 || env.JWT_SECRET === 'your-secret-key-change-in-production') {
    issue('JWT_SECRET', 'Production requires a non-default secret of at least 32 characters')
  }
  try {
    const url = new URL(env.DATABASE_URL || '')
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 ||
        env.DATABASE_URL?.includes('postgresql://user:password')) {
      issue('DATABASE_URL', 'A non-placeholder PostgreSQL database URL is required in production')
    }
  } catch {
    issue('DATABASE_URL', 'A PostgreSQL database URL is required in production')
  }
  if (env.ENABLE_DEV_MODE && env.ENABLE_DEV_MODE !== 'false') {
    issue('ENABLE_DEV_MODE', 'Development authentication bypass must be disabled in production')
  }
})

/**
 * Validate environment variables on startup
 */
export function validateEnv(environment: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(environment)
  if (!result.success) {
    // Describe fields, never echo credentials or connection-string values.
    const details = result.error.issues.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }
  return result.data
}

/**
 * Get validated environment variable
 */
export function getEnv(key: keyof z.infer<typeof envSchema>): string | undefined {
  return process.env[key]
}

