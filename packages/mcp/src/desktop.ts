const DEFAULT_DESKTOP_BRIDGE_URL = 'http://127.0.0.1:7600'

type DesktopHealthResponse =
  | {
      status: 'ok'
      token: string
    }
  | {
      status: 'no_app'
    }

type DesktopRpcSuccess = {
  ok: true
  result: unknown
}

type DesktopRpcFailure = {
  ok: false
  error: string
}

export interface DesktopBridgeOptions {
  bridgeUrl?: string
}

function resolveBridgeUrl(bridgeUrl?: string): string {
  return (bridgeUrl ?? process.env.OPENPENCIL_AUTOMATION_URL ?? DEFAULT_DESKTOP_BRIDGE_URL).replace(
    /\/+$/,
    ''
  )
}

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(fallbackMessage)
  }
}

async function getDesktopBridgeToken(options: DesktopBridgeOptions): Promise<{
  bridgeUrl: string
  token: string
}> {
  const bridgeUrl = resolveBridgeUrl(options.bridgeUrl)

  let response: Response
  try {
    response = await fetch(`${bridgeUrl}/health`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to reach the OpenPencil desktop app bridge at ${bridgeUrl}: ${message}`
    )
  }

  const health = await readJson<DesktopHealthResponse>(
    response,
    'Invalid health response from the OpenPencil desktop app bridge'
  )

  if (!response.ok || health.status !== 'ok' || !health.token) {
    throw new Error('OpenPencil desktop app is not connected. Open a document in the app first.')
  }

  return { bridgeUrl, token: health.token }
}

export async function callDesktopAutomation(
  command: string,
  args: unknown,
  options: DesktopBridgeOptions = {}
): Promise<unknown> {
  const { bridgeUrl, token } = await getDesktopBridgeToken(options)

  let response: Response
  try {
    response = await fetch(`${bridgeUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ command, args })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to reach the OpenPencil desktop app bridge at ${bridgeUrl}: ${message}`
    )
  }

  const payload = await readJson<DesktopRpcSuccess | DesktopRpcFailure | { error?: string }>(
    response,
    'Invalid RPC response from the OpenPencil desktop app bridge'
  )

  if ('ok' in payload) {
    if (!payload.ok) throw new Error(payload.error)
    return payload.result
  }

  if (!response.ok) {
    throw new Error(payload.error ?? 'Desktop bridge request failed')
  }

  return payload
}
