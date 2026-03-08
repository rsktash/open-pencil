import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createServer } from '../../packages/mcp/src/server'
import { SceneGraph, exportFigFile } from '@open-pencil/core'

function parseResult(result: { content: { type: string; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text)
}

async function createLinkedClient(options?: Parameters<typeof createServer>[1]) {
  const server = createServer('0.0.0-test', options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

async function withDesktopBridgeMock(
  handler: (request: {
    path: string
    method: string
    authorization: string | undefined
    body: string
  }) => { status?: number; payload: unknown },
  run: (bridgeUrl: string) => Promise<void>
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const result = handler({
      path: new URL(request.url).pathname,
      method: request.method,
      authorization: request.headers.get('authorization') ?? undefined,
      body: await request.text()
    })
    return Response.json(result.payload, { status: result.status ?? 200 })
  }

  try {
    await run('http://127.0.0.1:7600')
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('MCP server', () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const server = createServer('0.0.0-test')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    cleanup = async () => {
      await client.close()
      await server.close()
    }
  })

  afterEach(async () => {
    await cleanup()
  })

  test('lists all registered tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('new_document')
    expect(names).toContain('open_file')
    expect(names).toContain('save_file')
    expect(names).toContain('create_shape')
    expect(names).toContain('set_fill')
    expect(names).toContain('get_page_tree')
    expect(names).toContain('take_screenshot')
    expect(tools.length).toBeGreaterThan(70)
  })

  test('tools have descriptions and input schemas', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
    }
  })

  test('new_document creates an empty document', async () => {
    const result = await client.callTool({ name: 'new_document', arguments: {} })
    const data = parseResult(result) as { page: string; id: string }
    expect(data.page).toBe('Page 1')
    expect(data.id).toBeTruthy()
  })

  test('tools fail without a loaded document', async () => {
    const result = await client.callTool({ name: 'get_page_tree', arguments: {} })
    expect(result.isError).toBe(true)
    const data = parseResult(result) as { error: string }
    expect(data.error).toContain('No document loaded')
  })

  test('create_shape after new_document', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    const result = await client.callTool({
      name: 'create_shape',
      arguments: { type: 'FRAME', x: 0, y: 0, width: 200, height: 100, name: 'Test' }
    })
    const data = parseResult(result) as { id: string; name: string; type: string }
    expect(data.name).toBe('Test')
    expect(data.type).toBe('FRAME')
    expect(data.id).toBeTruthy()
  })

  test('set_fill validates color string', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    const shape = parseResult(
      await client.callTool({
        name: 'create_shape',
        arguments: { type: 'RECTANGLE', x: 0, y: 0, width: 50, height: 50 }
      })
    ) as { id: string }

    await client.callTool({
      name: 'set_fill',
      arguments: { id: shape.id, color: '#00ff00' }
    })

    const node = parseResult(
      await client.callTool({ name: 'get_node', arguments: { id: shape.id } })
    ) as { fills: { color: { r: number; g: number; b: number } }[] }
    expect(node.fills[0].color.g).toBeCloseTo(1)
  })

  test('delete_node removes created node', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    const shape = parseResult(
      await client.callTool({
        name: 'create_shape',
        arguments: { type: 'RECTANGLE', x: 0, y: 0, width: 50, height: 50 }
      })
    ) as { id: string }

    await client.callTool({ name: 'delete_node', arguments: { id: shape.id } })

    const result = await client.callTool({ name: 'get_node', arguments: { id: shape.id } })
    const data = parseResult(result) as { error?: string }
    expect(data.error).toContain('not found')
  })

  test('get_node on nonexistent ID returns error in response', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    const result = await client.callTool({ name: 'get_node', arguments: { id: 'bogus' } })
    const data = parseResult(result) as { error: string }
    expect(data.error).toContain('not found')
  })

  test('open_file loads a .fig file', async () => {
    const fixturePath = join(import.meta.dir, '..', 'fixtures', 'gold-preview.fig')
    const result = await client.callTool({ name: 'open_file', arguments: { path: fixturePath } })
    const data = parseResult(result) as { pages: { name: string }[]; currentPage: string }
    expect(data.pages.length).toBeGreaterThan(0)
    expect(data.currentPage).toBeTruthy()
  })

  test('open_file with invalid path returns error', async () => {
    const result = await client.callTool({
      name: 'open_file',
      arguments: { path: '/nonexistent/file.fig' }
    })
    expect(result.isError).toBe(true)
  })

  test('save_file roundtrips a document', async () => {
    const tmpPath = join(import.meta.dir, '..', `_mcp_test_${Date.now()}.fig`)
    try {
      await client.callTool({ name: 'new_document', arguments: {} })
      await client.callTool({
        name: 'create_shape',
        arguments: { type: 'FRAME', x: 0, y: 0, width: 300, height: 200, name: 'Saved' }
      })

      const saveResult = await client.callTool({
        name: 'save_file',
        arguments: { path: tmpPath }
      })
      const saved = parseResult(saveResult) as { saved: string; bytes: number }
      expect(saved.bytes).toBeGreaterThan(0)

      await client.callTool({ name: 'open_file', arguments: { path: tmpPath } })
      const tree = parseResult(
        await client.callTool({ name: 'get_page_tree', arguments: {} })
      ) as { children: { name: string }[] }
      expect(tree.children.some((c) => c.name === 'Saved')).toBe(true)
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  })

  test('save_file without document returns error', async () => {
    const result = await client.callTool({
      name: 'save_file',
      arguments: { path: '/tmp/_mcp_no_doc.fig' }
    })
    expect(result.isError).toBe(true)
  })

  test('full workflow: new → create → query → delete', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })

    const frame = parseResult(
      await client.callTool({
        name: 'create_shape',
        arguments: { type: 'FRAME', x: 10, y: 20, width: 400, height: 300, name: 'Container' }
      })
    ) as { id: string }

    const child = parseResult(
      await client.callTool({
        name: 'create_shape',
        arguments: {
          type: 'TEXT',
          x: 0,
          y: 0,
          width: 200,
          height: 30,
          name: 'Label',
          parent_id: frame.id
        }
      })
    ) as { id: string }

    await client.callTool({
      name: 'set_fill',
      arguments: { id: frame.id, color: '#336699' }
    })

    const tree = parseResult(
      await client.callTool({ name: 'get_page_tree', arguments: {} })
    ) as { children: { id: string; name: string; children?: { name: string }[] }[] }

    const container = tree.children.find((c) => c.name === 'Container')
    expect(container).toBeDefined()
    expect(container!.children?.some((c) => c.name === 'Label')).toBe(true)

    await client.callTool({ name: 'delete_node', arguments: { id: child.id } })

    const tree2 = parseResult(
      await client.callTool({ name: 'get_page_tree', arguments: {} })
    ) as { children: { id: string; children?: unknown[] }[] }
    const container2 = tree2.children.find((c) => c.id === frame.id)
    expect(container2!.children ?? []).toHaveLength(0)
  })

  test('find_nodes filters by type', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    await client.callTool({
      name: 'create_shape',
      arguments: { type: 'FRAME', x: 0, y: 0, width: 100, height: 100, name: 'F1' }
    })
    await client.callTool({
      name: 'create_shape',
      arguments: { type: 'RECTANGLE', x: 0, y: 0, width: 50, height: 50, name: 'R1' }
    })
    await client.callTool({
      name: 'create_shape',
      arguments: { type: 'FRAME', x: 0, y: 0, width: 100, height: 100, name: 'F2' }
    })

    const result = await client.callTool({ name: 'find_nodes', arguments: { type: 'FRAME' } })
    const data = parseResult(result) as { count: number }
    expect(data.count).toBe(2)
  })

  test('take_screenshot returns image content for a created node', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })
    const shape = parseResult(
      await client.callTool({
        name: 'create_shape',
        arguments: { type: 'RECTANGLE', x: 0, y: 0, width: 120, height: 80, name: 'Shot' }
      })
    ) as { id: string }

    const result = await client.callTool({
      name: 'take_screenshot',
      arguments: { ids: [shape.id], format: 'PNG', scale: 1 }
    })

    const imagePart = result.content[0] as { type: string; data?: string; mimeType?: string }
    expect(imagePart.type).toBe('image')
    expect(imagePart.mimeType).toBe('image/png')
    expect(typeof imagePart.data).toBe('string')
    expect(imagePart.data!.length).toBeGreaterThan(0)
  })

  test('create_shape rejects invalid type enum', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })

    const result = await client.callTool({
      name: 'create_shape',
      arguments: { type: 'INVALID_TYPE', x: 0, y: 0, width: 100, height: 100 }
    })
    const r = result as { content: { text: string }[]; isError?: boolean }
    const text = r.content[0].text
    expect(r.isError === true || text.toLowerCase().includes('invalid')).toBe(true)
  })

  test('create_shape rejects missing required param', async () => {
    await client.callTool({ name: 'new_document', arguments: {} })

    const result = await client.callTool({
      name: 'create_shape',
      arguments: { x: 0, y: 0, width: 100, height: 100 }
    })
    const r = result as { content: { text: string }[]; isError?: boolean }
    const text = r.content[0].text
    expect(r.isError === true || text.toLowerCase().includes('required')).toBe(true)
  })

  test('createServer option enableEval=false removes eval tool', async () => {
    const custom = await createLinkedClient({ enableEval: false })
    try {
      const { tools } = await custom.client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).not.toContain('eval')
      expect(names).toContain('create_shape')
    } finally {
      await custom.close()
    }
  })

  test('createServer option fileRoot restricts open_file and save_file paths', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'openpencil-mcp-root-'))
    const insidePath = join(rootDir, 'inside.fig')
    const outsidePath = join(tmpdir(), `outside-${Date.now()}.fig`)

    const graph = new SceneGraph()
    const bytes = await exportFigFile(graph)
    await writeFile(insidePath, new Uint8Array(bytes))

    const custom = await createLinkedClient({ fileRoot: rootDir })
    try {
      const openInside = await custom.client.callTool({
        name: 'open_file',
        arguments: { path: insidePath }
      })
      expect(openInside.isError).not.toBe(true)

      const saveOutside = await custom.client.callTool({
        name: 'save_file',
        arguments: { path: outsidePath }
      })
      expect(saveOutside.isError).toBe(true)
      const saveOutsideErr = parseResult(saveOutside) as { error: string }
      expect(saveOutsideErr.error).toContain('outside allowed root')

      const saveInside = await custom.client.callTool({
        name: 'save_file',
        arguments: { path: insidePath }
      })
      expect(saveInside.isError).not.toBe(true)
    } finally {
      await custom.close()
      await unlink(outsidePath).catch(() => {})
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('desktop mode omits file tools and proxies read tools to the live app bridge', async () => {
    await withDesktopBridgeMock(
      ({ path, method, authorization, body }) => {
        if (path === '/health' && method === 'GET') {
          return { payload: { status: 'ok', token: 'desktop-token' } }
        }

        if (path === '/rpc' && method === 'POST') {
          expect(authorization).toBe('Bearer desktop-token')
          expect(JSON.parse(body)).toEqual({
            command: 'tool',
            args: { name: 'get_current_page', args: {} }
          })
          return { payload: { ok: true, result: { id: 'page-1', name: 'Page 1' } } }
        }

        return { status: 404, payload: { error: 'Not found' } }
      },
      async (bridgeUrl) => {
        const custom = await createLinkedClient({ mode: 'desktop', bridgeUrl })
        try {
          const { tools } = await custom.client.listTools()
          const names = tools.map((tool) => tool.name)
          expect(names).not.toContain('open_file')
          expect(names).not.toContain('save_file')
          expect(names).not.toContain('new_document')
          expect(names).toContain('get_current_page')

          const result = await custom.client.callTool({
            name: 'get_current_page',
            arguments: {}
          })
          expect(parseResult(result)).toEqual({ id: 'page-1', name: 'Page 1' })
        } finally {
          await custom.close()
        }
      }
    )
  })

  test('desktop mode returns image parts from live-app screenshot results', async () => {
    await withDesktopBridgeMock(
      ({ path, method }) => {
        if (path === '/health' && method === 'GET') {
          return { payload: { status: 'ok', token: 'desktop-token' } }
        }

        if (path === '/rpc' && method === 'POST') {
          return {
            payload: { ok: true, result: { base64: 'c2hvdA==', mimeType: 'image/png' } }
          }
        }

        return { status: 404, payload: { error: 'Not found' } }
      },
      async (bridgeUrl) => {
        const custom = await createLinkedClient({ mode: 'desktop', bridgeUrl })
        try {
          const result = await custom.client.callTool({
            name: 'take_screenshot',
            arguments: { target: 'PAGE', format: 'PNG' }
          })
          const imagePart = result.content[0] as { type: string; data?: string; mimeType?: string }
          expect(imagePart.type).toBe('image')
          expect(imagePart.data).toBe('c2hvdA==')
          expect(imagePart.mimeType).toBe('image/png')
        } finally {
          await custom.close()
        }
      }
    )
  })
})
