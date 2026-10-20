'use server'

import { appendAudit, clearUnmatchedFolderMarks, folderIdForType, folderNameForType, formatTime, hasCanonicalName, loadAudit, loadConfig, loadGmailState, loadInsuranceCovers, plateFromTypedName, resolveFolderName, saveConfig, saveGmailState, saveInsuranceCover, saveInsuranceCovers, scanFolders, suggestedName, uniqueSuggestedName } from '@/lib/fleet'
import { parseInsuranceCover, type InsuranceCover } from '@/lib/insurance'
import { getAttachment, findAttachments, getMessage, listRecentMessages, messageMeta } from '@/lib/gmail'
import { downloadBinary, downloadNamedFile, findFleetAssetsWorkbook, listFolders, listSharedDrives, listSpreadsheets as listSpreadsheetFiles, moveAndRename, searchFolders, uploadBinary } from '@/lib/drive'
import { coverFromCertificate, isOcrImage, ocrConfigured, plateFromImage, resolvePlateFromFile } from '@/lib/ocr'
import { cleanInboxEmail, isInboxEmail, mailboxSearchQuery } from '@/lib/mailboxes'
import { warmPlateReader } from '@/lib/read-plate-runner'
import { SHEET_MODULES, stockDocumentsModule, syncSheetModules } from '@/lib/modules'
import { driveIdFromUri, linkUnlinkedDocuments, readStockRegisterSnapshot } from '@/lib/modules/stock-documents'
import { surplusCopies } from '@/lib/unmatched-files'
import type { SheetCells, SheetSyncMode } from '@/lib/modules/types'
import { compactPlate, extractKenyanPlate, listRegistrationNumbers, parseKenyanPlate, parsePhotoPlate, pickOcrPlate, plateFromCertificateText, plateFromLogbookText, plateFromText, printedRegistrationPlate } from '@/lib/plates'
import { attachLastAction, beginProcessJob, endProcessJob, fileMatchesFocus, getProcessJob, isProcessCancelled, isProcessRunning, isRepairFocus, isStaleProcess, markProcessMatches, processFocusLabel, processGeneration, requestProcessStop, touchProcessItem, type ProcessFocus } from '@/lib/processing'
import { confirmedPlate, forgetFile, hydrateProcessCursor, isCursorHydrated, lastAction, markConfirmed, markTried, persistProcessCursor, recordLastAction, wasTriedRecently, canResumeProcessQueue, processQueueItems, replaceProcessQueue, takeProcessQueueItem, type ProcessQueueItem } from '@/lib/process-cursor'
import { requireSession } from '@/lib/session'
import { databaseConfigured, databaseStatus } from '@/lib/prisma'
import { importVehiclesToDatabase, loadExportedRegister, loadRegisterFromDatabase, saveCoverDates } from '@/lib/register-db'
import { attachInsurance, EMPTY_STATS, filterVehicles, fleetStats, insuranceAlertsFor, slimVehicle, type VehicleQuery } from '@/lib/vehicles'
import type { DocType, FleetConfig, FleetSnapshot, InboxItem, TypedFile, VehicleRecord } from '@/lib/types'

let rememberedPlates: string[] = []

const ON_VERCEL = Boolean(process.env.VERCEL)
const OCR_BATCH = ON_VERCEL ? 1 : 10
const OCR_CONCURRENCY = ON_VERCEL ? 1 : 5

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const generation = processGeneration()
  let next = 0
  async function worker() {
    while (true) {
      if (isStaleProcess(generation) || isProcessCancelled()) return
      const index = next++
      if (index >= items.length) return
      await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, () => worker()))
}

function namedPlateOf(file: { name: string; type: DocType }) {
  const typed = plateFromTypedName(file.name, file.type)
  if (typed) return typed
  if (file.type === 'photo') return parsePhotoPlate(file.name) || parsePhotoPlate(extractKenyanPlate(file.name) || '')
  if (file.type === 'logbook' || file.type === 'agreement') return extractKenyanPlate(file.name)
  return plateFromText(file.name)
}

function isPlatePdf(type: DocType) {
  return type === 'certificate' || type === 'logbook' || type === 'agreement'
}

function nameMatchesDocument(file: { id: string; name: string; type: DocType }) {
  const named = namedPlateOf(file)
  const hit = confirmedPlate(file.id)
  if (!named || !hit) return false
  return hit === compactPlate(named)
}

function emptySnapshot(session: { name: string; email: string; image?: string }, config: FleetConfig | null, extra: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    user: { name: session.name, email: session.email, image: session.image },
    config,
    vehicles: [],
    unmatched: [],
    duplicates: [],
    insuranceAlerts: [],
    inbox: [],
    audit: [],
    stats: EMPTY_STATS,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config?.spreadsheetId),
    databaseConnected: false,
    databaseVehicles: 0,
    ...extra,
  }
}

function statsFor(vehicles: VehicleRecord[]) {
  const stats = fleetStats(vehicles, rememberedPlates)
  rememberedPlates = vehicles.map((vehicle) => vehicle.plate)
  return stats
}

export async function loadWorkspace(): Promise<FleetSnapshot> {
  const session = await requireSession()
  const config = await loadConfig()
  const database = await databaseStatus().catch(() => ({ configured: false, connected: false, vehicles: 0 }))
  return emptySnapshot(session, config, {
    sheetsConnected: Boolean(config?.spreadsheetId),
    databaseConnected: database.connected,
    databaseVehicles: database.vehicles,
  })
}

export async function syncRegisterToDatabase() {
  const session = await requireSession()
  const config = await requireConfig()
  if (!databaseConfigured()) {
    throw new Error('Add DATABASE_URL from Neon to .env, run npx prisma db push, then restart npm run dev.')
  }
  if (!config.spreadsheetId) throw new Error('Pick Fleet Assets - KE in Settings first. STOCK DOCUMENTS is a tab on that workbook.')
  const sheet = await readStockRegisterSnapshot(config, { fresh: true })
  if (sheet.error) throw new Error(sheet.error)
  const covers = await loadInsuranceCovers(config).catch(() => ({} as Record<string, InsuranceCover>))
  const vehicles = attachInsurance(sheet.vehicles, covers)
  const result = await importVehiclesToDatabase(vehicles)
  const database = await databaseStatus()
  return emptySnapshot(session, config, {
    lastSync: new Date().toISOString(),
    sheetsConnected: true,
    databaseConnected: database.connected,
    databaseVehicles: database.vehicles,
    ingest: {
      watching: 'Neon',
      attempted: vehicles.length,
      renamed: result.imported,
      notice: `Imported ${result.imported} rows from the STOCK DOCUMENTS tab on ${config.spreadsheetName || 'Fleet Assets - KE'} into Neon.`,
    },
  })
}

export async function loadVehiclePage(input: VehicleQuery = {}) {
  await requireSession()
  const config = await loadConfig()
  if (databaseConfigured()) {
    const database = await databaseStatus().catch(() => ({ connected: false, vehicles: 0 }))
    if (database.connected && database.vehicles > 0) {
      try {
        const covers = config ? await loadInsuranceCovers(config).catch(() => ({} as Record<string, InsuranceCover>)) : {}
        if (Object.keys(covers).length) await saveCoverDates(covers).catch(() => {})
        const fromDb = await loadRegisterFromDatabase(input, covers)
        return { ...fromDb, error: undefined as string | undefined }
      } catch (err) {
        return {
          vehicles: [] as VehicleRecord[],
          total: 0,
          page: 1,
          pageSize: input.pageSize || 25,
          stats: EMPTY_STATS,
          insuranceAlerts: [] as FleetSnapshot['insuranceAlerts'],
          error: err instanceof Error ? err.message : 'Unable to read the Neon register',
        }
      }
    }
  }
  if (!config?.spreadsheetId) {
    return { vehicles: [] as VehicleRecord[], total: 0, page: 1, pageSize: input.pageSize || 25, stats: EMPTY_STATS, insuranceAlerts: [] as FleetSnapshot['insuranceAlerts'], error: undefined as string | undefined }
  }
  const sheet = await readStockRegisterSnapshot(config)
  let covers = await loadInsuranceCovers(config).catch(() => ({} as Record<string, InsuranceCover>))
  const filtered = filterVehicles(attachInsurance(sheet.vehicles, covers), input)
  const pageSize = Math.min(100, Math.max(10, input.pageSize || 25))
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, input.page || 1), totalPages)
  const start = (page - 1) * pageSize
  const pageVehicles = filtered.slice(start, start + pageSize)
  covers = await fillMissingCertificateCovers(config, pageVehicles, covers)
  const withCover = attachInsurance(sheet.vehicles, covers)
  return {
    vehicles: attachInsurance(pageVehicles, covers).map(slimVehicle),
    total: filtered.length,
    page,
    pageSize,
    stats: statsFor(withCover),
    insuranceAlerts: insuranceAlertsFor(covers),
    error: sheet.error,
  }
}

