import { zipSync, deflateSync } from 'fflate'

import { CANVAS_BG_COLOR, IS_TAURI } from './constants'
import { weightToFigmaStyle } from './fonts'
import { sceneNodeToKiwi, fractionalPosition, buildFigKiwi } from './kiwi-serialize'
import { initCodec, getCompiledSchema, getSchemaBytes } from './kiwi/codec'
import { renderThumbnail } from './render-image'

import type { NodeChange } from './kiwi/codec'
import type { SkiaRenderer } from './renderer'
import { SceneGraph } from './scene-graph'
import type { NodeType, SceneNode } from './scene-graph'
import type { CanvasKit } from 'canvaskit-wasm'

const THUMBNAIL_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

type KiwiNodeChange = NodeChange & Record<string, unknown>
export type ExportTarget = 'openpencil' | 'figma'
export interface FigExportOptions {
  target?: ExportTarget
}

const THUMBNAIL_WIDTH = 400
const THUMBNAIL_HEIGHT = 225

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', Uint8Array.from(bytes))
  return bytesToHex(new Uint8Array(digest))
}

async function buildCanonicalImageHashMap(
  graph: SceneGraph
): Promise<{ hashMap: Map<string, string>; imageEntries: Record<string, readonly [Uint8Array, { level: 0 }]> }> {
  const hashMap = new Map<string, string>()
  const imageEntries: Record<string, readonly [Uint8Array, { level: 0 }]> = {}

  await Promise.all(
    [...graph.images.entries()].map(async ([hash, bytes]) => {
      const canonicalHash = await sha1Hex(bytes)
      hashMap.set(hash, canonicalHash)
      imageEntries[`images/${canonicalHash}`] = [bytes, { level: 0 }]
    })
  )

  return { hashMap, imageEntries }
}

const FIGMA_COMPAT_NODE_TYPES = new Set<NodeType>(['GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'])

function figmaCompatNodeType(node: SceneNode): NodeType {
  return FIGMA_COMPAT_NODE_TYPES.has(node.type) ? 'FRAME' : node.type
}

function buildFigmaCompatGraph(source: SceneGraph): {
  graph: SceneGraph
  typeOverrides: Map<string, NodeType>
} {
  const graph = new SceneGraph()
  const typeOverrides = new Map<string, NodeType>()

  for (const page of graph.getPages(true)) {
    graph.deleteNode(page.id)
  }

  for (const [hash, bytes] of source.images.entries()) {
    graph.images.set(hash, bytes)
  }

  function cloneNode(sourceNodeId: string, parentId: string): void {
    const sourceNode = source.getNode(sourceNodeId)
    if (!sourceNode) return

    const {
      id: _id,
      type: _type,
      parentId: _parentId,
      childIds: _childIds,
      componentId: _componentId,
      overrides: _overrides,
      boundVariables: _boundVariables,
      ...rest
    } = structuredClone(sourceNode)

    const compatType = figmaCompatNodeType(sourceNode)
    const clone = graph.createNode(compatType, parentId, {
      ...rest,
      layoutMode: 'NONE',
      layoutWrap: 'NO_WRAP',
      primaryAxisSizing: 'FIXED',
      counterAxisSizing: 'FIXED',
      itemSpacing: 0,
      counterAxisSpacing: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      layoutPositioning: 'AUTO',
      layoutGrow: 0,
      layoutAlignSelf: 'AUTO',
      componentId: null,
      overrides: {},
      boundVariables: {},
      clipsContent: sourceNode.isMask ? sourceNode.clipsContent : false,
      textAutoResize: sourceNode.textAutoResize
    })
    typeOverrides.set(clone.id, compatType)

    for (const childId of sourceNode.childIds) {
      cloneNode(childId, clone.id)
    }
  }

  for (const sourcePage of source.getPages(true)) {
    const targetPage = graph.addPage(sourcePage.name)
    targetPage.internalOnly = sourcePage.internalOnly
    typeOverrides.set(targetPage.id, targetPage.type)

    for (const childId of sourcePage.childIds) {
      cloneNode(childId, targetPage.id)
    }
  }

  flattenFigmaCompatWrappers(graph)

  return { graph, typeOverrides }
}

function isFlattenableFigmaWrapper(node: SceneNode, graph: SceneGraph): boolean {
  const parent = node.parentId ? graph.getNode(node.parentId) : null
  return (
    node.type === 'FRAME' &&
    parent?.type !== 'CANVAS' &&
    node.childIds.length > 0 &&
    node.layoutMode === 'NONE' &&
    node.layoutPositioning === 'AUTO' &&
    node.opacity === 1 &&
    node.rotation === 0 &&
    !node.flipX &&
    !node.flipY &&
    !node.clipsContent &&
    !node.isMask &&
    node.blendMode === 'PASS_THROUGH' &&
    node.fills.length === 0 &&
    node.strokes.length === 0 &&
    node.effects.length === 0 &&
    node.cornerRadius === 0 &&
    !node.independentCorners &&
    node.cornerSmoothing === 0 &&
    node.text.length === 0
  )
}

