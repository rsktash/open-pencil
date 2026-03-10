export const FIG_KIWI_VERSION = 106

import { deflateSync, inflateSync } from 'fflate'

import { weightToStyle } from './fonts'
import { encodeVectorNetworkBlob } from './vector'

import type { NodeChange, Paint } from './kiwi/codec'
import type { SceneGraph, SceneNode, CharacterStyleOverride, NodeType } from './scene-graph'
import type { GUID } from './types'

type KiwiNodeChange = NodeChange & Record<string, unknown>
export interface KiwiSerializeOptions {
  imageHashMap?: ReadonlyMap<string, string>
  fontStyleFormatter?: (weight: number, italic?: boolean) => string
  typeOverrides?: ReadonlyMap<string, NodeType>
}

export function parseFigKiwiChunks(binary: Uint8Array): Uint8Array[] | null {
  const header = new TextDecoder().decode(binary.slice(0, 8))
  if (header !== 'fig-kiwi') return null

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  let offset = 12

  const chunks: Uint8Array[] = []
  while (offset < binary.length) {
    const chunkLen = view.getUint32(offset, true)
    offset += 4
    chunks.push(binary.slice(offset, offset + chunkLen))
    offset += chunkLen
  }
  return chunks.length >= 2 ? chunks : null
}

export function decompressFigKiwiData(compressed: Uint8Array): Uint8Array {
  try {
    return inflateSync(compressed)
  } catch {
    throw new Error('Failed to decompress fig-kiwi data (try async variant for Zstd)')
  }
}

export async function decompressFigKiwiDataAsync(compressed: Uint8Array): Promise<Uint8Array> {
  try {
    return inflateSync(compressed)
  } catch {
    const fzstd = await import('fzstd')
    return fzstd.decompress(compressed)
  }
}

export function buildFigKiwi(schemaDeflated: Uint8Array, dataRaw: Uint8Array): Uint8Array {
  const dataDeflated = deflateSync(dataRaw)

  const total = 8 + 4 + 4 + schemaDeflated.length + 4 + dataDeflated.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)

  out.set(new TextEncoder().encode('fig-kiwi'), 0)
  view.setUint32(8, FIG_KIWI_VERSION, true)

  let offset = 12
  view.setUint32(offset, schemaDeflated.length, true)
  offset += 4
  out.set(schemaDeflated, offset)
  offset += schemaDeflated.length

  view.setUint32(offset, dataDeflated.length, true)
  offset += 4
  out.set(dataDeflated, offset)

  return out
}

export function mapToFigmaType(type: SceneNode['type']): string {
  switch (type) {
    case 'FRAME':
      return 'FRAME'
    case 'RECTANGLE':
      return 'RECTANGLE'
    case 'ROUNDED_RECTANGLE':
      return 'ROUNDED_RECTANGLE'
    case 'ELLIPSE':
      return 'ELLIPSE'
    case 'TEXT':
      return 'TEXT'
    case 'LINE':
      return 'LINE'
    case 'STAR':
      return 'STAR'
    case 'POLYGON':
      return 'REGULAR_POLYGON'
    case 'VECTOR':
      return 'VECTOR'
    case 'GROUP':
      return 'FRAME'
    case 'SECTION':
      return 'SECTION'
    case 'COMPONENT':
      return 'SYMBOL'
    case 'COMPONENT_SET':
      return 'SYMBOL'
    case 'INSTANCE':
      return 'INSTANCE'
    case 'CONNECTOR':
      return 'CONNECTOR'
    case 'SHAPE_WITH_TEXT':
      return 'SHAPE_WITH_TEXT'
    default:
      return 'RECTANGLE'
  }
}

export function fractionalPosition(index: number): string {
  return String.fromCharCode('!'.charCodeAt(0) + index)
}

function formatSerializedFontStyle(
  weight: number | undefined,
  italic: boolean | undefined,
  options: KiwiSerializeOptions
): string {
  return (options.fontStyleFormatter ?? weightToStyle)(weight ?? 400, italic ?? false)
}

