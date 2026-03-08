import { Chat } from '@ai-sdk/vue'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createProviderRegistry, DirectChatTransport, ToolLoopAgent } from 'ai'
import dedent from 'dedent'
import { computed, ref, shallowRef, watch } from 'vue'

import { createCliAgentTransport } from '@/ai/cli-agent'
import { createAITools } from '@/ai/tools'
import {
  CHAT_CLI_SESSION_STORAGE,
  CHAT_MESSAGE_HISTORY_STORAGE,
  IS_TAURI
} from '@/constants'
import { useEditorStore } from '@/stores/editor'
import {
  buildAttachmentPlaceholderUrl,
  clearStoredChatAttachments,
  isAttachmentPlaceholderUrl,
  storeChatAttachment
} from '@/utils/chat-attachment-store'
import { AI_MODELS, DEFAULT_AI_MODEL } from '@open-pencil/core'

import type { FileUIPart, ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
import type { ModelOption } from '@open-pencil/core'

export const MODELS = AI_MODELS
export type { AIBackendId, ModelOption } from '@open-pencil/core'

type ProviderRegistryModelId = `openai::${string}` | `openrouter::${string}`
type APIBackedModel = ModelOption & {
  backend: 'openai' | 'openrouter'
  id: ProviderRegistryModelId
}
type LocalCliBackend = Extract<ModelOption['backend'], 'claude-code' | 'codex-cli'>

export interface CliSessionState {
  backend: LocalCliBackend
  modelId: string
  sessionId: string
}

const MODEL_STORAGE = 'open-pencil:model'
const API_KEY_STORAGE = {
  openrouter: 'open-pencil:openrouter-api-key',
  openai: 'open-pencil:openai-api-key'
} as const

export const AI_BACKEND_INFO = {
  openrouter: {
    mode: 'api-key',
    name: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyPlaceholder: 'sk-or-…',
    keyLink: 'https://openrouter.ai/keys',
    keyLinkLabel: 'Get an OpenRouter API key'
  },
  openai: {
    mode: 'api-key',
    name: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    keyLink: 'https://platform.openai.com/api-keys',
    keyLinkLabel: 'Get an OpenAI API key'
  },
  'claude-code': {
    mode: 'local-cli',
    name: 'Claude Code CLI',
    keyLabel: '',
    keyPlaceholder: '',
    keyLink: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    keyLinkLabel: 'Claude Code setup'
  },
  'codex-cli': {
    mode: 'local-cli',
    name: 'Codex CLI',
    keyLabel: '',
    keyPlaceholder: '',
    keyLink: 'https://developers.openai.com/codex/cli',
    keyLinkLabel: 'Codex CLI setup'
  }
} as const

const SYSTEM_PROMPT = dedent`
  You are a design assistant inside OpenPencil, a Figma-like design editor.
  Help users create and modify designs. Be concise and direct.
  When describing changes, use specific design terminology.

  Available node types: FRAME (containers/cards), RECTANGLE, ELLIPSE, TEXT, LINE, STAR, POLYGON, SECTION.
  Colors can be hex strings (#ff0000) or RGBA objects with values 0–1.
  Coordinates use canvas space — (0, 0) is the top-left of the page.

  Always use tools to make changes. After creating nodes, briefly describe what you did.
  When the user asks to create a layout, use create_shape with FRAME, then set_layout for auto-layout.
  When the user provides a screenshot, mockup, or other reference image, use take_screenshot to inspect the current canvas before editing.
  Use target=PAGE for whole-screen comparisons and target=SELECTION or explicit ids for localized comparisons.
  Compare the current capture against the user attachment before making visual changes, then take another screenshot after substantial edits to verify the result.
  Use screenshots for visual verification and structural tools for the actual edits.
`

function getStoredValue(key: string): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(key) ?? ''
}

