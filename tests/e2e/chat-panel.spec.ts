import { expect, test, type Page } from '@playwright/test'

import { CanvasHelper } from '../helpers/canvas'

const USE_REAL_LLM = process.env.TEST_REAL_LLM === '1'
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? ''
const CHAT_CLI_SESSION_STORAGE = 'open-pencil:chat-cli-session'
const CHAT_MESSAGE_HISTORY_STORAGE = 'open-pencil:chat-history'
const CHAT_PROMPT_HISTORY_STORAGE = 'open-pencil:chat-prompt-history'

let page: Page
let canvas: CanvasHelper

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/')
  canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }
})

test.afterAll(async () => {
  await page.close()
})

async function injectMockTransport(page: Page) {
  await page.evaluate(() => {
    const setTransport = window.__OPEN_PENCIL_SET_TRANSPORT__
    if (!setTransport) throw new Error('Transport override not available')

    let msgCounter = 0

    setTransport(() => ({
      async sendMessages({
        messages,
      }: {
        messages: Array<{
          role: string
          parts: Array<{ type: string; text?: string; filename?: string; mediaType?: string }>
        }>
      }) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        const text = lastUser?.parts?.find((p) => p.type === 'text')?.text ?? ''
        const msgId = `mock-msg-${++msgCounter}`
        const wantsTool = text.toLowerCase().includes('frame') || text.toLowerCase().includes('rectangle')

        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: msgId })

            if (wantsTool) {
              const toolCallId = `call-${msgId}`
              controller.enqueue({
                type: 'tool-input-start',
                toolCallId,
                toolName: 'create_shape',
              })
              controller.enqueue({
                type: 'tool-input-delta',
                toolCallId,
                inputTextDelta: '{"type":"FRAME","x":100,"y":100,"width":200,"height":150,"name":"Card"}',
              })
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId,
                toolName: 'create_shape',
                input: { type: 'FRAME', x: 100, y: 100, width: 200, height: 150, name: 'Card' },
              })
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId,
                toolName: 'create_shape',
                output: { id: '0:99', type: 'FRAME', x: 100, y: 100, width: 200, height: 150, name: 'Card' },
              })
            }

            const words = wantsTool
              ? ['Created', 'a', 'frame', 'called', '"Card".']
              : `I'll help you with: "${text}". Here's a mock response.`.split(' ')

            controller.enqueue({ type: 'text-start', id: 'text-1' })
            for (const word of words) {
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: word + ' ' })
            }
            controller.enqueue({ type: 'text-end', id: 'text-1' })
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
          },
        })
      },
      async reconnectToStream() {
        return null
      },
    }))
  })
}

async function injectCaptureTransport(page: Page) {
  await page.evaluate(() => {
    const setTransport = window.__OPEN_PENCIL_SET_TRANSPORT__
    if (!setTransport) throw new Error('Transport override not available')

    ;(window as Window & { __OPEN_PENCIL_LAST_CHAT_MESSAGES__?: unknown }).__OPEN_PENCIL_LAST_CHAT_MESSAGES__ = null

    setTransport(() => ({
      async sendMessages({
        messages,
      }: {
        messages: Array<{
          role: string
          parts: Array<{ type: string; url?: string; filename?: string; mediaType?: string; text?: string }>
        }>
      }) {
        ;(window as Window & { __OPEN_PENCIL_LAST_CHAT_MESSAGES__?: unknown }).__OPEN_PENCIL_LAST_CHAT_MESSAGES__ = messages

        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'capture-msg-1' })
            controller.enqueue({ type: 'text-start', id: 'text-1' })
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'captured' })
            controller.enqueue({ type: 'text-end', id: 'text-1' })
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
          },
        })
      },
      async reconnectToStream() {
        return null
      },
    }))
  })
}

