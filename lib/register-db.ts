import type { DocKind, Document, Vehicle } from '@prisma/client'
import { insuranceAlerts, insuranceState, type InsuranceCover } from '@/lib/insurance'
import { compactPlate } from '@/lib/plates'
import { databaseConfigured, clearDatabaseStatusCache, prisma } from '@/lib/prisma'
import type { DocType, TypedFile, VehicleRecord } from '@/lib/types'
import { attachInsurance, fleetStats, slimVehicle, type VehicleQuery } from '@/lib/vehicles'

type VehicleWithDocs = Vehicle & { documents: Document[] }

const DOC_TYPES: DocType[] = ['logbook', 'certificate', 'photo', 'agreement']

const registerStatsStore = globalThis as typeof globalThis & {
  __fleetwiseRegisterStats?: {
    at: number
    stats: ReturnType<typeof fleetStats>
    insuranceAlerts: ReturnType<typeof insuranceAlerts>
  }
}

const sheetSyncStore = globalThis as typeof globalThis & {
  __fleetwiseSheetSync?: { spreadsheetId: string; modifiedTime: string }
}

export function knownSheetRevision(spreadsheetId: string) {
  const cursor = sheetSyncStore.__fleetwiseSheetSync
  return cursor?.spreadsheetId === spreadsheetId ? cursor.modifiedTime : ''
}

export function noteSheetRevision(spreadsheetId: string, modifiedTime: string) {
  if (!spreadsheetId || !modifiedTime) return
  sheetSyncStore.__fleetwiseSheetSync = { spreadsheetId, modifiedTime }
}

const SHEET_SYNC_NAME = 'fleetwise-register-sync.json'

export async function storedSheetRevision(spreadsheetId: string) {
  const memory = knownSheetRevision(spreadsheetId)
  if (memory) return memory
  try {
    const { findFileByName, readJsonFile } = await import('@/lib/drive')
    const file = await findFileByName(SHEET_SYNC_NAME)
    if (!file) return ''
    const data = await readJsonFile<{ spreadsheetId?: string; modifiedTime?: string }>(file.id)
    const modifiedTime = data?.spreadsheetId === spreadsheetId ? data.modifiedTime || '' : ''
    if (modifiedTime) noteSheetRevision(spreadsheetId, modifiedTime)
    return modifiedTime
  } catch {
    return ''
  }
}

export async function rememberSheetRevision(spreadsheetId: string, modifiedTime: string) {
  noteSheetRevision(spreadsheetId, modifiedTime)
  try {
    const { findFileByName, upsertJsonFile } = await import('@/lib/drive')
    const existing = await findFileByName(SHEET_SYNC_NAME)
    await upsertJsonFile('root', SHEET_SYNC_NAME, { spreadsheetId, modifiedTime }, existing?.id)
  } catch {
    // This process still has the revision, so the next page does not copy the sheet again.
  }
}

let registerWrite: Promise<void> = Promise.resolve()

function enqueueRegisterWrite<T>(work: () => Promise<T>) {
  const run = registerWrite.then(work, work)
  registerWrite = run.then(() => undefined, () => undefined)
  return run
}

export function importVehiclesToDatabase(vehicles: VehicleRecord[]) {
  return enqueueRegisterWrite(() => importVehiclesNow(vehicles))
}