export async function exportVehicleRegister(input: VehicleQuery = {}) {
  await requireSession()
  const config = await loadConfig()
  const fromDb = databaseConfigured() ? await databaseStatus().catch(() => ({ connected: false, vehicles: 0 })) : { connected: false, vehicles: 0 }
  const vehicles = fromDb.connected && fromDb.vehicles
    ? await loadExportedRegister(input)
    : config?.spreadsheetId ? filterVehicles(attachInsurance((await readStockRegisterSnapshot(config)).vehicles, await loadInsuranceCovers(config).catch(() => ({}))), input) : []
  const rows = [['Plate', 'Brand', 'Logbook', 'Agreement', 'Certificate', 'Photo', 'Collateral', 'Commencement', 'Expiry', 'Status', 'Updated'], ...vehicles.map((vehicle) => [
    vehicle.plate,
    vehicle.brand || '',
    vehicle.files.logbook.length ? 'yes' : 'no',
    vehicle.agreement ? 'yes' : 'no',
    vehicle.files.certificate.length ? 'yes' : 'no',
    vehicle.files.photo.length ? 'yes' : 'no',
    vehicle.collateral ? 'yes' : 'no',
    vehicle.insurance?.commencement || '',
    vehicle.insurance?.expiry || '',
    vehicle.status,
    vehicle.updated,
  ])]
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export async function loadFleet(mode: 'auto' | 'full' = 'auto', closeLive = false, focus?: ProcessFocus | 'off'): Promise<FleetSnapshot> {
  const session = await requireSession()
  let config = await loadConfig()
  if (!config) {
    return emptySnapshot(session, null)
  }
  if (!config.spreadsheetId) {
    const workbook = await findFleetAssetsWorkbook()
    if (workbook) {
      config = await saveConfig({ ...config, spreadsheetId: workbook.id, spreadsheetName: workbook.name })
    }
  }
  await hydrateProcessCursor(config).catch(() => lastAction())
  attachLastAction(lastAction())
  const live = getProcessJob()
  const requested = focus && focus !== 'off' ? focus : undefined
  const jobFocus: ProcessFocus | undefined = requested || (!live.cancelled && (live.running || live.advancing) ? live.focus : undefined)
  const skipOcr = focus === 'off' || (!requested && (isProcessCancelled() || live.cancelled || !jobFocus))
  const watchPass = focus === 'off'
  const skipExtras = watchPass && mode === 'auto'
  const freshRead = mode === 'full' || (!ON_VERCEL && !skipOcr)
  const resumeQueue = ON_VERCEL && !skipOcr && canResumeProcessQueue(jobFocus || 'all')
  const emptyPreview = { vehicles: [] as VehicleRecord[], unmatched: [] as TypedFile[], duplicates: [] as FleetSnapshot['duplicates'], plates: new Set<string>(), cells: new Map() as SheetCells, error: undefined as string | undefined }
  const [preview, folderScan] = await Promise.all([
    config.spreadsheetId ? readStockRegisterSnapshot(config, { fresh: freshRead }) : Promise.resolve(emptyPreview),
    resumeQueue ? Promise.resolve(null) : scanFolders(config, new Set<string>(), new Map() as SheetCells, undefined, { fresh: freshRead }),
  ])
  let ingest = { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined as string | undefined, renamedFiles: [] as TypedFile[], started: false, focus: jobFocus, notice: undefined as string | undefined }
  let files: TypedFile[] = []
  const warming = !skipOcr ? warmPlateReader().catch(() => {}) : Promise.resolve()
  try {
    if (resumeQueue) {
      await warming
      ingest = await ingestQueued(config, session.name, jobFocus || 'all', preview.plates)
      files = [...processQueueItems().map(queueItemToFile), ...ingest.renamedFiles]
    } else {
      const listed = await scanFolders(config, preview.plates, preview.cells, folderScan?.files)
      await warming
      ingest = skipOcr
        ? { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined, renamedFiles: [] as TypedFile[], started: false, focus: undefined }
        : await ingestIncoming(config, session.name, mode, listed.files, preview.plates, jobFocus || 'all', preview.cells)
      files = mergeTypedFiles(listed.files, ingest.renamedFiles)
      if (!skipOcr && !ON_VERCEL && !isProcessRunning()) {
        const cleared = await clearUnmatchedFolderMarks(files)
        if (cleared.length) files = mergeTypedFiles(files, cleared)
      }
    }
  } catch (err) {
    ingest = { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: err instanceof Error ? err.message : 'Drive scan failed', renamedFiles: [], started: ingest.started, focus: jobFocus }
    const ingestGen = processGeneration()
    if (ingest.started && isProcessRunning() && !isStaleProcess(ingestGen)) endProcessJob(ingest.error, { remaining: ingest.remaining || 0, renamed: ingest.renamed })
  }
  const ingestGen = processGeneration()
  const continuing = Boolean(ingest.more)
  const deferSheet = skipOcr || (ON_VERCEL && !skipOcr && (ingest.started || Boolean(ingest.more)))
  let sheet = deferSheet || !files.length
    ? { plates: preview.plates, error: preview.error, missing: [] as string[], matched: [] as string[], hint: '', cells: preview.cells, more: false }
    : await syncSheetIndex(config, continuing ? 'match' : mode, files)
  for (let round = 0; !deferSheet && sheet.more && !sheet.error && round < 5; round += 1) {
    const next = await syncSheetIndex(config, continuing ? 'match' : mode, files)
    sheet = { ...next, matched: [...new Set([...(sheet.matched || []), ...(next.matched || [])])] }
  }
  const linkCells = sheet.cells?.size ? sheet.cells : preview.cells
  if (getProcessJob().items.length && linkCells?.size) {
    markProcessMatches(sheet.matched, sheet.missing, sheet.plates || preview.plates, linkedSheetFileIds(linkCells))
  }
  if ((ingest.started || closeLive) && isProcessRunning() && !isStaleProcess(ingestGen)) {
    endProcessJob(ingest.error || sheet.error, { remaining: ingest.remaining || 0, renamed: ingest.renamed })
  }
  const emptyGmail = { state: { processedIds: [] as string[], items: [] as InboxItem[] } }
  const plates = sheet.plates?.size ? sheet.plates : preview.plates
  const cells = sheet.cells?.size ? sheet.cells : preview.cells
  const [{ vehicles, unmatched, duplicates }, audit, gmail] = await Promise.all([
    scanFolders(config, plates, cells, files),
    skipExtras || continuing ? Promise.resolve([] as FleetSnapshot['audit']) : loadAudit().catch(() => [] as FleetSnapshot['audit']),
    skipExtras || continuing ? Promise.resolve(emptyGmail) : loadGmailState().catch(() => emptyGmail),
  ])
  const covers = await loadInsuranceCovers(config).catch(() => ({} as Awaited<ReturnType<typeof loadInsuranceCovers>>))
  const registerVehicles = attachInsurance(vehicles.length ? vehicles : preview.vehicles, covers)
  if (!skipOcr && Object.keys(covers).length) await saveCoverDates(covers).catch(() => {})
  const database = await databaseStatus().catch(() => ({ configured: false, connected: false, vehicles: 0 }))
  return {
    user: { name: session.name, email: session.email, image: session.image },
    config,
    vehicles: [],
    unmatched,
    duplicates,
    insuranceAlerts: insuranceAlertsFor(covers),
    inbox: gmail.state.items,
    audit,
    stats: statsFor(registerVehicles),
    lastSync: config.lastSync || gmail.state.lastSync,
    gmailConnected: Boolean(gmail.state.lastSync),
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config.spreadsheetId) && !sheet.error && !preview.error,
    databaseConnected: database.connected,
    databaseVehicles: database.vehicles,
    sheetsError: sheet.error || preview.error,
    ingest: {
      ...ingest,
      more: Boolean(!isProcessCancelled() && ingest.more),
      remaining: ingest.remaining || lastAction().remaining || 0,
      focus: ingest.focus || jobFocus,
      lastAction: lastAction(),
      notice: ingest.notice || sheetMatchNotice(sheet.matched, ingest.renamedFiles),
      error: ingest.error || (sheet.missing.length
        ? `These files were renamed in Drive, but STOCK DOCUMENTS has no Registration Number for ${listRegistrationNumbers(sheet.missing)}. Add that plate on the sheet, then scan again.`
        : undefined),
    },
  }
}

export async function listSpreadsheets() {
  await requireSession()
  return listSpreadsheetFiles()
}