function exportTextData(node: SceneNode, options: KiwiSerializeOptions): NodeChange['textData'] {
  const runs = node.styleRuns
  if (runs.length === 0) {
    return { characters: node.text }
  }

  const charIds = Array.from<number>({ length: node.text.length }).fill(0)
  const styleMap = new Map<string, { id: number; style: CharacterStyleOverride }>()
  let nextId = 1

  for (const run of runs) {
    const key = JSON.stringify(run.style)
    let entry = styleMap.get(key)
    if (!entry) {
      entry = { id: nextId++, style: run.style }
      styleMap.set(key, entry)
    }
    for (let i = run.start; i < run.start + run.length && i < charIds.length; i++) {
      charIds[i] = entry.id
    }
  }

  const overrideTable: NodeChange[] = []
  for (const { id, style } of styleMap.values()) {
    const override: Record<string, unknown> = { styleID: id }
    const weight = style.fontWeight ?? node.fontWeight
    const italic = style.italic ?? node.italic
    override.fontName = {
      family: style.fontFamily ?? node.fontFamily,
      style: formatSerializedFontStyle(weight, italic, options),
      postscript: ''
    }
    if (style.fontSize !== undefined) override.fontSize = style.fontSize
    if (style.letterSpacing !== undefined) {
      override.letterSpacing = { value: style.letterSpacing, units: 'PIXELS' }
    }
    if (style.lineHeight !== undefined && style.lineHeight !== null) {
      override.lineHeight = { value: style.lineHeight, units: 'PIXELS' }
    }
    if (style.textDecoration) override.textDecoration = style.textDecoration
    overrideTable.push(override as unknown as NodeChange)
  }

  return {
    characters: node.text,
    characterStyleIDs: charIds,
    styleOverrideTable: overrideTable
  }
}

function buildFillPaints(node: SceneNode, options: KiwiSerializeOptions): Paint[] {
  return node.fills.map((fill) => {
    const serializedImageHash = fill.imageHash
      ? (options.imageHashMap?.get(fill.imageHash) ?? fill.imageHash)
      : null
    const paint: Paint = {
      type: fill.type,
      color: fill.color,
      opacity: fill.opacity,
      visible: fill.visible,
      blendMode: fill.blendMode ?? 'NORMAL'
    }
    if (fill.gradientStops) {
      paint.stops = fill.gradientStops.map((stop) => ({
        color: stop.color,
        position: stop.position
      }))
    }
    if (fill.gradientTransform) paint.transform = fill.gradientTransform
    if (serializedImageHash) paint.image = { hash: serializedImageHash }
    if (fill.imageScaleMode) paint.imageScaleMode = fill.imageScaleMode
    if (fill.imageTransform) paint.transform = fill.imageTransform
    return paint
  })
}

function buildStrokePaints(node: SceneNode): Paint[] {
  return node.strokes.map((stroke) => ({
    type: 'SOLID',
    color: stroke.color,
    opacity: stroke.opacity,
    visible: stroke.visible,
    blendMode: 'NORMAL'
  }))
}

function createBaseNodeChange(
  node: SceneNode,
  parentGuid: GUID,
  childIndex: number,
  guid: GUID,
  serializedType: NodeType
): KiwiNodeChange {
  const sx = node.flipX ? -1 : 1
  const cos = Math.cos((node.rotation * Math.PI) / 180)
  const sin = Math.sin((node.rotation * Math.PI) / 180)
  return {
    guid,
    parentIndex: { guid: parentGuid, position: fractionalPosition(childIndex) },
    type: mapToFigmaType(serializedType),
    name: node.name,
    visible: node.visible,
    opacity: node.opacity,
    phase: 'CREATED',
    size: { x: node.width, y: node.height },
    transform: { m00: cos * sx, m01: -sin, m02: node.x, m10: sin * sx, m11: cos, m12: node.y },
    strokeWeight: node.strokes.length > 0 ? node.strokes[0].weight : 1,
    strokeAlign: node.strokes.length > 0 ? node.strokes[0].align : 'INSIDE'
  }
}

