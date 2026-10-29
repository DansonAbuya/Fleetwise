import { cookies } from 'next/headers'
import {
  appendTextFile,
  findFileByName,
  findFileInFolder,
  findOwnedFileByName,
  getFile,
  listFolderFiles,
  moveAndRename,
  readJsonFile,
  readTextFile,
  upsertJsonFile,
} from '@/lib/drive'
import { stockDocumentsModule } from '@/lib/modules/stock-documents'
import type { SheetCells } from '@/lib/modules/types'
import { compactPlate, extractKenyanPlate } from '@/lib/plates'
import { hasCanonicalName, hasUnmatchedMark, plateFromTypedName, stripUnmatchedMark, uniqueSuggestedName } from '@/lib/document-names'
import type { InsuranceCover } from '@/lib/insurance'
import type { AuditEvent, DocType, FleetConfig, GmailState, TypedFile } from '@/lib/types'

export const CONFIG_NAME = 'fleetwise-config.json'
export const AUDIT_NAME = 'fleetwise-audit.jsonl'
export const GMAIL_STATE_NAME = 'fleetwise-gmail-state.json'
export const INSURANCE_COVER_NAME = 'fleetwise-insurance-cover.json'
const CONFIG_COOKIE = 'fleetwise_folders'

export function folderIdForType(config: FleetConfig, type: DocType) {
  if (type === 'logbook') return config.logbooksId
  if (type === 'certificate') return config.certificatesId
  if (type === 'agreement') return config.agreementsId || ''
  return config.photosId
}

export function folderNameForType(config: FleetConfig, type: DocType) {
  if (type === 'logbook') return config.logbooksName || 'Logbooks'
  if (type === 'certificate') return config.certificatesName || 'Certificates'
  if (type === 'agreement') return config.agreementsName || 'Agreements'
  return config.photosName || 'Photos'
}

export async function loadConfig(): Promise<FleetConfig | null> {
  const cookie = await readConfigCookie()
  if (cookie) return cookie
  const owned = await findOwnedFileByName(CONFIG_NAME)
  const stored = owned ? await readStoredConfig(owned.id) : null
  if (stored) return stored
  const shared = await findFileByName(CONFIG_NAME)
  if (shared && shared.id !== owned?.id) {
    const fromShared = await readStoredConfig(shared.id)
    if (fromShared) return fromShared
  }
  return envFolderConfig()
}

async function readStoredConfig(fileId: string): Promise<FleetConfig | null> {
  try {
    const stored = await readJsonFile<FleetConfig>(fileId)
    if (stored?.logbooksId && stored.certificatesId && stored.photosId) {
      return { ...stored, configFileId: fileId, autoUploadThreshold: stored.autoUploadThreshold ?? 85 }
    }
  } catch {
    return null
  }
  return null
}

function envFolderConfig(): FleetConfig | null {
  const logbooksId = process.env.DRIVE_FOLDER_LOGBOOKS
  const certificatesId = process.env.DRIVE_FOLDER_CERTIFICATES
  const photosId = process.env.DRIVE_FOLDER_PHOTOS
  const agreementsId = process.env.DRIVE_FOLDER_AGREEMENTS
  if (!logbooksId || !certificatesId || !photosId) return null
  return {
    logbooksId,
    certificatesId,
    photosId,
    agreementsId,
    collateralId: process.env.DRIVE_FOLDER_COLLATERAL,
    spreadsheetId: process.env.DRIVE_SPREADSHEET_ID,
    insuranceInboxEmail: process.env.GMAIL_INSURANCE_INBOX || process.env.DRIVE_INSURANCE_INBOX_EMAIL,
    logbooksInboxEmail: process.env.GMAIL_LOGBOOKS_INBOX || process.env.DRIVE_LOGBOOKS_INBOX_EMAIL,
    autoUploadThreshold: Number(process.env.DRIVE_MATCH_THRESHOLD || 85),
  }
}

export async function saveConfig(input: FleetConfig) {
  const payload = {
    logbooksId: input.logbooksId,
    certificatesId: input.certificatesId,
    photosId: input.photosId,
    agreementsId: input.agreementsId,
    collateralId: input.collateralId,
    logbooksName: cleanFolderLabel(input.logbooksName),
    certificatesName: cleanFolderLabel(input.certificatesName),
    photosName: cleanFolderLabel(input.photosName),
    agreementsName: cleanFolderLabel(input.agreementsName),
    collateralName: cleanFolderLabel(input.collateralName),
    spreadsheetId: input.spreadsheetId,
    spreadsheetName: cleanFolderLabel(input.spreadsheetName),
    logbooksSheet: input.logbooksSheet,
    certificatesSheet: input.certificatesSheet,
    photosSheet: input.photosSheet,
    autoUploadThreshold: input.autoUploadThreshold ?? 85,
    insuranceInboxEmail: input.insuranceInboxEmail,
    logbooksInboxEmail: input.logbooksInboxEmail,
    lastSync: input.lastSync,
  }
  const existing = await findOwnedFileByName(CONFIG_NAME)
  let file
  try {
    file = await upsertJsonFile('root', CONFIG_NAME, payload, existing?.id)
  } catch {
    file = await upsertJsonFile('root', CONFIG_NAME, payload)
  }
  const saved = { ...input, ...payload, configFileId: file.id }
  await writeConfigCookie(saved)
  return saved
}