export async function listDriveFolders(parentId?: string, query?: string) {
  await requireSession()
  if (query?.trim()) return searchFolders(query)
  if (!parentId) {
    const root = await listFolders()
    try {
      const shared = await listSharedDrives()
      return [...shared.map((item) => ({ ...item, name: `${item.name} (Shared drive)` })), ...root]
    } catch {
      return root
    }
  }
  return listFolders(parentId)
}

export async function saveFolderConfig(input: {
  logbooksId: string
  certificatesId: string
  photosId: string
  agreementsId?: string
  collateralId?: string
  spreadsheetId?: string
  autoUploadThreshold: number
  insuranceInboxEmail?: string
  logbooksInboxEmail?: string
}) {
  const session = await requireSession()
  const previous = await loadConfig()
  const collateralId = input.collateralId || previous?.collateralId
  const agreementsId = input.agreementsId || previous?.agreementsId
  const names = await Promise.allSettled([
    resolveFolderName(input.logbooksId),
    resolveFolderName(input.certificatesId),
    resolveFolderName(input.photosId),
    collateralId ? resolveFolderName(collateralId) : Promise.resolve(''),
    input.spreadsheetId ? resolveFolderName(input.spreadsheetId) : Promise.resolve(''),
    agreementsId ? resolveFolderName(agreementsId) : Promise.resolve(''),
  ])
  const settled = (index: number, fallback: string) => names[index].status === 'fulfilled' ? names[index].value : fallback
  const logbooksName = settled(0, previous?.logbooksName || input.logbooksId)
  const certificatesName = settled(1, previous?.certificatesName || input.certificatesId)
  const photosName = settled(2, previous?.photosName || input.photosId)
  const collateralName = settled(3, previous?.collateralName || '')
  const spreadsheetName = settled(4, previous?.spreadsheetName || '')
  const agreementsName = settled(5, previous?.agreementsName || '')
  const config = await saveConfig({
    ...(previous || { logbooksId: input.logbooksId, certificatesId: input.certificatesId, photosId: input.photosId, autoUploadThreshold: input.autoUploadThreshold }),
    ...input,
    logbooksId: input.logbooksId,
    certificatesId: input.certificatesId,
    photosId: input.photosId,
    agreementsId,
    logbooksName,
    certificatesName,
    photosName,
    agreementsName: agreementsName || undefined,
    collateralId,
    collateralName: collateralName || undefined,
    spreadsheetId: input.spreadsheetId || undefined,
    spreadsheetName: spreadsheetName || undefined,
    insuranceInboxEmail: isInboxEmail(input.insuranceInboxEmail) ? cleanInboxEmail(input.insuranceInboxEmail) : '',
    logbooksInboxEmail: isInboxEmail(input.logbooksInboxEmail) ? cleanInboxEmail(input.logbooksInboxEmail) : '',
    lastSync: new Date().toISOString(),
  })
  try {
    await appendAudit(config, session.name, 'Updated Drive folder configuration')
  } catch { /* keep the saved folders even if the audit log write fails */ }
  const audit = await loadAudit().catch(() => [] as FleetSnapshot['audit'])
  const watching = [logbooksName, certificatesName, photosName, agreementsName].filter(Boolean).join(', ')
  return {
    user: { name: session.name, email: session.email, image: session.image },
    config,
    vehicles: [],
    unmatched: [],
    duplicates: [],
    inbox: [],
    audit,
    lastSync: config.lastSync,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config.spreadsheetId),
    ingest: { watching, attempted: 0, renamed: 0 },
  }
}

export async function uploadDocument(formData: FormData) {
  const session = await requireSession()
  const config = await requireConfig()
  const type = formData.get('type') as DocType
  const file = formData.get('file') as File | null
  if (!file || !type) throw new Error('Choose a document type and file')
  const bytes = Buffer.from(await file.arrayBuffer())
  let match = { plate: plateFromText(file.name), confidence: plateFromText(file.name) ? 96 : 0 }
  try {
    match = await resolvePlateFromFile({ filename: file.name, bytes, mimeType: file.type })
  } catch (err) {
    await appendAudit(config, 'System', `OCR skipped for ${file.name}: ${err instanceof Error ? err.message : 'OCR error'}`)
  }
  const auto = Boolean(match.plate && match.confidence >= (config.autoUploadThreshold ?? 85))
  const name = auto && match.plate ? suggestedName(match.plate, type, file.name) : file.name
  const folderId = folderIdForType(config, type)
  if (!folderId) throw new Error(type === 'agreement' ? 'Choose the agreements Drive folder in Settings first.' : 'Choose the Drive folder for that document type in Settings.')
  const uploaded = await uploadBinary(folderId, name, bytes, file.type || 'application/octet-stream')
  await appendAudit(config, session.name, `Uploaded ${uploaded.name} to ${folderNameForType(config, type)}`)
  await touchSync(config)
  return loadFleet()
}

type AssignUnmatchedInput = { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }

async function applyManualAssignment(config: FleetConfig, user: string, input: AssignUnmatchedInput) {
  const plate = parseKenyanPlate(input.plate)
  if (!plate) throw new Error(`Enter a Kenyan registration number for ${input.name}, for example KMHE520A.`)
  const currentFolder = folderIdForType(config, input.currentType)
  const nextFolder = folderIdForType(config, input.type)
  if (!nextFolder) throw new Error(input.type === 'agreement' ? 'Choose the agreements Drive folder in Settings first.' : 'Choose the Drive folder for that document type in Settings.')
  const file = await moveAndRename(input.fileId, {
    name: suggestedName(plate, input.type, input.name),
    addParent: currentFolder !== nextFolder ? nextFolder : undefined,
    removeParent: currentFolder !== nextFolder ? currentFolder : undefined,
  })
  await appendAudit(config, user, `Assigned ${file.name} as ${input.type} for ${plate}`)
  return plate
}

export async function assignUnmatched(input: AssignUnmatchedInput) {
  const session = await requireSession()
  const config = await requireConfig()
  await applyManualAssignment(config, session.name, input)
  await touchSync(config)
  return loadFleet()
}

export async function assignUnmatchedBatch(inputs: AssignUnmatchedInput[]) {
  const session = await requireSession()
  const config = await requireConfig()
  if (!inputs.length) throw new Error('Enter registration numbers on the files you want to assign, then assign them together.')
  const failed: string[] = []
  let assigned = 0
  for (const input of inputs) {
    try {
      await applyManualAssignment(config, session.name, input)
      assigned += 1
    } catch (err) {
      failed.push(err instanceof Error ? err.message : `Could not assign ${input.name}.`)
    }
  }
  await touchSync(config)
  const fleet = await loadFleet()
  if (!assigned) throw new Error(failed[0] || 'Could not assign those files.')
  if (failed.length) {
    return {
      ...fleet,
      ingest: {
        watching: fleet.ingest?.watching || '',
        attempted: assigned,
        renamed: assigned,
        notice: `Assigned ${assigned}. Could not assign ${failed.length}: ${failed.join(' ')}`,
      },
    }
  }
  return fleet
}

