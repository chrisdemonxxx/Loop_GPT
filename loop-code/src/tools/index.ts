import { runBash } from './bash.js'
import { readFile, writeFile, listDir, searchFiles } from './files.js'

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string>
}

export const LOCAL_TOOLS: ToolDef[] = [
  {
    name: 'bash',
    description: 'Execute a shell command on the user\'s local machine. Use for running tests, builds, git operations, installs, scripts, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to current directory).' },
      },
      required: ['command'],
    },
    async handler(args) {
      const { stdout, stderr, exitCode } = await runBash(String(args.command || ''), args.cwd ? String(args.cwd) : undefined)
      const out = [stdout, stderr ? `[stderr] ${stderr}` : ''].filter(Boolean).join('\n')
      return (out || '(no output)') + (exitCode !== 0 ? `\n[exit ${exitCode}]` : '')
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file on the local filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path (absolute or relative to cwd).' } },
      required: ['path'],
    },
    async handler(args) { return readFile(String(args.path || '')) },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file on the local filesystem. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'File content.' },
      },
      required: ['path', 'content'],
    },
    async handler(args) { return writeFile(String(args.path || ''), String(args.content || '')) },
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a path (tree view, 2 levels deep by default).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path.' },
        depth: { type: 'number', description: 'How many levels to traverse (default 2).' },
      },
      required: [],
    },
    async handler(args) { return listDir(String(args.path || '.'), Number(args.depth || 2)) },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in source files using grep. Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The pattern or string to search for.' },
        path: { type: 'string', description: 'Directory to search in (default: current).' },
      },
      required: ['pattern'],
    },
    async handler(args) { return searchFiles(String(args.pattern || ''), String(args.path || '.')) },
  },
]

export function getToolDefs() {
  return LOCAL_TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }))
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = LOCAL_TOOLS.find((t) => t.name === name)
  if (!tool) return `Unknown tool: ${name}`
  return tool.handler(args)
}