async function injectDelayedMockTransport(page: Page, delayMs = 250) {
  await page.evaluate((delay) => {
    const setTransport = window.__OPEN_PENCIL_SET_TRANSPORT__
    if (!setTransport) throw new Error('Transport override not available')

    let msgCounter = 0

    setTransport(() => ({
      async sendMessages() {
        const msgId = `delayed-msg-${++msgCounter}`

        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: msgId })

            setTimeout(() => {
              controller.enqueue({ type: 'text-start', id: 'text-1' })
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Done thinking. ' })
              controller.enqueue({ type: 'text-end', id: 'text-1' })
              controller.enqueue({ type: 'finish', finishReason: 'stop' })
              controller.close()
            }, delay)
          },
        })
      },
      async reconnectToStream() {
        return null
      },
    }))
  }, delayMs)
}

async function injectStreamingMarkdownTransport(page: Page, delayMs = 60) {
  await page.evaluate((delay) => {
    const setTransport = window.__OPEN_PENCIL_SET_TRANSPORT__
    if (!setTransport) throw new Error('Transport override not available')

    let msgCounter = 0

    setTransport(() => ({
      async sendMessages() {
        const msgId = `markdown-msg-${++msgCounter}`
        const deltas = [
          'Reading `REQUEST.md` and locating the helper script first. ',
          "I've got the task files. Next I'll inspect the page state. ",
          'The initial connection retried successfully and rendering is continuing.'
        ]

        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: msgId })
            controller.enqueue({
              type: 'tool-input-start',
              toolCallId: `tool-${msgId}`,
              toolName: 'get_current_page',
            })
            controller.enqueue({
              type: 'tool-input-available',
              toolCallId: `tool-${msgId}`,
              toolName: 'get_current_page',
              input: {},
            })
            controller.enqueue({
              type: 'tool-output-available',
              toolCallId: `tool-${msgId}`,
              toolName: 'get_current_page',
              output: { ok: true },
            })
            controller.enqueue({ type: 'text-start', id: 'text-1' })

            let chunkIndex = 0
            const emitNextChunk = () => {
              const nextDelta = deltas[chunkIndex]
              if (!nextDelta) {
                controller.enqueue({ type: 'text-end', id: 'text-1' })
                controller.enqueue({ type: 'finish', finishReason: 'stop' })
                controller.close()
                return
              }

              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: nextDelta })
              chunkIndex += 1
              setTimeout(emitNextChunk, delay)
            }

            setTimeout(emitNextChunk, delay)
          },
        })
      },
      async reconnectToStream() {
        return null
      },
    }))
  }, delayMs)
}

async function injectSegmentedToolTransport(page: Page, delayMs = 120) {
  await page.evaluate((delay) => {
    const setTransport = window.__OPEN_PENCIL_SET_TRANSPORT__
    if (!setTransport) throw new Error('Transport override not available')

    let msgCounter = 0

    setTransport(() => ({
      async sendMessages() {
        const msgId = `segmented-msg-${++msgCounter}`

        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: msgId })
            controller.enqueue({
              type: 'tool-input-start',
              toolCallId: `thinking-${msgId}`,
              toolName: 'thinking_step',
            })
            controller.enqueue({
              type: 'tool-input-available',
              toolCallId: `thinking-${msgId}`,
              toolName: 'thinking_step',
              input: 'Inspecting the reference screenshot and current canvas state.',
            })

            setTimeout(() => {
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId: `thinking-${msgId}`,
                toolName: 'thinking_step',
                output: 'Compared the current canvas against the reference.',
              })
              controller.enqueue({ type: 'text-start', id: 'text-1' })
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'I found the main layout mismatch. ' })
              controller.enqueue({ type: 'text-end', id: 'text-1' })
              controller.enqueue({
                type: 'tool-input-start',
                toolCallId: `tool-${msgId}`,
                toolName: 'create_shape',
              })
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: `tool-${msgId}`,
                toolName: 'create_shape',
                input: { type: 'FRAME', x: 100, y: 100, width: 240, height: 300 },
              })
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId: `tool-${msgId}`,
                toolName: 'create_shape',
                output: { id: '0:100', type: 'FRAME' },
              })
              controller.enqueue({ type: 'text-start', id: 'text-2' })
              controller.enqueue({ type: 'text-delta', id: 'text-2', delta: 'I created the new frame and aligned it to the reference.' })
              controller.enqueue({ type: 'text-end', id: 'text-2' })
              controller.enqueue({ type: 'finish', finishReason: 'stop' })
              controller.close()
            }, delay)
          },
        })
      },
      async reconnectToStream() {
        return null
      },
    }))
  }, delayMs)
}

