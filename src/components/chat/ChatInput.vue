<script setup lang="ts">
import { useStorage } from '@vueuse/core'
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'
import { computed, nextTick, ref } from 'vue'

import {
  extractTransferFiles,
  fileSignature,
  hasTransferFiles,
  normalizeIncomingAttachmentFile
} from '@/components/chat/attachment-utils'
import ChatModelSelector from '@/components/chat/ChatModelSelector.vue'
import ChatSubagentSelector from '@/components/chat/ChatSubagentSelector.vue'
import { uiButton } from '@/components/ui/button'
import { CHAT_PROMPT_HISTORY_LIMIT, CHAT_PROMPT_HISTORY_STORAGE } from '@/constants'

import type { ChatComposerSubmission } from '@/components/chat/types'

const props = withDefaults(
  defineProps<{
    status: 'ready' | 'submitted' | 'streaming' | 'error'
    externalDraggingFiles?: boolean
  }>(),
  {
    externalDraggingFiles: false
  }
)

const emit = defineEmits<{
  submit: [payload: ChatComposerSubmission]
  stop: []
}>()

const input = ref('')
const attachments = ref<File[]>([])
const fileInput = ref<HTMLInputElement>()
const inputRef = ref<HTMLTextAreaElement>()
const promptHistory = useStorage<string[]>(CHAT_PROMPT_HISTORY_STORAGE, [])
const historyIndex = ref<number | null>(null)
const draftInput = ref('')
const dragDepth = ref(0)
const isDraggingFiles = ref(false)

const isStreaming = computed(() => props.status === 'streaming' || props.status === 'submitted')
const canSubmit = computed(() => input.value.trim().length > 0 || attachments.value.length > 0)
const showDropTarget = computed(() => isDraggingFiles.value || props.externalDraggingFiles)

type HistoryDirection = 'up' | 'down'

function addFiles(files: Iterable<File>) {
  const seen = new Set(attachments.value.map(fileSignature))
  const nextFiles = [...attachments.value]

  for (const file of files) {
    const normalized = normalizeIncomingAttachmentFile(file)
    const signature = fileSignature(normalized)
    if (seen.has(signature)) continue
    seen.add(signature)
    nextFiles.push(normalized)
  }

  attachments.value = nextFiles
}

function removeAttachment(index: number) {
  attachments.value = attachments.value.filter((_, fileIndex) => fileIndex !== index)
}

function openFilePicker() {
  fileInput.value?.click()
}

function handleFileSelection(e: Event) {
  const target = e.target
  if (!(target instanceof HTMLInputElement) || !target.files) return
  addFiles(target.files)
  target.value = ''
}

function handlePaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)

  if (files.length === 0) return

  e.preventDefault()
  addFiles(files)
}

function resetDropState() {
  dragDepth.value = 0
  isDraggingFiles.value = false
}

function handleDragEnter(e: DragEvent) {
  if (isStreaming.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  dragDepth.value += 1
  isDraggingFiles.value = true
}

function handleDragOver(e: DragEvent) {
  if (isStreaming.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  isDraggingFiles.value = true
}

function handleDragLeave(e: DragEvent) {
  if (!isDraggingFiles.value) return
  e.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) {
    isDraggingFiles.value = false
  }
}

function handleDrop(e: DragEvent) {
  if (isStreaming.value || !hasTransferFiles(e.dataTransfer)) return
  e.preventDefault()
  const files = extractTransferFiles(e.dataTransfer)
  resetDropState()
  if (files.length === 0) return
  addFiles(files)
}

function pushPromptToHistory(text: string) {
  if (!text) return

  const dedupedHistory = promptHistory.value.filter((entry) => entry !== text)
  dedupedHistory.push(text)
  promptHistory.value =
    dedupedHistory.length > CHAT_PROMPT_HISTORY_LIMIT
      ? dedupedHistory.slice(-CHAT_PROMPT_HISTORY_LIMIT)
      : dedupedHistory
}

function moveCaretToEnd() {
  nextTick(() => {
    const element = inputRef.value
    if (!element) return

    element.focus()
    const caret = element.value.length
    element.setSelectionRange(caret, caret)
  })
}

function setInputText(text: string) {
  input.value = text
  moveCaretToEnd()
}

function resetHistoryNavigation() {
  historyIndex.value = null
  draftInput.value = ''
}

function restoreDraftInput() {
  const draft = draftInput.value
  resetHistoryNavigation()
  setInputText(draft)
}

function browsePromptHistory(direction: HistoryDirection): boolean {
  if (promptHistory.value.length === 0) return false

  if (direction === 'up') {
    draftInput.value = historyIndex.value === null ? input.value : draftInput.value
    const nextIndex =
      historyIndex.value === null
        ? promptHistory.value.length - 1
        : Math.max(0, historyIndex.value - 1)
    historyIndex.value = nextIndex
    setInputText(promptHistory.value[nextIndex] ?? '')
    return true
  }

  if (historyIndex.value === null) return false

  const nextIndex = historyIndex.value + 1
  if (nextIndex >= promptHistory.value.length) {
    restoreDraftInput()
    return true
  }

  historyIndex.value = nextIndex
  setInputText(promptHistory.value[nextIndex] ?? '')
  return true
}

function shouldBrowseHistory(e: KeyboardEvent, direction: HistoryDirection): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (!(e.currentTarget instanceof HTMLTextAreaElement)) return false

  const element = e.currentTarget
  const selectionStart = element.selectionStart
  const selectionEnd = element.selectionEnd
  if (selectionStart !== selectionEnd) return false

  if (direction === 'up') return selectionStart === 0
  return selectionEnd === element.value.length
}

