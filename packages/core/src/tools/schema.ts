/**
 * Tool definition schema.
 *
 * Each tool is defined once with typed params and an execute function
 * that operates on FigmaAPI. Adapters for AI chat (valibot), CLI (citty),
 * and MCP (JSON Schema) are generated from these definitions.
 */

import type { FigmaAPI, FigmaNodeProxy } from '../figma-api'
import type { Rect } from '../types'

export type ParamType = 'string' | 'number' | 'boolean' | 'color' | 'string[]'

export interface ParamDef {
  type: ParamType
  description: string
  required?: boolean
  default?: unknown
  enum?: string[]
  min?: number
  max?: number
}

export interface ToolDef {
  name: string
  description: string
  mutates?: boolean
  highlights?: boolean
  params: Record<string, ParamDef>
  execute: (figma: FigmaAPI, args: Record<string, any>) => unknown
}

export interface ToolCaptureRect extends Rect {
  rotation?: number
}

export interface ToolCaptureHighlight {
  rects: ToolCaptureRect[]
}

type ResolvedType<T extends ParamType> = T extends 'string'
  ? string
  : T extends 'number'
    ? number
    : T extends 'boolean'
      ? boolean
      : T extends 'color'
        ? string
        : T extends 'string[]'
          ? string[]
          : never

type ResolvedParams<P extends Record<string, ParamDef>> = {
  [K in keyof P as P[K]['required'] extends true ? K : never]: ResolvedType<P[K]['type']>
} & {
  [K in keyof P as P[K]['required'] extends true ? never : K]?: ResolvedType<P[K]['type']>
}

export function defineTool<P extends Record<string, ParamDef>>(def: {
  name: string
  description: string
  mutates?: boolean
  highlights?: boolean
  params: P
  execute: (figma: FigmaAPI, args: ResolvedParams<P>) => unknown
}): ToolDef {
  return def as unknown as ToolDef
}

export function nodeToResult(node: FigmaNodeProxy): Record<string, unknown> {
  return node.toJSON()
}

export function nodeSummary(node: FigmaNodeProxy): { id: string; name: string; type: string } {
  return { id: node.id, name: node.name, type: node.type }
}

function extractIdsFromArray(arr: unknown[]): string[] {
  const ids: string[] = []
  for (const item of arr) {
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
      ids.push(item.id)
    }
  }
  return ids
}

export function extractHighlightedNodeIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  if ('deleted' in result && typeof result.deleted === 'string') return []

  const ids: string[] = []
  if ('id' in result && typeof result.id === 'string') ids.push(result.id)
  if ('highlightIds' in result && Array.isArray(result.highlightIds)) {
    ids.push(
      ...result.highlightIds.filter((id): id is string => typeof id === 'string')
    )
  }
  if ('selection' in result && Array.isArray(result.selection)) {
    ids.push(...extractIdsFromArray(result.selection))
  }
  if ('results' in result && Array.isArray(result.results)) {
    ids.push(...extractIdsFromArray(result.results))
  }
  return [...new Set(ids)]
}

export function extractCaptureHighlight(result: unknown): ToolCaptureHighlight | null {
  if (!result || typeof result !== 'object' || !('captureHighlight' in result)) return null
  const captureHighlight = result.captureHighlight
  if (!captureHighlight || typeof captureHighlight !== 'object') return null
  if (!('rects' in captureHighlight) || !Array.isArray(captureHighlight.rects)) return null

  const rects: ToolCaptureRect[] = []
  for (const rect of captureHighlight.rects) {
    if (!rect || typeof rect !== 'object') continue
    const x = 'x' in rect ? rect.x : undefined
    const y = 'y' in rect ? rect.y : undefined
    const width = 'width' in rect ? rect.width : undefined
    const height = 'height' in rect ? rect.height : undefined
    const rotation = 'rotation' in rect ? rect.rotation : undefined
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      continue
    }
    rects.push({
      x,
      y,
      width,
      height,
      ...(typeof rotation === 'number' ? { rotation } : {})
    })
  }

  return rects.length > 0 ? { rects } : null
}
