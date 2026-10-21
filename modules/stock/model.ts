import { listRegistrationNumbers } from '@/lib/plates'
import { EMPTY_STATS } from '@/lib/vehicles'
import type { DocType, DuplicateFile, FleetSnapshot, InboxItem, TypedFile, VehicleRecord } from '@/lib/types'
import {
  AlertCircle,
  Copy,
  FileText,
  History,
  LayoutDashboard,
  Mail,
  RefreshCw,
  Settings,
  Bike,
} from 'lucide-react'
import type { ProcessFocus } from '@/lib/process-focus'

export type NavKey = 'Overview' | 'Vehicles' | 'Insurance inbox' | 'Logbook inbox' | 'Processing' | 'Unmatched' | 'Duplicates' | 'Audit log' | 'Settings'
export type ViewSlug = 'overview' | 'vehicles' | 'inbox' | 'logbook-inbox' | 'processing' | 'unmatched' | 'duplicates' | 'audit' | 'settings'
export type StatusFilter = 'all' | 'Complete' | 'Needs attention'
export type MissingFilter = 'logbook' | 'certificate' | 'photo' | 'collateral' | 'agreement'

export const MISSING_FILTERS: { id: MissingFilter; label: string }[] = [
  { id: 'logbook', label: 'Without logbook' },
  { id: 'certificate', label: 'Without certificate' },
  { id: 'photo', label: 'Without photo' },
  { id: 'collateral', label: 'Without collateral' },
  { id: 'agreement', label: 'Without agreement' },
]

export const PROCESS_TASKS: { id: ProcessFocus; label: string; detail: string }[] = [
  { id: 'photos', label: 'Photos only', detail: 'Rename photos that are not yet named Photos {plate}, then match each file onto the STOCK DOCUMENTS row. Files already named that way are left alone.' },
  { id: 'certificates', label: 'Insurance only', detail: 'Rename insurance files that are not yet named Insurance - {plate}, then match each file onto the STOCK DOCUMENTS row. Files already named that way are left alone.' },
  { id: 'logbooks', label: 'Logbooks only', detail: 'Rename logbooks that are not yet named {plate} - Logbook, then match each file onto the STOCK DOCUMENTS row. Files already named that way are left alone.' },
  { id: 'agreements', label: 'Agreements only', detail: 'Read loan agreements in the agreements folder, including subfolders. Chip the latest signed PDF onto an empty Agreement Link cell. The file name stays as it is.' },
  { id: 'all', label: 'All waiting files', detail: 'Photos, insurance, logbooks, and other waiting documents. Agreement file names stay as they are.' },
  { id: 'repair-photos', label: 'Fix wrong photos', detail: 'Reopen unmatched photos only and rename them from the plate. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-certificates', label: 'Fix wrong insurance', detail: 'Reopen unmatched insurance only and rename from REGISTRATION No. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-logbooks', label: 'Fix wrong logbooks', detail: 'Reopen unmatched logbooks only and rename from REGISTRATION No. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-agreements', label: 'Fix wrong agreements', detail: 'Agreement file names stay as they are. Agreements Only matches Registration No. inside the PDF to an empty Agreement Link cell.' },
]

export const SLUGS: Record<ViewSlug, NavKey> = {
  overview: 'Overview',
  vehicles: 'Vehicles',
  inbox: 'Insurance inbox',
  'logbook-inbox': 'Logbook inbox',
  processing: 'Processing',
  unmatched: 'Unmatched',
  duplicates: 'Duplicates',
  audit: 'Audit log',
  settings: 'Settings',
}

export const TO_SLUG: Record<NavKey, ViewSlug> = {
  Overview: 'overview',
  Vehicles: 'vehicles',
  'Insurance inbox': 'inbox',
  'Logbook inbox': 'logbook-inbox',
  Processing: 'processing',
  Unmatched: 'unmatched',
  Duplicates: 'duplicates',
  'Audit log': 'audit',
  Settings: 'settings',
}

export const nav = [
  { label: 'Overview' as const, icon: LayoutDashboard },
  { label: 'Vehicles' as const, icon: Bike },
  { label: 'Insurance inbox' as const, icon: Mail },
  { label: 'Logbook inbox' as const, icon: FileText },
  { label: 'Processing' as const, icon: RefreshCw },
  { label: 'Unmatched' as const, icon: AlertCircle },
  { label: 'Duplicates' as const, icon: Copy },
  { label: 'Audit log' as const, icon: History },
  { label: 'Settings' as const, icon: Settings },
]

