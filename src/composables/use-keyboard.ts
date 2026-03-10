import { useBreakpoints, useEventListener } from '@vueuse/core'

import { useAIChat } from '@/composables/use-chat'
import { TOOL_SHORTCUTS, useEditorStore } from '@/stores/editor'
import { closeTab, createTab, activeTab as activeTabRef } from '@/stores/tabs'

import { openFileDialog } from './use-menu'

function isEditing(e: Event) {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
}

export function useKeyboard() {
  const { activeTab } = useAIChat()
  const store = useEditorStore()
  const breakpoints = useBreakpoints({ mobile: 768 })
  const isMobile = breakpoints.smaller('mobile')

  function toggleAI() {
    if (isMobile.value) {
      store.state.activeRibbonTab = store.state.activeRibbonTab === 'ai' ? 'panels' : 'ai'
      if (store.state.mobileDrawerSnap === 'closed') {
        store.state.mobileDrawerSnap = 'half'
      }
      return
    }
    activeTab.value = activeTab.value === 'ai' ? 'design' : 'ai'
  }

  function handleToolShortcut(key: string) {
    if (!(key in TOOL_SHORTCUTS)) return false
    store.setTool(TOOL_SHORTCUTS[key])
    return true
  }

  function handleAltCommandShortcut(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || !e.altKey) return false
    if (e.code === 'KeyK') {
      e.preventDefault()
      store.createComponentFromSelection()
      return true
    }
    if (e.code === 'KeyB') {
      e.preventDefault()
      store.detachInstance()
      return true
    }
    return false
  }

  function handleShiftCommandShortcut(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return false
    if (e.code === 'KeyK') {
      e.preventDefault()
      store.createComponentSetFromComponents()
      return true
    }
    if (e.code === 'KeyH') {
      e.preventDefault()
      store.toggleVisibility()
      return true
    }
    if (e.code === 'KeyL') {
      e.preventDefault()
      store.toggleLock()
      return true
    }
    if (e.code === 'KeyE') {
      e.preventDefault()
      if (store.state.selectedIds.size > 0) {
        void store.exportSelection(1, 'PNG')
      }
      return true
    }
    return false
  }

  function handleCommandUIShortcut(e: KeyboardEvent, key: string) {
    if (e.code === 'Backslash') {
      e.preventDefault()
      store.state.showUI = !store.state.showUI
      return true
    }
    if (e.code === 'KeyJ') {
      e.preventDefault()
      toggleAI()
      return true
    }
    if (key === 'w') {
      e.preventDefault()
      if (activeTabRef.value) void closeTab(activeTabRef.value.id)
      return true
    }
    if (key === 'n' || key === 't') {
      e.preventDefault()
      createTab()
      return true
    }
    return false
  }

  function handleCommandDocumentShortcut(e: KeyboardEvent, key: string) {
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault()
      store.undoAction()
      return true
    }
    if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault()
      store.redoAction()
      return true
    }
    if (key === '0') {
      e.preventDefault()
      store.zoomToFit()
      return true
    }
    if (key === 'd') {
      e.preventDefault()
      store.duplicateSelected()
      return true
    }
    if (key === 'a') {
      e.preventDefault()
      store.selectAll()
      return true
    }
    return false
  }

  function handleCommandFileShortcut(e: KeyboardEvent, key: string) {
    if (key === 's' && e.shiftKey) {
      e.preventDefault()
      void store.saveFigFileAs()
      return true
    }
    if (key === 's') {
      e.preventDefault()
      void store.saveFigFile()
      return true
    }
    if (key === 'o') {
      e.preventDefault()
      void openFileDialog()
      return true
    }
    if (key === 'g' && !e.shiftKey) {
      e.preventDefault()
      store.groupSelected()
      return true
    }
    if (key === 'g' && e.shiftKey) {
      e.preventDefault()
      store.ungroupSelected()
      return true
    }
    return false
  }

  function handleCommandShortcut(e: KeyboardEvent, key: string) {
    if (!(e.metaKey || e.ctrlKey)) return false
    return (
      handleCommandUIShortcut(e, key) ||
      handleCommandDocumentShortcut(e, key) ||
      handleCommandFileShortcut(e, key)
    )
  }

  function handleAutoLayoutShortcut(e: KeyboardEvent) {
    if (!e.shiftKey || e.key !== 'A') return false
    e.preventDefault()
    const node = store.selectedNode.value
    if (node?.type === 'FRAME' && store.selectedNodes.value.length === 1) {
      store.setLayoutMode(node.id, node.layoutMode === 'NONE' ? 'VERTICAL' : 'NONE')
      return true
    }
    if (store.selectedNodes.value.length > 0) {
      store.wrapInAutoLayout()
      return true
    }
    return false
  }

  function handleArrangeShortcut(e: KeyboardEvent, key: string) {
    if (key === ']') {
      e.preventDefault()
      store.bringToFront()
      return true
    }
    if (key === '[') {
      e.preventDefault()
      store.sendToBack()
      return true
    }
    return false
  }

  function handleEditingShortcut(e: KeyboardEvent, key: string) {
    if (key === 'Backspace' || key === 'Delete') {
      store.deleteSelected()
      return true
    }
    if (key === 'Enter' && store.state.penState) {
      e.preventDefault()
      store.penCommit(false)
      return true
    }
    if (key !== 'Escape') return false
    if (store.state.penState) {
      store.penCancel()
      return true
    }
    store.clearSelection()
    store.setTool('SELECT')
    return true
  }

  useEventListener(window, 'copy', (e: ClipboardEvent) => {
    if (isEditing(e)) return
    e.preventDefault()
    if (e.clipboardData) store.writeCopyData(e.clipboardData)
  })

  useEventListener(window, 'cut', (e: ClipboardEvent) => {
    if (isEditing(e)) return
    e.preventDefault()
    if (e.clipboardData) store.writeCopyData(e.clipboardData)
    store.deleteSelected()
  })

  useEventListener(window, 'paste', (e: ClipboardEvent) => {
    if (isEditing(e)) return
    e.preventDefault()
    const html = e.clipboardData?.getData('text/html') ?? ''
    if (html) store.pasteFromHTML(html)
  })

  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if (isEditing(e)) return

    const key = e.key.toLowerCase()
    if (handleToolShortcut(key)) return
    if (handleAltCommandShortcut(e)) return
    if (handleShiftCommandShortcut(e)) return
    if (handleCommandShortcut(e, key)) return
    if (handleAutoLayoutShortcut(e)) return
    if (handleArrangeShortcut(e, key)) return
    handleEditingShortcut(e, key)
  })
}
