import { compactPlate } from '@/lib/plates'
import type { ProcessLastAction } from '@/lib/process-cursor'
import type { DocType } from '@/lib/types'

export type ProcessFocus = 'all' | 'photos' | 'certificates' | 'repair'
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
  focus?: ProcessFocus
  cancelled?: boolean
  items: ProcessItem[]
  error?: string
  currentId?: string
  lastAction?: ProcessLastAction
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
    focus: undefined,
    cancelled: false,
    items: [],
  }
}

let cancelRequested = false
let generation = 0

export function processGeneration() {
  return generation
}

export function isProcessCancelled() {
  return cancelRequested
}

export function isStaleProcess(startedAt: number) {
  return cancelRequested || startedAt !== generation
}

export function requestProcessStop(message = 'Stopped. Choose photos, insurance, or match repair to start the next job.') {
  cancelRequested = true
  generation += 1
  recount()
  job = {
    ...job,
    running: false,
    advancing: false,
    remaining: 0,
    cancelled: true,
    finishedAt: now(),
    error: message,
    currentId: undefined,
  }
}

export function processFocusLabel(focus?: ProcessFocus) {
  if (focus === 'photos') return 'Photos'
  if (focus === 'certificates') return 'Insurance'
  if (focus === 'repair') return 'Wrong matches'
  if (focus === 'all') return 'All files'
  return 'Processing'
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

export function fileMatchesFocus(file: { type: DocType }, focus: ProcessFocus) {
  if (focus === 'all') return true
  if (focus === 'photos') return file.type === 'photo'
  if (focus === 'certificates') return file.type === 'certificate'
  return file.type === 'photo' || file.type === 'certificate'
}

export function getProcessJob(): ProcessJob {
  return job
}

export function attachLastAction(action?: ProcessLastAction) {
  job = { ...job, lastAction: action }
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

export function beginProcessJob(watching: string, files: Array<{ id: string; name: string; type: DocType; mimeType?: string }>, focus: ProcessFocus = 'all') {
  if (job.running) return false
  cancelRequested = false
  generation += 1
  const incoming = files.map(asQueued)
  const continueMs = job.finishedAt ? Date.now() - Date.parse(job.finishedAt) : Number.POSITIVE_INFINITY
  const continuing = Boolean(!job.cancelled && job.focus === focus && job.items.length && job.finishedAt && continueMs < 5 * 60_000)
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
      focus,
      cancelled: false,
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
    focus,
    cancelled: false,
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

export function markProcessMatches(matched: string[] = [], missing: string[] = [], register?: Set<string>) {
  const matchedSet = new Set(matched.map((plate) => compactPlate(plate)).filter(Boolean))
  const missingSet = new Set(missing.map((plate) => compactPlate(plate)).filter(Boolean))
  const onSheet = (key: string) => {
    if (matchedSet.has(key)) return true
    if (missingSet.has(key)) return false
    if (register?.size) return register.has(key)
    return false
  }
  for (const item of job.items) {
    if (item.stage === 'error') continue
    const key = compactPlate(item.plate || '')
    if (!key) {
      if (item.stage === 'queued' || item.stage === 'opening' || item.stage === 'reading' || item.stage === 'renaming' || item.stage === 'matching') continue
      if (item.stage !== 'unmatched') {
        touchProcessItem(item.fileId, { stage: 'unmatched', detail: 'No plate read yet. Open Unmatched and type it if you can see it on the file.' })
      }
      continue
    }
    if (onSheet(key)) {
      touchProcessItem(item.fileId, {
        stage: 'matched',
        detail: matchedSet.has(key)
          ? `Matched ${key} on STOCK DOCUMENTS`
          : `Matched ${key} on STOCK DOCUMENTS. The sheet row already had this document.`,
        plate: key,
      })
      continue
    }
    touchProcessItem(item.fileId, {
      stage: 'unmatched',
      detail: `Named ${key} from the document. Add this Registration Number on STOCK DOCUMENTS, then scan again.`,
      plate: key,
    })
  }
}

export function endProcessJob(error?: string, extras?: { remaining?: number; renamed?: number }) {
  recount()
  const remaining = job.cancelled ? 0 : extras?.remaining || 0
  job = {
    ...job,
    running: false,
    advancing: remaining > 0,
    remaining,
    lastRenamed: extras?.renamed ?? job.lastRenamed,
    finishedAt: now(),
    error: job.cancelled ? job.error : error,
    currentId: undefined,
  }
}
