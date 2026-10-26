/** Enabled account connectors join the bot grant. Disabled ones stay out. */

export function mergeConnectorTools(
  names: readonly string[],
  tools: readonly { name: string; enabled?: boolean }[],
): string[] {
  const next = [...names]
  for (const tool of tools) {
    if (tool.enabled === false) continue
    if (!tool.name.startsWith('connector__')) continue
    if (!next.includes(tool.name)) next.push(tool.name)
  }
  return next
}