async function importVehiclesNow(vehicles: VehicleRecord[]) {
  registerStatsStore.__fleetwiseRegisterStats = undefined
  clearDatabaseStatusCache()
  const db = prisma()
  const unique: { plate: string; vehicle: VehicleRecord; docs: ReturnType<typeof documentsFromVehicle>; flags: ReturnType<typeof coverageFlags> }[] = []
  const seen = new Set<string>()
  for (const vehicle of vehicles) {
    const plate = compactPlate(vehicle.plate)
    if (!plate || seen.has(plate)) continue
    seen.add(plate)
    const docs = documentsFromVehicle(vehicle)
    unique.push({ plate, vehicle, docs, flags: coverageFlags(docs) })
  }

  const vehicleIds: string[] = []
  const documentRows: { vehicleId: string; type: DocKind; driveFileId: string; name: string; webViewLink?: string }[] = []
  for (let index = 0; index < unique.length; index += 20) {
    const batch = unique.slice(index, index + 20)
    const rows = await Promise.all(batch.map((item) => db.vehicle.upsert({
      where: { plate: item.plate },
      create: {
        plate: item.plate,
        brand: item.vehicle.brand || '',
        ...coverDates(item.vehicle, true),
        ...item.flags,
      },
      update: {
        brand: item.vehicle.brand || '',
        ...coverDates(item.vehicle, false),
        ...item.flags,
      },
    })))
    rows.forEach((row, offset) => {
      vehicleIds.push(row.id)
      for (const doc of batch[offset].docs) {
        documentRows.push({ ...doc, vehicleId: row.id })
      }
    })
  }

  const documents = dedupeDocuments(documentRows)
  for (let index = 0; index < vehicleIds.length; index += 200) {
    await db.document.deleteMany({ where: { vehicleId: { in: vehicleIds.slice(index, index + 200) } } })
  }
  for (let index = 0; index < documents.length; index += 300) {
    await db.document.createMany({ data: documents.slice(index, index + 300) })
  }
  if (unique.length) {
    await db.vehicle.deleteMany({ where: { plate: { notIn: unique.map((item) => item.plate) } } })
  }
  return { imported: unique.length }
}

/** Update the plates whose sheet chips just changed. Other plates stay as they are. */
export function rememberRegisterLinks(vehicles: VehicleRecord[]) {
  return enqueueRegisterWrite(() => rememberRegisterLinksNow(vehicles))
}

async function rememberRegisterLinksNow(vehicles: VehicleRecord[]) {
  if (!databaseConfigured() || !vehicles.length) return { updated: 0 }
  registerStatsStore.__fleetwiseRegisterStats = undefined
  const db = prisma()
  const unique: { plate: string; vehicle: VehicleRecord; docs: ReturnType<typeof documentsFromVehicle>; flags: ReturnType<typeof coverageFlags> }[] = []
  const seen = new Set<string>()
  for (const vehicle of vehicles) {
    const plate = compactPlate(vehicle.plate)
    if (!plate || seen.has(plate)) continue
    seen.add(plate)
    const docs = documentsFromVehicle(vehicle)
    unique.push({ plate, vehicle, docs, flags: coverageFlags(docs) })
  }
  const vehicleIds: string[] = []
  const documentRows: { vehicleId: string; type: DocKind; driveFileId: string; name: string; webViewLink?: string }[] = []
  for (let index = 0; index < unique.length; index += 20) {
    const batch = unique.slice(index, index + 20)
    const rows = await Promise.all(batch.map((item) => db.vehicle.upsert({
      where: { plate: item.plate },
      create: {
        plate: item.plate,
        brand: item.vehicle.brand || '',
        ...coverDates(item.vehicle, true),
        ...item.flags,
      },
      update: {
        brand: item.vehicle.brand || '',
        ...coverDates(item.vehicle, false),
        ...item.flags,
      },
    })))
    rows.forEach((row, offset) => {
      vehicleIds.push(row.id)
      for (const doc of batch[offset].docs) documentRows.push({ ...doc, vehicleId: row.id })
    })
  }
  const documents = dedupeDocuments(documentRows)
  if (vehicleIds.length) {
    await db.document.deleteMany({ where: { vehicleId: { in: vehicleIds } } })
  }
  if (documents.length) await db.document.createMany({ data: documents })
  return { updated: unique.length }
}

function dedupeDocuments<T extends { vehicleId: string; type: DocKind }>(rows: T[]) {
  const byKey = new Map<string, T>()
  for (const row of rows) byKey.set(`${row.vehicleId}:${row.type}`, row)
  return [...byKey.values()]
}

