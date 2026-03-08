<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import {
  basename,
  extractTransferFiles,
  hasTransferFiles,
  mimeTypeFromPath
} from '@/components/chat/attachment-utils'
import APIKeySetup from '@/components/chat/APIKeySetup.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import ChatMessage from '@/components/chat/ChatMessage.vue'
import type { ChatComposerSubmission } from '@/components/chat/types'
import { uiButton } from '@/components/ui/button'
import { useAIChat } from '@/composables/use-chat'
import { toast } from '@/composables/use-toast'
import {
  CHAT_IMAGE_UPLOAD_MAX_BYTES,
  CHAT_IMAGE_UPLOAD_MAX_EDGE,
  CHAT_IMAGE_UPLOAD_QUALITY,
  IS_TAURI
} from '@/constants'

import { isFileUIPart, isReasoningUIPart, isTextUIPart, isToolUIPart, type FileUIPart } from 'ai'

const props = withDefaults(
  defineProps<{
    active?: boolean
  }>(),
  {
    active: true
  }
)

const { activeCliSession, chat, isConfigured, ensureChat, selectedModel, startNewSession } = useAIChat()
const messagesEnd = ref<HTMLDivElement>()
const chatInputRef = ref<{
  attachFiles: (files: Iterable<File>) => void
} | null>(null)
const panelDragDepth = ref(0)
const windowDraggingFiles = ref(false)
let removeNativeDropListeners: (() => void) | null = null

const messages = computed(() => chat.value?.messages ?? [])
const status = computed(() => chat.value?.status ?? 'ready')
const isGenerating = computed(() => status.value === 'submitted' || status.value === 'streaming')
const showNewSessionButton = computed(
  () => messages.value.length > 0 || activeCliSession.value !== null
)
const lastMessage = computed(() => messages.value.at(-1) ?? null)
const showThinkingIndicator = computed(() => {
  if (!isGenerating.value) return false
  const assistantMessage = lastMessage.value?.role === 'assistant' ? lastMessage.value : null
  if (!assistantMessage) return true
  return !assistantMessage.parts.some((part) => {
    if (isTextUIPart(part)) return part.text.trim().length > 0
    return isReasoningUIPart(part) || isToolUIPart(part) || isFileUIPart(part)
  })
})
const isPanelDraggingFiles = computed(() => panelDragDepth.value > 0 || windowDraggingFiles.value)

function scrollToBottom() {
  nextTick(() => {
    messagesEnd.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  })
}

watch(messages, scrollToBottom, { deep: true })
watch(
  [isConfigured, () => props.active],
  ([configured, active]) => {
    if (configured && active) {
      ensureChat()
    }
  },
  { immediate: true }
)

function handleSubmit(payload: ChatComposerSubmission) {
  void sendMessageWithAttachments(payload).catch(() => {})
}

function handleStop() {
  chat.value?.stop()
}

function handleNewSession() {
  void startNewSession().catch(() => {})
}

function resetPanelDropState() {
  panelDragDepth.value = 0
  windowDraggingFiles.value = false
}

function handlePanelDragEnter(e: DragEvent) {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  panelDragDepth.value += 1
}

function handlePanelDragOver(e: DragEvent) {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function handlePanelDragLeave(e: DragEvent) {
  if (panelDragDepth.value === 0) return
  e.preventDefault()
  panelDragDepth.value = Math.max(0, panelDragDepth.value - 1)
}

function handlePanelDrop(e: DragEvent) {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  const files = extractTransferFiles(e.dataTransfer)
  resetPanelDropState()
  if (files.length === 0) return
  chatInputRef.value?.attachFiles(files)
}

interface TauriDragDropPayload {
  paths?: string[]
  position?: {
    x: number
    y: number
  }
}

async function attachNativeDroppedPaths(paths: string[]) {
  if (paths.length === 0) return

  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const results = await Promise.allSettled(
      paths.map(async (path) => {
        const bytes = await readFile(path)
        return new File([bytes], basename(path), {
          type: mimeTypeFromPath(path),
          lastModified: Date.now()
        })
      })
    )

    const files = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    if (files.length > 0) {
      chatInputRef.value?.attachFiles(files)
    }

    const failedCount = results.length - files.length
    if (failedCount > 0) {
      toast.show(
        failedCount === paths.length
          ? 'Dropped files could not be attached.'
          : `${failedCount} dropped file${failedCount === 1 ? '' : 's'} could not be attached.`,
        'error'
      )
    }
  } catch {
    toast.show('Dropped files could not be attached.', 'error')
  }
}

