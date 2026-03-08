<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX } from '@/constants'
import { getStoredChatAttachment } from '@/utils/chat-attachment-store'

import type { FileUIPart, UIMessage } from 'ai'

const { part, role } = defineProps<{
  part: FileUIPart
  role: UIMessage['role']
}>()

const previewUrl = ref<string | null>(null)
let activeObjectUrl: string | null = null

function isPlaceholderUrl(url: string): boolean {
  return url.startsWith(CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX)
}

function isImageFile(filePart: FileUIPart): boolean {
  return filePart.mediaType?.startsWith('image/') ?? false
}

function fileLabel(filePart: FileUIPart): string {
  if (filePart.filename) return filePart.filename
  if (filePart.mediaType) return filePart.mediaType.replace(/^[^/]+\//, '') || 'Attachment'
  return 'Attachment'
}

function releasePreviewUrl() {
  if (!activeObjectUrl) return
  URL.revokeObjectURL(activeObjectUrl)
  activeObjectUrl = null
}

async function refreshPreview() {
  releasePreviewUrl()

  if (!isImageFile(part)) {
    previewUrl.value = null
    return
  }

  if (!isPlaceholderUrl(part.url)) {
    previewUrl.value = part.url
    return
  }

  const attachment = await getStoredChatAttachment(part.url)
  if (!attachment) {
    previewUrl.value = null
    return
  }

  activeObjectUrl = URL.createObjectURL(attachment.blob)
  previewUrl.value = activeObjectUrl
}

watch(() => part.url, () => {
  void refreshPreview()
}, { immediate: true })

onBeforeUnmount(() => {
  releasePreviewUrl()
})

const showPreview = computed(() => isImageFile(part) && previewUrl.value !== null)
</script>

<template>
  <div
    data-test-id="chat-part-file"
    class="grid gap-2"
    :class="role === 'user' ? 'justify-items-end' : ''"
  >
    <div class="w-full max-w-xs overflow-hidden rounded-xl border border-border bg-hover">
      <img
        v-if="showPreview && previewUrl"
        :src="previewUrl"
        :alt="fileLabel(part)"
        class="max-h-56 w-full object-cover"
      />
      <div class="flex items-center gap-2 p-2 text-[11px] text-surface">
        <icon-lucide-image v-if="isImageFile(part)" class="size-3 shrink-0" />
        <icon-lucide-file v-else class="size-3 shrink-0" />
        <span class="truncate">{{ fileLabel(part) }}</span>
      </div>
    </div>
  </div>
</template>