export const FOLDER_STORE = 'fleetwise-folders'
export const VEHICLE_COUNT_STORE = 'fleetwise-vehicle-count'
export const EMPTY_BRANDS: string[] = []

export function rememberVehicleGrowth(count: number, newcomers: string[] = []) {
  if (!count) return ''
  try {
    const previousCount = Number(localStorage.getItem(VEHICLE_COUNT_STORE) || 0)
    let message = ''
    if (previousCount > 0 && count > previousCount) {
      const added = count - previousCount
      const listed = listRegistrationNumbers(newcomers)
      message = `The vehicle register grew by ${added}, from ${previousCount} to ${count}.${listed ? ` New Registration Number ${listed}.` : ''}`
    }
    localStorage.setItem(VEHICLE_COUNT_STORE, String(count))
    return message
  } catch {
    return ''
  }
}

export function writeSavedFolders(input: { logbooksId: string; certificatesId: string; photosId: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }) {
  try {
    localStorage.setItem(FOLDER_STORE, JSON.stringify({
      logbooksId: input.logbooksId,
      certificatesId: input.certificatesId,
      photosId: input.photosId,
      agreementsId: input.agreementsId,
      collateralId: input.collateralId,
      spreadsheetId: input.spreadsheetId,
      autoUploadThreshold: input.autoUploadThreshold ?? 85,
      insuranceInboxEmail: input.insuranceInboxEmail || '',
      logbooksInboxEmail: input.logbooksInboxEmail || '',
    }))
  } catch { /* ignore quota */ }
}

export function readSavedFolders() {
  try {
    const raw = localStorage.getItem(FOLDER_STORE)
    if (!raw) return null
    const stored = JSON.parse(raw) as { logbooksId?: string; certificatesId?: string; photosId?: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }
    if (!stored.logbooksId || !stored.certificatesId || !stored.photosId) return null
    return {
      logbooksId: stored.logbooksId,
      certificatesId: stored.certificatesId,
      photosId: stored.photosId,
      agreementsId: stored.agreementsId,
      collateralId: stored.collateralId,
      spreadsheetId: stored.spreadsheetId,
      autoUploadThreshold: stored.autoUploadThreshold ?? 85,
      insuranceInboxEmail: stored.insuranceInboxEmail || '',
      logbooksInboxEmail: stored.logbooksInboxEmail || '',
    }
  } catch {
    return null
  }
}

export function keepVehicles(current: FleetSnapshot | null, next: FleetSnapshot) {
  if (next.ingest?.preserve && current) {
    return {
      ...current,
      config: next.config || current.config,
      inbox: next.inbox.length ? next.inbox : current.inbox,
      gmailConnected: next.gmailConnected || current.gmailConnected,
      lastSync: next.lastSync || current.lastSync,
      ingest: next.ingest,
      sheetsError: next.sheetsError || current.sheetsError,
    }
  }
  return {
    ...next,
    config: next.config || current?.config || null,
    vehicles: next.vehicles.length ? next.vehicles : current?.vehicles || [],
    stats: next.stats?.total ? next.stats : current?.stats || next.stats,
    sheetsError: next.sheetsError || current?.sheetsError,
    inbox: next.inbox.length ? next.inbox : current?.inbox || next.inbox,
    audit: next.audit.length ? next.audit : current?.audit || next.audit,
  }
}

export function stubFleet(user: { name: string; email: string; image?: string }, folders: ReturnType<typeof readSavedFolders>): FleetSnapshot {
  return {
    user,
    config: folders ? {
      logbooksId: folders.logbooksId,
      certificatesId: folders.certificatesId,
      photosId: folders.photosId,
      agreementsId: folders.agreementsId,
      collateralId: folders.collateralId,
      spreadsheetId: folders.spreadsheetId,
      autoUploadThreshold: folders.autoUploadThreshold ?? 85,
      insuranceInboxEmail: folders.insuranceInboxEmail,
      logbooksInboxEmail: folders.logbooksInboxEmail,
    } : null,
    vehicles: [],
    unmatched: [],
    duplicates: [],
    inbox: [],
    audit: [],
    stats: EMPTY_STATS,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: true,
    sheetsConnected: Boolean(folders?.spreadsheetId),
  }
}

export function viewFromSearch(search = typeof window === 'undefined' ? '' : window.location.search): NavKey {
  const slug = new URLSearchParams(search).get('view') as ViewSlug
  return SLUGS[slug] || 'Overview'
}

