'use server'

import { appendAudit, folderIdForType, folderNameForType, formatTime, hasCanonicalName, loadAudit, loadConfig, loadGmailState, plateFromTypedName, resolveFolderName, saveConfig, saveGmailState, scanFolders, suggestedName } from '@/lib/fleet'
import { getAttachment, findAttachments, getMessage, listRecentMessages, messageMeta } from '@/lib/gmail'
import { downloadBinary, downloadNamedFile, findFleetAssetsWorkbook, listFolders, listSharedDrives, listSpreadsheets as listSpreadsheetFiles, moveAndRename, searchFolders, uploadBinary } from '@/lib/drive'
import { isOcrImage, ocrConfigured, plateFromImage, resolvePlateFromFile } from '@/lib/ocr'
import { SHEET_MODULES, stockDocumentsModule, syncSheetModules } from '@/lib/modules'
import { readStockRegisterSnapshot } from '@/lib/modules/stock-documents'
import type { SheetCells, SheetSyncMode } from '@/lib/modules/types'
import { compactPlate, listRegistrationNumbers, parseKenyanPlate, pickOcrPlate, plateFromCertificateText, plateFromText } from '@/lib/plates'
import { attachLastAction, beginProcessJob, endProcessJob, fileMatchesFocus, getProcessJob, isProcessCancelled, isProcessRunning, isStaleProcess, markProcessMatches, processFocusLabel, processGeneration, requestProcessStop, touchProcessItem, type ProcessFocus } from '@/lib/processing'
import { confirmedPlate, forgetFile, hydrateProcessCursor, lastAction, markConfirmed, markTried, persistProcessCursor, recordLastAction, wasTriedRecently } from '@/lib/process-cursor'
import { requireSession } from '@/lib/session'
import { EMPTY_STATS, filterVehicles, fleetStats, slimVehicle, type VehicleQuery } from '@/lib/vehicles'
import type { DocType, FleetConfig, FleetSnapshot, InboxItem, TypedFile, VehicleRecord } from '@/lib/types'

let rememberedPlates: string[] = []

const OCR_BATCH = 12
const OCR_CONCURRENCY = 2

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
  return plateFromTypedName(file.name, file.type) || plateFromText(file.name)
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
    inbox: [],
    audit: [],
    stats: EMPTY_STATS,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config?.spreadsheetId),
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
  return emptySnapshot(session, config, { sheetsConnected: Boolean(config?.spreadsheetId) })
}

export async function loadVehiclePage(input: VehicleQuery = {}) {
  await requireSession()
  const config = await loadConfig()
  if (!config?.spreadsheetId) {
    return { vehicles: [] as VehicleRecord[], total: 0, page: 1, pageSize: input.pageSize || 25, stats: EMPTY_STATS, error: undefined as string | undefined }
  }
  const sheet = await readStockRegisterSnapshot(config)
  const filtered = filterVehicles(sheet.vehicles, input)
  const pageSize = Math.min(100, Math.max(10, input.pageSize || 25))
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, input.page || 1), totalPages)
  const start = (page - 1) * pageSize
  return {
    vehicles: filtered.slice(start, start + pageSize).map(slimVehicle),
    total: filtered.length,
    page,
    pageSize,
    stats: statsFor(sheet.vehicles),
    error: sheet.error,
  }
}

