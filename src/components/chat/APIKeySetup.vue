<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ChatModelSelector from '@/components/chat/ChatModelSelector.vue'
import { useAIChat } from '@/composables/use-chat'

const { apiKey, backendInfo } = useAIChat()

const input = ref(apiKey.value)

watch(apiKey, (value) => {
  input.value = value
})

const helperText = computed(
  () =>
    `Enter your ${backendInfo.value.keyLabel} to use ${backendInfo.value.name}-backed chat in OpenPencil.`
)

function save() {
  apiKey.value = input.value.trim()
}
</script>

<template>
  <div
    data-test-id="api-key-setup"
    class="flex flex-1 flex-col items-center justify-center gap-4 px-4"
  >
    <div class="flex flex-col items-center gap-2">
      <icon-lucide-key-round class="size-8 text-muted" />
      <ChatModelSelector />
    </div>
    <p class="max-w-72 text-center text-xs text-muted">{{ helperText }}</p>
    <form class="flex w-full max-w-80 gap-1.5" @submit.prevent="save">
      <input
        v-model="input"
        type="password"
        data-test-id="api-key-input"
        :placeholder="backendInfo.keyPlaceholder"
        class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1 text-xs text-surface outline-none focus:border-accent"
      />
      <button
        type="submit"
        data-test-id="api-key-save"
        class="shrink-0 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90"
        :disabled="!input.trim()"
      >
        Save
      </button>
    </form>
    <a
      :href="backendInfo.keyLink"
      target="_blank"
      data-test-id="api-key-get-link"
      class="text-[10px] text-muted underline hover:text-surface"
    >
      {{ backendInfo.keyLinkLabel }} →
    </a>
  </div>
</template>
