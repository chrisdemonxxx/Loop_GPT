/**
 * Built-in skills (Anthropic-style): reusable instruction packages that the
 * agent loads into its system prompt when enabled/relevant. Skills may point
 * the model at existing tools (e.g. create_document) rather than shipping code.
 */
import type { Skill } from './skillLoader'

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'pdf-report',
    name: 'PDF Report Writer',
    description: 'Produce polished, well-structured PDF reports from research or data.',
    triggers: ['report', 'pdf', 'write up', 'document', 'summary document'],
    tools: ['create_document', 'web_search', 'web_fetch'],
    instructions: [
      'When the user asks for a report or written document:',
      '1. Gather the needed facts (use web_search/web_fetch if the topic needs current info).',
      '2. Draft a clear structure: title, executive summary, sections with "## " headings, and a conclusion.',
      '3. Call create_document with format:"pdf" (or the format the user asked for), a title, and the full body in "content" using "# "/"## " for headings.',
      'Keep prose concise and factual; cite sources inline when you used the web.',
      'Source: builtin',
    ].join('\n'),
  },
  {
    id: 'spreadsheet-analyst',
    name: 'Spreadsheet Analyst',
    description: 'Organize data into spreadsheets and produce Excel/CSV outputs with tidy tables.',
    triggers: ['spreadsheet', 'excel', 'csv', 'table of', 'tabulate', 'xlsx'],
    tools: ['create_document'],
    instructions: [
      'When the user needs tabular data or a spreadsheet:',
      '1. Decide the columns (a clear header row) and the data rows.',
      '2. Call create_document with format:"xlsx" (or "csv"), passing "rows" as an array of arrays where the first inner array is the header row.',
      '3. Briefly explain the structure of the sheet you produced.',
      'Prefer numeric values (not strings) for numeric columns.',
      'Source: builtin',
    ].join('\n'),
  },
]