function chatTab() {
  return page.getByRole('tab', { name: 'AI' })
}

function designTab() {
  return page.getByRole('tab', { name: 'Design' })
}

function chatInput() {
  return page.locator('textarea[placeholder="Describe a change, paste images, or attach files…"]')
}

function apiKeyInput() {
  return page.locator('[data-test-id="api-key-input"]')
}

test('⌘J switches to AI tab', async () => {
  await designTab().waitFor()
  await page.keyboard.press('Meta+j')
  await expect(chatTab()).toHaveAttribute('data-state', 'active')
})

test('⌘J switches back to Design tab', async () => {
  await page.keyboard.press('Meta+j')
  await expect(designTab()).toHaveAttribute('data-state', 'active')
})

test('clicking AI tab shows API key setup when no key set', async () => {
  await chatTab().click()
  await expect(apiKeyInput()).toBeVisible()
  await expect(page.getByText('Enter your OpenRouter API key', { exact: false })).toBeVisible()
})

test('saving API key shows chat interface', async () => {
  const key = USE_REAL_LLM ? OPENROUTER_KEY : 'sk-or-test-key-12345'
  await apiKeyInput().fill(key)
  await page.locator('button:has-text("Save")').click()

  await expect(chatInput()).toBeVisible()
  await expect(page.getByText('Describe what you want to create or change.')).toBeVisible()
})

test('empty input has disabled send button', async () => {
  const sendButton = page.locator('button[type="submit"]')
  await expect(sendButton).toBeDisabled()
})

test('typing enables send button', async () => {
  await chatInput().fill('Make a red rectangle')
  const sendButton = page.locator('button[type="submit"]')
  await expect(sendButton).toBeEnabled()
})

test('Enter submits message and clears input', async () => {
  await chatInput().fill('Hello there')
  await chatInput().press('Enter')

  await expect(page.getByText('Hello there', { exact: true })).toBeVisible({ timeout: 5000 })
  await expect(chatInput()).toHaveValue('')
})

test('assistant responds', async () => {
  if (USE_REAL_LLM) {
    await expect(
      page.locator('.chat-markdown, [class*="rounded-tl-md"]').first(),
    ).toBeVisible({ timeout: 30000 })
  } else {
    await expect(page.getByText('mock response', { exact: false })).toBeVisible({ timeout: 5000 })
  }
})

test('model selector is visible and clickable', async () => {
  const trigger = page.getByRole('combobox')
  await expect(trigger).toBeVisible()
  await trigger.click()

  await expect(page.getByText('Codex CLI')).toBeVisible()
  await expect(page.getByText('Claude Code CLI')).toBeVisible()
  await expect(page.getByText('Open Router')).toBeVisible()
  await expect(page.getByRole('option', { name: /GPT 5\.4/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Sonnet 4\.6/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Claude Sonnet 4\.6/ })).toBeVisible()
  await expect(page.getByText('Best for design')).toBeVisible()
  await expect(page.getByText('Free').first()).toBeVisible()

  await page.keyboard.press('Escape')
})

test('switching to Codex updates the key setup copy', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)
  await chatTab().click()

  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: /GPT-5\.3 Codex/i }).click()

  await expect(page.getByText('Enter your OpenAI API key', { exact: false })).toBeVisible()
  await expect(apiKeyInput()).toHaveAttribute('placeholder', 'sk-\u2026')

  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: /Claude Sonnet 4\.6/i }).click()
  await expect(chatInput()).toBeVisible()
})

test('desktop cli models are grouped and selectable', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)
  await chatTab().click()

  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: /GPT 5\.4/i }).click()
  await expect(page.getByRole('combobox')).toContainText('Codex CLI')
  await expect(page.getByRole('combobox')).toContainText('GPT 5.4')

  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: /Opus 4\.6/i }).click()
  await expect(page.getByRole('combobox')).toContainText('Claude Code CLI')
  await expect(page.getByRole('combobox')).toContainText('Opus 4.6')
})