function cleanFolderLabel(name?: string) {
  return name?.replace(/\s+\((Shared with me|Shared drive)\)$/i, '').trim() || name
}

async function writeConfigCookie(config: FleetConfig) {
  const jar = await cookies()
  jar.set(CONFIG_COOKIE, encodeURIComponent(JSON.stringify({
    logbooksId: config.logbooksId,
    certificatesId: config.certificatesId,
    photosId: config.photosId,
    agreementsId: config.agreementsId,
    collateralId: config.collateralId,
    logbooksName: config.logbooksName,
    certificatesName: config.certificatesName,
    photosName: config.photosName,
    agreementsName: config.agreementsName,
    collateralName: config.collateralName,
    spreadsheetId: config.spreadsheetId,
    spreadsheetName: config.spreadsheetName,
    autoUploadThreshold: config.autoUploadThreshold ?? 85,
    insuranceInboxEmail: config.insuranceInboxEmail,
    logbooksInboxEmail: config.logbooksInboxEmail,
  })), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}

async function readConfigCookie(): Promise<FleetConfig | null> {
  try {
    const jar = await cookies()
    const raw = jar.get(CONFIG_COOKIE)?.value
    if (!raw) return null
    const stored = JSON.parse(decodeURIComponent(raw)) as FleetConfig
    if (!stored?.logbooksId || !stored.certificatesId || !stored.photosId) return null
    return { ...stored, autoUploadThreshold: stored.autoUploadThreshold ?? 85 }
  } catch {
    return null
  }
}

export async function loadGmailState(): Promise<{ state: GmailState; fileId?: string }> {
  const existing = await findFileByName(GMAIL_STATE_NAME)
  if (!existing) return { state: { processedIds: [], items: [] } }
  const state = await readJsonFile<GmailState>(existing.id)
  return { state: state || { processedIds: [], items: [] }, fileId: existing.id }
}

export async function saveGmailState(config: FleetConfig, state: GmailState, fileId?: string) {
  const trimmed: GmailState = {
    lastSync: state.lastSync,
    processedIds: state.processedIds.slice(-400),
    items: state.items.slice(0, 50),
  }
  await upsertJsonFile(config.certificatesId, GMAIL_STATE_NAME, trimmed, fileId)
}

async function insuranceCoverFile(config: FleetConfig) {
  return (config.certificatesId ? await findFileInFolder(config.certificatesId, INSURANCE_COVER_NAME) : null)
    || await findFileByName(INSURANCE_COVER_NAME)
}

const coverStore = globalThis as typeof globalThis & { __fleetwiseCovers?: { at: number; covers: Record<string, InsuranceCover> } }

export async function loadInsuranceCovers(config: FleetConfig): Promise<Record<string, InsuranceCover>> {
  const cached = coverStore.__fleetwiseCovers
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.covers
  const existing = await insuranceCoverFile(config)
  if (!existing) return cached?.covers || {}
  const data = await readJsonFile<Record<string, InsuranceCover>>(existing.id)
  const covers = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  coverStore.__fleetwiseCovers = { at: Date.now(), covers }
  return covers
}

export async function saveInsuranceCovers(config: FleetConfig, covers: Record<string, InsuranceCover>) {
  const existing = await insuranceCoverFile(config)
  await upsertJsonFile(config.certificatesId, INSURANCE_COVER_NAME, covers, existing?.id)
  coverStore.__fleetwiseCovers = { at: Date.now(), covers }
}

export async function saveInsuranceCover(config: FleetConfig, plate: string, cover: InsuranceCover) {
  if (!cover.commencement && !cover.expiry) return
  const covers = await loadInsuranceCovers(config)
  const key = compactPlate(plate)
  const previous = covers[key] || { commencement: null, expiry: null }
  covers[key] = {
    commencement: cover.commencement || previous.commencement,
    expiry: cover.expiry || previous.expiry,
  }
  await saveInsuranceCovers(config, covers)
}

export async function appendAudit(config: FleetConfig, user: string, action: string) {
  const existing = await findFileByName(AUDIT_NAME)
  const line = JSON.stringify({ user, action, time: new Date().toISOString() })
  await appendTextFile(config.certificatesId, AUDIT_NAME, line, existing?.id)
}

export async function loadAudit(): Promise<AuditEvent[]> {
  const existing = await findFileByName(AUDIT_NAME)
  if (!existing) return []
  const text = await readTextFile(existing.id)
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .slice(0, 40)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AuditEvent
        return [{ ...parsed, time: formatTime(parsed.time) }]
      } catch {
        return []
      }
    })
}

