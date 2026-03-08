import { describe, expect, test } from 'bun:test'

import { shouldStartViteAutomationBridge } from '../../src/automation/vite-plugin'

describe('shouldStartViteAutomationBridge', () => {
  test('starts the Vite bridge in normal web dev', () => {
    expect(shouldStartViteAutomationBridge({})).toBe(true)
  })

  test('skips the Vite bridge when desktop dev owns automation', () => {
    expect(shouldStartViteAutomationBridge({ OPENPENCIL_DESKTOP_DEV: '1' })).toBe(false)
  })

  test('skips the Vite bridge when Tauri host env is present', () => {
    expect(shouldStartViteAutomationBridge({ TAURI_DEV_HOST: '127.0.0.1' })).toBe(false)
  })
})
