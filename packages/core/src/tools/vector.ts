import { defineTool, nodeSummary } from './schema'

import type { FigmaNodeProxy } from '../figma-api'
import type { ToolCaptureHighlight, ToolCaptureRect } from './schema'

const CHUNK_SIZE = 0x8000

function nodeToCaptureRect(node: FigmaNodeProxy): ToolCaptureRect {
  const bounds = node.absoluteBoundingBox
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(node.rotation !== 0 ? { rotation: node.rotation } : {})
  }
}

function aggregateCaptureRect(nodes: readonly FigmaNodeProxy[]): ToolCaptureRect | null {
  if (nodes.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const bounds = node.absoluteBoundingBox
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  }
}

function resolveCaptureScale(
  nodes: readonly FigmaNodeProxy[],
  requestedScale: number,
  maxLongEdge: number
): number {
  if (maxLongEdge <= 0) return requestedScale
  const rect = aggregateCaptureRect(nodes)
  if (!rect) return requestedScale
  const longEdge = Math.max(rect.width, rect.height)
  if (longEdge <= 0) return requestedScale
  return Math.min(requestedScale, maxLongEdge / longEdge)
}

function buildCaptureHighlight(
  target: 'PAGE' | 'SELECTION' | 'NODES',
  nodes: readonly FigmaNodeProxy[]
): ToolCaptureHighlight | null {
  if (target === 'PAGE') {
    const rect = aggregateCaptureRect(nodes)
    return rect ? { rects: [rect] } : null
  }

  const rects = nodes.map(nodeToCaptureRect)
  return rects.length > 0 ? { rects } : null
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE)
    binary += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  return btoa(binary)
}

export const booleanUnion = defineTool({
  name: 'boolean_union',
  mutates: true,
  description: 'Union (combine) multiple nodes.',
  params: {
    ids: { type: 'string[]', description: 'Node IDs to union', required: true }
  },
  execute: (figma, { ids }) => {
    const result = figma.booleanOperation('UNION', ids)
    return nodeSummary(result)
  }
})

export const booleanSubtract = defineTool({
  name: 'boolean_subtract',
  mutates: true,
  description: 'Subtract the second node from the first.',
  params: {
    ids: { type: 'string[]', description: 'Node IDs (first minus rest)', required: true }
  },
  execute: (figma, { ids }) => {
    const result = figma.booleanOperation('SUBTRACT', ids)
    return nodeSummary(result)
  }
})

export const booleanIntersect = defineTool({
  name: 'boolean_intersect',
  mutates: true,
  description: 'Intersect multiple nodes.',
  params: {
    ids: { type: 'string[]', description: 'Node IDs to intersect', required: true }
  },
  execute: (figma, { ids }) => {
    const result = figma.booleanOperation('INTERSECT', ids)
    return nodeSummary(result)
  }
})

export const booleanExclude = defineTool({
  name: 'boolean_exclude',
  mutates: true,
  description: 'Exclude (XOR) multiple nodes.',
  params: {
    ids: { type: 'string[]', description: 'Node IDs to exclude', required: true }
  },
  execute: (figma, { ids }) => {
    const result = figma.booleanOperation('EXCLUDE', ids)
    return nodeSummary(result)
  }
})

export const pathGet = defineTool({
  name: 'path_get',
  description: 'Get vector path data of a node.',
  params: {
    id: { type: 'string', description: 'Node ID', required: true }
  },
  execute: (figma, { id }) => {
    const raw = figma.graph.getNode(id)
    if (!raw) return { error: `Node "${id}" not found` }
    if (!raw.vectorNetwork) return { error: `Node "${id}" has no vector data` }
    return { id, vectorNetwork: raw.vectorNetwork }
  }
})

export const pathSet = defineTool({
  name: 'path_set',
  mutates: true,
  description: 'Set vector path data on a node. Provide a VectorNetwork JSON.',
  params: {
    id: { type: 'string', description: 'Node ID', required: true },
    path: { type: 'string', description: 'VectorNetwork JSON', required: true }
  },
  execute: (figma, args) => {
    const raw = figma.graph.getNode(args.id)
    if (!raw) return { error: `Node "${args.id}" not found` }
    const network = JSON.parse(args.path)
    figma.graph.updateNode(args.id, { vectorNetwork: network } as any)
    return { id: args.id }
  }
})

export const pathScale = defineTool({
  name: 'path_scale',
  mutates: true,
  description: 'Scale vector path from center.',
  params: {
    id: { type: 'string', description: 'Node ID', required: true },
    factor: { type: 'number', description: 'Scale factor (e.g. 2 for double)', required: true }
  },
  execute: (figma, { id, factor }) => {
    const raw = figma.graph.getNode(id)
    if (!raw) return { error: `Node "${id}" not found` }
    if (!raw.vectorNetwork) return { error: `Node "${id}" has no vector data` }
    const vn = structuredClone(raw.vectorNetwork)
    const cx = raw.width / 2
    const cy = raw.height / 2
    for (const v of vn.vertices) {
      v.x = cx + (v.x - cx) * factor
      v.y = cy + (v.y - cy) * factor
    }
    for (const s of vn.segments) {
      s.tangentStart.x *= factor
      s.tangentStart.y *= factor
      s.tangentEnd.x *= factor
      s.tangentEnd.y *= factor
    }
    figma.graph.updateNode(id, { vectorNetwork: vn } as any)
    return { id, factor }
  }
})