/** Write commencement and expiry onto existing vehicle rows. Sheet cells are updated by writeCoverDates. */
export async function saveCoverDates(covers: Record<string, InsuranceCover>) {
  if (!databaseConfigured()) return { updated: 0 }
  const entries = Object.entries(covers).flatMap(([plate, cover]) => {
    const key = compactPlate(plate)
    if (!key || (!cover?.commencement && !cover?.expiry)) return []
    return [[key, cover] as const]
  })
  if (!entries.length) return { updated: 0 }
  const db = prisma()
  let updated = 0
  for (let index = 0; index < entries.length; index += 20) {
    const batch = entries.slice(index, index + 20)
    const results = await Promise.all(batch.map(([plate, cover]) => db.vehicle.updateMany({
      where: { plate },
      data: {
        ...(cover.commencement ? { commencement: cover.commencement } : {}),
        ...(cover.expiry ? { expiry: cover.expiry } : {}),
      },
    })))
    updated += results.reduce((sum, result) => sum + result.count, 0)
  }
  return { updated }
}

export async function loadRegisterFromDatabase(input: VehicleQuery = {}, covers: Record<string, InsuranceCover> = {}) {
  const db = prisma()
  const pageSize = Math.min(100, Math.max(10, input.pageSize || 25))
  const where = registerWhere(input)
  const requested = Math.max(1, input.page || 1)
  const [total, rows] = await Promise.all([
    db.vehicle.count({ where }),
    db.vehicle.findMany({
      where,
      include: { documents: true },
      orderBy: { plate: 'asc' },
      skip: (requested - 1) * pageSize,
      take: pageSize,
    }),
  ])
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(requested, totalPages)
  const vehicles = attachInsurance(rows.map(toVehicleRecord), covers).map(slimVehicle)
  let cached = registerStatsStore.__fleetwiseRegisterStats
  if (!cached || Date.now() - cached.at > 20_000) {
    const all = await db.vehicle.findMany({
      select: {
        plate: true,
        brand: true,
        hasLogbook: true,
        hasAgreement: true,
        hasCertificate: true,
        hasPhoto: true,
        hasCollateral: true,
        present: true,
        status: true,
        commencement: true,
        expiry: true,
      },
    })
    const statsSource = attachInsurance(all.map((row) => ({
      plate: row.plate,
      brand: row.brand,
      files: {
        logbook: row.hasLogbook ? [{ id: 'flag', name: '', type: 'logbook' as const, plate: row.plate }] : [],
        certificate: row.hasCertificate ? [{ id: 'flag', name: '', type: 'certificate' as const, plate: row.plate }] : [],
        photo: row.hasPhoto ? [{ id: 'flag', name: '', type: 'photo' as const, plate: row.plate }] : [],
        agreement: row.hasAgreement ? [{ id: 'flag', name: '', type: 'agreement' as const, plate: row.plate }] : [],
      },
      collateral: row.hasCollateral ? { id: 'flag', name: '' } : undefined,
      agreement: row.hasAgreement ? { id: 'flag', name: '' } : undefined,
      present: row.present,
      total: 5 as const,
      status: row.status === 'Complete' ? 'Complete' as const : 'Needs attention' as const,
      updated: '',
      insurance: insuranceState({ commencement: row.commencement, expiry: row.expiry }),
    })), covers)
    const merged = Object.fromEntries(statsSource.map((vehicle) => [vehicle.plate, {
      commencement: vehicle.insurance?.commencement || null,
      expiry: vehicle.insurance?.expiry || null,
    }]))
    cached = { at: Date.now(), stats: fleetStats(statsSource), insuranceAlerts: insuranceAlerts(merged) }
    registerStatsStore.__fleetwiseRegisterStats = cached
  }
  return {
    vehicles,
    total,
    page,
    pageSize,
    stats: cached.stats,
    insuranceAlerts: cached.insuranceAlerts,
  }
}

export async function loadExportedRegister(input: VehicleQuery = {}) {
  const rows = await prisma().vehicle.findMany({
    where: registerWhere(input),
    include: { documents: true },
    orderBy: { plate: 'asc' },
  })
  return rows.map(toVehicleRecord)
}

