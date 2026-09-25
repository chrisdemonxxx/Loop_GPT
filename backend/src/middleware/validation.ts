import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'

/**
 * Validation middleware factory
 */
export const validate = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      })
      // Update req with validated data
      if (result.body) req.body = result.body
      if (result.query) req.query = result.query
      if (result.params) req.params = result.params
      next()
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation error',
          details: error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        })
      }
      next(error)
    }
  }
}

/**
 * Validation schemas
 */
export const validationSchemas = {
  // Auth schemas
  register: z.object({
    body: z.object({
      email: z.string().email('Invalid email format'),
      password: z.string().min(6, 'Password must be at least 6 characters'),
      name: z.string().optional(),
    }),
  }),

  login: z.object({
    body: z.object({
      email: z.string().email('Invalid email format'),
      password: z.string().min(1, 'Password is required'),
      // Optional TOTP code (required only when the account has MFA enabled).
      totp: z.string().regex(/^\d{6}$/).optional(),
    }),
  }),

  // Conversation schemas
  createConversation: z.object({
    body: z.object({
      title: z.string().max(200, 'Title must be less than 200 characters').optional(),
    }),
  }),

  updateConversation: z.object({
    params: z.object({
      id: z.string().min(1, 'Conversation ID is required'),
    }),
    body: z.object({
      title: z.string().max(200, 'Title must be less than 200 characters'),
    }),
  }),

  deleteConversation: z.object({
    params: z.object({
      id: z.string().min(1, 'Conversation ID is required'),
    }),
  }),

  // Message schemas
  sendMessage: z.object({
    params: z.object({
      conversationId: z.string().min(1, 'Conversation ID is required'),
    }),
    body: z.object({
      content: z.string().max(100_000).optional(),
      imagePath: z.never().optional(),
      attachmentId: z.string().uuid().optional(),
      tool: z.enum(['chat', 'generate-image', 'analyze-image', 'vision-chat', 'mcp', 'gpt-creation']).optional(),
      // Raw provider/destination overrides are rejected by the route before
      // this schema can strip fields. Only request-local hosted selection remains.
      provider: z.literal('huggingface').optional(),
      model: z.string().trim().min(1).max(200).optional(),
      interactionMode: z.literal('ask').optional(),
    }).refine(data => data.content || data.attachmentId, {
      message: 'Either content or attachmentId must be provided',
    }),
  }),

  getMessages: z.object({
    params: z.object({
      conversationId: z.string().min(1, 'Conversation ID is required'),
    }),
  }),

  // Settings schemas
  updateProvider: z.object({
    body: z.object({
      provider: z.string().min(1, 'Provider is required'),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      baseUrl: z.string().url('Invalid URL format').optional().or(z.literal('')),
    }),
  }),

  getProviderModels: z.object({
    params: z.object({
      providerId: z.string().min(1, 'Provider ID is required'),
    }),
    body: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
    }),
  }),
}

