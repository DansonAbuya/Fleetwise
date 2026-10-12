import { compactPlate } from '@/lib/plates'
import type { DocType } from '@/lib/types'

export type ProcessStage = 'queued' | 'opening' | 'reading' | 'renaming' | 'matching' | 'matched' | 'unmatched' | 'error'

export type ProcessItem = {
  fileId: string
  name: string
  type: DocType
  mimeType?: string
  preview: boolean
  plate?: string | null
  stage: ProcessStage
  detail: string
  updatedAt: string
}

export type ProcessJob = {
  running: boolean
  watching: string
  startedAt?: string
  finishedAt?: string
  attempted: number
  done: number
  matched: number
  failed: number
  batch: number
  remaining: number
  lastRenamed: number
  advancing: boolean
  items: ProcessItem[]
  error?: string
  currentId?: string
}

const MAX_ITEMS = 48
const TERMINAL: ProcessStage[] = ['matched', 'unmatched', 'error']

let job: ProcessJob = emptyJob()

function emptyJob(): ProcessJob {
  return {
    running: false,
    watching: '',
    attempted: 0,
    done: 0,
    matched: 0,
    failed: 0,
    batch: 0,
    remaining: 0,
    lastRenamed: 0,
    advancing: false,
    items: [],
  }
}

function now() {
  return new Date().toISOString()
}

function canPreview(file: { name: string; mimeType?: string }) {
  return /image\/(jpeg|png|gif|webp)/i.test(file.mimeType || '') || /\.(jpe?g|png|gif|webp)$/i.test(file.name)
}

function recount() {
  job.done = job.items.filter((item) => TERMINAL.includes(item.stage)).length
  job.matched = job.items.filter((item) => item.stage === 'matched').length
  job.failed = job.items.filter((item) => item.stage === 'error' || item.stage === 'unmatched').length
  job.currentId = job.items.find((item) => !TERMINAL.includes(item.stage))?.fileId
}

export function getProcessJob(): ProcessJob {
  return job
}

export function isProcessRunning() {
  return job.running
}

function asQueued(file: { id: string; name: string; type: DocType; mimeType?: string }): ProcessItem {
  return {
    fileId: file.id,
    name: file.name,
    type: file.type,
    mimeType: file.mimeType,
    preview: canPreview(file),
    plate: null,
    stage: 'queued',
    detail: 'Waiting to open',
    updatedAt: now(),
  }
}

export function beginProcessJob(watching: string, files: Array<{ id: string; name: string; type: DocType; mimeType?: string }>) {
  if (job.running) return false
  const incoming = files.map(asQueued)
  const continueMs = job.finishedAt ? Date.now() - Date.parse(job.finishedAt) : Number.POSITIVE_INFINITY
  const continuing = Boolean(job.items.length && job.finishedAt && continueMs < 5 * 60_000)
  if (continuing) {
    const seen = new Set(job.items.map((item) => item.fileId))
    const added = incoming.filter((item) => !seen.has(item.fileId))
    const items = [...job.items, ...added].slice(-MAX_ITEMS)
    job = {
      ...job,
      running: true,
      advancing: false,
      watching,
      finishedAt: undefined,
      error: undefined,
      batch: (job.batch || 1) + 1,
      remaining: 0,
      attempted: job.attempted + added.length,
      items,
      currentId: added[0]?.fileId || items.find((item) => item.stage === 'queued')?.fileId,
    }
    recount()
    return true
  }
  job = {
    running: true,
    advancing: false,
    watching,
    startedAt: now(),
    attempted: files.length,
    done: 0,
    matched: 0,
    failed: 0,
    batch: 1,
    remaining: 0,
    lastRenamed: 0,
    items: incoming.slice(0, MAX_ITEMS),
    currentId: incoming[0]?.fileId,
  }
  return true
}

export function touchProcessItem(fileId: string, patch: Partial<Omit<ProcessItem, 'fileId' | 'preview'>> & { mimeType?: string; name?: string; type?: DocType }) {
  const index = job.items.findIndex((item) => item.fileId === fileId)
  const previous = index >= 0 ? job.items[index] : undefined
  const next: ProcessItem = {
    fileId,
    name: patch.name || previous?.name || 'File',
    type: patch.type || previous?.type || 'photo',
    mimeType: patch.mimeType || previous?.mimeType,
    preview: previous?.preview ?? canPreview({ name: patch.name || previous?.name || '', mimeType: patch.mimeType || previous?.mimeType }),
    plate: patch.plate !== undefined ? patch.plate : previous?.plate,
    stage: patch.stage || previous?.stage || 'queued',
    detail: patch.detail || previous?.detail || '',
    updatedAt: now(),
  }
  if (index >= 0) job.items[index] = next
  else if (job.items.length < MAX_ITEMS) job.items.push(next)
  recount()
}

export function markProcessMatches(matched: string[] = [], missing: string[] = []) {
  const matchedSet = new Set(matched.map((plate) => compactPlate(plate)).filter(Boolean))
  const missingSet = new Set(missing.map((plate) => compactPlate(plate)).filter(Boolean))
  for (const item of job.items) {
    if (item.stage === 'error') continue
    const key = compactPlate(item.plate || '')
    if (!key) {
      touchProcessItem(item.fileId, { stage: 'unmatched', detail: 'No plate read yet. Open Unmatched and type it if you can see it on the file.' })
      continue
    }
    touchProcessItem(item.fileId, { stage: 'matching', detail: `Matching ${key} on STOCK DOCUMENTS`, plate: key })
    if (missingSet.has(key)) {
      touchProcessItem(item.fileId, { stage: 'unmatched', detail: `${key} is not a Registration Number on STOCK DOCUMENTS. Add the plate on the sheet, then scan again.`, plate: key })
    } else if (matchedSet.has(key)) {
      touchProcessItem(item.fileId, { stage: 'matched', detail: `Matched ${key} on STOCK DOCUMENTS`, plate: key })
    } else {
      touchProcessItem(item.fileId, { stage: 'matched', detail: `Renamed for ${key}. The sheet row already had this document type or the plate is on the register.`, plate: key })
    }
  }
}

export function endProcessJob(error?: string, extras?: { remaining?: number; renamed?: number }) {
  recount()
  const remaining = extras?.remaining || 0
  job = {
    ...job,
    running: false,
    advancing: remaining > 0,
    remaining,
    lastRenamed: extras?.renamed ?? job.lastRenamed,
    finishedAt: now(),
    error,
    currentId: undefined,
  }
}