export async function exportVehicleRegister(input: VehicleQuery = {}) {
  await requireSession()
  const config = await loadConfig()
  const vehicles = config?.spreadsheetId ? filterVehicles((await readStockRegisterSnapshot(config)).vehicles, input) : []
  const rows = [['Plate', 'Brand', 'Logbook', 'Certificate', 'Photo', 'Collateral', 'Status', 'Updated'], ...vehicles.map((vehicle) => [
    vehicle.plate,
    vehicle.brand || '',
    vehicle.files.logbook.length ? 'yes' : 'no',
    vehicle.files.certificate.length ? 'yes' : 'no',
    vehicle.files.photo.length ? 'yes' : 'no',
    vehicle.collateral ? 'yes' : 'no',
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
  const preview = config.spreadsheetId ? await readStockRegisterSnapshot(config) : { vehicles: [], unmatched: [], plates: new Set<string>(), cells: new Map() as SheetCells, error: undefined as string | undefined }
  let ingest = { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined as string | undefined, renamedFiles: [] as TypedFile[], started: false, focus: jobFocus }
  let files: TypedFile[] = []
  try {
    const listed = await scanFolders(config, preview.plates, preview.cells)
    ingest = skipOcr
      ? { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined, renamedFiles: [] as TypedFile[], started: false, focus: undefined }
      : await ingestIncoming(config, session.name, mode, listed.files, preview.plates, jobFocus || 'all')
    files = mergeTypedFiles(listed.files, ingest.renamedFiles)
  } catch (err) {
    ingest = { watching: '', attempted: 0, renamed: 0, remaining: 0, more: false, error: err instanceof Error ? err.message : 'Drive scan failed', renamedFiles: [], started: ingest.started, focus: jobFocus }
    const ingestGen = processGeneration()
    if (ingest.started && isProcessRunning() && !isStaleProcess(ingestGen)) endProcessJob(ingest.error, { remaining: ingest.remaining || 0, renamed: ingest.renamed })
  }
  const ingestGen = processGeneration()
  const continuing = Boolean(ingest.more)
  const sheet = await syncSheetIndex(config, continuing ? 'match' : mode, files)
  if ((ingest.started || closeLive) && isProcessRunning() && !isStaleProcess(ingestGen)) {
    markProcessMatches(sheet.matched, sheet.missing, sheet.plates)
    endProcessJob(ingest.error || sheet.error, { remaining: ingest.remaining || 0, renamed: ingest.renamed })
  }
  const emptyGmail = { state: { processedIds: [] as string[], items: [] as InboxItem[] } }
  const [{ vehicles, unmatched }, audit, gmail] = await Promise.all([
    scanFolders(config, sheet.plates?.size ? sheet.plates : preview.plates, sheet.cells?.size ? sheet.cells : preview.cells, files),
    continuing ? Promise.resolve([] as FleetSnapshot['audit']) : loadAudit().catch(() => [] as FleetSnapshot['audit']),
    continuing ? Promise.resolve(emptyGmail) : loadGmailState().catch(() => emptyGmail),
  ])
  const registerVehicles = vehicles.length ? vehicles : preview.vehicles
  return {
    user: { name: session.name, email: session.email, image: session.image },
    config,
    vehicles: [],
    unmatched,
    inbox: gmail.state.items,
    audit,
    stats: statsFor(registerVehicles),
    lastSync: config.lastSync || gmail.state.lastSync,
    gmailConnected: Boolean(gmail.state.lastSync),
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config.spreadsheetId) && !sheet.error && !preview.error,
    sheetsError: sheet.error || preview.error,
    ingest: {
      ...ingest,
      more: Boolean(!isProcessCancelled() && ingest.more),
      remaining: ingest.remaining || lastAction().remaining || 0,
      focus: ingest.focus || jobFocus,
      lastAction: lastAction(),
      notice: sheetMatchNotice(sheet.matched, ingest.renamedFiles),
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
  collateralId?: string
  spreadsheetId?: string
  autoUploadThreshold: number
}) {
  const session = await requireSession()
  const previous = await loadConfig()
  const collateralId = input.collateralId || previous?.collateralId
  const names = await Promise.allSettled([
    resolveFolderName(input.logbooksId),
    resolveFolderName(input.certificatesId),
    resolveFolderName(input.photosId),
    collateralId ? resolveFolderName(collateralId) : Promise.resolve(''),
    input.spreadsheetId ? resolveFolderName(input.spreadsheetId) : Promise.resolve(''),
  ])
  const settled = (index: number, fallback: string) => names[index].status === 'fulfilled' ? names[index].value : fallback
  const logbooksName = settled(0, previous?.logbooksName || input.logbooksId)
  const certificatesName = settled(1, previous?.certificatesName || input.certificatesId)
  const photosName = settled(2, previous?.photosName || input.photosId)
  const collateralName = settled(3, previous?.collateralName || '')
  const spreadsheetName = settled(4, previous?.spreadsheetName || '')
  const config = await saveConfig({
    ...(previous || { logbooksId: input.logbooksId, certificatesId: input.certificatesId, photosId: input.photosId, autoUploadThreshold: input.autoUploadThreshold }),
    ...input,
    logbooksId: input.logbooksId,
    certificatesId: input.certificatesId,
    photosId: input.photosId,
    logbooksName,
    certificatesName,
    photosName,
    collateralId,
    collateralName: collateralName || undefined,
    spreadsheetId: input.spreadsheetId || undefined,
    spreadsheetName: spreadsheetName || undefined,
    lastSync: new Date().toISOString(),
  })
  try {
    await appendAudit(config, session.name, 'Updated Drive folder configuration')
  } catch { /* keep the saved folders even if the audit log write fails */ }
  const audit = await loadAudit().catch(() => [] as FleetSnapshot['audit'])
  return {
    user: { name: session.name, email: session.email, image: session.image },
    config,
    vehicles: [],
    unmatched: [],
    inbox: [],
    audit,
    lastSync: config.lastSync,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: ocrConfigured(),
    sheetsConnected: Boolean(config.spreadsheetId),
    ingest: { watching: [logbooksName, certificatesName, photosName].join(', '), attempted: 0, renamed: 0 },
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
  const uploaded = await uploadBinary(folderIdForType(config, type), name, bytes, file.type || 'application/octet-stream')
  await appendAudit(config, session.name, `Uploaded ${uploaded.name} to ${folderNameForType(config, type)}`)
  await touchSync(config)
  return loadFleet()
}

export async function assignUnmatched(input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) {
  const session = await requireSession()
  const config = await requireConfig()
  const plate = parseKenyanPlate(input.plate)
  if (!plate) throw new Error('Enter a Kenyan registration number, for example KMHE520A.')
  const currentFolder = folderIdForType(config, input.currentType)
  const nextFolder = folderIdForType(config, input.type)
  const file = await moveAndRename(input.fileId, {
    name: suggestedName(plate, input.type, input.name),
    addParent: currentFolder !== nextFolder ? nextFolder : undefined,
    removeParent: currentFolder !== nextFolder ? currentFolder : undefined,
  })
  await appendAudit(config, session.name, `Assigned ${file.name} as ${input.type} for ${plate}`)
  await touchSync(config)
  return loadFleet()
}

export async function syncGmail() {
  const session = await requireSession()
  const config = await requireConfig()
  const { state, fileId } = await loadGmailState()
  const messages = await listRecentMessages()
  const items: InboxItem[] = [...state.items]
  const processed = new Set(state.processedIds)

  for (const listed of messages) {
    if (processed.has(listed.id)) continue
    const message = await getMessage(listed.id)
    const meta = messageMeta(message)
    const attachments = findAttachments(message.payload).filter((item) => /\.(pdf|png|jpe?g|webp|tif?f|heic)$/i.test(item.filename))
    processed.add(listed.id)
    if (!attachments.length) continue
    for (const attachment of attachments) {
      const bytes = await getAttachment(listed.id, attachment.attachmentId)
      let match = { plate: null as string | null, confidence: 0 }
      try {
        match = await resolvePlateFromFile({
          filename: attachment.filename,
          subject: meta.subject,
          body: `${meta.snippet} ${meta.from}`,
          bytes,
          mimeType: attachment.mimeType,
        })
      } catch (err) {
        await appendAudit(config, 'System', `OCR skipped for ${attachment.filename}: ${err instanceof Error ? err.message : 'OCR error'}`)
      }
      const auto = match.confidence >= (config.autoUploadThreshold ?? 85) && match.plate
      const name = auto && match.plate ? suggestedName(match.plate, 'certificate', attachment.filename) : attachment.filename
      const uploaded = await uploadBinary(config.certificatesId, name, bytes, attachment.mimeType)
      items.unshift({
        id: `${listed.id}:${attachment.attachmentId}`,
        sender: meta.from,
        subject: meta.subject || 'Insurance attachment',
        attachment: uploaded.name,
        received: formatTime(meta.date || new Date(Number(message.internalDate)).toISOString()),
        vehicle: match.plate || 'No plate detected',
        confidence: match.confidence,
        status: auto ? 'Auto-uploaded' : 'Needs review',
        fileId: uploaded.id,
        folder: auto ? folderNameForType(config, 'certificate') : 'Needs plate in filename',
      })
      await appendAudit(
        config,
        auto ? 'System' : session.name,
        auto ? `Matched ${uploaded.name} to ${match.plate}` : `Stored unmatched attachment ${uploaded.name}`,
      )
    }
  }

  const nextState = { lastSync: new Date().toISOString(), processedIds: [...processed], items: items.slice(0, 50) }
  await saveGmailState(config, nextState, fileId)
  await touchSync(config, nextState.lastSync)
  return loadFleet()
}

export async function getProcessingJob() {
  await requireSession()
  const config = await loadConfig()
  if (config) await hydrateProcessCursor(config).catch(() => lastAction())
  attachLastAction(lastAction())
  return getProcessJob()
}

export async function runProcessing(focus: ProcessFocus = 'all') {
  await requireSession()
  const config = await requireConfig()
  await hydrateProcessCursor(config).catch(() => lastAction())
  recordLastAction({
    focus,
    status: 'running',
    detail: `Continuing ${processFocusLabel(focus)} from the last file`,
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
  const { unmatched, files } = await scanFolders(config)
  const target = fileId ? files.find((file) => file.id === fileId) || unmatched.find((file) => file.id === fileId) : undefined
  if (fileId) forgetFile(fileId)
  const readable = unmatched.filter((file) => isOcrImage(file.mimeType, file.name) || plateFromText(file.name))
  const waiting = fileId ? (target ? [target] : []) : readable.filter((file) => !hasCanonicalName(file) && !nameMatchesDocument(file) && !wasTriedRecently(file.id))
  const remainingAfter = Math.max(0, waiting.length - OCR_BATCH)
  const candidates = waiting.slice(0, OCR_BATCH)
  if (!candidates.length) {
    throw new Error(fileId ? 'That file is not a JPEG, PNG, or PDF Fleetwise can OCR.' : 'No unmatched photos or insurance files to OCR.')
  }
  if (isProcessRunning()) {
    throw new Error('A processing run is already live. Open Processing to watch it.')
  }
  beginProcessJob('Unmatched', candidates, 'repair')
  let renamed = 0
  try {
    await mapPool(candidates, fileId ? 1 : OCR_CONCURRENCY, async (file) => {
      try {
        const result = await ocrAndRename(config, session.name, file, { verify: true })
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

async function ocrAndRename(config: FleetConfig, user: string, file: TypedFile, options: { verify?: boolean } = {}) {
  const typedPlate = plateFromTypedName(file.name, file.type)
  const named = typedPlate || plateFromText(file.name)
  const readable = isOcrImage(file.mimeType, file.name)
  const usesRegistrationField = file.type === 'certificate' || file.type === 'logbook'
  if (hasCanonicalName(file) && !options.verify) {
    const plate = typedPlate || named
    const name = file.name
    touchProcessItem(file.id, { stage: 'matching', detail: `Already named ${name}`, plate, name, type: file.type, mimeType: file.mimeType })
    return { renamed: 0, text: '', name, plate, file: { ...file, name, plate, type: file.type } }
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
    detail: usesRegistrationField ? `Opening the PDF to read REGISTRATION No on ${file.name}` : 'Downloading from Drive',
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
    detail: usesRegistrationField ? 'Reading REGISTRATION No inside the certificate' : named ? `Re-reading the registration number on ${file.name}` : 'Reading the registration number',
  })
  const ocr = await plateFromImage(downloaded.bytes, downloaded.mime || file.mimeType, downloaded.filename || file.name, usesRegistrationField ? 'certificate' : file.type)
  const labeled = usesRegistrationField ? plateFromCertificateText(ocr.text) : null
  const documentPlate = parseKenyanPlate(labeled || (usesRegistrationField ? pickOcrPlate(ocr.text, 'certificate') : ocr.plate) || '')
  if (documentPlate) markConfirmed(file.id, documentPlate)
  let plate = usesRegistrationField ? documentPlate : (documentPlate || parseKenyanPlate(named || ''))
  if (usesRegistrationField) {
    if (documentPlate) {
      if (named && compactPlate(named) !== compactPlate(documentPlate)) {
        await appendAudit(config, user, `Certificate ${file.name} was named ${named} but REGISTRATION No on the PDF reads ${documentPlate}; renaming from the document`)
      }
      plate = documentPlate
    } else {
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
  }
  if (!plate) {
    touchProcessItem(file.id, { stage: 'unmatched', detail: `Couldn't read a Kenyan plate on ${file.name}.` })
    return { renamed: 0, text: ocr.text, name: file.name, plate: null as string | null }
  }
  const name = suggestedName(plate, file.type, file.name)
  if (named && documentPlate && compactPlate(named) === compactPlate(documentPlate) && name === file.name) {
    touchProcessItem(file.id, { stage: 'renaming', detail: `Checked ${plate} — the filename already matches REGISTRATION No`, plate, name: file.name })
    return { renamed: 0, text: ocr.text, name, plate, file: { ...file, name, plate, type: file.type } }
  }
  touchProcessItem(file.id, {
    stage: 'renaming',
    detail: `REGISTRATION No ${plate} — renaming to ${name}`,
    plate,
    name: file.name,
  })
  if (name === file.name) {
    touchProcessItem(file.id, { stage: 'matching', detail: `Named ${name} from REGISTRATION No on the PDF. Matching on STOCK DOCUMENTS`, plate, name })
    return { renamed: 0, text: ocr.text, name, plate, file: { ...file, name, plate, type: file.type } }
  }
  const updated = await moveAndRename(file.id, { name })
  await appendAudit(config, user, `Opened ${file.name} and renamed to ${name} from REGISTRATION No`)
  touchProcessItem(file.id, { stage: 'matching', detail: `Renamed to ${name} from REGISTRATION No on the PDF`, plate, name })
  return { renamed: 1, text: ocr.text, name, plate, file: { ...file, ...updated, name, plate, type: file.type } }
}

function watchingLabel(config: FleetConfig, focus: ProcessFocus) {
  if (focus === 'photos') return config.photosName || 'photos'
  if (focus === 'certificates') return config.certificatesName || 'certificates'
  if (focus === 'repair') return 'wrong matches'
  return [config.photosName || 'photos', config.certificatesName || 'certificates', config.logbooksName || 'logbooks'].join(', ')
}

function pendingForFocus(file: TypedFile, focus: ProcessFocus, sheetPlates?: Set<string>) {
  if (!fileMatchesFocus(file, focus)) return false
  if (focus !== 'repair' && hasCanonicalName(file)) return false
  const named = namedPlateOf(file)
  const readable = isOcrImage(file.mimeType, file.name)
  if (file.type === 'certificate') {
    return readable || /\.pdf$/i.test(file.name) || (file.mimeType || '').includes('pdf') || (file.mimeType || '').startsWith('application/vnd.google-apps.')
  }
  if (wasTriedRecently(file.id) || nameMatchesDocument(file)) return false
  if (!named && !readable) return false
  const onSheet = Boolean(named && sheetPlates?.has(compactPlate(named)))
  if (onSheet) return false
  return true
}

function orderForResume(files: TypedFile[], focus: ProcessFocus) {
  const lastId = lastAction().fileId
  const unnamed = files
    .filter((file) => !hasCanonicalName(file))
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '') || a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  if (focus !== 'repair') return unnamed
  const named = files
    .filter((file) => hasCanonicalName(file))
    .sort((a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || '') || a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  if (!lastId) return [...unnamed, ...named]
  const index = named.findIndex((file) => file.id === lastId)
  const rotated = index < 0 ? named : [...named.slice(index + 1), ...named.slice(0, index + 1)]
  return [...unnamed, ...rotated]
}

async function ingestIncoming(config: FleetConfig, user: string, mode: 'auto' | 'full' = 'auto', files?: TypedFile[], sheetPlates?: Set<string>, focus: ProcessFocus = 'all') {
  const watching = watchingLabel(config, focus)
  const listed = files || (await scanFolders(config)).files
  const toNormalize = listed.filter((file) => fileMatchesFocus(file, focus) && plateFromTypedName(file.name, file.type) && !hasCanonicalName(file) && !isOcrImage(file.mimeType, file.name))
  const pending = orderForResume(listed.filter((file) => pendingForFocus(file, focus, sheetPlates)), focus)
  const remainingAfter = Math.max(0, pending.length - OCR_BATCH)
  const ocrCandidates = pending.slice(0, OCR_BATCH)
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
      error: 'Photos or insurance files are waiting, but local OCR is not ready. Restart the Next.js server after installing tesseract.js.',
    }
  }
  const candidates = [...toNormalize, ...(ocrConfigured() ? ocrCandidates : [])]
  if (candidates.length && isProcessRunning()) {
    return { watching, attempted: 0, renamed: 0, remaining: pending.length, more: true, renamedFiles: [] as TypedFile[], started: false, focus }
  }
  if (candidates.length) beginProcessJob(watching, candidates, focus)
  let renamed = 0
  let error: string | undefined
  const renamedFiles: TypedFile[] = []
  const generation = processGeneration()
  const concurrency = focus === 'certificates' ? 1 : OCR_CONCURRENCY
  await mapPool(candidates, concurrency, async (file) => {
    if (isStaleProcess(generation)) return
    try {
      const result = await ocrAndRename(config, user, file, { verify: focus === 'repair' && Boolean(namedPlateOf(file)) })
      renamed += result.renamed
      if (result.file) renamedFiles.push(result.file)
      if (result.error && !error) error = result.error
      if (result.plate) markTried(file.id)
      recordLastAction({
        focus,
        status: 'running',
        fileId: file.id,
        fileName: result.file?.name || file.name,
        plate: result.plate || undefined,
        detail: result.plate ? `Read ${result.plate} on ${result.file?.name || file.name}` : `Finished ${file.name}`,
        done: (lastAction().done || 0) + 1,
      })
    } catch (err) {
      error = err instanceof Error ? err.message : 'OCR error'
      recordLastAction({ focus, status: 'running', fileId: file.id, fileName: file.name, detail: error })
      touchProcessItem(file.id, { stage: 'error', detail: error, name: file.name, type: file.type, mimeType: file.mimeType })
      await appendAudit(config, 'System', `OCR failed for ${file.name}: ${error}`)
    }
  })
  const processedIds = new Set(candidates.map((file) => file.id))
  const recheck = focus === 'repair' ? mergeTypedFiles(listed, renamedFiles).filter((file) => {
    if (!processedIds.has(file.id) || !isOcrImage(file.mimeType, file.name) || hasCanonicalName(file)) return false
    const named = namedPlateOf(file)
    if (!named || sheetPlates?.has(compactPlate(named))) return false
    return true
  }) : []
  if (recheck.length && !isStaleProcess(generation)) {
    await mapPool(recheck, OCR_CONCURRENCY, async (file) => {
      if (isStaleProcess(generation)) return
      try {
        const named = namedPlateOf(file)
        touchProcessItem(file.id, { stage: 'reading', detail: `Rechecking unmatched ${named} against the document`, plate: named, name: file.name, type: file.type, mimeType: file.mimeType })
        const result = await ocrAndRename(config, user, file, { verify: true })
        renamed += result.renamed
        if (result.file) renamedFiles.push(result.file)
        if (result.error && !error) error = result.error
      } catch (err) {
        error = err instanceof Error ? err.message : 'OCR error'
        touchProcessItem(file.id, { stage: 'error', detail: error, name: file.name, type: file.type, mimeType: file.mimeType })
        await appendAudit(config, 'System', `OCR failed for ${file.name}: ${error}`)
      }
    })
  }
  if (renamedFiles.length && !config.spreadsheetId && !error) {
    error = 'Renamed in Drive, but no Fleet Assets workbook is selected in Settings, so Sheets was not updated.'
  }
  if (ocrConfigured() && ocrCandidates.length && renamed === 0 && !error) {
    error = unreadPlateMessage(ocrCandidates, watching)
  }
  const stopped = isStaleProcess(generation) || isProcessCancelled()
  recordLastAction({
    focus,
    status: stopped ? 'paused' : remainingAfter > 0 ? 'running' : 'done',
    remaining: stopped ? pending.length : remainingAfter,
    done: lastAction().done,
    detail: stopped
      ? `Paused ${processFocusLabel(focus)} after ${lastAction().fileName || 'the last file'}. Start again to continue.`
      : remainingAfter > 0
        ? `${processFocusLabel(focus)} batch finished. ${remainingAfter} still need a plate.`
        : `${processFocusLabel(focus)} caught up.`,
  })
  await persistProcessCursor(config).catch(() => {})
  attachLastAction(lastAction())
  return { watching, attempted: candidates.length, renamed, remaining: stopped ? lastAction().remaining || pending.length : remainingAfter, more: !stopped && remainingAfter > 0, error: stopped ? undefined : error, renamedFiles, started: candidates.length > 0, focus, lastAction: lastAction() }
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

function sheetMatchNotice(matched?: string[], renamedFiles?: TypedFile[]) {
  const onSheet = listRegistrationNumbers(matched || [])
  if (onSheet) return `Matched Registration Number ${onSheet} on STOCK DOCUMENTS.`
  const renamed = listRegistrationNumbers((renamedFiles || []).flatMap((file) => file.plate ? [file.plate] : []))
  if (renamed) return `Renamed files for Registration Number ${renamed} in Drive.`
  return undefined
}