async function listTypedFiles(config: FleetConfig, fresh = false, types?: Array<'logbook' | 'certificate' | 'photo' | 'agreement'>): Promise<TypedFile[]> {
  const want = (type: 'logbook' | 'certificate' | 'photo' | 'agreement') => !types?.length || types.includes(type)
  const [logbooks, certificates, photos, agreements] = await Promise.all([
    want('logbook') ? listFolderFiles(config.logbooksId, { fresh }) : Promise.resolve([]),
    want('certificate') ? listFolderFiles(config.certificatesId, { fresh }) : Promise.resolve([]),
    want('photo') ? listFolderFiles(config.photosId, { fresh }) : Promise.resolve([]),
    want('agreement') && config.agreementsId ? listFolderFiles(config.agreementsId, { fresh }) : Promise.resolve([]),
  ])
  return [
    ...logbooks.map((file) => ({ ...file, type: 'logbook' as const, plate: plateFromTypedName(file.name, 'logbook') || extractKenyanPlate(file.name) })),
    ...certificates.map((file) => ({ ...file, type: 'certificate' as const, plate: plateFromTypedName(file.name, 'certificate') || extractKenyanPlate(file.name) })),
    ...photos.map((file) => ({ ...file, type: 'photo' as const, plate: plateFromTypedName(file.name, 'photo') || extractKenyanPlate(file.name) })),
    ...agreements.map((file) => ({ ...file, type: 'agreement' as const, plate: plateFromTypedName(file.name, 'agreement') || extractKenyanPlate(file.name) })),
  ]
}

export async function scanFolders(config: FleetConfig, sheetPlates?: Set<string>, sheetCells?: SheetCells, listed?: TypedFile[], options?: { fresh?: boolean; types?: Array<'logbook' | 'certificate' | 'photo' | 'agreement'> }) {
  const typed = listed || await listTypedFiles(config, options?.fresh, options?.types)
  const register = stockDocumentsModule.buildRegister(typed, {
    keys: sheetPlates || new Set(),
    cells: sheetCells || new Map(),
  })
  return { ...register, files: typed }
}

export async function resolveFolderName(id: string) {
  try {
    const file = await getFile(id)
    return file.name
  } catch {
    return id
  }
}

export function formatTime(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export {
  documentBaseName,
  hasCanonicalAgreementName,
  hasCanonicalName,
  plateFromTypedName,
  suggestedName,
  uniqueSuggestedName,
} from '@/lib/document-names'

const LOGBOOK_RENAME_LIMIT = 40
const UNMATCHED_MARK_LIMIT = 40

/** Remove leftover Unmatched prefixes from Drive folder names. */
export async function clearUnmatchedFolderMarks(files: TypedFile[]) {
  const taken = new Set(files.map((file) => file.name))
  const renamed: TypedFile[] = []
  for (const file of files) {
    if (file.type === 'agreement' || !hasUnmatchedMark(file.name)) continue
    const stripped = stripUnmatchedMark(file.name)
    const plate = plateFromTypedName(stripped, file.type) || extractKenyanPlate(stripped)
    const name = plate ? uniqueSuggestedName(plate, file.type, stripped, taken) : stripped
    if (!name || name === file.name) continue
    try {
      const updated = await moveAndRename(file.id, { name })
      taken.delete(file.name)
      taken.add(name)
      renamed.push({ ...file, ...updated, name, plate, type: file.type })
    } catch {
      // Leave this file for the next scan if Drive rejects the name.
    }
    if (renamed.length >= UNMATCHED_MARK_LIMIT) break
  }
  return renamed
}

/** Rename logbooks that already have a plate to exactly `{plate} - Logbook`. */
export async function normalizeLogbookFilenames(files: TypedFile[]) {
  const taken = new Set(files.map((file) => file.name))
  const renamed: TypedFile[] = []
  for (const file of files) {
    if (file.type !== 'logbook' || hasCanonicalName(file)) continue
    const plate = plateFromTypedName(file.name, file.type) || extractKenyanPlate(file.name)
    if (!plate) continue
    const name = uniqueSuggestedName(plate, file.type, file.name, taken)
    if (name === file.name) continue
    try {
      const updated = await moveAndRename(file.id, { name })
      taken.delete(file.name)
      taken.add(name)
      renamed.push({ ...file, ...updated, name, plate, type: file.type })
    } catch {
      // Leave this file for the next scan if Drive rejects the name.
    }
    if (renamed.length >= LOGBOOK_RENAME_LIMIT) break
  }
  return renamed
}

