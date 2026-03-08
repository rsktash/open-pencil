<script setup lang="ts">
import {
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectViewport
} from 'reka-ui'
import { computed } from 'vue'

import { selectContent, selectItem, selectTrigger } from '@/components/ui/select'
import { useAIChat } from '@/composables/use-chat'

const { backendInfo, subagentCount } = useAIChat()

const isVisible = computed(() => backendInfo.value.mode === 'local-cli')
const subagentOptions = [1, 2, 3, 4, 5] as const
</script>

<template>
  <SelectRoot v-if="isVisible" v-model="subagentCount">
    <SelectTrigger
      data-test-id="chat-subagent-selector"
      :class="
        selectTrigger({
          class:
            'gap-1 rounded border-none bg-transparent px-1.5 py-0.5 text-[10px] text-muted'
        })
      "
    >
      <icon-lucide-users class="size-3" />
      {{ subagentCount }}x
      <icon-lucide-chevron-down class="size-2.5" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        side="top"
        :side-offset="4"
        :class="selectContent({ radius: 'lg', padding: 'md', class: 'max-h-60 overflow-y-auto' })"
      >
        <SelectViewport>
          <SelectItem
            v-for="count in subagentOptions"
            :key="count"
            :value="String(count)"
            :class="selectItem({ class: 'gap-2 rounded px-2 py-1.5 text-[11px]' })"
          >
            <SelectItemText>{{ count }}x</SelectItemText>
            <span v-if="count === 1" class="text-[9px] uppercase tracking-wide text-muted">
              Default
            </span>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
