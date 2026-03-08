<script setup lang="ts">
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
import { computed } from 'vue'

import ChatAttachmentPart from '@/components/chat/ChatAttachmentPart.vue'
import {
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type FileUIPart,
  type ReasoningUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessage
} from 'ai'

const { message } = defineProps<{ message: UIMessage }>()

type RenderablePart = FileUIPart | ReasoningUIPart | TextUIPart | ToolUIPart

const renderableParts = computed(() =>
  message.parts.filter(
    (part): part is RenderablePart =>
      isTextUIPart(part) || isReasoningUIPart(part) || isToolUIPart(part) || isFileUIPart(part)
  )
)

function partKey(part: RenderablePart, index: number): string {
  if (isToolUIPart(part)) return part.toolCallId
  if (isFileUIPart(part)) return `${part.url}:${part.filename ?? part.mediaType ?? index}`
  return `${part.type}-${index}`
}

function toolName(part: ToolUIPart): string {
  return part.type.replace(/^tool-/, '')
}

function isThinkingTool(part: ToolUIPart): boolean {
  return toolName(part) === 'thinking_step'
}

function toolDisplayName(part: ToolUIPart): string {
  if (isThinkingTool(part)) return 'Thinking'
  return toolName(part)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function toolState(part: ToolUIPart): 'pending' | 'done' | 'error' {
  if (part.state === 'error' || part.state === 'output-error') return 'error'
  if (part.state === 'output-available') return 'done'
  return 'pending'
}

function stringifyValue(value: unknown, maxChars = 1200): string {
  if (typeof value === 'string') {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`
  }

  try {
    const text = JSON.stringify(value, null, 2)
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
  } catch {
    const text = String(value)
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
  }
}

function toolPreview(part: ToolUIPart): string | null {
  if (toolState(part) === 'error') {
    return part.errorText ? stringifyValue(part.errorText, 320) : 'Tool call failed'
  }

  if (toolState(part) === 'pending') {
    if (part.input === undefined) return null
    return stringifyValue(part.input, isThinkingTool(part) ? 240 : 320)
  }

  if (isThinkingTool(part) && part.output !== undefined) {
    return stringifyValue(part.output, 240)
  }

  return null
}

function toolBody(part: ToolUIPart): string | null {
  if (toolState(part) === 'pending') return null
  if (toolState(part) === 'error') {
    return part.errorText ? stringifyValue(part.errorText) : 'Tool call failed'
  }
  return part.output !== undefined ? stringifyValue(part.output) : null
}
</script>

<template>
  <div
    :data-test-id="`chat-message-${message.role}`"
    :class="message.role === 'user' ? 'flex justify-end' : ''"
  >
    <div class="min-w-0 space-y-1.5" :class="message.role === 'user' ? 'max-w-[85%]' : ''">
      <template v-for="(part, index) in renderableParts" :key="partKey(part, index)">
        <div
          v-if="isTextUIPart(part)"
          data-test-id="chat-text-bubble"
          class="rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
          :class="
            message.role === 'user'
              ? 'rounded-br-md bg-accent text-white'
              : 'rounded-tl-md bg-hover text-surface'
          "
        >
          {{ part.text }}
        </div>

        <div
          v-else-if="isReasoningUIPart(part)"
          data-test-id="chat-part-reasoning"
          class="rounded-xl rounded-tl-md border border-border bg-canvas px-3 py-2"
        >
          <div class="mb-1 flex items-center gap-2">
            <icon-lucide-loader-circle
              v-if="part.state === 'streaming'"
              class="size-3 animate-spin text-accent"
            />
            <icon-lucide-brain v-else class="size-3 text-muted" />
            <span class="text-[11px] font-medium text-surface">Thinking</span>
          </div>
          <div class="text-[10px] leading-relaxed whitespace-pre-wrap text-muted">
            {{ part.text || 'Working through the next step…' }}
          </div>
        </div>

        <div
          v-else-if="isToolUIPart(part) && isThinkingTool(part)"
          data-test-id="chat-part-thinking"
          class="rounded-xl rounded-tl-md border border-border bg-canvas px-3 py-2"
        >
          <div class="mb-1 flex items-center gap-2">
            <div
              class="flex size-4 items-center justify-center rounded-full"
              :class="{
                'bg-accent/20 text-accent': toolState(part) === 'pending',
                'bg-green-500/20 text-green-400': toolState(part) === 'done',
                'bg-red-500/20 text-red-400': toolState(part) === 'error'
              }"
            >
              <icon-lucide-loader-circle
                v-if="toolState(part) === 'pending'"
                class="size-3 animate-spin"
              />
              <icon-lucide-check v-else-if="toolState(part) === 'done'" class="size-3" />
              <icon-lucide-triangle-alert v-else class="size-3" />
            </div>
            <span class="text-[11px] font-medium text-surface">Thinking</span>
            <span class="text-[10px] text-muted">
              {{
                toolState(part) === 'pending'
                  ? 'Working…'
                  : toolState(part) === 'done'
                    ? 'Done'
                    : 'Error'
              }}
            </span>
          </div>
          <div
            v-if="toolPreview(part)"
            class="text-[10px] leading-relaxed whitespace-pre-wrap text-muted"
          >
            {{ toolPreview(part) }}
          </div>
        </div>

        <div
          v-else-if="isToolUIPart(part)"
          data-test-id="chat-part-tool"
          class="rounded-lg border border-border bg-canvas p-2"
        >
          <CollapsibleRoot>
            <CollapsibleTrigger class="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
              <div
                class="flex size-4 items-center justify-center rounded-full"
                :class="{
                  'bg-accent/20 text-accent': toolState(part) === 'pending',
                  'bg-green-500/20 text-green-400': toolState(part) === 'done',
                  'bg-red-500/20 text-red-400': toolState(part) === 'error'
                }"
              >
                <icon-lucide-loader-circle
                  v-if="toolState(part) === 'pending'"
                  class="size-3 animate-spin"
                />
                <icon-lucide-check v-else-if="toolState(part) === 'done'" class="size-3" />
                <icon-lucide-triangle-alert v-else class="size-3" />
              </div>
              <span class="text-[11px] text-surface">{{ toolDisplayName(part) }}</span>
              <span class="text-[10px] text-muted">
                {{
                  toolState(part) === 'pending'
                    ? 'Running…'
                    : toolState(part) === 'done'
                      ? 'Done'
                      : 'Error'
                }}
              </span>
              <icon-lucide-chevron-down
                v-if="toolState(part) !== 'pending'"
                class="ml-auto size-3 text-muted transition-transform [[data-state=open]>&]:rotate-180"
              />
            </CollapsibleTrigger>
            <div
              v-if="toolState(part) === 'pending' && toolPreview(part)"
              class="px-1 pt-1 text-[10px] whitespace-pre-wrap text-muted"
            >
              {{ toolPreview(part) }}
            </div>
            <CollapsibleContent
              v-else-if="toolBody(part)"
              class="overflow-hidden text-[10px] data-[state=closed]:collapsible-up data-[state=open]:collapsible-down"
            >
              <pre class="mt-1 overflow-x-auto rounded bg-input p-2 text-muted">{{
                toolBody(part)
              }}</pre>
            </CollapsibleContent>
          </CollapsibleRoot>
        </div>

        <ChatAttachmentPart
          v-else-if="isFileUIPart(part)"
          :part="part"
          :role="message.role"
        />
      </template>
    </div>
  </div>
</template>
