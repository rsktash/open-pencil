import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const BRIDGE_URL = 'http://127.0.0.1:7600'
const { default: LUCIDE_DATA } = await import('@iconify-json/lucide/icons.json', {
  with: { type: 'json' }
})
const { icons: LUCIDE_ICONS } = LUCIDE_DATA
const SVG_NS = 'http://www.w3.org/2000/svg'
const SPECIAL_ICON_SVGS = {
  apple: `
    <svg xmlns="${SVG_NS}" viewBox="0 0 24 24" fill="none">
      <path d="M15.6 3.4c-.8 1-2.1 1.8-3.2 1.7-.2-1.2.4-2.4 1.1-3.2.8-.9 2.1-1.6 3.2-1.7.1 1.3-.4 2.4-1.1 3.2Z" fill="CURRENT_COLOR"/>
      <path d="M18.7 12.8c0-2.7 2.2-4 2.3-4.1-1.2-1.8-3-2-3.7-2-.4 0-1.4.1-2.5.7-.5.2-1 .4-1.5.4-.5 0-1-.1-1.5-.4-1-.5-2-.7-2.5-.7-1.8 0-5 1.5-5 5.9 0 1.7.6 3.5 1.4 4.9 1 1.8 2.2 3.8 3.8 3.7.8 0 1.3-.2 1.9-.5.6-.2 1.2-.5 2-.5.8 0 1.4.2 2 .5.6.2 1.1.5 1.9.4 1.6 0 2.7-1.8 3.7-3.6.7-1.3 1-2.6 1.1-2.7 0 0-2.2-.8-2.4-4Z" fill="CURRENT_COLOR"/>
    </svg>
  `,
  google: `
    <svg xmlns="${SVG_NS}" viewBox="0 0 24 24" fill="none">
      <path d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.4c-.2 1.2-.9 2.2-1.9 2.8v2.3h3.1c1.8-1.6 3-4 3-6.8Z" fill="#4285F4"/>
      <path d="M12 22c2.7 0 5-.9 6.6-2.5l-3.1-2.3c-.9.6-2 .9-3.5.9-2.7 0-5-1.8-5.8-4.3H3v2.4C4.6 19.5 8 22 12 22Z" fill="#34A853"/>
      <path d="M6.2 13.8c-.2-.6-.3-1.2-.3-1.8s.1-1.2.3-1.8V7.8H3C2.4 9 2 10.5 2 12s.4 3 1 4.2l3.2-2.4Z" fill="#FBBC05"/>
      <path d="M12 5.9c1.4 0 2.7.5 3.7 1.4l2.8-2.8C16.9 3 14.7 2 12 2 8 2 4.6 4.5 3 7.8l3.2 2.4c.8-2.5 3.1-4.3 5.8-4.3Z" fill="#EA4335"/>
    </svg>
  `
}

