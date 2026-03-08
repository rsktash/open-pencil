import { computed, shallowRef } from 'vue'

export type UnsavedChangesDecision = 'save' | 'discard' | 'cancel'

interface UnsavedChangesRequest {
  title: string
  description: string
  saveLabel: string
  discardLabel: string
  documentNames: string[]
  resolve: (decision: UnsavedChangesDecision) => void
}

const requestRef = shallowRef<UnsavedChangesRequest | null>(null)

export interface UnsavedChangesDialogOptions {
  title: string
  description: string
  saveLabel?: string
  discardLabel?: string
  documentNames?: string[]
}

export function confirmUnsavedChanges(
  options: UnsavedChangesDialogOptions
): Promise<UnsavedChangesDecision> {
  if (requestRef.value) {
    requestRef.value.resolve('cancel')
  }

  return new Promise((resolve) => {
    requestRef.value = {
      title: options.title,
      description: options.description,
      saveLabel: options.saveLabel ?? 'Save',
      discardLabel: options.discardLabel ?? "Don't Save",
      documentNames: options.documentNames ?? [],
      resolve
    }
  })
}

export function useUnsavedChangesDialog() {
  function settle(decision: UnsavedChangesDecision) {
    const current = requestRef.value
    if (!current) return
    requestRef.value = null
    current.resolve(decision)
  }

  return {
    request: computed(() => requestRef.value),
    settle
  }
}
