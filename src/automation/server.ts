/**
 * Live editor automation client.
 *
 * In web dev it connects to the local bridge over WebSocket.
 * In the desktop app it registers with the Rust bridge and handles requests via Tauri events.
 */
import { AUTOMATION_WS_PORT } from '@open-pencil/core'

import { handleAutomationRequest } from '@/automation/handler'
import { IS_TAURI } from '@/constants'
import type { EditorStore } from '@/stores/editor'

const TOKEN_LENGTH = 32

interface AutomationRequestPayload {
  id: string
  command: string
  args?: unknown
}

function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function connectAutomation(getStore: () => EditorStore) {
  if (IS_TAURI) return connectDesktopAutomation(getStore)
  return connectWebAutomation(getStore)
}

function connectDesktopAutomation(getStore: () => EditorStore) {
  const token = generateToken()
  let disposed = false
  let unlisten: (() => void) | undefined

  void (async () => {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event')
    ])

    if (disposed) return

    unlisten = await listen<AutomationRequestPayload>('automation-request', async (event) => {
      const { id, command, args } = event.payload
      try {
        const result = await handleAutomationRequest(getStore, command, args)
        await invoke('automation_bridge_respond', { id, response: result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await invoke('automation_bridge_respond', {
          id,
          response: { ok: false, error: message }
        }).catch(() => {})
      }
    })

    if (disposed) {
      unlisten()
      unlisten = undefined
      return
    }

    await invoke('register_automation_bridge', { token }).catch(() => {})
  })().catch(() => {})

  function disconnect() {
    disposed = true
    unlisten?.()
    unlisten = undefined
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('unregister_automation_bridge').catch(() => {})
    })
  }

  return { disconnect, token }
}

function connectWebAutomation(getStore: () => EditorStore) {
  const token = generateToken()
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function connect() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${AUTOMATION_WS_PORT}`)
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: 'register', token }))
    }

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data) as {
          type: string
          id: string
          command: string
          args?: unknown
        }
        if (msg.type !== 'request' || !msg.id) return
        try {
          const result = await handleAutomationRequest(getStore, msg.command, msg.args)
          ws?.send(JSON.stringify({ type: 'response', id: msg.id, ...(result as object) }))
        } catch (e) {
          ws?.send(
            JSON.stringify({
              type: 'response',
              id: msg.id,
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          )
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      ws = null
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 2000)
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
  }

  connect()
  return { disconnect, token }
}
