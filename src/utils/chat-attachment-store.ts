import {
  CHAT_ATTACHMENT_DB_NAME,
  CHAT_ATTACHMENT_DB_VERSION,
  CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX,
  CHAT_ATTACHMENT_STORE_NAME
} from '@/constants'

interface StoredChatAttachment {
  id: string
  blob: Blob
  mediaType: string
  filename?: string
  updatedAt: number
}

interface ParsedAttachmentPlaceholder {
  id: string
  filename?: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function getIndexedDb(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

async function openAttachmentDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise

  const indexedDb = getIndexedDb()
  if (!indexedDb) {
    dbPromise = Promise.resolve(null)
    return dbPromise
  }

  dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDb.open(CHAT_ATTACHMENT_DB_NAME, CHAT_ATTACHMENT_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHAT_ATTACHMENT_STORE_NAME)) {
        db.createObjectStore(CHAT_ATTACHMENT_STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open chat attachment database'))
  }).catch(() => null)

  return dbPromise
}

function transactionStore(
  db: IDBDatabase,
  mode: IDBTransactionMode
): IDBObjectStore {
  return db.transaction(CHAT_ATTACHMENT_STORE_NAME, mode).objectStore(CHAT_ATTACHMENT_STORE_NAME)
}

export function buildAttachmentPlaceholderUrl(id: string, filename?: string): string {
  const query = filename ? `?name=${encodeURIComponent(filename)}` : ''
  return `${CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX}${encodeURIComponent(id)}${query}`
}

export function parseAttachmentPlaceholderUrl(url: string): ParsedAttachmentPlaceholder | null {
  if (!url.startsWith(CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX)) return null

  const raw = url.slice(CHAT_ATTACHMENT_PLACEHOLDER_URL_PREFIX.length)
  if (!raw) return null

  const [idPart, query = ''] = raw.split('?')
  if (!idPart) return null

  const params = new URLSearchParams(query)
  const filename = params.get('name') ?? undefined

  return {
    id: decodeURIComponent(idPart),
    ...(filename ? { filename } : {})
  }
}

export function isAttachmentPlaceholderUrl(url: string): boolean {
  return parseAttachmentPlaceholderUrl(url) !== null
}

export async function storeChatAttachment(
  blob: Blob,
  options: {
    filename?: string
    mediaType?: string
    id?: string
  } = {}
): Promise<string | null> {
  const db = await openAttachmentDb()
  if (!db) return null

  const id = options.id ?? crypto.randomUUID()
  const record: StoredChatAttachment = {
    id,
    blob,
    mediaType: options.mediaType ?? blob.type ?? 'application/octet-stream',
    ...(options.filename ? { filename: options.filename } : {}),
    updatedAt: Date.now()
  }

  await requestToPromise(transactionStore(db, 'readwrite').put(record))
  return buildAttachmentPlaceholderUrl(id, options.filename)
}

export async function getStoredChatAttachment(
  placeholderUrl: string
): Promise<StoredChatAttachment | null> {
  const parsed = parseAttachmentPlaceholderUrl(placeholderUrl)
  if (!parsed) return null

  const db = await openAttachmentDb()
  if (!db) return null

  const result = await requestToPromise(
    transactionStore(db, 'readonly').get(parsed.id)
  ).catch(() => null)

  if (!result || typeof result !== 'object') return null
  const record = result as Partial<StoredChatAttachment>
  if (!(record.blob instanceof Blob) || typeof record.id !== 'string') return null

  return {
    id: record.id,
    blob: record.blob,
    mediaType:
      typeof record.mediaType === 'string'
        ? record.mediaType
        : record.blob.type || 'application/octet-stream',
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0
  }
}

export async function clearStoredChatAttachments(): Promise<void> {
  const db = await openAttachmentDb()
  if (!db) return
  await requestToPromise(transactionStore(db, 'readwrite').clear()).catch(() => {})
}