if (IS_TAURI && typeof window !== 'undefined') {
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event')

    const unlistenEnter = await listen<TauriDragDropPayload>('tauri://drag-enter', (event) => {
      if (!props.active || isGenerating.value || (event.payload.paths?.length ?? 0) === 0) return
      windowDraggingFiles.value = true
    })
    const unlistenOver = await listen<TauriDragDropPayload>('tauri://drag-over', () => {
      if (!props.active || isGenerating.value) return
      windowDraggingFiles.value = true
    })
    const unlistenLeave = await listen('tauri://drag-leave', () => {
      windowDraggingFiles.value = false
    })
    const unlistenDrop = await listen<TauriDragDropPayload>('tauri://drag-drop', (event) => {
      if (!props.active || isGenerating.value) return
      const paths = event.payload.paths ?? []
      resetPanelDropState()
      void attachNativeDroppedPaths(paths)
    })

    removeNativeDropListeners = () => {
      unlistenEnter()
      unlistenOver()
      unlistenLeave()
      unlistenDrop()
    }
  })()
}

onBeforeUnmount(() => {
  removeNativeDropListeners?.()
  removeNativeDropListeners = null
})

useEventListener(window, 'dragenter', (e: DragEvent) => {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  windowDraggingFiles.value = true
})

useEventListener(window, 'dragover', (e: DragEvent) => {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  windowDraggingFiles.value = true
})

useEventListener(window, 'dragleave', (e: DragEvent) => {
  if (!windowDraggingFiles.value) return
  const leftWindow =
    e.clientX <= 0 ||
    e.clientY <= 0 ||
    e.clientX >= window.innerWidth ||
    e.clientY >= window.innerHeight
  if (!leftWindow) return
  e.preventDefault()
  windowDraggingFiles.value = false
})

