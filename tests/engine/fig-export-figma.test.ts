import { describe, expect, test } from 'bun:test'
import { unzipSync, inflateSync } from 'fflate'

import { exportFigFile, parseFigFile, SceneGraph } from '@open-pencil/core'
import { decodeBinarySchema, compileSchema, ByteBuffer } from '../../packages/core/src/kiwi/kiwi-schema'

function decodeFigNodeChanges(figBytes: Uint8Array) {
  const zip = unzipSync(figBytes)
  const canvasData = zip['canvas.fig']
  if (!canvasData) throw new Error('Missing canvas.fig')

  const header = new TextDecoder().decode(canvasData.slice(0, 8))
  expect(header).toBe('fig-kiwi')

  const view = new DataView(canvasData.buffer, canvasData.byteOffset, canvasData.byteLength)
  let offset = 12
  const schemaLength = view.getUint32(offset, true)
  offset += 4
  const schemaDeflated = canvasData.slice(offset, offset + schemaLength)
  offset += schemaLength
  const dataLength = view.getUint32(offset, true)
  offset += 4
  const dataDeflated = canvasData.slice(offset, offset + dataLength)

  const schemaBytes = inflateSync(schemaDeflated)
  const schema = decodeBinarySchema(new ByteBuffer(schemaBytes))
  const compiled = compileSchema(schema) as { decodeMessage(data: Uint8Array): { nodeChanges?: Array<Record<string, unknown>> } }
  return compiled.decodeMessage(inflateSync(dataDeflated)).nodeChanges ?? []
}

