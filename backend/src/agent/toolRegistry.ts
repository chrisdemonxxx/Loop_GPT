/**
 * Central registry of tools available to the agent.
 *
 * Built-in tools are registered at import time. MCP servers, skills, and
 * plugins register additional tools dynamically (see mcp/, skills/, plugins/).
 */
import type OpenAI from 'openai'
import type { ToolDefinition, ToolContext, ToolResult } from './types'

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
    const tool = this.tools.get(name)
    if (!tool) {
      return { content: `Error: unknown tool "${name}".`, isError: true }
    }
    try {
      return await tool.handler(args || {}, ctx)
    } catch (error: any) {
      return { content: `Tool "${name}" failed: ${error?.message || String(error)}`, isError: true }
    }
  }
}

export const toolRegistry = new ToolRegistry()
