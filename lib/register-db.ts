import type { DocKind, Document, Vehicle } from '@prisma/client'
import { insuranceAlerts, insuranceState } from '@/lib/insurance'
import { compactPlate } from '@/lib/plates'
import { prisma } from '@/lib/prisma'
import type { DocType, TypedFile, VehicleRecord } from '@/lib/types'
import { fleetStats, slimVehicle, type VehicleQuery } from '@/lib/vehicles'

type VehicleWithDocs = Vehicle & { documents: Document[] }

const DOC_TYPES: DocType[] = ['logbook', 'certificate', 'photo', 'agreement']

export async function importVehiclesToDatabase(vehicles: VehicleRecord[]) {
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
        commencement: item.vehicle.insurance?.commencement || null,
        expiry: item.vehicle.insurance?.expiry || null,
        ...item.flags,
      },
      update: {
        brand: item.vehicle.brand || '',
        commencement: item.vehicle.insurance?.commencement || null,
        expiry: item.vehicle.insurance?.expiry || null,
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

  for (let index = 0; index < vehicleIds.length; index += 200) {
    await db.document.deleteMany({ where: { vehicleId: { in: vehicleIds.slice(index, index + 200) } } })
  }
  for (let index = 0; index < documentRows.length; index += 300) {
    await db.document.createMany({ data: documentRows.slice(index, index + 300) })
  }
  if (unique.length) {
    await db.vehicle.deleteMany({ where: { plate: { notIn: unique.map((item) => item.plate) } } })
  }
  return { imported: unique.length }
}

export async function loadRegisterFromDatabase(input: VehicleQuery = {}) {
  const db = prisma()
  const pageSize = Math.min(100, Math.max(10, input.pageSize || 25))
  const where = registerWhere(input)
  const [total, rows, all] = await Promise.all([
    db.vehicle.count({ where }),
    db.vehicle.findMany({
      where,
      include: { documents: true },
      orderBy: { plate: 'asc' },
      skip: (Math.max(1, input.page || 1) - 1) * pageSize,
      take: pageSize,
    }),
    db.vehicle.findMany({
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
    }),
  ])
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, input.page || 1), totalPages)
  const vehicles = rows.map(toVehicleRecord).map(slimVehicle)
  const statsSource: VehicleRecord[] = all.map((row) => ({
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
  }))
  const covers = Object.fromEntries(all.map((row) => [row.plate, { commencement: row.commencement, expiry: row.expiry }]))
  return {
    vehicles,
    total,
    page,
    pageSize,
    stats: fleetStats(statsSource),
    insuranceAlerts: insuranceAlerts(covers),
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
