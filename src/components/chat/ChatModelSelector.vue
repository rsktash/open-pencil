<script setup lang="ts">
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemText,
  SelectLabel,
  SelectPortal,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectViewport
} from 'reka-ui'
import { computed } from 'vue'

import { selectContent, selectItem, selectTrigger } from '@/components/ui/select'
import { useAIChat } from '@/composables/use-chat'

import type { ModelOption } from '@open-pencil/core'

const { availableModels, modelId } = useAIChat()

const GROUP_ORDER = ['codex-cli', 'claude-code', 'openai', 'openrouter'] as const
const GROUP_LABELS = {
  'codex-cli': 'Codex CLI',
  'claude-code': 'Claude Code CLI',
  openai: 'OpenAI',
  openrouter: 'Open Router'
} as const

function groupLabel(model: ModelOption): string {
  return GROUP_LABELS[model.backend]
}

const selectedModel = computed(
  () => availableModels.value.find((model) => model.id === modelId.value) ?? null
)
const selectedModelName = computed(() =>
  selectedModel.value ? `${groupLabel(selectedModel.value)} · ${selectedModel.value.name}` : modelId.value
)
const groupedModels = computed(() =>
  GROUP_ORDER
    .map((backend) => ({
      backend,
      label: GROUP_LABELS[backend],
      models: availableModels.value.filter((model) => model.backend === backend)
    }))
    .filter((group) => group.models.length > 0)
)
</script>

<template>
  <SelectRoot v-model="modelId">
    <SelectTrigger
      data-test-id="chat-model-selector"
      :class="
        selectTrigger({
          class: 'gap-1 rounded border-none bg-transparent px-1.5 py-0.5 text-[10px] text-muted'
        })
      "
    >
      <icon-lucide-bot class="size-3" />
      {{ selectedModelName }}
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
          <template v-for="(group, groupIndex) in groupedModels" :key="group.backend">
            <SelectGroup>
              <SelectLabel class="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted">
                {{ group.label }}
              </SelectLabel>
              <SelectItem
                v-for="model in group.models"
                :key="model.id"
                :value="model.id"
                :class="selectItem({ class: 'items-start gap-2 rounded px-2 py-1.5 text-[11px]' })"
              >
                <div class="min-w-0 flex-1">
                  <SelectItemText class="block truncate">{{ model.name }}</SelectItemText>
                  <div class="mt-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-muted">
                    <span>{{ model.provider }}</span>
                  </div>
                </div>
                <span
                  v-if="model.tag"
                  class="rounded bg-accent/10 px-1 py-px text-[9px] text-accent"
                >
                  {{ model.tag }}
                </span>
              </SelectItem>
            </SelectGroup>
            <SelectSeparator
              v-if="groupIndex < groupedModels.length - 1"
              class="my-1 h-px bg-border/70"
            />
          </template>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
