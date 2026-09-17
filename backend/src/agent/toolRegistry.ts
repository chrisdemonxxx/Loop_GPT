/**
 * Legacy discovery registry. Registration is not execution authority.
 *
 * Execution uses a server-issued per-run grant and its captured definitions,
 * never this mutable discovery map. Shared extensions are no longer bootstrapped.
 */
import type OpenAI from 'openai'
import type { ToolDefinition, ToolContext, ToolResult } from './types'
import Ajv from 'ajv'
import { assertRunAccess, grantedTool } from './runAuthorization'

const validator = new Ajv({ strict: false, allErrors: false, coerceTypes: false })

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool)
  }

  unregister(name: string) {
    this.tools.delete(name)
  }

  /** Remove every tool contributed by a given source (e.g. an MCP server id). */
  unregisterSource(source: string) {
    for (const [name, tool] of this.tools) {
      if (tool.source === source) this.tools.delete(name)
    }
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /** Resolve a set of names (undefined = all) to concrete definitions. */
  resolve(names?: string[]): ToolDefinition[] {
    if (!names) return this.list()
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is ToolDefinition => Boolean(t))
  }

  /** Convert selected tools to the OpenAI function-tool schema. */
  toOpenAITools(names?: string[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.resolve(names).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
      },
    }))
  }

  async execute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    try {
      await assertRunAccess(ctx, name)
      const tool = grantedTool(ctx, name)
      if (!tool) return { content: 'Tool is not permitted for this run.', isError: true }
      const schema = { ...tool.parameters, additionalProperties: tool.parameters.additionalProperties ?? false }
      let valid: boolean
      try { valid = validator.validate(schema, args) as boolean }
      finally { validator.removeSchema(schema) }
      if (!valid) return { content: 'Invalid tool arguments.', isError: true }
      return await tool.handler(args, ctx)
    } catch {
      // Never reflect credentials or provider exception payloads to the model.
      return { content: 'Tool unavailable, access denied, or execution failed.', isError: true }
    }
  }
}

export const toolRegistry = new ToolRegistry()
