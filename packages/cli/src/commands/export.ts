import { basename, extname, resolve } from 'node:path'

import { defineCommand } from 'citty'

import { exportFigFile, renderNodesToSVG, sceneNodeToJSX, selectionToJSX } from '@open-pencil/core'

import { isAppMode, requireFile, rpc } from '../app-client'
import { ok, printError } from '../format'
import { loadDocument, loadFonts, exportNodes, exportThumbnail } from '../headless'

import type { ExportFormat, ExportTarget, JSXFormat } from '@open-pencil/core'

const RASTER_FORMATS = ['PNG', 'JPG', 'WEBP']
const ALL_FORMATS = [...RASTER_FORMATS, 'SVG', 'JSX', 'FIG']
const FIG_TARGETS = ['openpencil', 'figma'] as const
const JSX_STYLES = ['openpencil', 'tailwind']

interface ExportArgs {
  file?: string
  output?: string
  format: string
  scale: string
  quality?: string
  page?: string
  node?: string
  style: string
  target: string
  thumbnail?: boolean
  width: string
  height: string
}

function fail(message: string): never {
  printError(message)
  process.exit(1)
}

function resolveOutput(pathOrDefault: string) {
  return resolve(pathOrDefault)
}

async function writeExported(output: string, data: string | Uint8Array) {
  await Bun.write(output, data)
  const size = typeof data === 'string' ? data.length : data.length
  console.log(ok(`Exported ${output} (${(size / 1024).toFixed(1)} KB)`))
}

function validateArgs(args: ExportArgs): ExportFormat | 'JSX' | 'FIG' {
  const format = args.format.toUpperCase() as ExportFormat | 'JSX' | 'FIG'
  if (!ALL_FORMATS.includes(format)) {
    fail(`Invalid format "${args.format}". Use png, jpg, webp, svg, jsx, or fig.`)
  }
  if (format === 'JSX' && !JSX_STYLES.includes(args.style)) {
    fail(`Invalid JSX style "${args.style}". Use openpencil or tailwind.`)
  }
  if (format === 'FIG' && !FIG_TARGETS.includes(args.target as (typeof FIG_TARGETS)[number])) {
    fail(`Invalid fig target "${args.target}". Use openpencil or figma.`)
  }
  return format
}

function getRasterExtension(format: ExportFormat | 'JSX' | 'FIG' | 'SVG') {
  return format.toLowerCase() === 'jpg' ? 'jpg' : format.toLowerCase()
}

async function exportFromApp(args: ExportArgs, format: ExportFormat | 'JSX' | 'FIG') {
  if (format === 'FIG') {
    fail('FIG export is only supported from a file path right now.')
  }

  if (format === 'SVG') {
    const result = await rpc<{ svg: string }>('tool', {
      name: 'export_svg',
      args: { ids: args.node ? [args.node] : undefined }
    })
    if (!result.svg) fail('Nothing to export.')
    await writeExported(resolveOutput(args.output || 'export.svg'), result.svg)
    return
  }

  if (format === 'JSX') {
    const result = await rpc<{ jsx: string }>('export_jsx', {
      nodeIds: args.node ? [args.node] : undefined,
      style: args.style
    })
    if (!result.jsx) fail('Nothing to export.')
    await writeExported(resolveOutput(args.output || 'export.jsx'), result.jsx)
    return
  }

  const result = await rpc<{ base64: string }>('export', {
    nodeIds: args.node ? [args.node] : undefined,
    scale: Number(args.scale),
    format: format.toLowerCase()
  })
  const data = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))
  const output = resolveOutput(args.output || `export.${getRasterExtension(format)}`)
  await writeExported(output, data)
}

async function exportJSXToFile(
  defaultName: string,
  args: ExportArgs,
  pageId: string,
  pageChildIds: string[],
  graph: Awaited<ReturnType<typeof loadDocument>>
) {
  const jsxFormat = args.style as JSXFormat
  const nodeIds = args.node ? [args.node] : pageChildIds
  const jsx =
    nodeIds.length === 1
      ? sceneNodeToJSX(nodeIds[0], graph, jsxFormat)
      : selectionToJSX(nodeIds, graph, jsxFormat)
  if (!jsx) fail('Nothing to export (empty page or no visible nodes).')
  await writeExported(resolveOutput(args.output || `${defaultName}.jsx`), jsx)
}

