import { describe, expect, test } from 'bun:test'
import { unzipSync } from 'fflate'

import { exportFigFile, parseFigFile, SceneGraph } from '@open-pencil/core'

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('fig-export image hashing', () => {
  test('canonicalizes saved image hashes to the embedded bytes', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const originalHash = '00112233445566778899aabbccddeeff00112233'
    const canonicalHash = await sha1Hex(imageBytes)

    graph.images.set(originalHash, imageBytes)
    graph.createNode('RECTANGLE', page.id, {
      name: 'Image Fill',
      width: 64,
      height: 64,
      fills: [
        {
          type: 'IMAGE',
          color: { r: 1, g: 1, b: 1, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: 'NORMAL',
          imageHash: originalHash,
          imageScaleMode: 'FIT'
        }
      ]
    })

    const figBytes = await exportFigFile(graph)
    const zip = unzipSync(figBytes)

    expect(zip[`images/${canonicalHash}`]).toEqual(imageBytes)

    const reimported = await parseFigFile(figBytes.buffer.slice(
      figBytes.byteOffset,
      figBytes.byteOffset + figBytes.byteLength
    ))
    const imageNode = reimported.getChildren(reimported.getPages()[0].id)[0]

    expect(imageNode?.fills[0]?.imageHash).toBe(canonicalHash)
    expect(reimported.images.get(canonicalHash)).toEqual(imageBytes)
  })
})