function handleInputChange() {
  if (historyIndex.value === null) return
  resetHistoryNavigation()
}

function submit() {
  const text = input.value.trim()
  if (!text && attachments.value.length === 0) return

  pushPromptToHistory(text)
  emit('submit', {
    text,
    files: [...attachments.value]
  })

  input.value = ''
  attachments.value = []
  resetHistoryNavigation()
}

function handleSubmit(e: Event) {
  e.preventDefault()
  submit()
}

function handleKeydown(e: KeyboardEvent) {
  if (isStreaming.value) return

  if (e.key === 'ArrowUp' && shouldBrowseHistory(e, 'up')) {
    if (browsePromptHistory('up')) e.preventDefault()
    return
  }

  if (e.key === 'ArrowDown' && shouldBrowseHistory(e, 'down')) {
    if (browsePromptHistory('down')) e.preventDefault()
    return
  }

  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  submit()
}

defineExpose({
  attachFiles(files: Iterable<File>) {
    addFiles(files)
  }
})
</script>

<template>
  <TooltipProvider>
    <div
      data-test-id="chat-dropzone"
      :data-dragging="showDropTarget ? 'true' : 'false'"
      class="shrink-0 border-t border-border px-3 py-2 transition-colors"
      :class="showDropTarget ? 'bg-accent/5' : ''"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1">
          <ChatModelSelector />
          <ChatSubagentSelector />
        </div>
        <button
          type="button"
          data-test-id="chat-attach-button"
          :class="
            uiButton({
              tone: 'ghost',
              shape: 'rounded',
              size: 'sm',
              class: 'h-6 shrink-0 gap-1 border border-border px-2 text-[10px] text-muted'
            })
          "
          :disabled="isStreaming"
          @click="openFilePicker"
        >
          <icon-lucide-paperclip class="size-3" />
          Attach
        </button>
      </div>

      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        data-test-id="chat-file-input"
        @change="handleFileSelection"
      />

      <div v-if="attachments.length > 0" class="mb-2 flex flex-wrap gap-1.5">
        <div
          v-for="(file, index) in attachments"
          :key="fileSignature(file)"
          class="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-hover px-2 py-1 text-[10px] text-surface"
        >
          <icon-lucide-image v-if="file.type.startsWith('image/')" class="size-3 shrink-0" />
          <icon-lucide-file v-else class="size-3 shrink-0" />
          <span class="truncate">{{ file.name }}</span>
          <button
            type="button"
            class="rounded text-muted transition hover:text-surface"
            :disabled="isStreaming"
            @click="removeAttachment(index)"
          >
            <icon-lucide-x class="size-3" />
          </button>
        </div>
      </div>

      <form
        class="rounded-xl border border-transparent p-1 transition-colors"
        :class="showDropTarget ? 'border-accent/50 bg-accent/5' : ''"
        @submit="handleSubmit"
      >
        <div
          v-if="showDropTarget"
          data-test-id="chat-dropzone-hint"
          class="mb-2 flex items-center gap-1.5 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-2 py-1 text-[10px] text-accent"
        >
          <icon-lucide-download class="size-3" />
          Drop files to attach them to this prompt
        </div>

        <div class="flex gap-1.5">
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            data-test-id="chat-input"
            placeholder="Describe a change, paste images, or attach files…"
            class="min-h-[44px] min-w-0 flex-1 resize-none rounded border border-border bg-input px-2.5 py-2 text-xs text-surface outline-none placeholder:text-muted focus:border-accent"
            :disabled="status === 'submitted'"
            @input="handleInputChange"
            @keydown="handleKeydown"
            @paste="handlePaste"
          />
          <TooltipRoot v-if="isStreaming">
            <TooltipTrigger as-child>
              <button
                type="button"
                data-test-id="chat-stop-button"
                :class="
                  uiButton({
                    tone: 'ghost',
                    shape: 'rounded',
                    size: 'sm',
                    class: 'shrink-0 border border-border px-2 py-1.5'
                  })
                "
                @click="emit('stop')"
              >
                <icon-lucide-square class="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="top"
                :side-offset="4"
                class="rounded bg-surface px-2 py-1 text-[10px] text-canvas"
              >
                Stop generating
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <TooltipRoot v-else>
            <TooltipTrigger as-child>
              <button
                type="submit"
                data-test-id="chat-send-button"
                :class="
                  uiButton({
                    tone: 'accent',
                    shape: 'rounded',
                    size: 'sm',
                    class: 'shrink-0 px-2.5 py-1.5 font-medium'
                  })
                "
                :disabled="!canSubmit"
              >
                <icon-lucide-send class="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="top"
                :side-offset="4"
                class="rounded bg-surface px-2 py-1 text-[10px] text-canvas"
              >
                Send message
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </div>
      </form>
    </div>
  </TooltipProvider>
</template>
