import { ALL_TOOLS, sceneNodeToJSX, selectionToJSX } from '@open-pencil/core'
import dedent from 'dedent'

import { IS_TAURI } from '@/constants'
import { formatToolCatalog } from '@/ai/tool-executor'
import {
  getStoredChatAttachment,
  isAttachmentPlaceholderUrl
} from '@/utils/chat-attachment-store'

import type { EditorStore } from '@/stores/editor'
import type { ModelOption } from '@open-pencil/core'
import {
  isFileUIPart,
  isStaticToolUIPart,
  type FileUIPart,
  type ToolUIPart,
  type UIMessage
} from 'ai'

const MAX_CONTEXT_MESSAGES = 8
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_TEXT = 4000
const MAX_TOOL_RESULT_CHARS = 5000
const DIRECT_TOOL_CATALOG = formatToolCatalog(ALL_TOOLS)

interface TextPart {
  type: 'text'
  text: string
}

interface CliAttachmentPayload {
  name: string
  mediaType: string
  bytes: number[]
  textSnippet?: string
}

interface CliCommandResponse {
  stdout: string
  stderr: string
  exitCode: number
  toolLogs: CliToolLogEntry[]
}

interface CliToolLogEntry {
  name: string
  args: unknown
  ok: boolean
  result?: unknown
  error?: string | null
}

interface CliStreamEvent {
  requestId: string
  kind: 'stdout' | 'stderr' | 'tool-log'
  text?: string
  toolLog?: CliToolLogEntry
}

type LocalCliBackend = Extract<ModelOption['backend'], 'claude-code' | 'codex-cli'>

interface CliSessionState {
  backend: LocalCliBackend
  modelId: string
  sessionId: string
}

interface CliSessionManager {
  getOrCreateSession: () => {
    session: CliSessionState
    isNew: boolean
  }
  getSubagentCount: () => number
}

interface CliStructuredToolStart {
  toolCallId: string
  toolName: string
  input?: unknown
}

interface CliStructuredToolComplete {
  toolCallId: string
  toolName: string
  output?: unknown
  errorText?: string
}

interface CliStructuredParserHandlers {
  onAssistantDelta?: (delta: string) => void
  onAssistantSnapshotReplace?: (text: string) => void
  onReasoningStart?: (entry: { id: string; text?: string }) => void
  onReasoningDelta?: (entry: { id: string; delta: string }) => void
  onReasoningReplace?: (entry: { id: string; text: string }) => void
  onReasoningEnd?: (entry: { id: string }) => void
  onToolStart?: (entry: CliStructuredToolStart) => void
  onToolComplete?: (entry: CliStructuredToolComplete) => void
}

interface CliStructuredParserState {
  assistantText: string
  buffer: string
  finalAssistantText: string
  latestAssistantSnapshotText: string
  sawStructuredEvent: boolean
  textSnapshots: Map<string, string>
  reasoningSnapshots: Map<string, string>
  toolStarts: Set<string>
}