function setStoredValue(key: string, value: string) {
  if (typeof window === 'undefined') return
  if (value) {
    localStorage.setItem(key, value)
  } else {
    localStorage.removeItem(key)
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStoredRole(value: unknown): value is UIMessage['role'] {
  return value === 'assistant' || value === 'system' || value === 'user'
}

function isLocalCliBackend(value: unknown): value is LocalCliBackend {
  return value === 'claude-code' || value === 'codex-cli'
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeStoredTextPart(value: Record<string, unknown>): TextUIPart | null {
  if (value.type !== 'text' || typeof value.text !== 'string') return null

  return {
    type: 'text',
    text: value.text,
    state: value.state === 'streaming' ? 'streaming' : 'done'
  }
}

function normalizeStoredReasoningPart(value: Record<string, unknown>): ReasoningUIPart | null {
  if (value.type !== 'reasoning' || typeof value.text !== 'string') return null

  return {
    type: 'reasoning',
    text: value.text,
    state: value.state === 'streaming' ? 'streaming' : 'done'
  }
}

function normalizeStoredFilePart(value: Record<string, unknown>): FileUIPart | null {
  if (value.type !== 'file' || typeof value.url !== 'string') return null

  return {
    type: 'file',
    url: value.url,
    mediaType: normalizeOptionalString(value.mediaType) ?? 'application/octet-stream',
    filename: normalizeOptionalString(value.filename)
  }
}

function normalizeStoredToolPart(value: Record<string, unknown>): ToolUIPart | null {
  if (
    typeof value.type !== 'string' ||
    !value.type.startsWith('tool-') ||
    typeof value.toolCallId !== 'string' ||
    typeof value.state !== 'string'
  ) {
    return null
  }

  return {
    type: value.type as ToolUIPart['type'],
    toolCallId: value.toolCallId,
    state: value.state as ToolUIPart['state'],
    ...(value.input !== undefined ? { input: value.input } : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(typeof value.errorText === 'string' ? { errorText: value.errorText } : {}),
    ...(typeof value.rawInput === 'string' || isObjectRecord(value.rawInput) || Array.isArray(value.rawInput)
      ? { rawInput: value.rawInput }
      : {}),
    ...(typeof value.preliminary === 'boolean' ? { preliminary: value.preliminary } : {}),
    ...(typeof value.providerExecuted === 'boolean'
      ? { providerExecuted: value.providerExecuted }
      : {})
  } as ToolUIPart
}

function normalizeStoredMessagePart(value: unknown): UIMessage['parts'][number] | null {
  if (!isObjectRecord(value) || typeof value.type !== 'string') return null

  return (
    normalizeStoredTextPart(value) ??
    normalizeStoredReasoningPart(value) ??
    normalizeStoredFilePart(value) ??
    normalizeStoredToolPart(value) ??
    (value.type === 'step-start' ? { type: 'step-start' } : null)
  )
}

function normalizeStoredMessage(value: unknown): UIMessage | null {
  if (
    !isObjectRecord(value) ||
    typeof value.id !== 'string' ||
    !isStoredRole(value.role) ||
    !Array.isArray(value.parts)
  ) {
    return null
  }

  const parts = value.parts
    .map((part) => normalizeStoredMessagePart(part))
    .filter((part): part is UIMessage['parts'][number] => part !== null)

  return {
    id: value.id,
    role: value.role,
    parts
  }
}

function cloneMessages(messages: UIMessage[]): UIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as UIMessage[]
}

function readStoredMessages(): UIMessage[] {
  if (typeof window === 'undefined') return []

  const raw = localStorage.getItem(CHAT_MESSAGE_HISTORY_STORAGE)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((message) => normalizeStoredMessage(message))
      .filter((message): message is UIMessage => message !== null)
  } catch {
    return []
  }
}

const storedAttachmentUrlCache = new Map<string, string>()
let messagePersistVersion = 0

async function sanitizeStoredFilePartAsync(part: FileUIPart): Promise<FileUIPart> {
  if (isAttachmentPlaceholderUrl(part.url)) return part

  const isEphemeralUrl = part.url.startsWith('data:') || part.url.startsWith('blob:')
  if (!isEphemeralUrl) return part

  const cacheKey = `${part.url}|${part.mediaType ?? ''}|${part.filename ?? ''}`
  const cachedUrl = storedAttachmentUrlCache.get(cacheKey)
  if (cachedUrl) {
    return {
      ...part,
      url: cachedUrl
    }
  }

  const fallbackName = part.filename ?? part.mediaType?.replace(/^[^/]+\//, '') ?? 'attachment'

  try {
    const response = await fetch(part.url)
    const blob = await response.blob()
    const placeholderUrl = await storeChatAttachment(blob, {
      filename: part.filename ?? fallbackName,
      mediaType: part.mediaType ?? blob.type
    })
    const url = placeholderUrl ?? buildAttachmentPlaceholderUrl(fallbackName, part.filename)
    storedAttachmentUrlCache.set(cacheKey, url)
    return {
      ...part,
      url
    }
  } catch {
    return {
      ...part,
      url: buildAttachmentPlaceholderUrl(fallbackName, part.filename)
    }
  }
}

async function sanitizeStoredMessagePartAsync(
  part: UIMessage['parts'][number]
): Promise<UIMessage['parts'][number]> {
  return part.type === 'file' ? sanitizeStoredFilePartAsync(part) : part
}

async function sanitizeMessagesForStorage(messages: UIMessage[]): Promise<UIMessage[]> {
  const snapshot = cloneMessages(messages)
  return Promise.all(
    snapshot.map(async (message) => ({
      ...message,
      parts: await Promise.all(message.parts.map(sanitizeStoredMessagePartAsync))
    }))
  )
}

async function writeStoredMessages(messages: UIMessage[]) {
  if (typeof window === 'undefined') return
  const persistVersion = ++messagePersistVersion

  if (messages.length === 0) {
    localStorage.removeItem(CHAT_MESSAGE_HISTORY_STORAGE)
    await clearStoredChatAttachments()
    storedAttachmentUrlCache.clear()
    return
  }

  let nextMessages = await sanitizeMessagesForStorage(messages)
  if (persistVersion !== messagePersistVersion) return
  while (nextMessages.length > 0) {
    try {
      localStorage.setItem(CHAT_MESSAGE_HISTORY_STORAGE, JSON.stringify(nextMessages))
      return
    } catch {
      nextMessages = nextMessages.slice(1)
    }
  }

  localStorage.removeItem(CHAT_MESSAGE_HISTORY_STORAGE)
}

function isStoredCliSession(value: unknown): value is CliSessionState {
  return (
    isObjectRecord(value) &&
    isLocalCliBackend(value.backend) &&
    typeof value.modelId === 'string' &&
    typeof value.sessionId === 'string'
  )
}

function readStoredCliSession(): CliSessionState | null {
  if (typeof window === 'undefined') return null

  const raw = localStorage.getItem(CHAT_CLI_SESSION_STORAGE)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    return isStoredCliSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeStoredCliSession(session: CliSessionState | null) {
  if (typeof window === 'undefined') return

  if (!session) {
    localStorage.removeItem(CHAT_CLI_SESSION_STORAGE)
    return
  }

  localStorage.setItem(CHAT_CLI_SESSION_STORAGE, JSON.stringify(session))
}

function normalizeModelId(rawId: string): string {
  const legacyAliases: Record<string, string> = {
    'claude-code::cli': 'claude-code::claude-sonnet-4-6',
    'codex-cli::cli': 'codex-cli::gpt-5.4',
    claude: 'claude-code::claude-sonnet-4-6',
    codex: 'codex-cli::gpt-5.4'
  }
  const aliasedId = legacyAliases[rawId]
  if (aliasedId) return aliasedId

  const exactMatch = ALL_MODELS.find((model) => model.id === rawId)
  if (exactMatch) return exactMatch.id

  const legacyMatch = ALL_MODELS.find((model) => model.model === rawId)
  return legacyMatch?.id ?? DEFAULT_AI_MODEL
}

const ALL_MODELS = MODELS
const FALLBACK_MODEL = ALL_MODELS.find((model) => model.id === DEFAULT_AI_MODEL) ?? ALL_MODELS[0]
const openrouterApiKey = ref(getStoredValue(API_KEY_STORAGE.openrouter))
const openaiApiKey = ref(getStoredValue(API_KEY_STORAGE.openai))
const modelId = ref(normalizeModelId(getStoredValue(MODEL_STORAGE) || DEFAULT_AI_MODEL))
const activeTab = ref<'design' | 'code' | 'ai'>('design')
let persistedMessages: UIMessage[] = readStoredMessages()
const activeCliSession = ref<CliSessionState | null>(IS_TAURI ? readStoredCliSession() : null)
const availableModels = computed(() =>
  ALL_MODELS
    .filter((model) => model.backend === 'openrouter' || model.backend === 'openai' || IS_TAURI)
    .filter((model) =>
      activeCliSession.value ? model.backend === activeCliSession.value.backend : true
    )
)
const selectedModel = computed(() => {
  const matched = availableModels.value.find((model) => model.id === modelId.value)
  return matched ?? availableModels.value[0] ?? FALLBACK_MODEL
})
const activeBackend = computed(() => selectedModel.value.backend)
const backendInfo = computed(() => AI_BACKEND_INFO[activeBackend.value])
const apiKey = computed({
  get: () => {
    if (activeBackend.value === 'openai') return openaiApiKey.value
    if (activeBackend.value === 'openrouter') return openrouterApiKey.value
    return ''
  },
  set: (value: string) => {
    if (activeBackend.value === 'openai') {
      openaiApiKey.value = value
      return
    }
    if (activeBackend.value === 'openrouter') {
      openrouterApiKey.value = value
    }
  }
})

watch(openrouterApiKey, (key) => {
  setStoredValue(API_KEY_STORAGE.openrouter, key)
})

watch(openaiApiKey, (key) => {
  setStoredValue(API_KEY_STORAGE.openai, key)
})

watch(modelId, (id) => {
  setStoredValue(MODEL_STORAGE, id)
})

watch(
  activeCliSession,
  (session) => {
    writeStoredCliSession(session)
    if (!session) return

    const matchingModel = ALL_MODELS.find(
      (model) => model.id === session.modelId && model.backend === session.backend
    )
    const nextModel = matchingModel ?? ALL_MODELS.find((model) => model.backend === session.backend)
    if (nextModel && modelId.value !== nextModel.id) {
      modelId.value = nextModel.id
    }
  },
  { immediate: true, deep: true }
)

watch(
  availableModels,
  (models) => {
    if (models.some((model) => model.id === modelId.value)) return
    const nextModel = models[0] ?? FALLBACK_MODEL
    if (nextModel) modelId.value = nextModel.id
  },
  { immediate: true }
)

const isConfigured = computed(() => {
  if (backendInfo.value.mode === 'local-cli') return IS_TAURI
  return apiKey.value.trim().length > 0
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mock transports don't implement full generics
let overrideTransport: (() => any) | null = null

const chat = shallowRef<Chat<UIMessage> | null>(null)

function isAPIBackedModel(model: ModelOption): model is APIBackedModel {
  return model.backend === 'openai' || model.backend === 'openrouter'
}

function createTransport() {
  if (overrideTransport) return overrideTransport()

  const store = useEditorStore()

  if (backendInfo.value.mode === 'local-cli') {
    return createCliAgentTransport(store, selectedModel.value, {
      getOrCreateSession() {
        const current = activeCliSession.value
        if (current && current.backend === selectedModel.value.backend) {
          return { session: current, isNew: false }
        }

        const nextSession: CliSessionState = {
          backend: selectedModel.value.backend as LocalCliBackend,
          modelId: selectedModel.value.id,
          sessionId: crypto.randomUUID()
        }
        activeCliSession.value = nextSession
        return { session: nextSession, isNew: true }
      }
    })
  }

  const providerRegistry = createProviderRegistry(
    {
      openrouter: createOpenRouter({
        apiKey: openrouterApiKey.value,
        headers: {
          'X-OpenRouter-Title': 'OpenPencil',
          'HTTP-Referer': 'https://github.com/open-pencil/open-pencil'
        }
      }),
      openai: createOpenAI({
        apiKey: openaiApiKey.value
      })
    },
    {
      separator: '::'
    }
  )

  const tools = createAITools(store)
  const apiModel = selectedModel.value

  if (!isAPIBackedModel(apiModel)) {
    throw new Error(`Unsupported API-backed model: ${apiModel.id}`)
  }

  const agent = new ToolLoopAgent({
    model: providerRegistry.languageModel(apiModel.id),
    instructions: SYSTEM_PROMPT,
    tools
  })

  return new DirectChatTransport({ agent })
}

function ensureChat(): Chat<UIMessage> | null {
  if (!isConfigured.value) return null
  if (!chat.value) {
    chat.value = new Chat<UIMessage>({
      messages: cloneMessages(persistedMessages),
      transport: createTransport()
    })
  }
  return chat.value
}

function resetChat() {
  chat.value = null
  if (isConfigured.value) {
    ensureChat()
  }
}

watch([modelId, openrouterApiKey, openaiApiKey], resetChat)

watch(modelId, (id) => {
  const session = activeCliSession.value
  if (!session) return

  const nextModel = ALL_MODELS.find((model) => model.id === id)
  if (!nextModel || nextModel.backend !== session.backend || session.modelId === id) return

  activeCliSession.value = {
    ...session,
    modelId: id
  }
})

watch(
  () => chat.value?.messages,
  (messages) => {
    if (!messages) return
    const snapshot = cloneMessages(messages)
    persistedMessages = snapshot
    void writeStoredMessages(snapshot)
  },
  { deep: true }
)

async function startNewSession() {
  const previousSession = activeCliSession.value
  await chat.value?.stop()
  persistedMessages = []
  await writeStoredMessages([])
  activeCliSession.value = null

  if (previousSession && IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_agent_cli_session', {
      backend: previousSession.backend,
      sessionId: previousSession.sessionId
    }).catch(() => {})
  }

  resetChat()
}

if (typeof window !== 'undefined') {
  window.__OPEN_PENCIL_SET_TRANSPORT__ = (factory) => {
    overrideTransport = factory
  }
}

export function useAIChat() {
  return {
    apiKey,
    activeCliSession,
    availableModels,
    backendInfo,
    chat,
    modelId,
    selectedModel,
    activeTab,
    isConfigured,
    ensureChat,
    resetChat,
    startNewSession
  }
}
