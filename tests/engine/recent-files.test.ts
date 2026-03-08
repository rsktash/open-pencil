import { describe, expect, test } from 'bun:test'

import {
  formatRecentFileLabel,
  parseRecentFiles,
  removeRecentFile,
  upsertRecentFile
} from '@/composables/use-recent-files'

describe('recent files', () => {
  test('parses and sanitizes stored entries', () => {
    const entries = parseRecentFiles(
      JSON.stringify([
        { path: '/tmp/alpha.fig', name: 'alpha.fig', lastOpenedAt: 3 },
        { path: '/tmp/alpha.fig', name: 'duplicate.fig', lastOpenedAt: 2 },
        { path: '/tmp/beta.fig' },
        { nope: true }
      ])
    )

    expect(entries).toEqual([
      { path: '/tmp/alpha.fig', name: 'alpha.fig', lastOpenedAt: 3 },
      { path: '/tmp/beta.fig', name: 'beta.fig', lastOpenedAt: 0 }
    ])
  })

  test('upserts recent files to the front and deduplicates by path', () => {
    const nextEntries = upsertRecentFile(
      [
        { path: '/tmp/alpha.fig', name: 'alpha.fig', lastOpenedAt: 1 },
        { path: '/tmp/beta.fig', name: 'beta.fig', lastOpenedAt: 2 }
      ],
      '/tmp/alpha.fig',
      'alpha.fig',
      9
    )

    expect(nextEntries).toEqual([
      { path: '/tmp/alpha.fig', name: 'alpha.fig', lastOpenedAt: 9 },
      { path: '/tmp/beta.fig', name: 'beta.fig', lastOpenedAt: 2 }
    ])
  })

  test('removes recent files by path', () => {
    const nextEntries = removeRecentFile(
      [
        { path: '/tmp/alpha.fig', name: 'alpha.fig', lastOpenedAt: 1 },
        { path: '/tmp/beta.fig', name: 'beta.fig', lastOpenedAt: 2 }
      ],
      '/tmp/alpha.fig'
    )

    expect(nextEntries).toEqual([{ path: '/tmp/beta.fig', name: 'beta.fig', lastOpenedAt: 2 }])
  })

  test('formats recent file labels with the parent directory', () => {
    expect(
      formatRecentFileLabel({
        path: '/Users/rustam/Projects/open-pencil/demo.fig',
        name: 'demo.fig',
        lastOpenedAt: 1
      })
    ).toBe('demo.fig - /Users/rustam/Projects/open-pencil')
  })
})
