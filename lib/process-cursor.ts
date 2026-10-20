import { findFileByName, readJsonFile, upsertJsonFile } from '@/lib/drive'
import type { DocType, FleetConfig } from '@/lib/types'
import type { ProcessFocus } from '@/lib/process-focus'

export const PROCESS_NAME = 'fleetwise-process.json'
const TRIED_MS = 14 * 24 * 60 * 60 * 1000
const MAX_TRIED = 8000

export type ProcessLastAction = {
  focus?: ProcessFocus
  status: 'idle' | 'running' | 'paused' | 'done'
  fileId?: string
  fileName?: string
  plate?: string
  detail?: string
  at?: string
  remaining?: number
  done?: number
}

export type ProcessQueueItem = {
  id: string
  name: string
  mimeType?: string
  type: DocType
  plate: string | null
  modifiedTime?: string
  webViewLink?: string
  parents?: string[]
}

type CursorFile = ProcessLastAction & {
  tried?: Record<string, number>
  confirmed?: Record<string, { plate: string; at: number }>
  queue?: ProcessQueueItem[]
  queueFocus?: ProcessFocus
  fileId?: string
}

let cursor: ProcessLastAction = { status: 'idle' }
const tried = new Map<string, number>()
const confirmed = new Map<string, { plate: string; at: number }>()
let queue: ProcessQueueItem[] = []
let queueFocus: ProcessFocus | undefined
let storedFileId: string | undefined
let hydrated = false
let epoch = 0
let closed = false
let persistChain: Promise<void> = Promise.resolve()

function pruneTried() {
  const cutoff = Date.now() - TRIED_MS
  for (const [id, at] of tried) {
    if (at < cutoff) tried.delete(id)
  }
  for (const [id, hit] of confirmed) {
    if (hit.at < cutoff) confirmed.delete(id)
  }
  if (tried.size <= MAX_TRIED) return
  const oldest = [...tried.entries()].sort((a, b) => a[1] - b[1]).slice(0, tried.size - MAX_TRIED)
  for (const [id] of oldest) tried.delete(id)
}

export function lastAction(): ProcessLastAction {
  return { ...cursor }
}

export function wasTriedRecently(fileId: string) {
  const at = tried.get(fileId)
  if (!at) return false
  if (Date.now() - at > TRIED_MS) {
    tried.delete(fileId)
    return false
  }
  return true
}

export function confirmedPlate(fileId: string) {
  const hit = confirmed.get(fileId)
  if (!hit) return null
  if (Date.now() - hit.at > TRIED_MS) {
    confirmed.delete(fileId)
    return null
  }
  return hit.plate
}

export function markTried(fileId: string) {
  tried.set(fileId, Date.now())
}

export function markConfirmed(fileId: string, plate: string) {
  const value = plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  confirmed.set(fileId, { plate: value, at: Date.now() })
  tried.set(fileId, Date.now())
}

export function forgetFile(fileId: string) {
  tried.delete(fileId)
  confirmed.delete(fileId)
}

export function clearTriedFiles() {
  tried.clear()
  confirmed.clear()
}

export function canResumeProcessQueue(focus: ProcessFocus) {
  return queue.length > 0 && queueFocus === focus
}

export function processQueueItems() {
  return queue.slice()
}

export function replaceProcessQueue(items: ProcessQueueItem[], focus: ProcessFocus) {
  if (closed) return
  queue = items
  queueFocus = focus
}

export function takeProcessQueueItem() {
  if (closed) return undefined
  return queue.shift()
}

export function recordLastAction(patch: Partial<ProcessLastAction>) {
  if (closed) return
  cursor = {
    ...cursor,
    ...patch,
    at: patch.at || new Date().toISOString(),
  }
}

export function isCursorHydrated() {
  return hydrated
}

export async function hydrateProcessCursor(config: FleetConfig) {
  if (hydrated) return lastAction()
  hydrated = true
  const existing = await findFileByName(PROCESS_NAME)
  storedFileId = existing?.id
  if (!existing) return lastAction()
  const stored = await readJsonFile<CursorFile>(existing.id)
  if (!stored) return lastAction()
  cursor = {
    focus: stored.focus,
    status: stored.status || 'paused',
    fileId: stored.fileId,
    fileName: stored.fileName,
    plate: stored.plate,
    detail: stored.detail,
    at: stored.at,
    remaining: stored.remaining || 0,
    done: stored.done || 0,
  }
  queue = Array.isArray(stored.queue) ? stored.queue.filter((item) => item?.id && item?.name && item?.type) : []
  queueFocus = stored.queueFocus
  for (const [id, at] of Object.entries(stored.tried || {})) {
    if (typeof at === 'number') tried.set(id, at)
  }
  for (const [id, hit] of Object.entries(stored.confirmed || {})) {
    if (hit?.plate) confirmed.set(id, { plate: hit.plate, at: hit.at || Date.now() })
  }
  pruneTried()
  return lastAction()
}

export function closeRunningProcesses() {
  epoch += 1
  closed = true
  queue = []
  queueFocus = undefined
  cursor = {
    status: 'done',
    remaining: 0,
    done: 0,
    detail: 'Signed out. Start a job to process files.',
  }
}

export function openProcessSession() {
  closed = false
}

export async function persistProcessCursor(config: FleetConfig) {
  const seen = epoch
  pruneTried()
  const payload: CursorFile = {
    ...cursor,
    tried: Object.fromEntries(tried),
    confirmed: Object.fromEntries(confirmed),
    queue: queue.slice(),
    queueFocus,
  }
  const run = persistChain.then(async () => {
    if (seen !== epoch) return
    try {
      const file = await upsertJsonFile(config.certificatesId, PROCESS_NAME, payload, storedFileId)
      if (seen !== epoch) return
      storedFileId = file.id
    } catch {
      if (seen !== epoch) return
      const file = await upsertJsonFile(config.certificatesId, PROCESS_NAME, payload)
      if (seen !== epoch) return
      storedFileId = file.id
    }
  })
  persistChain = run.catch(() => {})
  await run
}