export async function syncGmail() {
  const session = await requireSession()
  const config = await requireConfig()
  const { state, fileId } = await loadGmailState()
  const items: InboxItem[] = [...state.items]
  const processed = new Set(state.processedIds)
  const insuranceEmail = isInboxEmail(config.insuranceInboxEmail)
  const logbooksEmail = isInboxEmail(config.logbooksInboxEmail)
  const mailboxes: { type: DocType; query: string }[] = []
  if (insuranceEmail) mailboxes.push({ type: 'certificate', query: mailboxSearchQuery(config.insuranceInboxEmail || '') })
  else if (!logbooksEmail) mailboxes.push({ type: 'certificate', query: 'has:attachment newer_than:21d' })
  if (logbooksEmail) mailboxes.push({ type: 'logbook', query: mailboxSearchQuery(config.logbooksInboxEmail || '') })

  let handled = 0
  let moreMail = false
  for (const mailbox of mailboxes) {
    if (moreMail) break
    const messages = await listRecentMessages(mailbox.query)
    for (const listed of messages) {
      if (moreMail) break
      const messageKey = `${mailbox.type}:${listed.id}`
      if (processed.has(messageKey)) continue
      const message = await getMessage(listed.id)
      const meta = messageMeta(message)
      const attachments = findAttachments(message.payload).filter((item) => /\.(pdf|png|jpe?g|webp|tif?f|heic)$/i.test(item.filename))
      if (!attachments.length) {
        processed.add(messageKey)
        continue
      }
      let messageOpen = false
      for (const attachment of attachments) {
        const attachmentKey = `${messageKey}:${attachment.attachmentId}`
        if (processed.has(attachmentKey)) continue
        if (ON_VERCEL && handled >= 1) {
          messageOpen = true
          moreMail = true
          break
        }
        const bytes = await getAttachment(listed.id, attachment.attachmentId)
        let match = { plate: null as string | null, confidence: 0 }
        try {
          match = await resolvePlateFromFile({
            filename: attachment.filename,
            subject: meta.subject,
            body: `${meta.snippet} ${meta.from}`,
            bytes,
            mimeType: attachment.mimeType,
            kind: mailbox.type,
          })
        } catch (err) {
          await appendAudit(config, 'System', `OCR skipped for ${attachment.filename}: ${err instanceof Error ? err.message : 'OCR error'}`)
        }
        const auto = Boolean(match.confidence >= (config.autoUploadThreshold ?? 85) && match.plate)
        const name = auto && match.plate ? suggestedName(match.plate, mailbox.type, attachment.filename) : attachment.filename
        const uploaded = await uploadBinary(folderIdForType(config, mailbox.type), name, bytes, attachment.mimeType)
        if (mailbox.type === 'certificate' && auto && match.plate) {
          await fillInsuranceCover(config, { ...uploaded, type: 'certificate', plate: match.plate }).catch(() => {})
        }
        items.unshift({
          id: `${listed.id}:${attachment.attachmentId}:${mailbox.type}`,
          sender: meta.from,
          subject: meta.subject || (mailbox.type === 'logbook' ? 'Logbook attachment' : 'Insurance attachment'),
          attachment: uploaded.name,
          received: formatTime(meta.date || new Date(Number(message.internalDate)).toISOString()),
          vehicle: match.plate || 'No plate detected',
          confidence: match.confidence,
          status: auto ? 'Auto-uploaded' : 'Needs review',
          fileId: uploaded.id,
          folder: auto ? folderNameForType(config, mailbox.type) : 'Needs plate in filename',
          type: mailbox.type,
        })
        await appendAudit(
          config,
          auto ? 'System' : session.name,
          auto ? `Renamed ${attachment.filename} to ${uploaded.name} for ${match.plate}` : `Stored unmatched ${mailbox.type} attachment ${uploaded.name}`,
        )
        processed.add(attachmentKey)
        handled += 1
      }
      if (!messageOpen) processed.add(messageKey)
    }
  }

  const nextState = { lastSync: new Date().toISOString(), processedIds: [...processed], items: items.slice(0, 80) }
  await saveGmailState(config, nextState, fileId)
  await touchSync(config, nextState.lastSync)
  if (ON_VERCEL && moreMail) {
    return emptySnapshot(session, config, {
      inbox: items.slice(0, 80),
      gmailConnected: true,
      lastSync: nextState.lastSync,
      ingest: {
        watching: 'Gmail',
        attempted: handled,
        renamed: handled,
        more: true,
        follow: 'gmail',
        preserve: true,
        notice: 'Renamed the latest inbox file. The next insurance or logbook attachment starts on its own. Leave this page open.',
      },
    })
  }
  return loadFleet()
}

export async function getProcessingJob() {
  await requireSession()
  if (!isCursorHydrated()) {
    const config = await loadConfig()
    if (config) await hydrateProcessCursor(config).catch(() => lastAction())
  }
  attachLastAction(lastAction())
  return getProcessJob()
}

export async function loadWorkspacePanels() {
  await requireSession()
  const emptyGmail = { state: { processedIds: [] as string[], items: [] as InboxItem[] } }
  const [audit, gmail] = await Promise.all([
    loadAudit().catch(() => [] as FleetSnapshot['audit']),
    loadGmailState().catch(() => emptyGmail),
  ])
  return {
    inbox: gmail.state.items,
    audit,
    gmailConnected: Boolean(gmail.state.lastSync),
  }
}

export async function linkPerceivedMatches(type: 'photo' | 'certificate' | 'logbook') {
  await requireSession()
  const config = await requireConfig()
  if (!config.spreadsheetId) throw new Error('Choose the Fleet Assets workbook in Settings first.')
  const label = type === 'certificate' ? 'insurance' : type === 'logbook' ? 'logbooks' : 'photos'
  const preview = await readStockRegisterSnapshot(config, { fresh: true })
  if (preview.error) throw new Error(preview.error)
  const listed = await scanFolders(config, preview.plates, preview.cells, undefined, { fresh: true })
  const waiting = listed.files.filter((file) => file.type === type)
  if (!waiting.length) throw new Error(`No ${label} files were found in the configured folders.`)
  const linked = await linkUnlinkedDocuments(config, type, waiting)
  if (!linked.written) {
    if (linked.unnamed) {
      const expected = type === 'certificate' ? 'Insurance - {plate}' : '{plate} - Logbook'
      const labelOne = type === 'certificate' ? 'insurance file' : 'logbook'
      throw new Error(`${linked.unnamed} ${labelOne}${linked.unnamed === 1 ? ' is' : 's are'} not linked because the file is not named ${expected} yet.`)
    }
    if (linked.missing.length) {
      const plates = listRegistrationNumbers(linked.missing)
      throw new Error(`${linked.missing.length} ${label} registration number${linked.missing.length === 1 ? ' is' : 's are'} not on STOCK DOCUMENTS${plates ? ` (${plates})` : ''}, so those files cannot be linked.`)
    }
    throw new Error(`Every ${label} file that has a registration number is already linked on its STOCK DOCUMENTS row.`)
  }
  const plates = listRegistrationNumbers(linked.matched)
  await appendAudit(config, 'System', `Linked ${linked.written} ${label} file${linked.written === 1 ? '' : 's'} onto STOCK DOCUMENTS${plates ? ` for ${plates}` : ''}`)
  const fleet = await loadFleet('auto', false, 'off')
  const skipped = [
    linked.missing.length ? `${linked.missing.length} registration number${linked.missing.length === 1 ? ' is' : 's are'} not on the sheet, so those files were left in the folder.` : '',
    linked.unnamed ? `${linked.unnamed} file${linked.unnamed === 1 ? '' : 's'} still need the name ${type === 'certificate' ? 'Insurance - {plate}' : '{plate} - Logbook'} before they can be linked.` : '',
  ].filter(Boolean).join(' ')
  return {
    ...fleet,
    ingest: {
      watching: label,
      attempted: waiting.length,
      renamed: linked.written,
      notice: `Linked ${linked.written} ${label} file${linked.written === 1 ? '' : 's'} onto the empty STOCK DOCUMENTS cells${plates ? ` for ${plates}` : ''}.${skipped ? ` ${skipped}` : ''}`,
    },
  }
}

export async function runProcessing(focus: ProcessFocus = 'all') {
  await requireSession()
  const config = await requireConfig()
  await hydrateProcessCursor(config).catch(() => lastAction())
  replaceProcessQueue([], focus)
  recordLastAction({
    focus,
    status: 'running',
    detail: `Continuing ${processFocusLabel(focus)} from the last file`,
  })
  attachLastAction(lastAction())
  return loadFleet('full', false, focus)
}

export async function continueProcessing() {
  await requireSession()
  const config = await loadConfig()
  if (config) await hydrateProcessCursor(config).catch(() => lastAction())
  const live = getProcessJob()
  const stored = lastAction()
  const focus = (live.focus || stored.focus || 'all') as ProcessFocus
  if (live.cancelled || stored.status === 'paused' || (stored.status === 'done' && !stored.remaining)) {
    return loadFleet('auto', true, 'off')
  }
  recordLastAction({
    focus,
    status: 'running',
    detail: `Starting the next ${processFocusLabel(focus)} batch`,
  })
  attachLastAction(lastAction())
  return loadFleet('full', false, focus)
}

export async function stopProcessing() {
  await requireSession()
  const config = await loadConfig()
  const live = getProcessJob()
  requestProcessStop()
  recordLastAction({
    focus: live.focus,
    status: 'paused',
    remaining: live.remaining || lastAction().remaining || 0,
    done: live.done,
    detail: live.currentId ? `Stopped while reading ${live.items.find((item) => item.fileId === live.currentId)?.name || 'a file'}` : 'Stopped. Start the same job to continue from this point.',
  })
  if (config) await persistProcessCursor(config).catch(() => {})
  attachLastAction(lastAction())
  return getProcessJob()
}