test('restored CLI sessions filter models until a new session is started', async () => {
  await page.evaluate(
    ([sessionKey, messageKey]) => {
      localStorage.setItem(
        sessionKey,
        JSON.stringify({
          backend: 'codex-cli',
          modelId: 'codex-cli::gpt-5.4',
          sessionId: 'session-test-1'
        })
      )
      localStorage.setItem(
        messageKey,
        JSON.stringify([
          {
            id: 'restored-user',
            role: 'user',
            parts: [{ type: 'text', text: 'Restored conversation' }]
          }
        ])
      )
    },
    [CHAT_CLI_SESSION_STORAGE, CHAT_MESSAGE_HISTORY_STORAGE]
  )

  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)
  await chatTab().click()

  await expect(page.getByText('Session locked to Codex CLI')).toBeVisible()
  await expect(page.getByText('Restored conversation')).toBeVisible()

  await page.getByRole('combobox').click()
  await expect(page.getByText('Codex CLI')).toBeVisible()
  await expect(page.getByText('Claude Code CLI')).toHaveCount(0)
  await expect(page.getByText('Open Router')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /New session/i }).click()
  await expect(page.getByText('Restored conversation')).toHaveCount(0)
  await expect(page.getByText('Describe what you want to create or change.')).toBeVisible()

  await page.getByRole('combobox').click()
  await expect(page.getByText('Claude Code CLI')).toBeVisible()
  await expect(page.getByText('Open Router')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('tool calls render in assistant message', async () => {
  await chatInput().fill('Create a frame')
  await chatInput().press('Enter')

  if (USE_REAL_LLM) {
    await expect(
      page.locator('.chat-markdown, [class*="rounded-tl-md"]').first(),
    ).toBeVisible({ timeout: 30000 })
  } else {
    await expect(page.getByText('Create Shape')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Done')).toBeVisible()
    await expect(page.getByText('Created a frame', { exact: false })).toBeVisible()
  }
})

test('switching tabs preserves chat', async () => {
  await designTab().click()
  await expect(designTab()).toHaveAttribute('data-state', 'active')

  await chatTab().click()
  await expect(page.getByText('Hello there', { exact: true })).toBeVisible()
})

test('attaching a file includes it in the user message', async () => {
  await page.locator('[data-test-id="chat-file-input"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('design notes'),
  })

  await expect(page.getByText('notes.txt')).toBeVisible()

  await chatInput().fill('Use this reference')
  await chatInput().press('Enter')

  await expect(page.locator('[data-test-id="chat-message-user"]').last().getByText('notes.txt')).toBeVisible()
  await expect(chatInput()).toHaveValue('')
})

test('dropping a file on the composer adds it as an attachment and submits it', async () => {
  await chatTab().click()

  await page.evaluate(() => {
    const panel = document.querySelector('[data-test-id="chat-panel"]')
    if (!(panel instanceof HTMLElement)) throw new Error('Chat panel not found')

    const data = new DataTransfer()
    const file = new File([new Blob(['drop me'])], 'dropped-notes.txt', { type: 'text/plain' })
    data.items.add(file)

    const dragEnterEvent = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: data })
    panel.dispatchEvent(dragEnterEvent)
  })

  await expect(page.locator('[data-test-id="chat-panel"]')).toHaveAttribute('data-dragging', 'true')
  await expect(page.locator('[data-test-id="chat-panel-drop-overlay"]')).toBeVisible()

  await page.evaluate(() => {
    const panel = document.querySelector('[data-test-id="chat-panel"]')
    if (!(panel instanceof HTMLElement)) throw new Error('Chat panel not found')

    const data = new DataTransfer()
    const file = new File([new Blob(['drop me'])], 'dropped-notes.txt', { type: 'text/plain' })
    data.items.add(file)

    const dropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(dropEvent, 'dataTransfer', { value: data })
    panel.dispatchEvent(dropEvent)
  })

  await expect(page.locator('[data-test-id="chat-panel"]')).toHaveAttribute('data-dragging', 'false')
  await expect(page.getByText('dropped-notes.txt')).toBeVisible()

  await chatInput().fill('Use dropped file')
  await chatInput().press('Enter')

  await expect(page.locator('[data-test-id="chat-message-user"]').last().getByText('dropped-notes.txt')).toBeVisible()
})

