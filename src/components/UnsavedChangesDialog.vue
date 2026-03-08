<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle
} from 'reka-ui'

import { useUnsavedChangesDialog } from '@/composables/use-unsaved-changes-dialog'

const { request, settle } = useUnsavedChangesDialog()
</script>

<template>
  <DialogRoot :open="!!request">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/60"
        @click="settle('cancel')"
      />
      <DialogContent
        data-test-id="unsaved-changes-dialog"
        class="fixed left-1/2 top-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-panel p-5 text-surface shadow-2xl outline-none"
        @escape-key-down="settle('cancel')"
        @interact-outside.prevent
      >
        <DialogTitle class="text-base font-semibold">
          {{ request?.title }}
        </DialogTitle>
        <p class="text-sm leading-6 text-muted">
          {{ request?.description }}
        </p>
        <ul
          v-if="request?.documentNames.length"
          class="max-h-32 overflow-auto rounded-lg border border-border bg-input px-3 py-2 text-sm text-muted"
        >
          <li v-for="name in request.documentNames" :key="name" class="truncate py-0.5">
            {{ name }}
          </li>
        </ul>
        <div class="flex items-center justify-end gap-2">
          <button
            data-test-id="unsaved-changes-cancel"
            class="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-hover hover:text-surface"
            @click="settle('cancel')"
          >
            Cancel
          </button>
          <button
            data-test-id="unsaved-changes-discard"
            class="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-hover hover:text-surface"
            @click="settle('discard')"
          >
            {{ request?.discardLabel }}
          </button>
          <button
            data-test-id="unsaved-changes-save"
            class="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
            @click="settle('save')"
          >
            {{ request?.saveLabel }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