export async function ocrUnmatchedPhotos(fileId?: string) {
  const session = await requireSession()
  const config = await requireConfig()
  if (!ocrConfigured()) {
    throw new Error('Photo OCR is not available. Restart the app after installing tesseract.js.')
  }
  const preview = config.spreadsheetId ? await readStockRegisterSnapshot(config) : { plates: new Set<string>(), cells: new Map() as SheetCells }
  const { unmatched, files } = await scanFolders(config, preview.plates, preview.cells, undefined, { fresh: true })
  const target = fileId ? files.find((file) => file.id === fileId) || unmatched.find((file) => file.id === fileId) : undefined
  if (fileId) forgetFile(fileId)
  const readable = unmatched.filter((file) => isOcrImage(file.mimeType, file.name) || plateFromText(file.name))
  const waiting = fileId ? (target ? [target] : []) : readable.filter((file) => !hasCanonicalName(file) && !nameMatchesDocument(file) && !wasTriedRecently(file.id))
  if (!waiting.length) {
    throw new Error(fileId ? 'That file is not a JPEG, PNG, or PDF Fleetwise can OCR.' : 'No unmatched photos, insurance, logbook, or agreement files to OCR.')
  }
  if (ON_VERCEL) {
    replaceProcessQueue(waiting.map(toQueueItem), 'repair')
    recordLastAction({
      focus: 'repair',
      status: 'running',
      remaining: waiting.length,
      detail: `Reading plates on ${waiting.length} unmatched file${waiting.length === 1 ? '' : 's'}, one at a time.`,
    })
    await persistProcessCursor(config).catch(() => {})
    attachLastAction(lastAction())
    return emptySnapshot(session, config, {
      gmailConnected: false,
      ingest: {
        watching: 'Unmatched',
        attempted: 0,
        renamed: 0,
        remaining: waiting.length,
        more: true,
        focus: 'repair',
        follow: 'files',
        preserve: true,
        notice: `Queued ${waiting.length} unmatched file${waiting.length === 1 ? '' : 's'}. Photos, insurance, logbooks, and agreements are renamed one at a time. Leave this page open.`,
      },
    })
  }
  const remainingAfter = Math.max(0, waiting.length - OCR_BATCH)
  const candidates = waiting.slice(0, OCR_BATCH)
  if (isProcessRunning()) {
    throw new Error('A processing run is already live. Open Processing to watch it.')
  }
  beginProcessJob('Unmatched', candidates, 'repair')
  let renamed = 0
  const takenNames = new Set(files.map((file) => file.name))
  try {
    await mapPool(candidates, fileId ? 1 : OCR_CONCURRENCY, async (file) => {
      try {
        const result = await ocrMatchFile(config, session.name, file, { sheetPlates: preview.plates, takenNames })
        if (result.file?.name) takenNames.add(result.file.name)
        renamed += result.renamed
        if (result.plate) markTried(file.id)
        recordLastAction({ focus: 'repair', status: 'running', fileId: file.id, fileName: result.file?.name || file.name, plate: result.plate || undefined })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'OCR error'
        touchProcessItem(file.id, { stage: 'error', detail: message, name: file.name, type: file.type, mimeType: file.mimeType })
        await appendAudit(config, 'System', `OCR failed for ${file.name}: ${message}`)
        if (fileId) throw new Error(message)
      }
    })
  } catch (err) {
    if (isProcessRunning()) endProcessJob(err instanceof Error ? err.message : 'OCR error')
    throw err
  }
  await appendAudit(config, session.name, `OCR read plates on ${renamed} of ${candidates.length} photos`)
  await touchSync(config)
  recordLastAction({ focus: 'repair', status: remainingAfter > 0 ? 'running' : 'done', remaining: remainingAfter })
  await persistProcessCursor(config).catch(() => {})
  if (isProcessRunning()) endProcessJob(undefined, { remaining: remainingAfter, renamed })
  const next = await loadFleet('auto', true, remainingAfter > 0 ? 'repair' : 'off')
  const more = remainingAfter > 0 || Boolean(next.ingest?.more)
  if (next.ingest) next.ingest.more = more
  if (renamed === 0 && !more) throw new Error(unreadPlateMessage(candidates, 'Unmatched'))
  return next
}

function plateOnRegister(plate: string | null | undefined, sheetPlates?: Set<string>) {
  if (!plate || !sheetPlates?.size) return false
  return sheetPlates.has(compactPlate(plate))
}

async function ocrMatchFile(config: FleetConfig, user: string, file: TypedFile, options: { verify?: boolean; sheetPlates?: Set<string>; focus?: ProcessFocus; takenNames?: Set<string> } = {}) {
  const certificate = isPlatePdf(file.type)
  const repair = isRepairFocus(options.focus)
  if (repair || certificate) forgetFile(file.id)
  const first = await ocrAndRename(config, user, file, { ...options, verify: false, forceRaster: false, reopen: repair || certificate })
  if (certificate) {
    const printed = (file.type === 'logbook' || file.type === 'agreement'
      ? plateFromLogbookText(first.text || '') || printedRegistrationPlate(first.text || '')
      : printedRegistrationPlate(first.text || '')) || first.plate
    const named = plateFromTypedName(first.file?.name || file.name, file.type) || plateFromText(first.file?.name || file.name)
    const filenameWrong = Boolean(printed && named && compactPlate(named) !== compactPlate(printed))
    if (!repair && !filenameWrong && (plateOnRegister(printed, options.sheetPlates) || !options.sheetPlates?.size)) return first
    forgetFile(file.id)
    const retry = first.file || file
    touchProcessItem(file.id, {
      stage: 'opening',
      detail: filenameWrong
        ? `Filename has ${named} but the PDF reads ${printed}. Reopening to rename from REGISTRATION No`
        : first.plate
          ? `${first.plate} did not match STOCK DOCUMENTS. Reopening ${file.name} to confirm REGISTRATION No`
          : `Reopening ${file.name} to confirm REGISTRATION No`,
      plate: printed,
      name: retry.name,
      type: file.type,
      mimeType: file.mimeType,
    })
    return ocrAndRename(config, user, retry, {
      verify: true,
      forceRaster: true,
      reopen: true,
      sheetPlates: options.sheetPlates,
    })
  }
  if (first.plate || options.verify || file.type === 'photo') return first
  forgetFile(file.id)
  const retry = first.file || file
  touchProcessItem(file.id, {
    stage: 'opening',
    detail: `No plate yet. Reopening ${file.name} to read the registration number`,
    name: retry.name,
    type: file.type,
    mimeType: file.mimeType,
  })
  return ocrAndRename(config, user, retry, { verify: true, sheetPlates: options.sheetPlates, reopen: true })
}

