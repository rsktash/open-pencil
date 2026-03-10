import type { Plugin } from 'vite'

export function shouldStartViteAutomationBridge(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.OPENPENCIL_DESKTOP_DEV !== '1' && !env.TAURI_DEV_HOST
}

export function automationPlugin(): Plugin {
  return {
    name: 'open-pencil-automation',
    configureServer(server) {
      if (!shouldStartViteAutomationBridge(process.env)) return
      void import('./bridge').then(({ startAutomationBridge }) => {
        startAutomationBridge(server)
      })
    }
  }
}