describe('fig-export figma target', () => {
  test('flattens auto-layout and component semantics for Figma export', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    const component = graph.createNode('COMPONENT', page.id, {
      name: 'Card Component',
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      layoutMode: 'VERTICAL',
      itemSpacing: 16,
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24
    })

    graph.createNode('TEXT', component.id, {
      name: 'Title',
      x: 24,
      y: 24,
      width: 120,
      height: 24,
      text: 'Hello',
      textAutoResize: 'HEIGHT'
    })

    const figBytes = await exportFigFile(graph, undefined, undefined, undefined, {
      target: 'figma'
    })
    const reimported = await parseFigFile(
      figBytes.buffer.slice(figBytes.byteOffset, figBytes.byteOffset + figBytes.byteLength)
    )

    const exportedNode = reimported.getChildren(reimported.getPages()[0].id)[0]
    const exportedText = reimported.getChildren(exportedNode.id)[0]

    expect(exportedNode.type).toBe('FRAME')
    expect(exportedNode.layoutMode).toBe('NONE')
    expect(exportedNode.x).toBe(10)
    expect(exportedNode.y).toBe(20)
    expect(exportedText.type).toBe('TEXT')
    expect(exportedText.textAutoResize).toBe('HEIGHT')
    expect(exportedText.x).toBe(24)
    expect(exportedText.y).toBe(24)
  })

  test('preserves WIDTH_AND_HEIGHT text sizing for figma-target export', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    graph.createNode('TEXT', page.id, {
      name: 'Hero Label',
      x: 32,
      y: 48,
      width: 120,
      height: 40,
      text: 'Yuklar',
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    const figBytes = await exportFigFile(graph, undefined, undefined, undefined, {
      target: 'figma'
    })
    const reimported = await parseFigFile(
      figBytes.buffer.slice(figBytes.byteOffset, figBytes.byteOffset + figBytes.byteLength)
    )

    const exportedText = reimported.getChildren(reimported.getPages()[0].id)[0]

    expect(exportedText.type).toBe('TEXT')
    expect(exportedText.textAutoResize).toBe('WIDTH_AND_HEIGHT')
    expect(exportedText.x).toBe(32)
    expect(exportedText.y).toBe(48)
  })

  test('uses figma-compatible font style names for text export', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    graph.createNode('TEXT', page.id, {
      name: 'Regular Text',
      x: 20,
      y: 20,
      width: 140,
      height: 24,
      text: 'Regular',
      fontFamily: 'Inter',
      fontWeight: 400,
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    graph.createNode('TEXT', page.id, {
      name: 'Semibold Text',
      x: 20,
      y: 60,
      width: 140,
      height: 24,
      text: 'Semibold',
      fontFamily: 'Inter',
      fontWeight: 600,
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    const figBytes = await exportFigFile(graph, undefined, undefined, undefined, {
      target: 'figma'
    })
    const nodeChanges = decodeFigNodeChanges(figBytes)
    const textChanges = nodeChanges.filter((node) => node.type === 'TEXT')

    expect(textChanges).toHaveLength(2)
    expect(textChanges[0]?.fontName).toEqual({ family: 'Inter', style: 'Regular', postscript: '' })
    expect(textChanges[1]?.fontName).toEqual({ family: 'Inter', style: 'Semi Bold', postscript: '' })
  })

  test('disables frame clipping for figma-target export unless used as a mask', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    const frame = graph.createNode('FRAME', page.id, {
      name: 'Clipped Frame',
      x: 10,
      y: 10,
      width: 200,
      height: 80,
      clipsContent: true
    })
    graph.createNode('TEXT', frame.id, {
      name: 'Top Label',
      x: 0,
      y: 0,
      width: 120,
      height: 20,
      text: 'Visible in Figma',
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    const figBytes = await exportFigFile(graph, undefined, undefined, undefined, {
      target: 'figma'
    })
    const reimported = await parseFigFile(
      figBytes.buffer.slice(figBytes.byteOffset, figBytes.byteOffset + figBytes.byteLength)
    )

    const exportedFrame = reimported.getChildren(reimported.getPages()[0].id)[0]

    expect(exportedFrame.type).toBe('FRAME')
    expect(exportedFrame.clipsContent).toBe(false)
  })

  test('flattens non-visual wrapper frames in figma-target export', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    const card = graph.createNode('FRAME', page.id, {
      name: 'Card',
      x: 10,
      y: 20,
      width: 280,
      height: 140,
      fills: [
        {
          type: 'SOLID',
          color: { r: 1, g: 1, b: 1, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: 'NORMAL'
        }
      ]
    })

    const wrapper = graph.createNode('FRAME', card.id, {
      name: 'Wrapper',
      x: 40,
      y: 60,
      width: 200,
      height: 80
    })

    graph.createNode('TEXT', wrapper.id, {
      name: 'Label',
      x: 12,
      y: 18,
      width: 80,
      height: 20,
      text: 'Hoisted',
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    const figBytes = await exportFigFile(graph, undefined, undefined, undefined, {
      target: 'figma'
    })
    const reimported = await parseFigFile(
      figBytes.buffer.slice(figBytes.byteOffset, figBytes.byteOffset + figBytes.byteLength)
    )

    const pageChildren = reimported.getChildren(reimported.getPages()[0].id)
    const exportedCard = pageChildren[0]
    const exportedCardChildren = reimported.getChildren(exportedCard.id)
    const exportedText = exportedCardChildren[0]

    expect(pageChildren).toHaveLength(1)
    expect(exportedCard.type).toBe('FRAME')
    expect(exportedCardChildren).toHaveLength(1)
    expect(exportedText.type).toBe('TEXT')
    expect(exportedText.name).toBe('Label')
    expect(exportedText.x).toBe(52)
    expect(exportedText.y).toBe(78)
  })

  test('preserves unclipped frames in native fig round-trip', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]

    graph.createNode('FRAME', page.id, {
      name: 'Unclipped Frame',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      clipsContent: false
    })

    const figBytes = await exportFigFile(graph)
    const reimported = await parseFigFile(
      figBytes.buffer.slice(figBytes.byteOffset, figBytes.byteOffset + figBytes.byteLength)
    )

    const exportedFrame = reimported.getChildren(reimported.getPages()[0].id)[0]

    expect(exportedFrame.type).toBe('FRAME')
    expect(exportedFrame.clipsContent).toBe(false)
  })
})
