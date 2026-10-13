import { cookies } from 'next/headers'
import {
  appendTextFile,
  findFileByName,
  findOwnedFileByName,
  getFile,
  listFolderFiles,
  readJsonFile,
  readTextFile,
  upsertJsonFile,
} from '@/lib/drive'
import { stockDocumentsModule } from '@/lib/modules/stock-documents'
import type { SheetCells } from '@/lib/modules/types'
import { compactPlate, isKenyanPlate, plateFromText } from '@/lib/plates'
import type { AuditEvent, DocType, FleetConfig, GmailState, TypedFile } from '@/lib/types'

export const CONFIG_NAME = 'fleetwise-config.json'
export const AUDIT_NAME = 'fleetwise-audit.jsonl'
export const GMAIL_STATE_NAME = 'fleetwise-gmail-state.json'
const CONFIG_COOKIE = 'fleetwise_folders'

export function folderIdForType(config: FleetConfig, type: DocType) {
  if (type === 'logbook') return config.logbooksId
  if (type === 'certificate') return config.certificatesId
  return config.photosId
}

export function folderNameForType(config: FleetConfig, type: DocType) {
  if (type === 'logbook') return config.logbooksName || 'Logbooks'
  if (type === 'certificate') return config.certificatesName || 'Certificates'
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
  if (!logbooksId || !certificatesId || !photosId) return null
  return {
    logbooksId,
    certificatesId,
    photosId,
    collateralId: process.env.DRIVE_FOLDER_COLLATERAL,
    spreadsheetId: process.env.DRIVE_SPREADSHEET_ID,
    autoUploadThreshold: Number(process.env.DRIVE_MATCH_THRESHOLD || 85),
  }
}

export async function saveConfig(input: FleetConfig) {
  const payload = {
    logbooksId: input.logbooksId,
    certificatesId: input.certificatesId,
    photosId: input.photosId,
    collateralId: input.collateralId,
    logbooksName: cleanFolderLabel(input.logbooksName),
    certificatesName: cleanFolderLabel(input.certificatesName),
    photosName: cleanFolderLabel(input.photosName),
    collateralName: cleanFolderLabel(input.collateralName),
    spreadsheetId: input.spreadsheetId,
    spreadsheetName: cleanFolderLabel(input.spreadsheetName),
    logbooksSheet: input.logbooksSheet,
    certificatesSheet: input.certificatesSheet,
    photosSheet: input.photosSheet,
    autoUploadThreshold: input.autoUploadThreshold ?? 85,
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
    collateralId: config.collateralId,
    logbooksName: config.logbooksName,
    certificatesName: config.certificatesName,
    photosName: config.photosName,
    collateralName: config.collateralName,
    spreadsheetId: config.spreadsheetId,
    spreadsheetName: config.spreadsheetName,
    autoUploadThreshold: config.autoUploadThreshold ?? 85,
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

async function listTypedFiles(config: FleetConfig): Promise<TypedFile[]> {
  const [logbooks, certificates, photos] = await Promise.all([
    listFolderFiles(config.logbooksId),
    listFolderFiles(config.certificatesId),
    listFolderFiles(config.photosId),
  ])
  return [
    ...logbooks.map((file) => ({ ...file, type: 'logbook' as const, plate: plateFromTypedName(file.name, 'logbook') || plateFromText(file.name) })),
    ...certificates.map((file) => ({ ...file, type: 'certificate' as const, plate: plateFromTypedName(file.name, 'certificate') || plateFromText(file.name) })),
    ...photos.map((file) => ({ ...file, type: 'photo' as const, plate: plateFromTypedName(file.name, 'photo') || plateFromText(file.name) })),
  ]
}

export async function scanFolders(config: FleetConfig, sheetPlates?: Set<string>, sheetCells?: SheetCells, listed?: TypedFile[]) {
  const typed = listed || await listTypedFiles(config)
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

export function suggestedName(plate: string, type: DocType, _original: string) {
  const registration = compactPlate(plateFromText(plate) || plate)
  if (type === 'photo') return `Photos ${registration}`
  if (type === 'certificate') return `Insurance - ${registration}`
  return `${registration} - Logbook`
}

export function documentBaseName(name: string) {
  return name.replace(/\.(pdf|jpe?g|png|webp|gif|heic)$/i, '').trim()
}

/** Plate from Insurance -KMHC335S, Insurance-KMHC335S, Photos KMHC335S, KMHC335S - Logbook. */
export function plateFromTypedName(name: string, type: DocType) {
  const base = documentBaseName(name)
  const body = type === 'certificate'
    ? base.match(/^insurance\s*-?\s*(.+)$/i)?.[1]
    : type === 'photo'
      ? base.match(/^photos\s+(.+)$/i)?.[1]
      : base.match(/^(.+?)\s*-?\s*logbook$/i)?.[1]
  if (!body) return null
  const plate = compactPlate(body)
  return isKenyanPlate(plate) ? plate : null
}

export function hasCanonicalName(file: { name: string; type: DocType }) {
  const plate = plateFromTypedName(file.name, file.type)
  if (!plate) return false
  const expected = suggestedName(plate, file.type, file.name)
  return file.name === expected || documentBaseName(file.name) === expected
}