test('dragging Files over the composer activates the drop target before drop data is populated', async () => {
  await chatTab().click()

  await page.evaluate(() => {
    const panel = document.querySelector('[data-test-id="chat-panel"]')
    if (!(panel instanceof HTMLElement)) throw new Error('Chat panel not found')

    const dragEnterEvent = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(dragEnterEvent, 'dataTransfer', {
      value: {
        files: { length: 0 },
        items: [],
        types: ['Files'],
        dropEffect: 'none'
      }
    })
    panel.dispatchEvent(dragEnterEvent)
  })

  await expect(page.locator('[data-test-id="chat-panel"]')).toHaveAttribute('data-dragging', 'true')
  await expect(page.locator('[data-test-id="chat-panel-drop-overlay"]')).toBeVisible()
})

test('window-level file drop attaches files while the AI tab is active', async () => {
  await chatTab().click()

  await page.evaluate(() => {
    const data = new DataTransfer()
    const file = new File([new Blob(['global drop'])], 'window-drop.txt', { type: 'text/plain' })
    data.items.add(file)

    const dragEnterEvent = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: data })
    window.dispatchEvent(dragEnterEvent)
  })

  await expect(page.locator('[data-test-id="chat-panel-drop-overlay"]')).toBeVisible()

  await page.evaluate(() => {
    const data = new DataTransfer()
    const file = new File([new Blob(['global drop'])], 'window-drop.txt', { type: 'text/plain' })
    data.items.add(file)

    const dropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(dropEvent, 'dataTransfer', { value: data })
    window.dispatchEvent(dropEvent)
  })

  await expect(page.getByText('window-drop.txt')).toBeVisible()
})

test('pasting an image adds it as an attachment chip', async () => {
  await chatTab().click()

  await page.evaluate(() => {
    const target = document.querySelector('[data-test-id="chat-input"]')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('Chat input not found')

    const data = new DataTransfer()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const file = new File([blob], 'clipboard-image.png', { type: 'image/png' })
    data.items.add(file)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    target.dispatchEvent(event)
  })

  await expect(page.getByText('clipboard-image.png')).toBeVisible()
})

test('pasting an image can be submitted as a user attachment', async () => {
  await chatTab().click()

  await page.evaluate(() => {
    const target = document.querySelector('[data-test-id="chat-input"]')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('Chat input not found')

    const data = new DataTransfer()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const file = new File([blob], 'clipboard-image.png', { type: 'image/png' })
    data.items.add(file)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    target.dispatchEvent(event)
  })

  await chatInput().fill('Use this screenshot')
  await chatInput().press('Enter')

  const userMessage = page.locator('[data-test-id="chat-message-user"]').last()
  await expect(userMessage.getByText('clipboard-image.png')).toBeVisible()
  await expect(userMessage.locator('img[alt="clipboard-image.png"]')).toBeVisible()
  await expect(page.getByText('mock response', { exact: false })).toBeVisible({ timeout: 5000 })
})

test('pasted png screenshots keep their original png payload when sent', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectCaptureTransport(page)

  await chatTab().click()

  await page.evaluate(() => {
    const target = document.querySelector('[data-test-id="chat-input"]')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('Chat input not found')

    const data = new DataTransfer()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const file = new File([blob], 'pixel-perfect.png', { type: 'image/png' })
    data.items.add(file)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    target.dispatchEvent(event)
  })

  await chatInput().fill('Compare pixel by pixel')
  await chatInput().press('Enter')

  const sentMessages = await page.evaluate(() => {
    return (window as Window & {
      __OPEN_PENCIL_LAST_CHAT_MESSAGES__?: Array<{
        role: string
        parts: Array<{ type: string; url?: string; mediaType?: string; filename?: string }>
      }>
    }).__OPEN_PENCIL_LAST_CHAT_MESSAGES__
  })

  const lastUser = sentMessages?.findLast((message) => message.role === 'user')
  const filePart = lastUser?.parts.find((part) => part.type === 'file')

  expect(filePart?.filename).toBe('pixel-perfect.png')
  expect(filePart?.mediaType).toBe('image/png')
  expect(filePart?.url?.startsWith('data:image/png;')).toBe(true)
})