function isTextPart(part: unknown): part is TextPart {
  return typeof part === 'object' && part !== null && 'type' in part && (part as TextPart).type === 'text'
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function getTextContent(message: UIMessage): string {
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join('')
}

function fileLabel(part: FileUIPart): string {
  if (part.filename) return part.filename
  if (part.mediaType) return part.mediaType.replace(/^[^/]+\//, '') || 'attachment'
  return 'attachment'
}

function stringifyValue(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  try {
    return truncate(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return truncate(String(value), maxChars)
  }
}

function toolOutputSummary(part: ToolUIPart): string | null {
  if (part.state === 'output-available') {
    return truncate(stringifyValue(part.output, 1500), 1500)
  }

  if (part.state === 'output-error') {
    return truncate(part.errorText, 1500)
  }

  return null
}

function buildConversationSummary(messages: UIMessage[]): string {
  return messages.slice(-MAX_CONTEXT_MESSAGES).map((message) => {
    const lines: string[] = [`Role: ${message.role}`]
    const text = getTextContent(message)
    if (text) lines.push(`Text: ${text}`)

    const files = message.parts.filter(isFileUIPart)
    if (files.length > 0) {
      lines.push(`Attachments: ${files.map((file) => fileLabel(file)).join(', ')}`)
    }

    const toolOutputs = message.parts
      .filter(isStaticToolUIPart)
      .flatMap((part) => {
        const summary = toolOutputSummary(part)
        return summary ? [summary] : []
      })
    if (toolOutputs.length > 0) {
      lines.push(`Tool outputs: ${toolOutputs.join('\n')}`)
    }

    return lines.join('\n')
  }).join('\n\n')
}

function buildCanvasContext(store: EditorStore): string {
  const currentPage = store.graph.getNode(store.state.currentPageId)
  const selectedIds = [...store.state.selectedIds]
  const selectedNodes = selectedIds
    .map((id) => store.graph.getNode(id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined)

  const selectionSummary =
    selectedNodes.length > 0
      ? selectedNodes.map((node) => `${node.id}: ${node.type} "${node.name}"`).join('\n')
      : 'No nodes selected.'

  let selectionJsx = ''
  if (selectedIds.length === 1) {
    selectionJsx = sceneNodeToJSX(selectedIds[0], store.graph, 'openpencil') ?? ''
  } else if (selectedIds.length > 1) {
    selectionJsx = selectionToJSX(selectedIds, store.graph, 'openpencil') ?? ''
  }

  return [
    `Current page: ${currentPage?.name ?? 'Unknown'} (${store.state.currentPageId})`,
    `Selection count: ${selectedIds.length}`,
    'Selected nodes:',
    selectionSummary,
    selectionJsx ? `Selection JSX:\n${selectionJsx}` : 'Selection JSX: none'
  ].join('\n')
}

function buildAttachmentSummary(attachments: CliAttachmentPayload[]): string {
  if (attachments.length === 0) return 'No attachments.'
  return attachments
    .map((attachment) =>
      [
        `${attachment.name} (${attachment.mediaType}, ${attachment.bytes.length} bytes)`,
        attachment.textSnippet
          ? `Text excerpt:\n${attachment.textSnippet}`
          : 'Binary attachment available in ./attachments.'
      ].join('\n')
    )
    .join('\n\n')
}

function getLatestUserRequest(messages: UIMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!lastUserMessage) return 'No explicit user request was provided.'

  const text = getTextContent(lastUserMessage).trim()
  return text || 'The request is conveyed only through the attached files for this turn.'
}

export function buildDirectPrompt(
  store: EditorStore,
  messages: UIMessage[],
  attachments: CliAttachmentPayload[],
  options: {
    resumeSession: boolean
    subagentCount: number
  }
): string {
  const useSubagents = options.subagentCount > 1
  const workerBudget = Math.max(0, options.subagentCount - 1)
  const sessionInstructions = options.resumeSession
    ? dedent`
        Session mode:
        - This is a continuation of an existing native CLI session.
        - Use the CLI's built-in conversation history instead of reconstructing prior turns yourself.
        - Focus on the current request below and the live OpenPencil canvas state.
      `
    : dedent`
        Session mode:
        - This is the first turn of a new native CLI session.
        - Use the conversation summary below to seed the initial context for this session.
      `

  const subagentInstructions = useSubagents
    ? dedent`
        Execution mode:
        - You have a budget of ${options.subagentCount} agents total, including yourself.
        - You are the lead coordinator. Start by analyzing the request and decomposing it into concrete sub-tasks.
        - If your backend supports native subagents or parallel delegation, use up to ${workerBudget} worker agents when the work is independent enough to benefit from parallel execution.
        - Reserve the main thread for planning, conflict resolution, verification, and synthesis.
        - Delegate only bounded sub-tasks. Do not fragment tightly coupled edits or duplicate work across workers.
        - After worker results come back, reconcile them against the live OpenPencil document, verify the final state, and then respond to the user.
        - If native subagents are unavailable, still follow the same coordinator-first plan yourself and execute the sub-tasks sequentially without dropping the decomposition discipline.
      `
    : dedent`
        Execution mode:
        - Work as a single agent.
        - Do not attempt delegation or subagent coordination for this turn.
      `

  return dedent`
    You are the local desktop CLI backend for OpenPencil, a design editor.

    Rules:
    - Satisfy the user's request against the live OpenPencil document.
    - To inspect or mutate the canvas, run: node openpencil-tool.mjs <tool_name> '<json_args>'
    - The helper prints the tool result JSON to stdout and exits non-zero on failure.
    - The render tool is supported here. Pass its normal JSON args with a JSX string and the helper will compile it for you.
    - Use only tools from the catalog below.
    - Do not invent tool names or arguments.
    - Attachment files for this turn are available in ./attachments and listed in ATTACHMENTS.md.
    - Do not edit files outside this session working directory.
    - After you finish, output only the final user-facing response in markdown. Do not output JSON.
    - When the user provides a screenshot, mockup, or other reference image, use take_screenshot before editing to inspect the current canvas state.
    - For screenshot comparison, prefer take_screenshot with format=PNG.
    - Use take_screenshot with target=PAGE for whole-screen comparisons and target=SELECTION or explicit node ids for localized comparisons.
    - For PAGE captures, rely on the tool's default max_long_edge limit so the image stays safe for multi-image model requests.
    - Use scale=2 only for focused SELECTION or explicit node captures, and scale=3 only for very small UI details.
    - Compare the current capture against the user attachment before making visual edits, then take another screenshot after substantial changes to verify the result.
    - Use screenshots for visual verification and structural tools for the actual edits.

    ${sessionInstructions}

    ${subagentInstructions}

    Canvas context:
    ${buildCanvasContext(store)}

    Current user request:
    ${getLatestUserRequest(messages)}

    Attachment summary:
    ${buildAttachmentSummary(attachments)}

    ${
      options.resumeSession
        ? 'Conversation summary:\nUse the native CLI session history for previous turns.'
        : `Conversation summary:\n${buildConversationSummary(messages)}`
    }

    Available OpenPencil tools:
    ${DIRECT_TOOL_CATALOG}
  `
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value[key] === 'string' ? value[key] : undefined
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  return typeof value[key] === 'number' ? value[key] : undefined
}

function extractTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((entry) => extractTextValue(entry)).filter(Boolean).join('')
  }
  if (!isRecord(value)) return ''

  if (typeof value.text === 'string') return value.text
  if (typeof value.message === 'string') return value.message
  if (typeof value.summary === 'string') return value.summary
  if (typeof value.result === 'string') return value.result
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return extractTextValue(value.content)
  if (typeof value.thinking === 'string') return value.thinking
  return ''
}

function appendAssistantDelta(
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers,
  delta: string
) {
  if (!delta) return
  state.assistantText += delta
  handlers.onAssistantDelta?.(delta)
}

function updateAssistantSnapshot(
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers,
  snapshotId: string,
  text: string
) {
  if (!text) return
  const previous = state.textSnapshots.get(snapshotId) ?? ''
  state.textSnapshots.set(snapshotId, text)
  state.finalAssistantText = text
  state.latestAssistantSnapshotText = text

  if (!previous) {
    appendAssistantDelta(state, handlers, text)
    return
  }

  if (text.startsWith(previous)) {
    appendAssistantDelta(state, handlers, text.slice(previous.length))
    return
  }

  handlers.onAssistantSnapshotReplace?.(text)
}

function updateReasoningSnapshot(
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers,
  snapshotId: string,
  text: string
) {
  if (!text) return
  const previous = state.reasoningSnapshots.get(snapshotId) ?? ''
  state.reasoningSnapshots.set(snapshotId, text)

  if (!previous) {
    handlers.onReasoningStart?.({
      id: snapshotId,
      text
    })
    return
  }

  if (text.startsWith(previous)) {
    handlers.onReasoningDelta?.({
      id: snapshotId,
      delta: text.slice(previous.length)
    })
    return
  }

  handlers.onReasoningReplace?.({
    id: snapshotId,
    text
  })
}

function getCodexItemType(item: Record<string, unknown>): string {
  return getStringProperty(item, 'type') ?? getStringProperty(item, 'item_type') ?? ''
}

function isCodexAssistantItemType(itemType: string): boolean {
  return itemType === 'agent_message' || itemType === 'assistant_message'
}

function codexProgressToolName(item: Record<string, unknown>): string {
  const itemType = getCodexItemType(item) || 'progress'
  if (itemType === 'reasoning') return 'thinking_step'
  if (itemType === 'command_execution') return 'run_command'
  if (itemType === 'todo_list') return 'update_plan'
  if (itemType === 'web_search') return 'web_search'
  if (itemType === 'mcp_tool_call') {
    return getStringProperty(item, 'tool_name') ?? getStringProperty(item, 'tool') ?? 'mcp_tool_call'
  }
  return itemType.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'progress_step'
}

function buildCodexToolInput(item: Record<string, unknown>): unknown {
  const itemType = getCodexItemType(item)

  if (itemType === 'reasoning') {
    return extractTextValue(item.summary ?? item.text ?? item.content) || 'Thinking through implementation'
  }

  if (itemType === 'command_execution') {
    return {
      command:
        getStringProperty(item, 'command') ??
        getStringProperty(item, 'raw_command') ??
        extractTextValue(item.input)
    }
  }

  if (itemType === 'mcp_tool_call') {
    return {
      server:
        getStringProperty(item, 'server_name') ??
        getStringProperty(item, 'server') ??
        'mcp',
      tool: getStringProperty(item, 'tool_name') ?? getStringProperty(item, 'tool') ?? 'tool',
      input: item.arguments ?? item.input
    }
  }

  const summary = extractTextValue(item.input ?? item.summary ?? item.text ?? item.content)
  return summary || undefined
}

function buildCodexToolOutput(item: Record<string, unknown>): {
  errorText?: string
  output?: unknown
} {
  const itemType = getCodexItemType(item)

  if (itemType === 'command_execution') {
    const exitCode = getNumberProperty(item, 'exit_code') ?? getNumberProperty(item, 'exitCode')
    const output =
      item.aggregated_output ??
      item.output ??
      item.result ??
      item.stderr ??
      extractTextValue(item)

    if (typeof exitCode === 'number' && exitCode !== 0) {
      const detail =
        typeof output === 'string' && output.trim().length > 0
          ? output
          : `Command exited with code ${exitCode}`
      return { errorText: detail }
    }

    return {
      output: {
        command:
          getStringProperty(item, 'command') ??
          getStringProperty(item, 'raw_command') ??
          undefined,
        exitCode,
        output
      }
    }
  }

  if (itemType === 'mcp_tool_call') {
    return {
      output: item.result ?? item.output ?? extractTextValue(item)
    }
  }

  if (itemType === 'reasoning') {
    return {
      output: extractTextValue(item.text ?? item.summary ?? item.content) || 'Completed'
    }
  }

  if (typeof item.error === 'string' && item.error) {
    return { errorText: item.error }
  }

  return {
    output: item.result ?? item.output ?? (extractTextValue(item) || 'Completed')
  }
}

function maybeEmitCodexToolStart(
  item: unknown,
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers
): Record<string, unknown> | null {
  if (!isRecord(item)) return null
  const itemId = getStringProperty(item, 'id')
  const itemType = getCodexItemType(item)
  if (!itemId || !itemType || isCodexAssistantItemType(itemType)) return null
  if (state.toolStarts.has(itemId)) return item

  state.toolStarts.add(itemId)
  handlers.onToolStart?.({
    toolCallId: itemId,
    toolName: codexProgressToolName(item),
    input: buildCodexToolInput(item)
  })
  return item
}

function parseCodexStructuredEvent(
  event: Record<string, unknown>,
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers
) {
  const eventType = getStringProperty(event, 'type')
  if (!eventType) return

  if (eventType === 'agent_message_delta') {
    appendAssistantDelta(state, handlers, getStringProperty(event, 'delta') ?? '')
    return
  }

  if (eventType === 'agent_message') {
    const message = getStringProperty(event, 'message') ?? extractTextValue(event.content)
    updateAssistantSnapshot(state, handlers, 'codex-agent-message', message)
    return
  }

  if (eventType === 'item.started' || eventType === 'item.updated') {
    if (!isRecord(event.item)) return
    const item = event.item
    const itemType = getCodexItemType(item)
    const itemId = getStringProperty(item, 'id')
    if (!itemId || !itemType) return

    if (itemType === 'reasoning') {
      maybeEmitCodexToolStart(item, state, handlers)
      const text = extractTextValue(item.summary ?? item.text ?? item.content)
      if (text) {
        updateReasoningSnapshot(state, handlers, itemId, text)
      }
      return
    }

    if (isCodexAssistantItemType(itemType)) {
      const text = extractTextValue(item.text ?? item.message ?? item.content)
      if (text) {
        updateAssistantSnapshot(state, handlers, itemId, text)
      }
      return
    }

    maybeEmitCodexToolStart(item, state, handlers)
    return
  }

  if (eventType === 'item.completed') {
    if (!isRecord(event.item)) return
    const item = event.item
    const itemType = getCodexItemType(item)
    const itemId = getStringProperty(item, 'id')
    if (!itemId || !itemType) return

    if (itemType === 'reasoning') {
      maybeEmitCodexToolStart(item, state, handlers)
      const text = extractTextValue(item.text ?? item.summary ?? item.content)
      if (text) {
        updateReasoningSnapshot(state, handlers, itemId, text)
      }
      handlers.onReasoningEnd?.({ id: itemId })
      const completion = buildCodexToolOutput(item)
      handlers.onToolComplete?.({
        toolCallId: itemId,
        toolName: codexProgressToolName(item),
        output: completion.output,
        errorText: completion.errorText
      })
      return
    }

    if (isCodexAssistantItemType(itemType)) {
      updateAssistantSnapshot(
        state,
        handlers,
        itemId,
        extractTextValue(item.text ?? item.message ?? item.content)
      )
      return
    }

    maybeEmitCodexToolStart(item, state, handlers)
    const completion = buildCodexToolOutput(item)
    handlers.onToolComplete?.({
      toolCallId: itemId,
      toolName: codexProgressToolName(item),
      output: completion.output,
      errorText: completion.errorText
    })
  }
}

function parseClaudeStructuredEvent(
  event: Record<string, unknown>,
  state: CliStructuredParserState,
  handlers: CliStructuredParserHandlers
) {
  const eventType = getStringProperty(event, 'type')
  if (!eventType) return

  if (eventType === 'assistant') {
    const message = isRecord(event.message) ? event.message : null
    if (!message) return
    const messageId = getStringProperty(message, 'id') ?? 'claude-assistant'
    const text = extractTextValue(message.content)
    updateAssistantSnapshot(state, handlers, messageId, text)
    return
  }

  if (eventType === 'result') {
    const resultText = getStringProperty(event, 'result') ?? ''
    if (resultText) {
      state.finalAssistantText = resultText
    }
  }
}

export function createCliStructuredOutputParser(
  backend: LocalCliBackend,
  handlers: CliStructuredParserHandlers = {}
) {
  const state: CliStructuredParserState = {
    assistantText: '',
    buffer: '',
    finalAssistantText: '',
    latestAssistantSnapshotText: '',
    sawStructuredEvent: false,
    textSnapshots: new Map(),
    reasoningSnapshots: new Map(),
    toolStarts: new Set()
  }

  function processLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }

    if (!isRecord(parsed)) return
    state.sawStructuredEvent = true

    if (backend === 'codex-cli') {
      parseCodexStructuredEvent(parsed, state, handlers)
      return
    }

    parseClaudeStructuredEvent(parsed, state, handlers)
  }

  return {
    push(chunk: string) {
      if (!chunk) return
      state.buffer += chunk

      while (true) {
        const newlineIndex = state.buffer.indexOf('\n')
        if (newlineIndex === -1) break
        const line = state.buffer.slice(0, newlineIndex)
        state.buffer = state.buffer.slice(newlineIndex + 1)
        processLine(line)
      }
    },
    flush() {
      if (state.buffer.trim()) {
        processLine(state.buffer)
      }
      state.buffer = ''
    },
    state
  }
}

