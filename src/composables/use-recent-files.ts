import { computed, readonly, shallowRef } from 'vue'

import { RECENT_FILES_LIMIT, RECENT_FILES_STORAGE } from '@/constants'

export interface RecentFileEntry {
  path: string
  name: string
  lastOpenedAt: number
}

export interface RecentFileMenuEntry {
  label: string
  path: string
}

interface RecentFileCandidate {
  path?: unknown
  name?: unknown
  lastOpenedAt?: unknown
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null
  return localStorage
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function dirname(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (separatorIndex < 0) return ''
  if (separatorIndex === 0 && normalized.startsWith('/')) return '/'
  return normalized.slice(0, separatorIndex)
}

function isRecentFileCandidate(value: unknown): value is RecentFileCandidate {
  return typeof value === 'object' && value !== null
}

function sanitizeRecentFileEntry(value: unknown): RecentFileEntry | null {
  if (!isRecentFileCandidate(value) || typeof value.path !== 'string' || value.path.length === 0) {
    return null
  }

  const path = value.path
  const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : basename(path)
  const lastOpenedAt = typeof value.lastOpenedAt === 'number' ? value.lastOpenedAt : 0

  return { path, name, lastOpenedAt }
}

export function parseRecentFiles(raw: string | null): RecentFileEntry[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const seen = new Set<string>()
    const entries: RecentFileEntry[] = []

    for (const value of parsed) {
      const entry = sanitizeRecentFileEntry(value)
      if (!entry || seen.has(entry.path)) continue
      seen.add(entry.path)
      entries.push(entry)
      if (entries.length >= RECENT_FILES_LIMIT) break
    }

    return entries
  } catch {
    return []
  }
}

export function upsertRecentFile(
  entries: RecentFileEntry[],
  path: string,
  name = basename(path),
  lastOpenedAt = Date.now()
): RecentFileEntry[] {
  const nextEntry: RecentFileEntry = { path, name, lastOpenedAt }
  return [nextEntry, ...entries.filter((entry) => entry.path !== path)].slice(0, RECENT_FILES_LIMIT)
}

export function removeRecentFile(entries: RecentFileEntry[], path: string): RecentFileEntry[] {
  return entries.filter((entry) => entry.path !== path)
}

export function formatRecentFileLabel(entry: RecentFileEntry): string {
  const directory = dirname(entry.path)
  return directory ? `${entry.name} - ${directory}` : entry.name
}

function loadRecentFiles(): RecentFileEntry[] {
  return parseRecentFiles(getStorage()?.getItem(RECENT_FILES_STORAGE) ?? null)
}

const recentFilesRef = shallowRef<RecentFileEntry[]>(loadRecentFiles())

function persistRecentFiles(entries: RecentFileEntry[]) {
  const storage = getStorage()
  if (!storage) return

  if (entries.length === 0) {
    storage.removeItem(RECENT_FILES_STORAGE)
    return
  }

  storage.setItem(RECENT_FILES_STORAGE, JSON.stringify(entries))
}

function setRecentFiles(entries: RecentFileEntry[]) {
  recentFilesRef.value = entries
  persistRecentFiles(entries)
}

export function rememberRecentFile(path: string, name = basename(path)) {
  if (!path) return
  setRecentFiles(upsertRecentFile(recentFilesRef.value, path, name))
}

export function forgetRecentFile(path: string) {
  if (!path) return
  const nextEntries = removeRecentFile(recentFilesRef.value, path)
  if (nextEntries.length === recentFilesRef.value.length) return
  setRecentFiles(nextEntries)
}

const recentFiles = readonly(recentFilesRef)

const recentFileMenuEntries = computed<RecentFileMenuEntry[]>(() =>
  recentFilesRef.value.map((entry) => ({
    path: entry.path,
    label: formatRecentFileLabel(entry)
  }))
)

const hasRecentFiles = computed(() => recentFilesRef.value.length > 0)

export function useRecentFiles() {
  return {
    recentFiles,
    recentFileMenuEntries,
    hasRecentFiles
  }
}
