import {
  ALL_TOOLS,
  computeAllLayouts,
  extractCaptureHighlight,
  extractHighlightedNodeIds,
  executeRpcCommand,
  renderTreeNode,
  sceneNodeToJSX,
  selectionToJSX
} from '@open-pencil/core'

import { makeFigmaFromStore } from '@/automation/figma-factory'

import type { EditorStore } from '@/stores/editor'
import type { ExportFormat } from '@open-pencil/core'

export async function handleAutomationRequest(
  getStore: () => EditorStore,
  command: string,
  args: unknown
): Promise<{ ok: true; result: unknown }> {
  const store = getStore()

  if (command === 'eval') {
    const code = (args as { code?: string })?.code
    if (!code) throw new Error('Missing "code" in args')
    const figma = makeFigmaFromStore(store)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const wrappedCode = code.trim().startsWith('return') ? code : `return (async () => { ${code} })()`
    const fn = new AsyncFunction('figma', wrappedCode)
    const result = await fn(figma)
    computeAllLayouts(store.graph)
    store.requestRender()
    return { ok: true, result: result ?? null }
  }

  if (command === 'tool') {
    const toolName = (args as { name?: string })?.name
    const toolArgs = (args as { args?: Record<string, unknown> })?.args ?? {}
    if (!toolName) throw new Error('Missing "name" in args')

    if (toolName === 'render' && toolArgs.tree) {
      const tree = toolArgs.tree as Parameters<typeof renderTreeNode>[1]
      const result = renderTreeNode(store.graph, tree, {
        parentId: (toolArgs.parent_id as string) ?? store.state.currentPageId,
        x: toolArgs.x as number | undefined,
        y: toolArgs.y as number | undefined
      })
      computeAllLayouts(store.graph, store.state.currentPageId)
      store.requestRender()
      store.flashNodes([result.id])
      return {
        ok: true,
        result: { id: result.id, name: result.name, type: result.type, children: result.childIds }
      }
    }

    if (toolName === 'render' && toolArgs.jsx) {
      throw new Error('Render requests with JSX require bridge-side preprocessing')
    }

    const def = ALL_TOOLS.find((tool) => tool.name === toolName)
    if (!def) throw new Error(`Unknown tool: ${toolName}`)
    const figma = makeFigmaFromStore(store)
    const result = await def.execute(figma, toolArgs)
    if (
      toolName === 'switch_page' &&
      result &&
      typeof result === 'object' &&
      'id' in result &&
      typeof result.id === 'string'
    ) {
      store.state.currentPageId = result.id
      store.state.selectedIds.clear()
    }
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
    return { ok: true, result }
  }

  if (command === 'export') {
    const exportArgs = args as { nodeIds?: string[]; scale?: number; format?: string } | undefined
    const nodeIds = exportArgs?.nodeIds ?? [...store.state.selectedIds]
    if (nodeIds.length === 0) throw new Error('No nodes to export')
    const data = await store.renderExportImage(
      nodeIds,
      exportArgs?.scale ?? 1,
      (exportArgs?.format ?? 'PNG') as ExportFormat
    )
    if (!data) throw new Error('Export failed')
    let binary = ''
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i])
    const base64 = btoa(binary)
    return {
      ok: true,
      result: { base64, mimeType: `image/${(exportArgs?.format ?? 'png').toLowerCase()}` }
    }
  }

  if (command === 'export_jsx') {
    const jsxArgs = args as { nodeIds?: string[]; style?: string } | undefined
    const style = (jsxArgs?.style ?? 'openpencil') as 'openpencil' | 'tailwind'
    const currentPage = store.graph.getNode(store.state.currentPageId)
    const nodeIds = jsxArgs?.nodeIds ?? currentPage?.childIds ?? []
    const jsx =
      nodeIds.length === 1
        ? sceneNodeToJSX(nodeIds[0], store.graph, style)
        : selectionToJSX(nodeIds, store.graph, style)
    return { ok: true, result: { jsx: jsx ?? '' } }
  }

  const result = executeRpcCommand(store.graph, command, args ?? {})
  return { ok: true, result }
}