function getFinalCliMessage(response: CliCommandResponse, parserState: CliStructuredParserState): string {
  if (response.exitCode !== 0) {
    const detail = response.stderr.trim() || response.stdout.trim() || `exit code ${response.exitCode}`
    throw new Error(`Local CLI exited with an error: ${detail}`)
  }

  const structuredText = parserState.finalAssistantText.trim() || parserState.assistantText.trim()
  if (structuredText) return structuredText

  const text = response.stdout.trim()
  if (text) return text

  const detail = response.stderr.trim() || `exit code ${response.exitCode}`
  throw new Error(`Local CLI did not return a final response: ${detail}`)
}

function chunkText(text: string): string[] {
  const parts = text.match(/\S+\s*/g)
  return parts && parts.length > 0 ? parts : [text]
}

function enqueueToolReplayEntry(
  controller: ReadableStreamDefaultController,
  index: number,
  entry: CliToolLogEntry
) {
  const toolCallId = `cli-tool-${index + 1}`
  controller.enqueue({
    type: 'tool-input-start',
    toolCallId,
    toolName: entry.name
  })
  controller.enqueue({
    type: 'tool-input-available',
    toolCallId,
    toolName: entry.name,
    input: entry.args
  })
  if (entry.ok) {
    controller.enqueue({
      type: 'tool-output-available',
      toolCallId,
      toolName: entry.name,
      output: entry.result
    })
    return
  }

  controller.enqueue({
    type: 'tool-output-error',
    toolCallId,
    toolName: entry.name,
    errorText: entry.error ?? 'Tool call failed'
  })
}

