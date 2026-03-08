export function fileSignature(file: File): string {
  return [file.name, file.type, file.size, file.lastModified].join(':')
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function mimeTypeFromPath(path: string): string {
  const extension = basename(path).split('.').at(-1)?.toLowerCase() ?? ''
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'txt':
      return 'text/plain'
    case 'json':
      return 'application/json'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

export function normalizeIncomingAttachmentFile(file: File): File {
  if (file.name) return file

  const extension = file.type.startsWith('image/') ? file.type.replace('image/', '') : 'bin'
  return new File([file], `pasted-image.${extension}`, {
    type: file.type,
    lastModified: Date.now()
  })
}

export function extractTransferFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  if (dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files)
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function hasTransferFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) return true
  if (Array.from(dataTransfer.types).includes('Files')) return true
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}
