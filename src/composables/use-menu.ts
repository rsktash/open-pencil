import { onUnmounted, watch } from 'vue'

import { IS_TAURI } from '@/constants'
import { forgetRecentFile, useRecentFiles } from '@/composables/use-recent-files'
import { toast } from '@/composables/use-toast'
import { useEditorStore } from '@/stores/editor'
import { openFileInNewTab, createTab, closeTab, activeTab } from '@/stores/tabs'

export async function openFileDialog() {
  if (IS_TAURI) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const path = await open({
      filters: [{ name: 'Figma file', extensions: ['fig'] }],
      multiple: false
    })
    if (!path) return
    const bytes = await readFile(path)
    const file = new File([bytes], basename(path))
    await openFileInNewTab(file, undefined, path)
    return
  }

  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'Figma file',
            accept: { 'application/octet-stream': ['.fig'] }
          }
        ]
      })
      const file = await handle.getFile()
      await openFileInNewTab(file, handle)
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.fig'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void openFileInNewTab(file)
  })
  input.click()
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

interface OpenRecentFileOptions {
  forgetOnFailure?: boolean
}

export async function openRecentFile(
  path: string,
  options: OpenRecentFileOptions = {}
) {
  if (!IS_TAURI) {
    toast.show('Open Recent is only available in the desktop app.', 'error')
    return
  }

  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(path)
    const file = new File([bytes], basename(path), { type: 'application/octet-stream' })
    await openFileInNewTab(file, undefined, path)
  } catch (error) {
    console.error(`Failed to open recent file: ${path}`, error)
    if (options.forgetOnFailure ?? true) {
      forgetRecentFile(path)
      toast.show(`Couldn't open ${basename(path)}. It was removed from Open Recent.`, 'error')
      return
    }
    toast.show(`Couldn't open ${basename(path)}.`, 'error')
  }
}

export async function openRecentFileByIndex(index: number) {
  const { recentFiles } = useRecentFiles()
  const entry = recentFiles.value[index]
  await openRecentFile(entry.path)
}

const store = useEditorStore()
const { recentFileMenuEntries } = useRecentFiles()

const MENU_ACTIONS: Record<string, () => void> = {
  new: () => createTab(),
  open: () => {
    void openFileDialog()
  },
  close: () => {
    if (activeTab.value) void closeTab(activeTab.value.id)
  },
  save: () => {
    void store.saveFigFile()
  },
  'save-as': () => {
    void store.saveFigFileAs()
  },
  'export-figma': () => {
    void store.exportFigmaCompatFigFile()
  },
  duplicate: () => store.duplicateSelected(),
  delete: () => store.deleteSelected(),
  group: () => store.groupSelected(),
  ungroup: () => store.ungroupSelected(),
  'create-component': () => store.createComponentFromSelection(),
  'create-component-set': () => store.createComponentSetFromComponents(),
  'detach-instance': () => store.detachInstance(),
  'zoom-fit': () => store.zoomToFit(),
  export: () => {
    if (store.state.selectedIds.size > 0) void store.exportSelection(1, 'PNG')
  }
}

function resolveMenuAction(id: string): (() => void) | undefined {
  const action = MENU_ACTIONS[id]
  if (id in MENU_ACTIONS) return action

  if (!id.startsWith('open-recent-')) return undefined

  const index = Number.parseInt(id.slice('open-recent-'.length), 10)
  if (Number.isNaN(index) || index < 0) return undefined

  return () => {
    void openRecentFileByIndex(index)
  }
}

export function useMenu() {
  if (!IS_TAURI) return

  let unlisten: (() => void) | undefined
  let stopRecentMenuWatch: (() => void) | undefined

  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<string>('menu-event', (event) => {
      const action = resolveMenuAction(event.payload)
      if (action) action()
    }).then((fn) => {
      unlisten = fn
    })
  })

  void import('@tauri-apps/api/core').then(({ invoke }) => {
    const syncRecentFilesMenu = async () => {
      await invoke('set_recent_files_menu', {
        items: recentFileMenuEntries.value.map(({ label }) => ({ label }))
      }).catch((error) => {
        console.error('Failed to sync Open Recent menu:', error)
      })
    }

    stopRecentMenuWatch = watch(
      () => recentFileMenuEntries.value.map(({ label }) => label),
      () => {
        void syncRecentFilesMenu()
      },
      { immediate: true }
    )
  })

  onUnmounted(() => {
    unlisten?.()
    stopRecentMenuWatch?.()
  })
}