test('ArrowUp and ArrowDown recall stored prompts and restore the draft', async () => {
  await page.evaluate((storageKey) => localStorage.removeItem(storageKey), CHAT_PROMPT_HISTORY_STORAGE)
  await page.reload()
  await canvas.waitForInit()
  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().fill('First prompt')
  await chatInput().press('Enter')
  await chatInput().fill('Second prompt')
  await chatInput().press('Enter')
  await chatInput().fill('Draft prompt')

  await chatInput().press('ArrowUp')
  await expect(chatInput()).toHaveValue('Second prompt')
  await chatInput().press('ArrowUp')
  await expect(chatInput()).toHaveValue('First prompt')
  await chatInput().press('ArrowDown')
  await expect(chatInput()).toHaveValue('Second prompt')
  await chatInput().press('ArrowDown')
  await expect(chatInput()).toHaveValue('Draft prompt')

  await page.reload()
  await canvas.waitForInit()
  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().press('ArrowUp')
  await expect(chatInput()).toHaveValue('Second prompt')
})

test('chat history is restored after reload', async () => {
  await page.evaluate((storageKey) => localStorage.removeItem(storageKey), CHAT_MESSAGE_HISTORY_STORAGE)
  await page.reload()
  await canvas.waitForInit()
  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().fill('Restore this conversation after reload')
  await chatInput().press('Enter')

  await expect(page.getByText('Restore this conversation after reload', { exact: true })).toBeVisible()
  if (!USE_REAL_LLM) {
    await expect(page.getByText('mock response', { exact: false })).toBeVisible({ timeout: 5000 })
  }

  await page.reload()
  await canvas.waitForInit()
  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }

  await chatTab().click()
  await expect(page.getByText('Restore this conversation after reload', { exact: true })).toBeVisible()
})

test('restored assistant chat history with inline markdown does not trigger page errors on AI tab open', async () => {
  await page.evaluate((storageKey) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify([
        {
          id: 'restored-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Restore this chat' }]
        },
        {
          id: 'restored-assistant',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Reading `REQUEST.md` and locating the helper script first.'
            }
          ]
        }
      ])
    )
  }, CHAT_MESSAGE_HISTORY_STORAGE)

  await page.reload()
  await canvas.waitForInit()
  if (!USE_REAL_LLM) {
    await injectMockTransport(page)
  }

  const pageErrors: string[] = []
  const handlePageError = (error: Error) => {
    pageErrors.push(error.message)
  }

  page.on('pageerror', handlePageError)

  await chatTab().click()
  await expect(page.getByText('Reading `REQUEST.md` and locating the helper script first.', { exact: false })).toBeVisible()
  expect(pageErrors).toEqual([])

  page.off('pageerror', handlePageError)
})

test('shows a thinking indicator before the assistant emits visible content', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectDelayedMockTransport(page)

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().fill('Think first')
  await chatInput().press('Enter')

  await expect(page.locator('[data-test-id="chat-typing-indicator"]')).toBeVisible()
  await expect(page.getByText('Thinking…')).toBeVisible()
  await expect(page.getByText('Done thinking.', { exact: false })).toBeVisible({ timeout: 5000 })
})

test('shows a thinking indicator for a new turn even when prior assistant history exists', async () => {
  await page.evaluate((storageKey) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify([
        {
          id: 'restored-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Restore this chat' }]
        },
        {
          id: 'restored-assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Previous assistant reply' }]
        }
      ])
    )
  }, CHAT_MESSAGE_HISTORY_STORAGE)

  await page.reload()
  await canvas.waitForInit()
  await injectDelayedMockTransport(page)

  await chatTab().click()
  await expect(page.getByText('Previous assistant reply', { exact: true })).toBeVisible()

  await chatInput().fill('Start another turn')
  await chatInput().press('Enter')

  await expect(page.locator('[data-test-id="chat-typing-indicator"]')).toBeVisible()
  await expect(page.getByText('Thinking…')).toBeVisible()
  await expect(page.getByText('Done thinking.', { exact: false })).toBeVisible({ timeout: 5000 })
})