async function ocrAndRename(config: FleetConfig, user: string, file: TypedFile, options: { verify?: boolean; sheetPlates?: Set<string>; forceRaster?: boolean; reopen?: boolean; takenNames?: Set<string> } = {}) {
  const typedPlate = plateFromTypedName(file.name, file.type)
  const named = typedPlate || (file.type === 'logbook' || file.type === 'agreement' ? extractKenyanPlate(file.name) : plateFromText(file.name))
  const readable = isOcrImage(file.mimeType, file.name)
  const usesRegistrationField = isPlatePdf(file.type)
  if (hasCanonicalName(file) && !options.verify && !options.forceRaster && plateOnRegister(typedPlate || named, options.sheetPlates)) {
    const plate = typedPlate || named
    const name = file.name
    touchProcessItem(file.id, { stage: 'matching', detail: `Already named ${name}`, plate, name, type: file.type, mimeType: file.mimeType })
    if (file.type === 'certificate' && plate) await fillInsuranceCover(config, { ...file, plate })
    return { renamed: 0, text: '', name, plate, file: { ...file, name, plate, type: file.type } }
  }
  if ((file.type === 'logbook' || file.type === 'agreement') && named && !hasCanonicalName(file) && !options.verify && !options.forceRaster) {
    const name = uniqueSuggestedName(named, file.type, file.name, options.takenNames)
    touchProcessItem(file.id, { stage: 'renaming', detail: `Renaming to ${name}`, plate: named, name: file.name, type: file.type, mimeType: file.mimeType })
    if (name === file.name) return { renamed: 0, text: '', name, plate: named, file: { ...file, name, plate: named, type: file.type } }
    const updated = await moveAndRename(file.id, { name })
    await appendAudit(config, user, `Normalized ${file.name} to ${name}`)
    touchProcessItem(file.id, { stage: 'renaming', detail: `Renamed to ${name}`, plate: named, name })
    return { renamed: 1, text: '', name, plate: named, file: { ...file, ...updated, name, plate: named, type: file.type } }
  }
  if (typedPlate && !readable && !usesRegistrationField) {
    const name = suggestedName(typedPlate, file.type, file.name)
    touchProcessItem(file.id, { stage: 'renaming', detail: `Filename already has ${typedPlate}`, plate: typedPlate, name: file.name, type: file.type, mimeType: file.mimeType })
    if (name === file.name) return { renamed: 0, text: '', name, plate: typedPlate, file: { ...file, name, plate: typedPlate, type: file.type } }
    const updated = await moveAndRename(file.id, { name })
    await appendAudit(config, user, `Normalized ${file.name} to ${name}`)
    touchProcessItem(file.id, { stage: 'renaming', detail: `Renamed to ${name}`, plate: typedPlate, name })
    return { renamed: 1, text: '', name, plate: typedPlate, file: { ...file, ...updated, name, plate: typedPlate, type: file.type } }
  }
  touchProcessItem(file.id, {
    stage: 'opening',
    detail: options.verify
      ? (usesRegistrationField ? `Reopening the PDF to correct REGISTRATION No on ${file.name}` : `Reopening ${file.name} to correct the registration number`)
      : usesRegistrationField ? `Opening the PDF to read REGISTRATION No on ${file.name}` : 'Downloading from Drive',
    plate: named,
    name: file.name,
    type: file.type,
    mimeType: file.mimeType,
  })
  const downloaded = (file.mimeType || '').startsWith('application/vnd.google-apps.')
    ? await downloadNamedFile(file.id)
    : { bytes: await downloadBinary(file.id), mime: file.mimeType, filename: file.name }
  touchProcessItem(file.id, {
    stage: 'reading',
    detail: usesRegistrationField
      ? 'Reading REGISTRATION No inside the certificate'
      : named
        ? `Re-reading the plate on the photo ${file.name}`
        : 'Reading the plate on the photo',
  })
  const ocrKind = usesRegistrationField ? (options.forceRaster ? 'pdf-confirm' : file.type === 'certificate' ? 'certificate' : 'logbook') : file.type
  const ocr = await plateFromImage(downloaded.bytes, downloaded.mime || file.mimeType, downloaded.filename || file.name, ocrKind)
  const labeled = usesRegistrationField
    ? (file.type === 'certificate'
      ? (printedRegistrationPlate(ocr.text) || plateFromCertificateText(ocr.text))
      : (plateFromLogbookText(ocr.text) || printedRegistrationPlate(ocr.text) || plateFromCertificateText(ocr.text)))
    : null
  const documentPlate = parseKenyanPlate(labeled || (usesRegistrationField ? pickOcrPlate(ocr.text, 'certificate') : ocr.plate) || '')
  if (documentPlate) markConfirmed(file.id, documentPlate)
  let plate = documentPlate
  if (usesRegistrationField) {
    if (!documentPlate) {
      const error = `Couldn't read REGISTRATION No inside ${file.name}. Open the PDF, or type the plate on Unmatched if you can see it.`
      touchProcessItem(file.id, { stage: 'unmatched', detail: error })
      return {
        renamed: 0,
        text: ocr.text,
        name: file.name,
        plate: null as string | null,
        error,
      }
    }
    if (named && compactPlate(named) !== compactPlate(documentPlate)) {
      await appendAudit(config, user, `Certificate ${file.name} was named ${named} but REGISTRATION No on the PDF reads ${documentPlate}; renaming from the document`)
    }
    plate = documentPlate
  }
  if (!plate || /^UNREADABLE$/i.test(plate)) {
    const namedBike = file.type === 'photo'
      ? (parsePhotoPlate(named) || parsePhotoPlate(file.name) || parsePhotoPlate(extractKenyanPlate(file.name) || ''))
      : null
    if (namedBike) plate = namedBike
  }
  if (!plate || /^UNREADABLE$/i.test(plate)) {
    touchProcessItem(file.id, { stage: 'unmatched', detail: usesRegistrationField ? `Couldn't read REGISTRATION No inside ${file.name}.` : `Couldn't read a plate on the photo ${file.name}.` })
    return { renamed: 0, text: ocr.text, name: file.name, plate: null as string | null }
  }
  if (file.type === 'certificate') await rememberInsuranceCover(config, plate, ocr.text)
  const name = uniqueSuggestedName(plate, file.type, file.name, options.takenNames)
  const source = usesRegistrationField ? 'REGISTRATION No on the PDF' : 'the plate on the photo'
  if (named && documentPlate && compactPlate(named) === compactPlate(documentPlate) && name === file.name) {
    touchProcessItem(file.id, { stage: 'renaming', detail: `Checked ${plate} — the filename already matches ${source}`, plate, name: file.name })
    return { renamed: 0, text: ocr.text, name, plate, file: { ...file, name, plate, type: file.type } }
  }
  touchProcessItem(file.id, {
    stage: 'renaming',
    detail: usesRegistrationField ? `REGISTRATION No ${plate} — renaming to ${name}` : `Plate ${plate} on the photo — renaming to ${name}`,
    plate,
    name: file.name,
  })
  if (name === file.name) {
    touchProcessItem(file.id, { stage: 'matching', detail: `Named ${name} from ${source}. Matching on STOCK DOCUMENTS`, plate, name })
    return { renamed: 0, text: ocr.text, name, plate, file: { ...file, name, plate, type: file.type } }
  }
  const updated = await moveAndRename(file.id, { name })
  await appendAudit(config, user, `Opened ${file.name} and renamed to ${name} from ${source}`)
  touchProcessItem(file.id, { stage: 'matching', detail: `Renamed to ${name} from ${source}`, plate, name })
  return { renamed: 1, text: ocr.text, name, plate, file: { ...file, ...updated, name, plate, type: file.type } }
}

async function rememberInsuranceCover(config: FleetConfig, plate: string, text: string) {
  const cover = parseInsuranceCover(text)
  if (!cover.commencement && !cover.expiry) return
  await saveInsuranceCover(config, plate, cover)
}

function certificateFileId(file?: { id?: string; webViewLink?: string }) {
  if (!file) return ''
  if (file.id && !file.id.startsWith('sheet:')) return file.id
  return driveIdFromUri(file.webViewLink || '') || ''
}

async function readCoverFromDriveFile(file: { id?: string; name?: string; mimeType?: string; webViewLink?: string }, ocr = false) {
  const id = certificateFileId(file)
  if (!id) return { commencement: null, expiry: null } as InsuranceCover
  const downloaded = (file.mimeType || '').startsWith('application/vnd.google-apps.')
    ? await downloadNamedFile(id)
    : { bytes: await downloadBinary(id), mime: file.mimeType, filename: file.name }
  return coverFromCertificate(downloaded.bytes, downloaded.mime || file.mimeType, downloaded.filename || file.name, ocr)
}

async function fillMissingCertificateCovers(config: FleetConfig, vehicles: VehicleRecord[], covers: Record<string, InsuranceCover>) {
  const next = { ...covers }
  const missing = vehicles.filter((vehicle) => {
    const plate = compactPlate(vehicle.plate)
    const stored = next[plate]
    return certificateFileId(vehicle.files.certificate[0]) && (!stored?.commencement || !stored?.expiry)
  }).slice(0, 8)
  if (!missing.length) return next
  let changed = false
  await mapPool(missing, 3, async (vehicle) => {
    const plate = compactPlate(vehicle.plate)
    try {
      const cover = await Promise.race([
        readCoverFromDriveFile(vehicle.files.certificate[0], false),
        new Promise<InsuranceCover>((_, reject) => setTimeout(() => reject(new Error('timeout')), 12_000)),
      ])
      if (!cover.commencement && !cover.expiry) return
      const previous = next[plate] || { commencement: null, expiry: null }
      next[plate] = {
        commencement: cover.commencement || previous.commencement,
        expiry: cover.expiry || previous.expiry,
      }
      changed = true
    } catch {
      // Leave this row as Not read if the PDF cannot be opened on this pass.
    }
  })
  if (changed) {
    await saveInsuranceCovers(config, next).catch(() => {})
    await saveCoverDates(next).catch(() => {})
  }
  return next
}

async function fillInsuranceCover(config: FleetConfig, file: TypedFile) {
  const plate = compactPlate(file.plate || '')
  if (!plate) return
  const existing = await loadInsuranceCovers(config).catch(() => ({} as Awaited<ReturnType<typeof loadInsuranceCovers>>))
  if (existing[plate]?.commencement && existing[plate]?.expiry) return
  try {
    const cover = await readCoverFromDriveFile(file, true)
    await saveInsuranceCover(config, plate, cover)
  } catch {
    // Keep the existing cover if this PDF cannot be opened on this pass.
  }
}

async function backfillInsuranceCovers(config: FleetConfig, files: TypedFile[], covers: Awaited<ReturnType<typeof loadInsuranceCovers>>) {
  const next = { ...covers }
  const missing = files.filter((file) => {
    if (file.type !== 'certificate') return false
    const plate = compactPlate(file.plate || plateFromTypedName(file.name, 'certificate') || plateFromText(file.name) || '')
    if (!plate) return false
    return !next[plate]?.expiry || !next[plate]?.commencement
  }).slice(0, 3)
  for (const file of missing) {
    const plate = compactPlate(file.plate || plateFromTypedName(file.name, 'certificate') || plateFromText(file.name) || '')
    await fillInsuranceCover(config, { ...file, plate })
    const updated = await loadInsuranceCovers(config).catch(() => next)
    Object.assign(next, updated)
  }
  return next
}