function applyStrokeWeights(target: KiwiNodeChange, node: SceneNode): void {
  if (!node.independentStrokeWeights) return
  target.borderStrokeWeightsIndependent = true
  target.borderTopWeight = node.borderTopWeight
  target.borderRightWeight = node.borderRightWeight
  target.borderBottomWeight = node.borderBottomWeight
  target.borderLeftWeight = node.borderLeftWeight
}

function applyPaints(target: KiwiNodeChange, fillPaints: Paint[], strokePaints: Paint[]): void {
  if (fillPaints.length > 0) target.fillPaints = fillPaints
  if (strokePaints.length > 0) target.strokePaints = strokePaints
}

function applyCornerData(target: KiwiNodeChange, node: SceneNode): void {
  if (node.cornerRadius <= 0 && !node.independentCorners) return
  target.cornerRadius = node.cornerRadius
  target.rectangleCornerRadiiIndependent = node.independentCorners
  target.rectangleTopLeftCornerRadius = node.independentCorners
    ? node.topLeftRadius
    : node.cornerRadius
  target.rectangleTopRightCornerRadius = node.independentCorners
    ? node.topRightRadius
    : node.cornerRadius
  target.rectangleBottomLeftCornerRadius = node.independentCorners
    ? node.bottomLeftRadius
    : node.cornerRadius
  target.rectangleBottomRightCornerRadius = node.independentCorners
    ? node.bottomRightRadius
    : node.cornerRadius
}

function applyCornerSmoothing(target: KiwiNodeChange, node: SceneNode): void {
  if (node.cornerSmoothing > 0) {
    target.cornerSmoothing = node.cornerSmoothing
  }
}

function applyEffects(target: KiwiNodeChange, node: SceneNode): void {
  if (node.effects.length === 0) return
  target.effects = node.effects.map((effect) => ({
    type: effect.type === 'LAYER_BLUR' ? 'FOREGROUND_BLUR' : effect.type,
    color: effect.color,
    offset: effect.offset,
    radius: effect.radius,
    spread: effect.spread,
    visible: effect.visible
  }))
}

function applyTextData(
  target: KiwiNodeChange,
  node: SceneNode,
  options: KiwiSerializeOptions
): void {
  if (node.type !== 'TEXT') return
  target.fontSize = node.fontSize
  target.fontName = {
    family: node.fontFamily,
    style: formatSerializedFontStyle(node.fontWeight, node.italic, options),
    postscript: ''
  }
  target.textData = exportTextData(node, options)
  target.textAutoResize = node.textAutoResize
  target.textAlignHorizontal = node.textAlignHorizontal
  if (node.lineHeight != null) target.lineHeight = { value: node.lineHeight, units: 'PIXELS' }
  if (node.letterSpacing !== 0) {
    target.letterSpacing = { value: node.letterSpacing, units: 'PIXELS' }
  }
  if (node.textDecoration !== 'NONE') {
    target.textDecoration = node.textDecoration === 'UNDERLINE' ? 'UNDERLINE' : 'STRIKETHROUGH'
  }
}

function isFrameLike(type: SceneNode['type']): boolean {
  return (
    type === 'FRAME' ||
    type === 'GROUP' ||
    type === 'COMPONENT' ||
    type === 'COMPONENT_SET' ||
    type === 'INSTANCE' ||
    type === 'SECTION'
  )
}

function applyFrameData(target: KiwiNodeChange, node: SceneNode): void {
  if (!isFrameLike(node.type)) return
  target.frameMaskDisabled = node.type === 'GROUP' ? true : !node.clipsContent
  if (node.clipsContent) target.clipsContent = true
}

