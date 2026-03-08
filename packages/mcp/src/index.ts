#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { resolveRuntimeOptions } from './runtime-options.js'
import { createServer } from './server.js'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'))
const runtime = resolveRuntimeOptions(process.argv.slice(2))
const server = createServer(pkg.version, {
  mode: runtime.mode,
  bridgeUrl: runtime.bridgeUrl
})

const transport = new StdioServerTransport()
await server.connect(transport)