export const pathFlip = defineTool({
  name: 'path_flip',
  mutates: true,
  description: 'Flip vector path horizontally or vertically.',
  params: {
    id: { type: 'string', description: 'Node ID', required: true },
    axis: {
      type: 'string',
      description: 'Flip axis',
      required: true,
      enum: ['horizontal', 'vertical']
    }
  },
  execute: (figma, { id, axis }) => {
    const raw = figma.graph.getNode(id)
    if (!raw) return { error: `Node "${id}" not found` }
    if (!raw.vectorNetwork) return { error: `Node "${id}" has no vector data` }
    const vn = structuredClone(raw.vectorNetwork)
    const w = raw.width
    const h = raw.height
    for (const v of vn.vertices) {
      if (axis === 'horizontal') v.x = w - v.x
      else v.y = h - v.y
    }
    for (const s of vn.segments) {
      if (axis === 'horizontal') s.tangentStart.x = -s.tangentStart.x
      else s.tangentStart.y = -s.tangentStart.y
      if (axis === 'horizontal') s.tangentEnd.x = -s.tangentEnd.x
      else s.tangentEnd.y = -s.tangentEnd.y
    }
    figma.graph.updateNode(id, { vectorNetwork: vn } as any)
    return { id, axis }
  }
})

export const pathMove = defineTool({
  name: 'path_move',
  mutates: true,
  description: 'Move all path points by an offset.',
  params: {
    id: { type: 'string', description: 'Node ID', required: true },
    dx: { type: 'number', description: 'X offset', required: true },
    dy: { type: 'number', description: 'Y offset', required: true }
  },
  execute: (figma, { id, dx, dy }) => {
    const raw = figma.graph.getNode(id)
    if (!raw) return { error: `Node "${id}" not found` }
    if (!raw.vectorNetwork) return { error: `Node "${id}" has no vector data` }
    const vn = structuredClone(raw.vectorNetwork)
    for (const v of vn.vertices) {
      v.x += dx
      v.y += dy
    }
    figma.graph.updateNode(id, { vectorNetwork: vn } as any)
    return { id, dx, dy }
  }
})

export const viewportGet = defineTool({
  name: 'viewport_get',
  description: 'Get current viewport position and zoom level.',
  params: {},
  execute: (figma) => {
    return figma.viewport
  }
})

export const viewportSet = defineTool({
  name: 'viewport_set',
  mutates: true,
  description: 'Set viewport position and zoom.',
  params: {
    x: { type: 'number', description: 'Center X', required: true },
    y: { type: 'number', description: 'Center Y', required: true },
    zoom: { type: 'number', description: 'Zoom level', required: true, min: 0.01 }
  },
  execute: (figma, { x, y, zoom }) => {
    figma.viewport = { center: { x, y }, zoom }
    return { x, y, zoom }
  }
})

export const viewportZoomToFit = defineTool({
  name: 'viewport_zoom_to_fit',
  mutates: true,
  description: 'Zoom viewport to fit specified nodes.',
  params: {
    ids: { type: 'string[]', description: 'Node IDs to fit in view', required: true }
  },
  execute: (figma, { ids }) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of ids) {
      const node = figma.getNodeById(id)
      if (!node) continue
      const bounds = node.absoluteBoundingBox
      minX = Math.min(minX, bounds.x)
      minY = Math.min(minY, bounds.y)
      maxX = Math.max(maxX, bounds.x + bounds.width)
      maxY = Math.max(maxY, bounds.y + bounds.height)
    }
    if (minX === Infinity) return { error: 'No valid nodes found' }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    figma.viewport = { center: { x: cx, y: cy }, zoom: 1 }
    return {
      center: { x: cx, y: cy },
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
  }
})

export const exportSvg = defineTool({
  name: 'export_svg',
  description: 'Export nodes as SVG markup. Returns the SVG string.',
  params: {
    ids: {
      type: 'string[]',
      description: 'Node IDs to export. Omit to export all top-level nodes on the current page.'
    }
  },
  execute: async (figma, args) => {
    const { renderNodesToSVG } = await import('../svg-export/index.js')
    const pageId = figma.currentPageId
    const ids =
      args.ids && args.ids.length > 0
        ? args.ids
        : figma.currentPage.children.map((n) => n.id)
    const svg = renderNodesToSVG(figma.graph, pageId, ids)
    if (!svg) return { error: 'No visible nodes to export' }
    return { svg }
  }
})