function parseArgs(argv) {
  const options = {
    source: null,
    only: new Set(),
    includeExisting: false,
    dryRun: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') {
      options.source = argv[++i] ?? null
    } else if (arg === '--only') {
      const value = argv[++i] ?? ''
      for (const part of value.split(',')) {
        const name = part.trim()
        if (name) options.only.add(name)
      }
    } else if (arg === '--include-existing') {
      options.includeExisting = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.source) {
    throw new Error('Usage: node scripts/import-pen-pages-to-live.mjs --source /abs/path/file.pen [--only "Page A,Page B"] [--include-existing] [--dry-run]')
  }

  return options
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sha1(input) {
  return createHash('sha1').update(input).digest('hex')
}

async function getBridgeToken() {
  const response = await fetch(`${BRIDGE_URL}/health`)
  if (!response.ok) {
    throw new Error(`Automation bridge health check failed (${response.status})`)
  }
  const body = await response.json()
  if (body.status !== 'ok' || !body.token) {
    throw new Error('OpenPencil desktop app is not connected. Open a document first.')
  }
  return body.token
}

async function rpc(token, command, args = {}) {
  const response = await fetch(`${BRIDGE_URL}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ command, args })
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.ok === false) {
    const error = body?.error ?? `RPC ${command} failed (${response.status})`
    throw new Error(error)
  }
  return body.result ?? body
}

async function callTool(token, name, args = {}) {
  return rpc(token, 'tool', { name, args })
}

function resolveColorToken(value, variables) {
  if (typeof value !== 'string') return value
  if (!value.startsWith('$')) return value
  const token = variables[value.slice(1)]
  return typeof token === 'string' ? token : '#000000'
}

function resolveStroke(stroke, variables) {
  if (!stroke || typeof stroke !== 'object') return null
  const color = resolveColorToken(stroke.fill, variables)
  if (typeof color !== 'string') return null
  return { fill: color, thickness: typeof stroke.thickness === 'number' ? stroke.thickness : 1 }
}

// oxlint-disable-next-line no-unused-vars -- referenced inside the injected bridge eval source below
function fontWeightToNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  if (value === 'bold') return 700
  if (value === 'medium') return 500
  return 400
}

function escapeSvgText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function iconSvgMarkup(iconName, color, width, height) {
  if (iconName in SPECIAL_ICON_SVGS) {
    return SPECIAL_ICON_SVGS[iconName].replaceAll('CURRENT_COLOR', color)
  }

  const icon = LUCIDE_ICONS[iconName]
  if (icon?.body) {
    return `
      <svg xmlns="${SVG_NS}" viewBox="0 0 24 24" width="${width}" height="${height}" fill="none">
        ${icon.body.replaceAll('currentColor', color)}
      </svg>
    `
  }

  const label = iconName.length === 1 ? iconName.toUpperCase() : iconName.slice(0, 1).toUpperCase()
  const fontSize = Math.max(10, Math.floor(Math.min(width, height) * 0.8))
  return `
    <svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" rx="${Math.floor(Math.min(width, height) / 4)}" fill="transparent"/>
      <text
        x="50%"
        y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="Inter, system-ui, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
        fill="${color}"
      >${escapeSvgText(label)}</text>
    </svg>
  `
}

function buildIconAsset(iconName, color, width, height) {
  const svg = iconSvgMarkup(iconName, color, width, height).trim()
  const base64 = Buffer.from(svg).toString('base64')
  return {
    hash: sha1(svg),
    base64,
    mimeType: 'image/svg+xml',
    width,
    height
  }
}

function expandRefs(node, context, pageName) {
  if (node.type === 'ref') {
    const target = context.components.get(node.ref)
    if (!target) throw new Error(`Missing reusable component "${node.ref}" on ${pageName}`)
    const inlined = deepClone(target)
    inlined.name = node.name || target.name
    delete inlined.x
    delete inlined.y
    return expandRefs(inlined, context, pageName)
  }

  if (node.type === 'icon_font') {
    const color = resolveColorToken(node.fill, context.variables)
    const width = typeof node.width === 'number' ? node.width : 16
    const height = typeof node.height === 'number' ? node.height : 16
    const asset = buildIconAsset(
      node.iconFontName,
      typeof color === 'string' ? color : '#667985',
      width,
      height
    )
    context.iconAssets.set(asset.hash, asset)
    return {
      type: 'rectangle',
      name: node.name,
      width,
      height,
      fill: {
        type: 'image',
        hash: asset.hash,
        mode: 'fit'
      }
    }
  }

  const cloned = deepClone(node)
  if (Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map((child) => expandRefs(child, context, pageName))
  }
  return cloned
}

function normalizeNode(node, context) {
  const next = deepClone(node)

  if (typeof next.fill === 'string') {
    next.fill = resolveColorToken(next.fill, context.variables)
  }
  if (next.stroke) {
    next.stroke = resolveStroke(next.stroke, context.variables)
  }
  if (next.effect && typeof next.effect === 'object' && typeof next.effect.color === 'string') {
    next.effect = { ...next.effect, color: resolveColorToken(next.effect.color, context.variables) }
  }

  if (Array.isArray(next.children)) {
    next.children = next.children.map((child) => normalizeNode(child, context))
  }

  return next
}

function collectImageUrls(node, urls = new Set()) {
  if (node.fill && typeof node.fill === 'object' && node.fill.type === 'image' && typeof node.fill.url === 'string') {
    urls.add(node.fill.url)
  }
  for (const child of node.children ?? []) {
    collectImageUrls(child, urls)
  }
  return urls
}

async function buildImageAssets(sourcePath, urls) {
  const assets = new Map()
  for (const url of urls) {
    const absPath = resolve(dirname(sourcePath), url)
    const bytes = await readFile(absPath)
    const hash = sha1(bytes)
    const ext = absPath.toLowerCase().split('.').pop()
    const mimeType =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png'
    assets.set(url, {
      hash,
      base64: base64FromBytes(bytes),
      mimeType
    })
  }
  return assets
}

function applyImageAssets(node, assets) {
  const next = deepClone(node)
  if (next.fill && typeof next.fill === 'object' && next.fill.type === 'image' && typeof next.fill.url === 'string') {
    const asset = assets.get(next.fill.url)
    if (asset) {
      next.fill = {
        type: 'image',
        hash: asset.hash,
        mode: typeof next.fill.mode === 'string' ? next.fill.mode.toUpperCase() : 'FIT'
      }
    }
  }
  if (Array.isArray(next.children)) {
    next.children = next.children.map((child) => applyImageAssets(child, assets))
  }
  return next
}

function buildImportEvalCode(pageId, pageData, imageAssets, resetPage) {
  return `
const pageId = ${JSON.stringify(pageId)}
const pageData = ${JSON.stringify(pageData)}
const imageAssets = ${JSON.stringify(Object.fromEntries([...imageAssets.values()].map((asset) => [asset.hash, asset])))}
const resetPage = ${JSON.stringify(resetPage)}
const graph = figma.graph
const fontWeightToNumber = ${fontWeightToNumber.toString()}

function parseHex(input) {
  if (typeof input !== 'string') return { r: 0, g: 0, b: 0, a: 1 }
  let hex = input.trim()
  if (!hex.startsWith('#')) return { r: 0, g: 0, b: 0, a: 1 }
  hex = hex.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    hex = hex.split('').map((c) => c + c).join('')
  }
  if (hex.length === 6) hex += 'ff'
  if (hex.length !== 8) return { r: 0, g: 0, b: 0, a: 1 }
  const int = Number.parseInt(hex, 16)
  return {
    r: ((int >> 24) & 255) / 255,
    g: ((int >> 16) & 255) / 255,
    b: ((int >> 8) & 255) / 255,
    a: (int & 255) / 255
  }
}

async function decodeAssetBytes(asset) {
  const binary = atob(asset.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  if (asset.mimeType !== 'image/svg+xml') {
    return bytes
  }

  const blob = new Blob([bytes], { type: asset.mimeType })
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Failed to rasterize SVG icon asset'))
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = asset.width ?? 24
    canvas.height = asset.height ?? 24
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to create icon rasterization canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) throw new Error('Failed to rasterize SVG icon asset')
    return new Uint8Array(await pngBlob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

for (const [hash, asset] of Object.entries(imageAssets)) {
  if (graph.images.get(hash)) continue
  const bytes = await decodeAssetBytes(asset)
  graph.images.set(hash, bytes)
}

function makeFill(fill) {
  if (!fill) return []
  if (typeof fill === 'string') {
    const color = parseHex(fill)
    return [{ type: 'SOLID', color, opacity: color.a, visible: true }]
  }
  if (typeof fill === 'object' && fill.type === 'image' && fill.hash) {
    return [{
      type: 'IMAGE',
      color: { r: 1, g: 1, b: 1, a: 1 },
      opacity: 1,
      visible: true,
      imageHash: fill.hash,
      imageScaleMode: fill.mode === 'FILL' ? 'FILL' : 'FIT'
    }]
  }
  return []
}

function makeStroke(stroke) {
  if (!stroke || typeof stroke.fill !== 'string') return []
  const color = parseHex(stroke.fill)
  return [{
    color,
    weight: typeof stroke.thickness === 'number' ? stroke.thickness : 1,
    opacity: color.a,
    visible: true,
    align: 'INSIDE'
  }]
}

function makeEffects(effect) {
  if (!effect || effect.type !== 'shadow' || effect.shadowType !== 'outer' || typeof effect.color !== 'string') {
    return []
  }
  const color = parseHex(effect.color)
  return [{
    type: 'DROP_SHADOW',
    color,
    offset: { x: effect.offset?.x ?? 0, y: effect.offset?.y ?? 0 },
    radius: effect.blur ?? 0,
    spread: 0,
    visible: true
  }]
}

function measureTextNode(raw) {
  const fontSize = typeof raw.fontSize === 'number' ? raw.fontSize : 14
  const fontWeight = fontWeightToNumber(raw.fontWeight)
  const fontFamily = typeof raw.fontFamily === 'string' ? raw.fontFamily : 'Inter'
  const lines = String(raw.content ?? '').split('\\n')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    const fallbackWidth = Math.max(8, ...lines.map((line) => Math.ceil(line.length * fontSize * 0.52)))
    return { width: fallbackWidth, height: Math.ceil(lines.length * fontSize * 1.25) }
  }
  ctx.font = String(fontWeight) + ' ' + String(fontSize) + 'px "' + fontFamily + '"'
  const width = Math.max(8, ...lines.map((line) => Math.ceil(ctx.measureText(line || ' ').width)))
  const lineHeight = typeof raw.lineHeight === 'number' ? raw.lineHeight : fontSize * 1.25
  return { width, height: Math.max(fontSize, Math.ceil(lines.length * lineHeight)) }
}

function mapType(type) {
  if (type === 'frame') return 'FRAME'
  if (type === 'rectangle') return 'RECTANGLE'
  if (type === 'line') return 'LINE'
  if (type === 'text') return 'TEXT'
  return 'FRAME'
}

function applyPadding(raw, overrides) {
  const padding = raw.padding
  if (typeof padding === 'number') {
    overrides.paddingTop = padding
    overrides.paddingRight = padding
    overrides.paddingBottom = padding
    overrides.paddingLeft = padding
    return
  }
  if (!Array.isArray(padding)) return
  if (padding.length === 2) {
    overrides.paddingTop = padding[0]
    overrides.paddingBottom = padding[0]
    overrides.paddingLeft = padding[1]
    overrides.paddingRight = padding[1]
    return
  }
  if (padding.length === 4) {
    overrides.paddingTop = padding[0]
    overrides.paddingRight = padding[1]
    overrides.paddingBottom = padding[2]
    overrides.paddingLeft = padding[3]
  }
}

function mapLayout(raw, overrides) {
  if (raw.layout === 'vertical') {
    overrides.layoutMode = 'VERTICAL'
  } else if (raw.layout === 'horizontal') {
    overrides.layoutMode = 'HORIZONTAL'
  } else {
    const children = Array.isArray(raw.children) ? raw.children : []
    const inferAutoLayout =
      raw.type === 'frame' &&
      children.length > 0 &&
      children.every((child) => typeof child.x !== 'number' && typeof child.y !== 'number')
    if (!inferAutoLayout) return
    overrides.layoutMode = 'HORIZONTAL'
  }

  const isVertical = overrides.layoutMode === 'VERTICAL'
  overrides.primaryAxisSizing = isVertical
    ? (typeof raw.height === 'number' ? 'FIXED' : 'HUG')
    : (typeof raw.width === 'number' ? 'FIXED' : 'HUG')
  overrides.counterAxisSizing = isVertical
    ? (typeof raw.width === 'number' ? 'FIXED' : 'HUG')
    : (typeof raw.height === 'number' ? 'FIXED' : 'HUG')

  if (typeof raw.gap === 'number') overrides.itemSpacing = raw.gap
  if (raw.justifyContent === 'center') overrides.primaryAxisAlign = 'CENTER'
  else if (raw.justifyContent === 'end') overrides.primaryAxisAlign = 'MAX'
  else if (raw.justifyContent === 'space-between' || raw.justifyContent === 'space_between') overrides.primaryAxisAlign = 'SPACE_BETWEEN'
  else overrides.primaryAxisAlign = 'MIN'

  if (raw.alignItems === 'center') overrides.counterAxisAlign = 'CENTER'
  else if (raw.alignItems === 'end') overrides.counterAxisAlign = 'MAX'
  else if (raw.alignItems === 'stretch') overrides.counterAxisAlign = 'STRETCH'
  else overrides.counterAxisAlign = 'MIN'

  applyPadding(raw, overrides)
}

function applySizing(raw, overrides, parentLayout) {
  if (typeof raw.width === 'number') overrides.width = raw.width
  if (typeof raw.height === 'number') overrides.height = raw.height

  if (raw.width === 'fill_container') {
    if (overrides.layoutMode === 'HORIZONTAL') overrides.primaryAxisSizing = 'FILL'
    else if (overrides.layoutMode === 'VERTICAL') overrides.counterAxisSizing = 'FILL'

    if (parentLayout === 'VERTICAL') overrides.layoutAlignSelf = 'STRETCH'
    if (parentLayout === 'HORIZONTAL') overrides.layoutGrow = 1
  }
  if (raw.height === 'fill_container') {
    if (overrides.layoutMode === 'HORIZONTAL') overrides.counterAxisSizing = 'FILL'
    else if (overrides.layoutMode === 'VERTICAL') overrides.primaryAxisSizing = 'FILL'

    if (parentLayout === 'HORIZONTAL') overrides.layoutAlignSelf = 'STRETCH'
    if (parentLayout === 'VERTICAL') overrides.layoutGrow = 1
  }
}

function importNode(raw, parentId, parentLayout, isRoot = false) {
  const overrides = {
    name: raw.name ?? raw.type,
    fills: makeFill(raw.fill),
    strokes: makeStroke(raw.stroke),
    effects: makeEffects(raw.effect)
  }

  if (!isRoot && typeof raw.x === 'number') overrides.x = raw.x
  if (!isRoot && typeof raw.y === 'number') overrides.y = raw.y
  if (typeof raw.cornerRadius === 'number') overrides.cornerRadius = raw.cornerRadius
  if (raw.clip === true) overrides.clipsContent = true

  mapLayout(raw, overrides)
  applySizing(raw, overrides, parentLayout)

  if (raw.type === 'text') {
    overrides.text = String(raw.content ?? '')
    if (typeof raw.fontFamily === 'string') overrides.fontFamily = raw.fontFamily
    if (typeof raw.fontSize === 'number') overrides.fontSize = raw.fontSize
    overrides.fontWeight = fontWeightToNumber(raw.fontWeight)
    if (typeof raw.letterSpacing === 'number') overrides.letterSpacing = raw.letterSpacing
    if (raw.textAlign === 'center') overrides.textAlignHorizontal = 'CENTER'
    else if (raw.textAlign === 'right') overrides.textAlignHorizontal = 'RIGHT'
    else overrides.textAlignHorizontal = 'LEFT'
    const measuredText = measureTextNode(raw)
    if (typeof raw.width !== 'number') overrides.width = measuredText.width
    if (typeof raw.height !== 'number') overrides.height = measuredText.height
    overrides.textAutoResize = typeof raw.width === 'number' ? 'HEIGHT' : 'WIDTH_AND_HEIGHT'
  }

  const node = graph.createNode(mapType(raw.type), parentId, overrides)
  const nextParentLayout = overrides.layoutMode ?? 'NONE'
  for (const child of raw.children ?? []) {
    importNode(child, node.id, nextParentLayout)
  }
  return node.id
}

const page = graph.getNode(pageId)
if (!page) throw new Error('Page not found: ' + pageId)
if (resetPage) {
  for (const childId of [...page.childIds]) graph.deleteNode(childId)
}
const rootId = importNode(pageData, pageId, 'NONE', true)
return { id: rootId, name: pageData.name ?? 'Imported root' }
`
}

function buildDeleteEmptyPlaceholderPageCode(pageName) {
  return `
const placeholderName = ${JSON.stringify(pageName)}
const pages = figma.graph.getPages(true)
const placeholder = pages.find((page) => page.name === placeholderName)
if (!placeholder) return { deleted: false, reason: 'missing' }
if (placeholder.childIds.length > 0) return { deleted: false, reason: 'not-empty', id: placeholder.id }
if (pages.length <= 1) return { deleted: false, reason: 'single-page', id: placeholder.id }
figma.graph.deleteNode(placeholder.id)
return { deleted: true, id: placeholder.id }
`
}

function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sourcePath = resolve(options.source)
  const token = await getBridgeToken()
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const variables = Object.fromEntries(
    Object.entries(source.variables ?? {}).map(([key, value]) => [key, value?.value ?? null])
  )
  const components = new Map(
    (source.children ?? [])
      .filter((child) => child?.reusable === true)
      .map((child) => [child.id, deepClone(child)])
  )

  const livePages = await rpc(token, 'pages', {})
  const existingNames = new Set((livePages ?? []).map((page) => page.name))
  const sourcePages = (source.children ?? []).filter((child) => child?.type === 'frame' && child?.reusable !== true)
  const sourcePageNames = new Set(sourcePages.map((page) => page.name))

  const targets = sourcePages.filter((page) => {
    if (options.only.size > 0 && !options.only.has(page.name)) return false
    if (!options.includeExisting && existingNames.has(page.name)) return false
    return true
  })

  console.log(`Source pages: ${sourcePages.length}`)
  console.log(`Existing live pages: ${[...existingNames].join(', ')}`)
  console.log(`Import targets: ${targets.map((page) => page.name).join(', ') || '(none)'}`)

  if (options.dryRun || targets.length === 0) return

  const context = { variables, components }
  context.iconAssets = new Map()

  for (const page of targets) {
    console.log(`\nImporting ${page.name}...`)
    const existing = livePages.find((entry) => entry.name === page.name) ?? null
    const pageInfo = existing ?? await callTool(token, 'create_page', { name: page.name })
    const expanded = expandRefs(page, context, page.name)
    const normalized = normalizeNode(expanded, context)
    const imageUrls = collectImageUrls(normalized)
    const imageAssets = await buildImageAssets(sourcePath, imageUrls)
    for (const [hash, asset] of context.iconAssets) {
      imageAssets.set(`icon:${hash}`, asset)
    }
    const prepared = applyImageAssets(normalized, imageAssets)

    await callTool(token, 'switch_page', { page: pageInfo.id })
    const result = await rpc(token, 'eval', {
      code: buildImportEvalCode(pageInfo.id, prepared, imageAssets, !!existing)
    })
    await callTool(token, 'update_node', { id: result.id, x: 0 })
    console.log(`  Imported root ${result.name} (${result.id})`)
  }

  if (!sourcePageNames.has('Page 1')) {
    const fallbackPage = targets[0]?.name ?? sourcePages[0]?.name ?? null
    if (fallbackPage) {
      await callTool(token, 'switch_page', { page: fallbackPage })
    }
    const cleanup = await rpc(token, 'eval', {
      code: buildDeleteEmptyPlaceholderPageCode('Page 1')
    })
    if (cleanup?.deleted) {
      console.log(`\nRemoved empty placeholder page Page 1 (${cleanup.id})`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