async function exportFigToFile(
  defaultName: string,
  args: ExportArgs,
  graph: Awaited<ReturnType<typeof loadDocument>>
) {
  const output = resolveOutput(args.output || `${defaultName}-${args.target}.fig`)
  const data = await exportFigFile(graph, undefined, undefined, undefined, {
    target: args.target as ExportTarget
  })
  await writeExported(output, data)
}

async function exportSvgToFile(
  output: string,
  args: ExportArgs,
  pageId: string,
  pageChildIds: string[],
  graph: Awaited<ReturnType<typeof loadDocument>>
) {
  const nodeIds = args.node ? [args.node] : pageChildIds
  const svg = renderNodesToSVG(graph, pageId, nodeIds)
  if (!svg) fail('Nothing to export (empty page or no visible nodes).')
  await writeExported(output, svg)
}

async function exportRasterToFile(
  output: string,
  format: ExportFormat,
  args: ExportArgs,
  pageId: string,
  pageChildIds: string[],
  graph: Awaited<ReturnType<typeof loadDocument>>
) {
  const data = args.thumbnail
    ? await exportThumbnail(graph, pageId, Number(args.width), Number(args.height))
    : await exportNodes(graph, pageId, args.node ? [args.node] : pageChildIds, {
        scale: Number(args.scale),
        format,
        quality: args.quality ? Number(args.quality) : undefined
      })
  if (!data) fail('Nothing to export (empty page or no visible nodes).')
  await writeExported(output, data)
}

export default defineCommand({
  meta: { description: 'Export a .fig file to PNG, JPG, WEBP, SVG, JSX, or Figma-compatible .fig' },
  args: {
    file: {
      type: 'positional',
      description: '.fig file path (omit to connect to running app)',
      required: false
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: <name>.<format>)'
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Export format: png, jpg, webp, svg, jsx, fig (default: png)',
      default: 'png'
    },
    scale: { type: 'string', alias: 's', description: 'Export scale (default: 1)', default: '1' },
    quality: {
      type: 'string',
      alias: 'q',
      description: 'Quality 0-100 for JPG/WEBP (default: 90)'
    },
    page: { type: 'string', description: 'Page name (default: first page)' },
    node: { type: 'string', description: 'Node ID to export (default: all top-level nodes)' },
    style: {
      type: 'string',
      description: 'JSX style: openpencil, tailwind (default: openpencil)',
      default: 'openpencil'
    },
    target: {
      type: 'string',
      description: 'Target when exporting .fig: openpencil or figma (default: openpencil)',
      default: 'openpencil'
    },
    thumbnail: { type: 'boolean', description: 'Export page thumbnail instead of full render' },
    width: { type: 'string', description: 'Thumbnail width (default: 1920)', default: '1920' },
    height: { type: 'string', description: 'Thumbnail height (default: 1080)', default: '1080' }
  },
  async run({ args }) {
    const normalizedArgs = args as ExportArgs
    const format = validateArgs(normalizedArgs)

    if (isAppMode(normalizedArgs.file)) {
      await exportFromApp(normalizedArgs, format)
      return
    }

    const file = requireFile(normalizedArgs.file)
    const graph = await loadDocument(file)
    await loadFonts(graph)

    const pages = graph.getPages()
    const page = normalizedArgs.page ? pages.find((p) => p.name === normalizedArgs.page) : pages[0]

    if (!page) {
      fail(`Page "${normalizedArgs.page}" not found.`)
    }

    const defaultName = basename(file, extname(file))
    if (format === 'JSX') {
      await exportJSXToFile(defaultName, normalizedArgs, page.id, page.childIds, graph)
      return
    }

    if (format === 'FIG') {
      await exportFigToFile(defaultName, normalizedArgs, graph)
      return
    }

    const output = resolveOutput(
      normalizedArgs.output || `${defaultName}.${getRasterExtension(format)}`
    )

    if (format === 'SVG') {
      await exportSvgToFile(output, normalizedArgs, page.id, page.childIds, graph)
      return
    }

    await exportRasterToFile(output, format, normalizedArgs, page.id, page.childIds, graph)
  }
})