function watchingLabel(config: FleetConfig, focus: ProcessFocus) {
  if (focus === 'photos' || focus === 'repair-photos') return config.photosName || 'photos'
  if (focus === 'certificates' || focus === 'repair-certificates') return config.certificatesName || 'certificates'
  if (focus === 'logbooks' || focus === 'repair-logbooks') return config.logbooksName || 'logbooks'
  if (focus === 'agreements' || focus === 'repair-agreements') return config.agreementsName || 'agreements'
  if (focus === 'repair') return 'wrong matches'
  return [config.photosName || 'photos', config.certificatesName || 'certificates', config.logbooksName || 'logbooks', config.agreementsName || 'agreements'].join(', ')
}

function pendingForFocus(file: TypedFile, focus: ProcessFocus, sheetPlates?: Set<string>, missingDates?: Set<string>, extraIds?: Set<string>) {
  if (extraIds?.has(file.id)) return false
  if (!fileMatchesFocus(file, focus)) return false
  const named = namedPlateOf(file)
  const matched = plateOnRegister(named, sheetPlates)
  const repair = isRepairFocus(focus)
  const plate = named ? compactPlate(named) : ''
  const needsDates = file.type === 'certificate' && Boolean(plate && missingDates?.has(plate))
  if ((file.type === 'logbook' || file.type === 'agreement') && !hasCanonicalName(file) && named) return true
  if (file.type === 'certificate' && !hasCanonicalName(file)) {
    if (!repair && wasTriedRecently(file.id) && !needsDates) return false
    return true
  }
  if (file.type === 'photo') {
    if (repair) return isOcrImage(file.mimeType, file.name)
    if (hasCanonicalName(file) && matched) return false
    if (!repair && wasTriedRecently(file.id)) return false
    return isOcrImage(file.mimeType, file.name)
  }
  if (matched && !needsDates) return false
  if (!repair && wasTriedRecently(file.id) && !needsDates) return false
  const readable = isOcrImage(file.mimeType, file.name)
  if (isPlatePdf(file.type)) {
    return readable || /\.pdf$/i.test(file.name) || (file.mimeType || '').includes('pdf') || (file.mimeType || '').startsWith('application/vnd.google-apps.')
  }
  if (!repair && nameMatchesDocument(file)) return false
  if (!named && !readable) return false
  return true
}

function orderForResume(files: TypedFile[], focus: ProcessFocus) {
  const lastId = lastAction().fileId
  const unnamed = files
    .filter((file) => !hasCanonicalName(file))
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '') || a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  const named = files
    .filter((file) => hasCanonicalName(file))
    .sort((a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || '') || a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  if (!isRepairFocus(focus)) return [...unnamed, ...named]
  if (!lastId) return [...unnamed, ...named]
  const index = named.findIndex((file) => file.id === lastId)
  const rotated = index < 0 ? named : [...named.slice(index + 1), ...named.slice(0, index + 1)]
  return [...unnamed, ...rotated]
}

function toQueueItem(file: TypedFile): ProcessQueueItem {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    type: file.type,
    plate: file.plate,
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
    parents: file.parents,
  }
}

function queueItemToFile(item: ProcessQueueItem): TypedFile {
  return { ...item, plate: item.plate || null }
}

async function ingestQueued(config: FleetConfig, user: string, focus: ProcessFocus, sheetPlates?: Set<string>) {
  const watching = watchingLabel(config, focus)
  const next = takeProcessQueueItem()
  if (!next) {
    replaceProcessQueue([], focus)
    recordLastAction({ focus, status: 'done', remaining: 0, detail: `${processFocusLabel(focus)} caught up.` })
    await persistProcessCursor(config).catch(() => {})
    attachLastAction(lastAction())
    return { watching, attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined as string | undefined, renamedFiles: [] as TypedFile[], started: false, focus, notice: undefined as string | undefined, lastAction: lastAction() }
  }
  const file = queueItemToFile(next)
  const remaining = processQueueItems().length
  await warmPlateReader().catch(() => {})
  beginProcessJob(watching, [file], focus)
  let renamed = 0
  let error: string | undefined
  const renamedFiles: TypedFile[] = []
  let plate: string | null = null
  let fileName = file.name
  try {
    const result = await ocrMatchFile(config, user, file, { sheetPlates, focus, takenNames: new Set(processQueueItems().map((item) => item.name)) })
    renamed = result.renamed
    plate = result.plate
    fileName = result.file?.name || file.name
    if (result.file) renamedFiles.push(result.file)
    if (result.error) error = result.error
    markTried(file.id)
  } catch (err) {
    error = err instanceof Error ? err.message : 'OCR error'
    markTried(file.id)
    await appendAudit(config, 'System', `OCR failed for ${file.name}: ${error}`).catch(() => {})
  }
  if (!remaining) replaceProcessQueue([], focus)
  recordLastAction({
    focus,
    status: remaining ? 'running' : 'done',
    fileId: file.id,
    fileName,
    plate: plate || undefined,
    remaining,
    done: (lastAction().done || 0) + 1,
    detail: error
      ? error
      : remaining
        ? `${processFocusLabel(focus)} finished ${fileName}. ${remaining} still waiting.`
        : `${processFocusLabel(focus)} caught up.`,
  })
  await persistProcessCursor(config).catch(() => {})
  attachLastAction(lastAction())
  const notice = error
    ? `${error} ${remaining} file${remaining === 1 ? '' : 's'} still waiting.`
    : remaining
      ? `${renamed ? `Renamed ${fileName}. ` : ''}${remaining} ${processFocusLabel(focus).toLowerCase()} file${remaining === 1 ? '' : 's'} still waiting. Leave this page open.`
      : renamed ? `Renamed ${fileName}.` : `${processFocusLabel(focus)} caught up.`
  return { watching, attempted: 1, renamed, remaining, more: remaining > 0, error: undefined, renamedFiles, started: true, focus, follow: 'files' as const, notice, lastAction: lastAction() }
}

