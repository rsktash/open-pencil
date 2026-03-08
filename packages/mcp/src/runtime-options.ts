export type McpServerMode = 'headless' | 'desktop'

export interface RuntimeOptions {
  mode: McpServerMode
  bridgeUrl?: string
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

export function resolveRuntimeOptions(argv: string[]): RuntimeOptions {
  const app = readFlag(argv, '--app') ?? process.env.OPENPENCIL_MCP_APP ?? 'headless'
  const mode: McpServerMode = app === 'desktop' ? 'desktop' : 'headless'
  const bridgeUrl = readFlag(argv, '--bridge-url') ?? process.env.OPENPENCIL_AUTOMATION_URL
  return { mode, bridgeUrl: bridgeUrl?.trim() || undefined }
}