export const exportImage = defineTool({
  name: 'export_image',
  description:
    'Export nodes as a raster image (PNG, JPG, or WEBP). Returns base64-encoded image data. Use to visually verify designs.',
  params: {
    ids: {
      type: 'string[]',
      description: 'Node IDs to export. Omit to export all top-level nodes on the current page.'
    },
    format: {
      type: 'string',
      description: 'Image format',
      enum: ['PNG', 'JPG', 'WEBP'],
      default: 'PNG'
    },
    scale: {
      type: 'number',
      description: 'Export scale multiplier (default: 1)',
      default: 1,
      min: 0.1,
      max: 4
    }
  },
  execute: async (figma, args) => {
    if (!figma.exportImage) {
      return { error: 'Image export is not available in this environment' }
    }
    const ids =
      args.ids && args.ids.length > 0
        ? args.ids
        : figma.currentPage.children.map((n) => n.id)
    const format = (args.format ?? 'PNG').toUpperCase() as 'PNG' | 'JPG' | 'WEBP'
    const data = await figma.exportImage(ids, {
      scale: args.scale ?? 1,
      format
    })
    if (!data || data.length === 0) return { error: 'No visible nodes to export' }
    const base64 = uint8ArrayToBase64(data)
    const mimeMap = { PNG: 'image/png', JPG: 'image/jpeg', WEBP: 'image/webp' } as const
    return {
      mimeType: mimeMap[format],
      base64,
      byteLength: data.length
    }
  }
})

export const takeScreenshot = defineTool({
  name: 'take_screenshot',
  highlights: true,
  description:
    'Capture a screenshot-style raster image of the current page, current selection, or explicit node IDs. Use this to compare the current design state with a reference image attachment.',
  params: {
    ids: {
      type: 'string[]',
      description: 'Specific node IDs to capture. Overrides target when provided.'
    },
    target: {
      type: 'string',
      description: 'Capture scope when ids are omitted',
      enum: ['PAGE', 'SELECTION'],
      default: 'PAGE'
    },
    format: {
      type: 'string',
      description: 'Image format',
      enum: ['PNG', 'JPG', 'WEBP'],
      default: 'PNG'
    },
    scale: {
      type: 'number',
      description: 'Capture scale multiplier (default: 1)',
      default: 1,
      min: 0.1,
      max: 4
    },
    max_long_edge: {
      type: 'number',
      description:
        'Optional maximum output size for the longest image edge in pixels. Defaults to 2000 for AI-safe comparison captures.',
      default: 2000,
      min: 256,
      max: 8192
    }
  },
  execute: async (figma, args) => {
    if (!figma.exportImage) {
      return { error: 'Image export is not available in this environment' }
    }

    const target = (args.target as string).toUpperCase() as 'PAGE' | 'SELECTION'
    const explicitIds =
      args.ids?.filter((id): id is string => typeof id === 'string' && id.length > 0) ?? []
    let screenshotNodes: FigmaNodeProxy[]
    if (explicitIds.length > 0) {
      screenshotNodes = explicitIds
        .map((id) => figma.getNodeById(id))
        .filter((node): node is FigmaNodeProxy => node !== null)
    } else if (target === 'SELECTION') {
      screenshotNodes = [...figma.currentPage.selection]
    } else {
      screenshotNodes = [...figma.currentPage.children]
    }
    const screenshotIds = screenshotNodes.map((node) => node.id)

    if (screenshotIds.length === 0) {
      let error = 'No visible nodes on the current page to capture'
      if (explicitIds.length > 0) error = 'No valid nodes to capture'
      else if (target === 'SELECTION') error = 'No selected nodes to capture'
      return {
        error
      }
    }

    const format = (args.format as string).toUpperCase() as 'PNG' | 'JPG' | 'WEBP'
    const requestedScale = args.scale ?? 1
    const maxLongEdge = args.max_long_edge ?? 2000
    const effectiveScale = resolveCaptureScale(screenshotNodes, requestedScale, maxLongEdge)
    const data = await figma.exportImage(screenshotIds, {
      scale: effectiveScale,
      format
    })
    if (!data || data.length === 0) return { error: 'No visible nodes to capture' }

    const base64 = uint8ArrayToBase64(data)
    const mimeMap = { PNG: 'image/png', JPG: 'image/jpeg', WEBP: 'image/webp' } as const
    const resolvedTarget = explicitIds.length > 0 ? 'NODES' : target
    const captureHighlight = buildCaptureHighlight(resolvedTarget, screenshotNodes)

    return {
      target: resolvedTarget,
      highlightIds: screenshotIds,
      ...(captureHighlight ? { captureHighlight } : {}),
      mimeType: mimeMap[format],
      base64,
      byteLength: data.length,
      scale: effectiveScale,
      requestedScale
    }
  }
})
