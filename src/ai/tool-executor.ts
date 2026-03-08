import {
  ALL_TOOLS,
  computeAllLayouts,
  extractCaptureHighlight,
  extractHighlightedNodeIds
} from '@open-pencil/core'

import { makeFigmaFromStore } from '@/automation/figma-factory'

import type { EditorStore } from '@/stores/editor'
import type { ParamDef, ToolDef } from '@open-pencil/core'

export interface PlannedToolCall {
  name: string
  args?: Record<string, unknown>
}

export interface PlannedToolResult {
  name: string
  args: Record<string, unknown>
  result: unknown
}

function paramSummary([name, param]: [string, ParamDef]): string {
  const required = param.required ? 'required' : 'optional'
  const enumValues = param.enum?.length ? ` enum=${param.enum.join(' | ')}` : ''
  return `- ${name}: ${param.type} (${required})${enumValues} — ${param.description}`
}

export function formatToolCatalog(tools: ToolDef[] = ALL_TOOLS): string {
  return tools
    .map((tool) => {
      const params = Object.entries(tool.params)
      const paramText = params.length > 0 ? params.map(paramSummary).join('\n') : '- no arguments'
      return [`Tool: ${tool.name}`, `Description: ${tool.description}`, 'Params:', paramText].join('\n')
    })
    .join('\n\n')
}

export async function executePlannedToolCall(
  store: EditorStore,
  toolCall: PlannedToolCall
): Promise<PlannedToolResult> {
  const def = ALL_TOOLS.find((tool) => tool.name === toolCall.name)
  if (!def) {
    throw new Error(`Unknown tool: ${toolCall.name}`)
  }

  const args = toolCall.args ?? {}
  const result = await def.execute(makeFigmaFromStore(store), args)

  if (def.mutates) {
    computeAllLayouts(store.graph, store.state.currentPageId)
    store.requestRender()
  }

  const highlightedIds = extractHighlightedNodeIds(result)
  const captureHighlight = def.highlights ? extractCaptureHighlight(result) : null

  if (def.highlights) {
    if (captureHighlight) {
      store.showCaptureHighlight(captureHighlight.rects)
    } else if (highlightedIds.length > 0) {
      store.flashNodes(highlightedIds)
    }
  }

  if (def.mutates && highlightedIds.length > 0) {
    store.flashNodes(highlightedIds)
  }

  return {
    name: toolCall.name,
    args,
    result
  }
}