test('streaming assistant markdown does not trigger page errors', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectStreamingMarkdownTransport(page)

  const pageErrors: string[] = []
  const handlePageError = (error: Error) => {
    pageErrors.push(error.message)
  }

  page.on('pageerror', handlePageError)

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().fill('Stream a markdown response')
  await chatInput().press('Enter')

  await expect(page.getByText('Reading `REQUEST.md` and locating the helper script first.', { exact: false })).toBeVisible()
  await expect(page.getByText('The initial connection retried successfully and rendering is continuing.', { exact: false })).toBeVisible({ timeout: 5000 })
  expect(pageErrors).toEqual([])

  page.off('pageerror', handlePageError)
})

test('assistant transcript stays segmented around thinking and tool calls', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectSegmentedToolTransport(page)

  await chatTab().click()
  await expect(chatInput()).toBeVisible()

  await chatInput().fill('Compare this and fix the layout')
  await chatInput().press('Enter')

  await expect(page.locator('[data-test-id="chat-part-thinking"]')).toContainText(
    'Inspecting the reference screenshot and current canvas state.'
  )
  await expect(page.getByText('Create Shape')).toBeVisible({ timeout: 5000 })

  const lastAssistantMessage = page.locator('[data-test-id="chat-message-assistant"]').last()
  await expect(lastAssistantMessage.locator('[data-test-id="chat-text-bubble"]')).toHaveCount(2)
  await expect(lastAssistantMessage.getByText('I found the main layout mismatch.', { exact: false })).toBeVisible()
  await expect(lastAssistantMessage.getByText('I created the new frame and aligned it to the reference.', { exact: false })).toBeVisible()
})

test('chat history storage strips raw image data urls', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)

  await chatTab().click()

  await page.evaluate(() => {
    const target = document.querySelector('[data-test-id="chat-input"]')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('Chat input not found')

    const data = new DataTransfer()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const file = new File([blob], 'clipboard-image.png', { type: 'image/png' })
    data.items.add(file)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    target.dispatchEvent(event)
  })

  await chatInput().fill('Use this screenshot')
  await chatInput().press('Enter')

  await expect(page.getByText('clipboard-image.png')).toBeVisible()

  await expect
    .poll(async () =>
      page.evaluate((storageKey) => localStorage.getItem(storageKey), CHAT_MESSAGE_HISTORY_STORAGE)
    )
    .toContain('openpencil://attachment/')

  const storedHistory = await page.evaluate(
    (storageKey) => localStorage.getItem(storageKey),
    CHAT_MESSAGE_HISTORY_STORAGE
  )
  expect(storedHistory).not.toContain('data:image/')
})

test('restored image attachments render from indexeddb-backed placeholders', async () => {
  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)

  await chatTab().click()

  await page.evaluate(() => {
    const target = document.querySelector('[data-test-id="chat-input"]')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('Chat input not found')

    const data = new DataTransfer()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const file = new File([blob], 'restored-image.png', { type: 'image/png' })
    data.items.add(file)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    target.dispatchEvent(event)
  })

  await chatInput().fill('Store this screenshot for reload')
  await chatInput().press('Enter')

  await expect
    .poll(async () =>
      page.evaluate((storageKey) => localStorage.getItem(storageKey), CHAT_MESSAGE_HISTORY_STORAGE)
    )
    .toContain('openpencil://attachment/')

  await page.reload()
  await canvas.waitForInit()
  await injectMockTransport(page)
  await chatTab().click()

  const restoredUserMessage = page.locator('[data-test-id="chat-message-user"]').last()
  await expect(restoredUserMessage.getByText('restored-image.png')).toBeVisible()
  await expect(restoredUserMessage.locator('img[alt="restored-image.png"]')).toBeVisible()
})