export function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function labelFor(type: DocType) {
  if (type === 'logbook') return 'Logbook'
  if (type === 'certificate') return 'Insurance certificate'
  if (type === 'agreement') return 'Agreement'
  return 'Vehicle photo'
}

export function isPhotoFile(file: TypedFile) {
  const mime = (file.mimeType || '').toLowerCase()
  if (mime.includes('svg') || mime.includes('heic') || mime.includes('heif')) return false
  if (mime.startsWith('image/') || mime.includes('pdf')) return true
  return /\.(png|jpe?g|webp|gif|bmp|tif?f|pdf)$/i.test(file.name)
}

export function splitUnmatched<T extends TypedFile>(files: T[]) {
  return {
    photos: files.filter((file) => file.type === 'photo'),
    insurance: files.filter((file) => file.type === 'certificate'),
    logbooks: files.filter((file) => file.type === 'logbook'),
    agreements: files.filter((file) => file.type === 'agreement'),
  }
}

export function unmatchedSplitLabel(files: TypedFile[]) {
  const { photos, insurance, logbooks, agreements } = splitUnmatched(files)
  return [
    `${photos.length} photo${photos.length === 1 ? '' : 's'}`,
    `${insurance.length} insurance`,
    `${logbooks.length} logbook${logbooks.length === 1 ? '' : 's'}`,
    `${agreements.length} agreement${agreements.length === 1 ? '' : 's'}`,
  ].join(' · ')
}

export type UnmatchedKind = 'all' | 'photo' | 'certificate' | 'logbook' | 'agreement'

export function inboxKind(item: InboxItem): 'certificate' | 'logbook' {
  return item.type === 'logbook' ? 'logbook' : 'certificate'
}

export function unmatchedTitle(file: TypedFile) {
  if (file.type === 'certificate') return 'Unmatched insurance'
  if (file.type === 'photo') return 'Unmatched photo'
  if (file.type === 'agreement') return 'Unmatched agreement'
  return 'Unmatched logbook'
}

export function isAuthError(message: string) {
  return /unauthorized|sign in|expired|google session/i.test(message)
}

export function downloadableFileId(file?: { id?: string; webViewLink?: string }) {
  if (!file) return
  if (file.webViewLink && /\/folders\//i.test(file.webViewLink)) return
  if (file.id && !file.id.startsWith('sheet:')) return file.id
  return file.webViewLink?.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)?.[1]
    || file.webViewLink?.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1]
}

export function hasRegisterItem(vehicle: VehicleRecord, item: MissingFilter) {
  if (item === 'collateral') return Boolean(vehicle.collateral)
  return vehicle.files[item].length > 0
}

export function shareParts(have: number, total: number) {
  const complete = Math.max(0, have)
  const missing = Math.max(0, total - complete)
  const completePct = total ? Math.round((complete / total) * 100) : 0
  const missingPct = total ? Math.round((missing / total) * 100) : 0
  return { complete, missing, completePct, missingPct }
}

export function shareLabel(have: number, total: number) {
  const { complete, completePct } = shareParts(have, total)
  if (!total) return '0 of 0 (0%)'
  return `${complete} of ${total} (${completePct}%)`
}

export function pageNumbers(page: number, totalPages: number) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const items: Array<number | '…'> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(totalPages - 1, page + 1)
  if (start > 2) items.push('…')
  for (let value = start; value <= end; value++) items.push(value)
  if (end < totalPages - 1) items.push('…')
  items.push(totalPages)
  return items
}

export function surplusGroups(files: DuplicateFile[]) {
  const groups = new Map<string, { key: string; plate: string; type: DocType; uploadedName: string; uploadedLink?: string; surplus: DuplicateFile[] }>()
  for (const file of files) {
    const plate = file.plate || ''
    const key = `${plate}:${file.type}:${file.uploadedId}`
    const current = groups.get(key)
    if (current) current.surplus.push(file)
    else groups.set(key, { key, plate, type: file.type, uploadedName: file.uploadedName, uploadedLink: file.uploadedLink, surplus: [file] })
  }
  return [...groups.values()].sort((a, b) => a.plate.localeCompare(b.plate) || a.type.localeCompare(b.type))
}

export function exportAudit(events: FleetSnapshot['audit']) {
  downloadCsv('fleetwise-audit.csv', [['User', 'Action', 'Time'], ...events.map((event) => [event.user, event.action, event.time])])
}

export function downloadCsv(name: string, rows: string[][]) {
  const blob = new Blob([rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