function applyLayoutData(target: KiwiNodeChange, node: SceneNode): void {
  if (node.layoutMode !== 'NONE' && node.layoutMode !== 'GRID') {
    target.stackMode = node.layoutMode
    target.stackSpacing = node.itemSpacing
    target.stackVerticalPadding = node.paddingTop
    target.stackHorizontalPadding = node.paddingLeft
    target.stackPaddingBottom = node.paddingBottom
    target.stackPaddingRight = node.paddingRight
    target.stackPrimarySizing = node.primaryAxisSizing === 'HUG' ? 'RESIZE_TO_FIT' : 'FIXED'
    target.stackCounterSizing = node.counterAxisSizing === 'HUG' ? 'RESIZE_TO_FIT' : 'FIXED'
    target.stackPrimaryAlignItems = node.primaryAxisAlign
    target.stackCounterAlignItems = node.counterAxisAlign
    if (node.layoutWrap === 'WRAP') target.stackWrap = 'WRAP'
    if (node.counterAxisSpacing > 0) target.stackCounterSpacing = node.counterAxisSpacing
  }

  if (node.layoutPositioning === 'ABSOLUTE') target.stackPositioning = 'ABSOLUTE'
  if (node.layoutGrow > 0) target.stackChildPrimaryGrow = node.layoutGrow
}

function applyVectorData(target: KiwiNodeChange, node: SceneNode, blobs: Uint8Array[]): void {
  if (!node.vectorNetwork || node.type !== 'VECTOR') return
  const blobIndex = blobs.length
  blobs.push(encodeVectorNetworkBlob(node.vectorNetwork))
  target.vectorData = {
    vectorNetworkBlob: blobIndex,
    normalizedSize: { x: node.width, y: node.height }
  }
}

function mapGeometryBlobs(
  geometry: SceneNode['fillGeometry'],
  blobs: Uint8Array[]
): Array<{ windingRule: string; commandsBlob: number }> {
  return geometry.map((path) => {
    const blobIndex = blobs.length
    blobs.push(path.commandsBlob)
    return { windingRule: path.windingRule, commandsBlob: blobIndex }
  })
}

function applyGeometryData(target: KiwiNodeChange, node: SceneNode, blobs: Uint8Array[]): void {
  if (node.fillGeometry.length > 0) {
    target.fillGeometry = mapGeometryBlobs(node.fillGeometry, blobs)
  }
  if (node.strokeGeometry.length > 0) {
    target.strokeGeometry = mapGeometryBlobs(node.strokeGeometry, blobs)
  }
}

export function sceneNodeToKiwi(
  node: SceneNode,
  parentGuid: GUID,
  childIndex: number,
  localIdCounter: { value: number },
  graph: SceneGraph,
  blobs: Uint8Array[],
  options: KiwiSerializeOptions = {}
): KiwiNodeChange[] {
  const localID = localIdCounter.value++
  const guid = { sessionID: 1, localID }
  const serializedType = options.typeOverrides?.get(node.id) ?? node.type
  const fillPaints = buildFillPaints(node, options)
  const strokePaints = buildStrokePaints(node)
  const nc = createBaseNodeChange(node, parentGuid, childIndex, guid, serializedType)

  applyStrokeWeights(nc, node)
  applyPaints(nc, fillPaints, strokePaints)
  applyCornerData(nc, node)
  applyCornerSmoothing(nc, node)
  applyEffects(nc, node)
  applyTextData(nc, node, options)
  applyFrameData(nc, node)
  applyLayoutData(nc, node)
  applyVectorData(nc, node, blobs)
  applyGeometryData(nc, node, blobs)

  const result: KiwiNodeChange[] = [nc]
  const children = graph.getChildren(node.id)
  for (let i = 0; i < children.length; i++) {
    result.push(...sceneNodeToKiwi(children[i], guid, i, localIdCounter, graph, blobs, options))
  }

  return result
}