useEventListener(window, 'drop', (e: DragEvent) => {
  if (!props.active || isGenerating.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  const files = extractTransferFiles(e.dataTransfer)
  resetPanelDropState()
  if (files.length === 0) return
  chatInputRef.value?.attachFiles(files)
})

async function fileToUIPart(file: File): Promise<FileUIPart> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result === 'string') {
        resolve(result)
        return
      }
      reject(new Error(`Failed to read attachment "${file.name}"`))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read attachment "${file.name}"`))
    reader.readAsDataURL(file)
  })

  return {
    type: 'file',
    mediaType: file.type,
    filename: file.name,
    url
  }
}

function fileExtensionForMimeType(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/png') return 'png'
  return mediaType.replace(/^image\//, '') || 'img'
}

function renameFileExtension(name: string, nextExtension: string): string {
  const baseName = name.replace(/\.[^.]+$/, '')
  return `${baseName}.${nextExtension}`
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality)
  })
}

async function optimizeAttachmentFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  if (selectedModel.value.backend === 'claude-code' || selectedModel.value.backend === 'codex-cli') {
    return file
  }
  if (file.type === 'image/png') return file

  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file

  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height)
    const scale = Math.min(1, CHAT_IMAGE_UPLOAD_MAX_EDGE / longestEdge)
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale))
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale))
    const shouldTranscode =
      targetWidth !== bitmap.width ||
      targetHeight !== bitmap.height ||
      file.size > CHAT_IMAGE_UPLOAD_MAX_BYTES

    if (!shouldTranscode) return file

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) return file

    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight)

    const preferredMimeType =
      file.type === 'image/webp'
        ? 'image/webp'
        : file.type === 'image/jpeg'
          ? 'image/jpeg'
          : 'image/png'
    const blob =
      (await canvasToBlob(canvas, preferredMimeType, CHAT_IMAGE_UPLOAD_QUALITY)) ??
      (await canvasToBlob(canvas, 'image/png'))
    if (!blob) return file
    if (blob.size >= file.size && targetWidth === bitmap.width && targetHeight === bitmap.height) {
      return file
    }

    return new File([blob], renameFileExtension(file.name, fileExtensionForMimeType(blob.type)), {
      type: blob.type,
      lastModified: file.lastModified
    })
  } finally {
    bitmap.close()
  }
}

async function sendMessageWithAttachments(payload: ChatComposerSubmission) {
  const activeChat = ensureChat()
  if (!activeChat) return

  const optimizedFiles = await Promise.all(payload.files.map((file) => optimizeAttachmentFile(file)))
  const files = await Promise.all(optimizedFiles.map((file) => fileToUIPart(file)))
  await activeChat.sendMessage({
    text: payload.text,
    files
  })
}
</script>

<template>
  <div
    data-test-id="chat-panel"
    :data-dragging="isPanelDraggingFiles ? 'true' : 'false'"
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden"
    @dragenter="handlePanelDragEnter"
    @dragover="handlePanelDragOver"
    @dragleave="handlePanelDragLeave"
    @drop="handlePanelDrop"
  >
    <APIKeySetup v-if="!isConfigured" />

    <template v-else>
      <div
        v-if="isPanelDraggingFiles"
        data-test-id="chat-panel-drop-overlay"
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-canvas/70 p-4 backdrop-blur-sm"
      >
        <div class="rounded-2xl border border-dashed border-accent/60 bg-panel px-4 py-3 text-center shadow-lg">
          <div class="mb-1 flex items-center justify-center gap-2 text-accent">
            <icon-lucide-download class="size-4" />
            <span class="text-sm font-medium">Drop files to attach</span>
          </div>
          <p class="text-xs text-muted">They will be added to your next prompt.</p>
        </div>
      </div>

      <div class="flex items-center justify-between gap-2 px-3 pt-2">
        <div class="flex min-w-0 items-center gap-2">
          <span
            v-if="activeCliSession"
            class="rounded-full border border-border bg-hover px-2 py-0.5 text-[10px] text-muted"
          >
            Session locked to {{ activeCliSession.backend === 'codex-cli' ? 'Codex CLI' : 'Claude Code CLI' }}
          </span>
          <button
            v-if="showNewSessionButton"
            type="button"
            :class="
              uiButton({
                tone: 'ghost',
                shape: 'rounded',
                size: 'sm',
                class: 'h-6 shrink-0 gap-1 border border-border px-2 text-[10px] text-muted'
              })
            "
            @click="handleNewSession"
          >
            <icon-lucide-plus class="size-3" />
            New session
          </button>
        </div>
      </div>
      <ScrollAreaRoot class="min-h-0 flex-1">
        <ScrollAreaViewport class="h-full px-3 py-3 [&>div]:h-full">
          <!-- Empty state -->
          <div
            v-if="messages.length === 0"
            data-test-id="chat-empty-state"
            class="flex h-full flex-col items-center justify-center gap-3 text-muted"
          >
            <icon-lucide-message-circle class="size-8 opacity-50" />
            <p class="text-center text-xs">Describe what you want to create or change.</p>
          </div>

          <!-- Messages -->
          <div v-else data-test-id="chat-messages" class="flex flex-col gap-3">
            <ChatMessage v-for="msg in messages" :key="msg.id" :message="msg" />

            <!-- Typing indicator -->
            <div v-if="showThinkingIndicator" data-test-id="chat-typing-indicator" class="flex gap-2">
              <div
                class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/20 text-[10px] font-bold text-muted"
              >
                AI
              </div>
              <div class="rounded-xl rounded-tl-md bg-hover px-3 py-2 text-xs text-surface">
                <div class="mb-1 text-[11px] font-medium text-muted">Thinking…</div>
                <div class="flex items-center gap-1">
                  <span
                    class="size-1.5 animate-bounce rounded-full bg-muted"
                    style="animation-delay: 0ms"
                  />
                  <span
                    class="size-1.5 animate-bounce rounded-full bg-muted"
                    style="animation-delay: 150ms"
                  />
                  <span
                    class="size-1.5 animate-bounce rounded-full bg-muted"
                    style="animation-delay: 300ms"
                  />
                </div>
              </div>
            </div>

            <div ref="messagesEnd" />
          </div>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar orientation="vertical" class="flex w-1.5 touch-none select-none p-px">
          <ScrollAreaThumb class="relative flex-1 rounded-full bg-muted/30" />
        </ScrollAreaScrollbar>
      </ScrollAreaRoot>

      <ChatInput
        ref="chatInputRef"
        :status="status"
        :external-dragging-files="isPanelDraggingFiles"
        @submit="handleSubmit"
        @stop="handleStop"
      />
    </template>
  </div>
</template>