function enqueueAssistantTextStart(controller: ReadableStreamDefaultController, textId: string) {
  controller.enqueue({ type: 'text-start', id: textId })
}

function enqueueAssistantTextDelta(
  controller: ReadableStreamDefaultController,
  textId: string,
  delta: string
) {
  if (!delta) return
  controller.enqueue({ type: 'text-delta', id: textId, delta })
}

function enqueueAssistantTextEnd(controller: ReadableStreamDefaultController, textId: string) {
  controller.enqueue({ type: 'text-end', id: textId })
}

function enqueueAssistantText(controller: ReadableStreamDefaultController, text: string) {
  enqueueAssistantTextStart(controller, 'text-1')
  for (const chunk of chunkText(text)) {
    enqueueAssistantTextDelta(controller, 'text-1', chunk)
  }
  enqueueAssistantTextEnd(controller, 'text-1')
}

async function filePartToPayload(part: FileUIPart): Promise<CliAttachmentPayload> {
  let blob: Blob
  if (isAttachmentPlaceholderUrl(part.url)) {
    const storedAttachment = await getStoredChatAttachment(part.url)
    if (!storedAttachment) {
      throw new Error(`Attachment "${fileLabel(part)}" is no longer available`)
    }
    blob = storedAttachment.blob
  } else {
    const response = await fetch(part.url)
    blob = await response.blob()
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment "${fileLabel(part)}" exceeds the 2 MB local CLI limit`)
  }

  const mediaType = part.mediaType ?? blob.type ?? 'application/octet-stream'
  const textSnippet =
    mediaType.startsWith('text/') || mediaType.includes('json') || mediaType.includes('xml')
      ? truncate(await blob.text(), MAX_ATTACHMENT_TEXT)
      : undefined

  return {
    name: fileLabel(part),
    mediaType,
    bytes: Array.from(bytes),
    textSnippet
  }
}

async function collectLatestAttachments(messages: UIMessage[]): Promise<CliAttachmentPayload[]> {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!lastUserMessage) return []

  const fileParts = lastUserMessage.parts.filter(isFileUIPart)
  const payloads: CliAttachmentPayload[] = []
  for (const filePart of fileParts) {
    payloads.push(await filePartToPayload(filePart))
  }
  return payloads
}

function createAbortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('The request was aborted', 'AbortError')
    : new Error('The request was aborted')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function cancelCliBackendRequest(requestId: string) {
  if (!IS_TAURI) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('cancel_agent_cli', { requestId }).catch(() => {})
}

async function invokeCliBackend(
  model: ModelOption,
  prompt: string,
  attachments: CliAttachmentPayload[],
  session: CliSessionState,
  resumeSession: boolean,
  handlers?: {
    onStdoutChunk?: (chunk: string) => void
    onStderrChunk?: (chunk: string) => void
    onToolLog?: (entry: CliToolLogEntry) => void
  },
  abortSignal?: AbortSignal
): Promise<CliCommandResponse> {
  if (!IS_TAURI) {
    throw new Error('Local CLI backends are only available in the desktop app')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  const requestId = `cli-${crypto.randomUUID()}`

  return new Promise<CliCommandResponse>((resolve, reject) => {
    let settled = false
    let unlisten: (() => void) | undefined

    const cleanup = () => {
      abortSignal?.removeEventListener('abort', onAbort)
      unlisten?.()
      unlisten = undefined
    }

    const resolveWith = (response: CliCommandResponse) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }

    const rejectWith = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const onAbort = () => {
      void cancelCliBackendRequest(requestId)
      rejectWith(createAbortError())
    }

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true })
      if (abortSignal.aborted) {
        onAbort()
        return
      }
    }

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<CliStreamEvent>('agent-cli-event', (event) => {
          if (event.payload.requestId !== requestId) return

          if (event.payload.kind === 'stdout' && event.payload.text) {
            handlers?.onStdoutChunk?.(event.payload.text)
          }

          if (event.payload.kind === 'stderr' && event.payload.text) {
            handlers?.onStderrChunk?.(event.payload.text)
          }

          if (event.payload.kind === 'tool-log' && event.payload.toolLog) {
            handlers?.onToolLog?.(event.payload.toolLog)
          }
        })

        if (abortSignal?.aborted) {
          onAbort()
          return
        }

        const response = await invoke<CliCommandResponse>('run_agent_cli', {
          request: {
            requestId,
            mode: 'direct',
            backend: model.backend,
            model: model.model,
            sessionId: session.sessionId,
            resumeSession,
            prompt,
            attachments
          }
        })
        resolveWith(response)
      } catch (error) {
        rejectWith(error)
      }
    })()
  })
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

export function createCliAgentTransport(
  store: EditorStore,
  model: ModelOption,
  sessionManager: CliSessionManager
) {
  return {
    async sendMessages({
      messages,
      abortSignal
    }: {
      messages: UIMessage[]
      abortSignal?: AbortSignal
    }) {
      return new ReadableStream({
        async start(controller) {
          const messageId = `cli-msg-${crypto.randomUUID()}`
          let liveToolLogCount = 0
          let textPartCount = 0
          let reasoningPartCount = 0
          let activeTextId: string | null = null
          let activeReasoning: {
            sourceId: string
            streamId: string
          } | null = null
          const cliBackend = model.backend as LocalCliBackend

          function openAssistantTextPart() {
            closeReasoningPart()
            if (activeTextId) return activeTextId
            textPartCount += 1
            activeTextId = `text-${textPartCount}`
            enqueueAssistantTextStart(controller, activeTextId)
            return activeTextId
          }

          function appendAssistantText(delta: string) {
            if (!delta) return
            const textId = openAssistantTextPart()
            enqueueAssistantTextDelta(controller, textId, delta)
          }

          function replaceAssistantText(text: string) {
            closeAssistantTextPart()
            if (!text) return
            appendAssistantText(text)
          }

          function closeAssistantTextPart() {
            if (!activeTextId) return
            enqueueAssistantTextEnd(controller, activeTextId)
            activeTextId = null
          }

          function openReasoningPart(sourceId: string) {
            closeAssistantTextPart()
            if (activeReasoning?.sourceId === sourceId) return activeReasoning.streamId
            closeReasoningPart()
            reasoningPartCount += 1
            const streamId = `reasoning-${reasoningPartCount}`
            activeReasoning = {
              sourceId,
              streamId
            }
            controller.enqueue({
              type: 'reasoning-start',
              id: streamId
            })
            return streamId
          }

          function appendReasoningText(sourceId: string, delta: string) {
            if (!delta) return
            const streamId = openReasoningPart(sourceId)
            controller.enqueue({
              type: 'reasoning-delta',
              id: streamId,
              delta
            })
          }

          function replaceReasoningText(sourceId: string, text: string) {
            closeReasoningPart()
            if (!text) return
            appendReasoningText(sourceId, text)
          }

          function closeReasoningPart(sourceId?: string) {
            if (!activeReasoning) return
            if (sourceId && activeReasoning.sourceId !== sourceId) return
            controller.enqueue({
              type: 'reasoning-end',
              id: activeReasoning.streamId
            })
            activeReasoning = null
          }

          function closeActiveParts() {
            closeAssistantTextPart()
            closeReasoningPart()
          }

          function isVisibleHelperToolLog(entry: CliToolLogEntry): boolean {
            return entry.name !== 'run_command' && entry.name !== 'thinking_step'
          }

          function enqueueVisibleToolReplayEntry(index: number, entry: CliToolLogEntry) {
            if (!isVisibleHelperToolLog(entry)) return
            closeActiveParts()
            enqueueToolReplayEntry(controller, index, entry)
          }

          function replayRemainingToolLogs(entries: CliToolLogEntry[]) {
            for (const entry of entries) {
              enqueueVisibleToolReplayEntry(liveToolLogCount, entry)
              liveToolLogCount += 1
            }
          }

          const outputParser = createCliStructuredOutputParser(cliBackend, {
            onAssistantDelta(delta) {
              if (abortSignal?.aborted || !delta) return
              appendAssistantText(delta)
            },
            onAssistantSnapshotReplace(text) {
              if (abortSignal?.aborted || !text) return
              replaceAssistantText(text)
            },
            onReasoningStart(entry) {
              if (abortSignal?.aborted) return
              if (entry.text) {
                appendReasoningText(entry.id, entry.text)
                return
              }
              openReasoningPart(entry.id)
            },
            onReasoningDelta(entry) {
              if (abortSignal?.aborted || !entry.delta) return
              appendReasoningText(entry.id, entry.delta)
            },
            onReasoningReplace(entry) {
              if (abortSignal?.aborted || !entry.text) return
              replaceReasoningText(entry.id, entry.text)
            },
            onReasoningEnd(entry) {
              if (abortSignal?.aborted) return
              closeReasoningPart(entry.id)
            }
          })
          controller.enqueue({ type: 'start', messageId })

          try {
            const attachments = await collectLatestAttachments(messages)
            const { session, isNew } = sessionManager.getOrCreateSession()
            const prompt = buildDirectPrompt(store, messages, attachments, {
              resumeSession: !isNew,
              subagentCount: sessionManager.getSubagentCount()
            })
            const cliResponse = await invokeCliBackend(
              model,
              prompt,
              attachments,
              session,
              !isNew,
              {
                onStdoutChunk(chunk) {
                  if (abortSignal?.aborted || !chunk) return
                  outputParser.push(chunk)
                },
                onStderrChunk(chunk) {
                  if (abortSignal?.aborted || !chunk) return
                  outputParser.push(chunk)
                },
                onToolLog(entry) {
                  if (abortSignal?.aborted) return
                  enqueueVisibleToolReplayEntry(liveToolLogCount, entry)
                  liveToolLogCount += 1
                }
              },
              abortSignal
            )

            if (abortSignal?.aborted) {
              controller.enqueue({ type: 'finish', finishReason: 'stop' })
              controller.close()
              return
            }

            if (cliResponse.toolLogs.length > liveToolLogCount) {
              replayRemainingToolLogs(cliResponse.toolLogs.slice(liveToolLogCount))
            }

            outputParser.flush()
            const finalAssistantMessage = getFinalCliMessage(cliResponse, outputParser.state)

            if (!abortSignal?.aborted) {
              const streamedAssistantText =
                outputParser.state.latestAssistantSnapshotText || outputParser.state.assistantText
              const prefixLength = commonPrefixLength(
                finalAssistantMessage,
                streamedAssistantText
              )
              const remainingText = streamedAssistantText
                ? finalAssistantMessage.slice(prefixLength)
                : finalAssistantMessage

              if (remainingText) {
                appendAssistantText(remainingText)
              }
            }
            closeActiveParts()
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
          } catch (error) {
            if (isAbortError(error) || abortSignal?.aborted) {
              closeActiveParts()
              controller.enqueue({ type: 'finish', finishReason: 'stop' })
              controller.close()
              return
            }
            const message = error instanceof Error ? error.message : String(error)
            closeActiveParts()
            enqueueAssistantText(controller, `Local CLI backend error: ${message}`)
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
          }
        }
      })
    },

    async reconnectToStream() {
      return null
    }
  }
}