async function ingestIncoming(config: FleetConfig, user: string, mode: 'auto' | 'full' = 'auto', files?: TypedFile[], sheetPlates?: Set<string>, focus: ProcessFocus = 'all', cells?: SheetCells) {
  const watching = watchingLabel(config, focus)
  const listed = files || (await scanFolders(config)).files
  const extraIds = new Set(surplusCopies(listed, cells).map((file) => file.id))
  for (const file of listed) {
    if (file.type !== 'photo' || extraIds.has(file.id)) continue
    if (focus === 'repair-photos' || focus === 'repair' || !hasCanonicalName(file)) forgetFile(file.id)
  }
  const covers = await loadInsuranceCovers(config).catch(() => ({} as Record<string, InsuranceCover>))
  const missingDates = new Set(
    listed.flatMap((file) => {
      if (file.type !== 'certificate') return []
      const plate = compactPlate(file.plate || plateFromTypedName(file.name, 'certificate') || plateFromText(file.name) || '')
      if (!plate || (covers[plate]?.commencement && covers[plate]?.expiry)) return []
      return [plate]
    }),
  )
  const toNormalize = listed.filter((file) => {
    if (extraIds.has(file.id) || !fileMatchesFocus(file, focus) || hasCanonicalName(file)) return false
    if (file.type === 'logbook' || file.type === 'agreement') return Boolean(plateFromTypedName(file.name, file.type) || extractKenyanPlate(file.name))
    return Boolean(plateFromTypedName(file.name, file.type)) && !isOcrImage(file.mimeType, file.name)
  })
  const pending = orderForResume(listed.filter((file) => pendingForFocus(file, focus, sheetPlates, missingDates, extraIds)), focus)
  if (ON_VERCEL) {
    const queued = uniqueTypedFiles([...toNormalize, ...pending])
    replaceProcessQueue(queued.map(toQueueItem), focus)
    const waiting = queued.length
    recordLastAction({
      focus,
      status: waiting ? 'running' : 'done',
      remaining: waiting,
      detail: waiting
        ? `Found ${waiting} ${processFocusLabel(focus).toLowerCase()} file${waiting === 1 ? '' : 's'} to rename.`
        : `${processFocusLabel(focus)} caught up.`,
    })
    await persistProcessCursor(config).catch(() => {})
    attachLastAction(lastAction())
    return {
      watching,
      attempted: 0,
      renamed: 0,
      remaining: waiting,
      more: waiting > 0,
      renamedFiles: [] as TypedFile[],
      started: false,
      focus,
      follow: 'files' as const,
      notice: waiting
        ? `Queued ${waiting} ${processFocusLabel(focus).toLowerCase()} file${waiting === 1 ? '' : 's'}. Photos, insurance, logbooks, and agreements rename one at a time. Leave this page open.`
        : undefined,
      lastAction: lastAction(),
    }
  }
  const ocrCandidates = pending.slice(0, OCR_BATCH)
  const candidates = uniqueTypedFiles([...toNormalize, ...(ocrConfigured() ? ocrCandidates : [])])
  if (!ocrConfigured() && ocrCandidates.length && !toNormalize.length) {
    return {
      watching,
      attempted: 0,
      renamed: 0,
      remaining: pending.length,
      more: false,
      renamedFiles: [] as TypedFile[],
      started: false,
      focus,
      error: 'Photos, insurance, logbook, or agreement files are waiting, but local OCR is not ready. Restart the Next.js server after installing tesseract.js.',
    }
  }
  const emptyIngest = { watching, attempted: 0, renamed: 0, remaining: pending.length, more: false, renamedFiles: [] as TypedFile[], started: false, focus }
  if (candidates.length && isProcessRunning()) {
    return { ...emptyIngest, remaining: pending.length }
  }
  if (!candidates.length) {
    recordLastAction({ focus, status: 'done', remaining: 0, detail: `${processFocusLabel(focus)} caught up.` })
    attachLastAction(lastAction())
    return { ...emptyIngest, remaining: 0, lastAction: lastAction() }
  }
  await warmPlateReader().catch(() => {})
  let working = listed
  let renamed = 0
  let attempted = 0
  let error: string | undefined
  const renamedFiles: TypedFile[] = []
  const takenNames = new Set(listed.map((file) => file.name))
  const processedIds = new Set<string>()
  let remaining = pending.length
  let stopped = false
  const maxBatches = ON_VERCEL ? 1 : 40
  for (let batch = 0; batch < maxBatches; batch++) {
    if (isProcessCancelled()) {
      stopped = true
      break
    }
    working = mergeTypedFiles(working, renamedFiles)
    const pendingNow = orderForResume(working.filter((file) => pendingForFocus(file, focus, sheetPlates, missingDates)), focus)
    const normalizeNow = batch === 0 ? toNormalize : []
    const ocrSlice = pendingNow.slice(0, OCR_BATCH)
    const batchFiles = uniqueTypedFiles([...normalizeNow, ...(ocrConfigured() ? ocrSlice : [])])
    remaining = Math.max(0, pendingNow.length - ocrSlice.length)
    if (!batchFiles.length) {
      remaining = 0
      break
    }
    if (batch > 0 && isProcessRunning()) endProcessJob(undefined, { remaining: remaining + batchFiles.length, renamed })
    beginProcessJob(watching, batchFiles, focus)
    const generation = processGeneration()
    attempted += batchFiles.length
    await mapPool(batchFiles, OCR_CONCURRENCY, async (file) => {
      if (isStaleProcess(generation)) return
      try {
        const result = await ocrMatchFile(config, user, file, { sheetPlates, focus, takenNames })
        renamed += result.renamed
        if (result.file) {
          renamedFiles.push(result.file)
          if (result.file.name) takenNames.add(result.file.name)
        }
        if (result.error && !error) error = result.error
        markTried(file.id)
        processedIds.add(file.id)
        recordLastAction({
          focus,
          status: 'running',
          fileId: file.id,
          fileName: result.file?.name || file.name,
          plate: result.plate || undefined,
          detail: result.plate ? `Read ${result.plate} on ${result.file?.name || file.name}` : `Finished ${file.name}`,
          done: (lastAction().done || 0) + 1,
          remaining,
        })
      } catch (err) {
        error = err instanceof Error ? err.message : 'OCR error'
        markTried(file.id)
        processedIds.add(file.id)
        recordLastAction({ focus, status: 'running', fileId: file.id, fileName: file.name, detail: error, remaining })
        touchProcessItem(file.id, { stage: 'error', detail: error, name: file.name, type: file.type, mimeType: file.mimeType })
        await appendAudit(config, 'System', `OCR failed for ${file.name}: ${error}`)
      }
    })
    stopped = isStaleProcess(generation) || isProcessCancelled()
    if (stopped || remaining === 0) break
  }
  if (renamedFiles.length && !config.spreadsheetId && !error) {
    error = 'Renamed in Drive, but no Fleet Assets workbook is selected in Settings, so Sheets was not updated.'
  }
  if (ocrConfigured() && attempted && renamed === 0 && !error) {
    error = unreadPlateMessage(ocrCandidates, watching)
  }
  recordLastAction({
    focus,
    status: stopped ? 'paused' : remaining > 0 ? 'running' : 'done',
    remaining: stopped ? remaining + OCR_BATCH : remaining,
    done: lastAction().done,
    detail: stopped
      ? `Paused ${processFocusLabel(focus)} after ${lastAction().fileName || 'the last file'}. Start again to continue.`
      : remaining > 0
        ? `${processFocusLabel(focus)} batch finished. ${remaining} still need a plate.`
        : `${processFocusLabel(focus)} caught up.`,
  })
  await persistProcessCursor(config).catch(() => {})
  attachLastAction(lastAction())
  return { watching, attempted, renamed, remaining: stopped ? lastAction().remaining || remaining : remaining, more: !stopped && remaining > 0, error: stopped ? undefined : error, renamedFiles, started: attempted > 0, focus, lastAction: lastAction() }
}

function uniqueTypedFiles(files: TypedFile[]) {
  const byId = new Map<string, TypedFile>()
  for (const file of files) {
    if (!byId.has(file.id)) byId.set(file.id, file)
  }
  return [...byId.values()]
}

function mergeTypedFiles(files: TypedFile[], updates: TypedFile[]) {
  const byId = new Map(files.map((file) => [file.id, file]))
  for (const file of updates) byId.set(file.id, file)
  return [...byId.values()]
}

async function syncSheetIndex(config: FleetConfig, mode: SheetSyncMode = 'auto', files?: TypedFile[]) {
  if (!config.spreadsheetId) return { plates: undefined as Set<string> | undefined, error: undefined as string | undefined, missing: [] as string[], matched: [] as string[], hint: '', cells: undefined as SheetCells | undefined, more: false }
  try {
    const listed = files || (await scanFolders(config)).files
    const results = await syncSheetModules(config, listed, mode)
    for (const result of results) {
      if (!result.written || result.error) continue
      const module = SHEET_MODULES.find((item) => item.id === result.moduleId)
      const plates = listRegistrationNumbers(result.matched)
      await appendAudit(config, 'System', plates
        ? `Matched Registration Number ${plates} on ${module?.label || result.moduleId}`
        : `Wrote ${result.written} Drive file links onto ${module?.label || result.moduleId}`)
    }
    const primary = results.find((result) => result.moduleId === stockDocumentsModule.id) || results[0]
    const error = results.map((result) => result.error).filter(Boolean).join(' ')
    return {
      plates: primary?.keys,
      error: error || undefined,
      missing: primary?.missing || [],
      matched: primary?.matched || [],
      hint: primary?.hint || '',
      cells: primary?.cells,
      more: results.some((result) => result.more),
    }
  } catch (err) {
    return { plates: undefined, error: err instanceof Error ? err.message : 'Google Sheets update failed', missing: [] as string[], matched: [] as string[], hint: '', cells: undefined, more: false }
  }
}

export async function markInboxReviewed(itemId: string) {
  const session = await requireSession()
  const config = await requireConfig()
  const { state, fileId } = await loadGmailState()
  state.items = state.items.map((item) => item.id === itemId ? { ...item, status: 'Auto-uploaded' as const } : item)
  await saveGmailState(config, state, fileId)
  await appendAudit(config, session.name, `Marked inbox item ${itemId} reviewed`)
  return loadFleet()
}

async function requireConfig() {
  const config = await loadConfig()
  if (!config) throw new Error('Configure the logbooks, certificates, and photos folders in Settings first.')
  return config
}

async function touchSync(config: FleetConfig, lastSync = new Date().toISOString()) {
  await saveConfig({ ...config, lastSync })
}

function unreadPlateMessage(files: { name: string }[], folders: string) {
  const names = files.map((file) => file.name)
  const shown = names.slice(0, 3).join(', ')
  const extra = names.length > 3 ? ` and ${names.length - 3} more` : ''
  return `Couldn't read a Kenyan registration number from ${shown}${extra} in ${folders}. Open Unmatched and type the plate if you can see it in the file, or use a closer photo of the plate.`
}

function linkedSheetFileIds(cells?: SheetCells) {
  const ids = new Set<string>()
  if (!cells?.size) return ids
  for (const row of cells.values()) {
    for (const type of ['logbook', 'certificate', 'photo', 'agreement'] as const) {
      const id = driveIdFromUri(row[type]?.uri)
      if (id) ids.add(id)
    }
  }
  return ids
}

function sheetMatchNotice(matched?: string[], renamedFiles?: TypedFile[]) {
  const onSheet = listRegistrationNumbers(matched || [])
  if (onSheet) return `Matched Registration Number ${onSheet} on STOCK DOCUMENTS.`
  const renamed = listRegistrationNumbers((renamedFiles || []).flatMap((file) => file.plate ? [file.plate] : []))
  if (renamed) return `Renamed files for Registration Number ${renamed} in Drive.`
  return undefined
}