function flattenFigmaCompatWrappers(graph: SceneGraph): void {
  function visit(nodeId: string): void {
    const childIds = [...(graph.getNode(nodeId)?.childIds ?? [])]
    for (const childId of childIds) {
      visit(childId)
    }

    const node = graph.getNode(nodeId)
    if (!node?.parentId || !isFlattenableFigmaWrapper(node, graph)) return

    const parent = graph.getNode(node.parentId)
    if (!parent) return

    let insertIndex = parent.childIds.indexOf(node.id)
    if (insertIndex === -1) return

    const childrenToHoist = [...node.childIds]
    for (const childId of childrenToHoist) {
      graph.reparentNode(childId, parent.id)
      graph.reorderChild(childId, parent.id, insertIndex)
      insertIndex += 1
    }

    graph.deleteNode(node.id)
  }

  for (const page of graph.getPages(true)) {
    for (const childId of page.childIds) {
      visit(childId)
    }
  }
}

export async function exportFigFile(
  graph: SceneGraph,
  ck?: CanvasKit,
  renderer?: SkiaRenderer,
  pageId?: string,
  options: FigExportOptions = {}
): Promise<Uint8Array> {
  const exportTarget = options.target ?? 'openpencil'
  const exportGraph =
    exportTarget === 'figma'
      ? buildFigmaCompatGraph(graph)
      : { graph, typeOverrides: new Map<string, NodeType>() }

  await initCodec()
  const compiled = getCompiledSchema()
  const schemaDeflated = deflateSync(getSchemaBytes())
  const { hashMap: canonicalImageHashMap, imageEntries } = await buildCanonicalImageHashMap(exportGraph.graph)

  const docGuid = { sessionID: 0, localID: 0 }
  const localIdCounter = { value: 2 }

  const nodeChanges: KiwiNodeChange[] = [
    {
      guid: docGuid,
      type: 'DOCUMENT',
      name: 'Document',
      visible: true,
      opacity: 1,
      phase: 'CREATED',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      strokeWeight: 1,
      strokeAlign: 'CENTER',
      strokeJoin: 'MITER',
      documentColorProfile: 'SRGB'
    }
  ]

  const blobs: Uint8Array[] = []
  const pages = exportGraph.graph.getPages(true)

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]
    const canvasLocalID = localIdCounter.value++
    const canvasGuid = { sessionID: 0, localID: canvasLocalID }

    const canvasNc: KiwiNodeChange = {
      guid: canvasGuid,
      parentIndex: { guid: docGuid, position: fractionalPosition(p) },
      type: 'CANVAS',
      name: page.name,
      visible: true,
      opacity: 1,
      phase: 'CREATED',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      strokeWeight: 1,
      strokeAlign: 'CENTER',
      strokeJoin: 'MITER',
      backgroundOpacity: 1,
      backgroundColor: { ...CANVAS_BG_COLOR },
      backgroundEnabled: true
    }
    if (page.internalOnly) canvasNc.internalOnly = true
    nodeChanges.push(canvasNc)

    const children = exportGraph.graph.getChildren(page.id)
    for (let i = 0; i < children.length; i++) {
      nodeChanges.push(
        ...sceneNodeToKiwi(children[i], canvasGuid, i, localIdCounter, exportGraph.graph, blobs, {
          fontStyleFormatter: exportTarget === 'figma' ? weightToFigmaStyle : undefined,
          imageHashMap: canonicalImageHashMap,
          typeOverrides: exportGraph.typeOverrides
        })
      )
    }
  }

  const msg: Record<string, unknown> = {
    type: 'NODE_CHANGES',
    sessionID: 0,
    ackID: 0,
    nodeChanges
  }

  if (blobs.length > 0) {
    msg.blobs = blobs.map((bytes) => ({ bytes }))
  }

  const kiwiData = compiled.encodeMessage(msg)

  const currentPageId = exportTarget === 'figma' ? undefined : pageId ?? pages[0]?.id
  const thumbnailPng =
    (ck && renderer && currentPageId
      ? renderThumbnail(ck, renderer, exportGraph.graph, currentPageId, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
      : null) ?? THUMBNAIL_1X1

  const metaJson = JSON.stringify({
    version: 1,
    app: 'OpenPencil',
    target: exportTarget,
    createdAt: new Date().toISOString()
  })

  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core')
    return new Uint8Array(
      await invoke<number[]>('build_fig_file', {
        schemaDeflated: Array.from(schemaDeflated),
        kiwiData: Array.from(kiwiData),
        thumbnailPng: Array.from(thumbnailPng),
        metaJson,
        images: Object.fromEntries(
          Object.entries(imageEntries).map(([path, [bytes]]) => [path.replace('images/', ''), Array.from(bytes)])
        )
      })
    )
  }

  const canvasData = buildFigKiwi(schemaDeflated, kiwiData)
  return zipSync({
    'canvas.fig': [canvasData, { level: 0 }],
    'thumbnail.png': [thumbnailPng, { level: 0 }],
    'meta.json': new TextEncoder().encode(metaJson),
    ...imageEntries
  })
}