function registerWhere(input: VehicleQuery) {
  const needle = (input.query || '').trim()
  const missing = input.missing || []
  return {
    ...(needle
      ? {
          OR: [
            { plate: { contains: compactPlate(needle) || needle, mode: 'insensitive' as const } },
            { brand: { contains: needle, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(input.status && input.status !== 'all' ? { status: input.status } : {}),
    ...(input.brand && input.brand !== 'all'
      ? input.brand === '__none'
        ? { brand: '' }
        : { brand: { equals: input.brand, mode: 'insensitive' as const } }
      : {}),
    ...(missing.includes('logbook') ? { hasLogbook: false } : {}),
    ...(missing.includes('agreement') ? { hasAgreement: false } : {}),
    ...(missing.includes('certificate') ? { hasCertificate: false } : {}),
    ...(missing.includes('photo') ? { hasPhoto: false } : {}),
    ...(missing.includes('collateral') ? { hasCollateral: false } : {}),
  }
}

function coverDates(vehicle: VehicleRecord, creating: boolean) {
  const commencement = vehicle.insurance?.commencement || ''
  const expiry = vehicle.insurance?.expiry || ''
  if (creating) return { commencement: commencement || null, expiry: expiry || null }
  return {
    ...(commencement ? { commencement } : {}),
    ...(expiry ? { expiry } : {}),
  }
}

function documentsFromVehicle(vehicle: VehicleRecord) {
  const docs: { type: DocKind; driveFileId: string; name: string; webViewLink?: string }[] = []
  for (const type of DOC_TYPES) {
    const file = vehicle.files[type]?.[0]
    if (file?.id && file.webViewLink) docs.push(chipDoc(type, file))
  }
  if (vehicle.agreement && !docs.some((doc) => doc.type === 'agreement')) {
    docs.push(chipDoc('agreement', vehicle.agreement))
  }
  if (vehicle.collateral) docs.push(chipDoc('collateral', vehicle.collateral))
  return docs
}

function chipDoc(type: DocKind, file: { id: string; name: string; webViewLink?: string }) {
  return {
    type,
    driveFileId: file.id,
    name: file.name,
    webViewLink: file.webViewLink,
  }
}

function coverageFlags(docs: { type: DocKind }[]) {
  const has = (type: DocKind) => docs.some((doc) => doc.type === type)
  const hasLogbook = has('logbook')
  const hasAgreement = has('agreement')
  const hasCertificate = has('certificate')
  const hasPhoto = has('photo')
  const hasCollateral = has('collateral')
  const present = [hasLogbook, hasAgreement, hasCertificate, hasPhoto, hasCollateral].filter(Boolean).length
  return {
    hasLogbook,
    hasAgreement,
    hasCertificate,
    hasPhoto,
    hasCollateral,
    present,
    status: present === 5 ? 'Complete' : 'Needs attention',
  }
}

function toVehicleRecord(row: VehicleWithDocs): VehicleRecord {
  const files = { logbook: [] as TypedFile[], certificate: [] as TypedFile[], photo: [] as TypedFile[], agreement: [] as TypedFile[] }
  let collateral: VehicleRecord['collateral']
  for (const doc of row.documents) {
    if (doc.type === 'collateral') {
      collateral = { id: doc.driveFileId, name: doc.name, webViewLink: doc.webViewLink || undefined }
      continue
    }
    files[doc.type].push({
      id: doc.driveFileId,
      name: doc.name,
      type: doc.type,
      plate: row.plate,
      webViewLink: doc.webViewLink || undefined,
    })
  }
  const agreementFile = files.agreement[0]
  return {
    plate: row.plate,
    brand: row.brand,
    files,
    collateral,
    agreement: agreementFile
      ? { id: agreementFile.id, name: agreementFile.name, webViewLink: agreementFile.webViewLink }
      : undefined,
    insurance: insuranceState({ commencement: row.commencement, expiry: row.expiry }),
    present: row.present,
    total: 5,
    status: row.status === 'Complete' ? 'Complete' : 'Needs attention',
    updated: row.updatedAt.toISOString(),
  }
}
