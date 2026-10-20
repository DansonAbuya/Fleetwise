/**
 * STOCK DOCUMENTS workbook module.
 * To add another tab, copy this file, change id/label/headers/sync, then register it in lib/modules/index.ts.
 */
import { createFolder, folderViewLink, getFile, listChildFolders } from '@/lib/drive'
import {
  applyChipBatches,
  cellContents,
  chipRequest,
  clearChipRequest,
  driveIdFromUri,
  driveViewLink,
  headerRequest,
  isDriveDocumentUri,
  listTabs,
  parseSheetLink,
  pickTab,
  readTabGrid,
  type GridCell,
  type SheetMerge,
} from '@/lib/sheets/client'
import { insuranceState, parseCoverDate } from '@/lib/insurance'
import { compactPlate, extractKenyanPlate, plateFromText } from '@/lib/plates'
import { hasCanonicalName } from '@/lib/document-names'
import { isUnmatchedFile, onRegister, surplusCopies } from '@/lib/unmatched-files'
import { DEFAULT_COLLATERAL_PARENT_ID, type DocType, type FleetConfig, type TypedFile, type VehicleRecord } from '@/lib/types'
import type { ModuleSyncResult, SheetCell, SheetCells, SheetDocKey, SheetModule, SheetSyncMode } from '@/lib/modules/types'

export const STOCK_TAB = 'STOCK DOCUMENTS'
export const COLLATERAL_HEADER = 'Collateral Files'
export const FLEET_WORKBOOK_NAMES = ['Fleet Assets - KE', 'Fleet Assets'] as const

type ColumnKey = DocType | 'photoBranded' | 'collateral' | 'agreement'

type StockRow = {
  row: number
  plate: string
  rawPlate: string
  brand: string
  columns: Partial<Record<ColumnKey, { col: number; value: string; uri?: string }>>
  commencement?: { col: number; value: string }
  expiry?: { col: number; value: string }
}

type StockRegister = {
  title: string
  sheetId: number
  rows: Map<string, StockRow>
  plates: Set<string>
  samples: string[]
  headerRow: number
  nextColumn: number
}

const registerCache = new Map<string, { modifiedTime: string; register: StockRegister }>()

function cacheKeyFor(spreadsheetId: string) {
  return `${spreadsheetId}:stock-documents`
}

function storeRegister(spreadsheetId: string, register: StockRegister, modifiedTime = '') {
  registerCache.set(cacheKeyFor(spreadsheetId), { modifiedTime, register })
}

async function sheetModifiedTime(spreadsheetId: string) {
  try {
    const file = await getFile(spreadsheetId)
    return file.modifiedTime || ''
  } catch {
    return ''
  }
}

export function stockTabTitle(config: FleetConfig) {
  return config.logbooksSheet || STOCK_TAB
}

export function collateralParentId(config: FleetConfig) {
  return config.collateralId || process.env.DRIVE_FOLDER_COLLATERAL || DEFAULT_COLLATERAL_PARENT_ID
}

export async function readStockRegisterSnapshot(config: FleetConfig, options?: { fresh?: boolean }) {
  if (!config.spreadsheetId) {
    return { vehicles: [] as VehicleRecord[], unmatched: [] as TypedFile[], duplicates: [], plates: new Set<string>(), cells: new Map() as SheetCells, error: undefined as string | undefined }
  }
  try {
    const cacheKey = cacheKeyFor(config.spreadsheetId)
    const before = registerCache.get(cacheKey)?.modifiedTime || ''
    const register = await loadStockRegister(config, options)
    const after = registerCache.get(cacheKey)?.modifiedTime || ''
    const cells = cellsFromRegister(register)
    const built = buildRegister([], { keys: register.plates, cells })
    return { ...built, plates: register.plates, cells, refreshed: !before || before !== after, error: register.rows.size ? undefined : `Tab '${register.title}' in ${config.spreadsheetName || 'the workbook'} had no readable Registration Number plates.` }
  } catch (err) {
    return {
      vehicles: [] as VehicleRecord[],
      unmatched: [] as TypedFile[],
      duplicates: [],
      plates: new Set<string>(),
      cells: new Map() as SheetCells,
      refreshed: false,
      error: err instanceof Error ? err.message : 'Unable to read STOCK DOCUMENTS',
    }
  }
}

export async function loadStockRegister(config: FleetConfig, options?: { fresh?: boolean }): Promise<StockRegister> {
  if (!config.spreadsheetId) {
    return { title: STOCK_TAB, sheetId: 0, rows: new Map(), plates: new Set(), samples: [], headerRow: 1, nextColumn: 1 }
  }
  const cacheKey = cacheKeyFor(config.spreadsheetId)
  const modifiedTime = await sheetModifiedTime(config.spreadsheetId)
  const cached = registerCache.get(cacheKey)
  if (!options?.fresh && modifiedTime && cached?.modifiedTime === modifiedTime) return cached.register
  const tabs = await listTabs(config.spreadsheetId)
  const preferred = pickTab(tabs, STOCK_TAB, [/stock documents?/i]) || pickTab(tabs, stockTabTitle(config), [/stock document/i, /stock/i, /register/i])
  const fallbacks = tabs.filter((tab) => /stock|register|fleet/i.test(tab.title) && tab.title !== preferred?.title)
  const toRead = preferred || fallbacks.length ? [...(preferred ? [preferred] : []), ...fallbacks] : tabs
  let lastError = ''
  for (const tab of toRead) {
    try {
      const register = await readStockTab(config.spreadsheetId, tab.title, tab.sheetId, { rows: tab.rowCount, columns: tab.columnCount })
      storeRegister(config.spreadsheetId, register, modifiedTime)
      return register
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unable to read sheet'
    }
  }
  throw new Error(lastError || `${config.spreadsheetName || 'The workbook'} has no tab with a Registration Number column.`)
}

async function writeSheetMatches(config: FleetConfig, files: TypedFile[], mode: SheetSyncMode = 'auto') {
  if (!config.spreadsheetId) return emptySync()
  const register = await loadStockRegister(config)
  const missing: string[] = []
  const matched: string[] = []
  const seenMissing = new Set<string>()
  const seenMatched = new Set<string>()
  const chipRequests: object[] = []
  const writeLimit = mode === 'full' ? 400 : 80
  const filesById = new Map(files.map((file) => [file.id, file]))
  const bestForRow = new Map<string, TypedFile>()
  for (const file of files) {
    if ((file.type === 'logbook' || file.type === 'agreement' || file.type === 'certificate') && !hasCanonicalName(file)) continue
    const plate = filePlate(file)
    if (!plate) continue
    const key = `${columnKeyForFile(file.type, file.name)}:${plate}`
    const previous = bestForRow.get(key)
    if (!previous || (canonicalFileName(file) && !canonicalFileName(previous))) bestForRow.set(key, file)
  }

  function queueChip(row: StockRow, column: { col: number; value: string; uri?: string }, file: TypedFile) {
    const link = driveViewLink(file)
    if (!link) return
    chipRequests.push(chipRequest(register.sheetId, row.row, column.col, link))
    column.value = chipTitle(file)
    column.uri = link
    if (!seenMatched.has(row.plate)) {
      seenMatched.add(row.plate)
      matched.push(row.plate)
    }
  }

  for (const row of register.rows.values()) {
    for (const key of ['logbook', 'agreement', 'certificate', 'photo', 'photoBranded'] as ColumnKey[]) {
      const column = row.columns[key]
      if (!column || chipRequests.length >= writeLimit) continue
      const correct = bestForRow.get(`${key}:${row.plate}`)
      const linkedId = column.uri ? driveIdFromUri(column.uri) : ''
      const linked = linkedId ? filesById.get(linkedId) : undefined
      const currentPlate = linked
        ? filePlate(linked)
        : compactPlate(plateFromText(column.value || '') || '')
      const hasChip = isDriveDocumentUri(column.uri)
      if (correct) {
        const title = chipTitle(correct)
        const shown = chipTitle({ name: column.value || '' })
        const already = hasChip && linkedId === correct.id && shown === title
        if (!already) queueChip(row, column, correct)
        continue
      }
      if (key === 'logbook' && hasChip && linked && !hasCanonicalName(linked)) {
        chipRequests.push(clearChipRequest(register.sheetId, row.row, column.col))
        column.value = ''
        column.uri = undefined
        continue
      }
      if (key === 'agreement' && hasChip && linked?.type === 'agreement' && !hasCanonicalName(linked)) {
        chipRequests.push(clearChipRequest(register.sheetId, row.row, column.col))
        column.value = ''
        column.uri = undefined
        continue
      }
      if (hasChip && !currentPlate && linkedId && !linked) continue
      if (hasChip && currentPlate && currentPlate !== row.plate) {
        chipRequests.push(clearChipRequest(register.sheetId, row.row, column.col))
        column.value = ''
        column.uri = undefined
      }
    }
  }

  for (const file of files) {
    if (file.type === 'logbook' || file.type === 'certificate' || file.type === 'photo' || file.type === 'agreement') continue
    const plate = filePlate(file)
    if (!plate) continue
    const link = driveViewLink(file)
    if (!link) continue
    const row = register.rows.get(plate) || rowByLoosePlate(register, plate)
    if (!row) {
      if (!seenMissing.has(plate)) {
        seenMissing.add(plate)
        missing.push(plate)
      }
      continue
    }
    const key = columnKeyForFile(file.type, file.name)
    const column = row.columns[key]
    if (!column || isDriveDocumentUri(column.uri) || chipRequests.length >= writeLimit) continue
    queueChip(row, column, file)
  }

  for (const file of files) {
    if (file.type !== 'logbook' && file.type !== 'certificate' && file.type !== 'photo' && file.type !== 'agreement') continue
    const plate = filePlate(file)
    if (plate && !register.rows.has(plate) && !rowByLoosePlate(register, plate) && !seenMissing.has(plate)) {
      seenMissing.add(plate)
      missing.push(plate)
    }
  }

  if (chipRequests.length) {
    await applyChipBatches(config.spreadsheetId, chipRequests)
    storeRegister(config.spreadsheetId, register)
  }
  const sampleText = register.samples.length
    ? ` Values already in Registration Number on '${register.title}': ${register.samples.join(', ')}.`
    : ` Tab '${register.title}' in ${config.spreadsheetName || 'the workbook'} had no readable plates in Registration Number.`
  return {
    plates: register.plates,
    written: chipRequests.length,
    missing,
    matched,
    hint: missing.length ? sampleText : '',
    cells: cellsFromRegister(register),
    more: chipRequests.length >= writeLimit,
  }
}

export async function linkUnlinkedDocuments(config: FleetConfig, type: 'photo' | 'certificate' | 'logbook', files: TypedFile[]) {
  if (!config.spreadsheetId) return { written: 0, matched: [] as string[], missing: [] as string[], cells: new Map() as SheetCells }
  const register = await loadStockRegister(config, { fresh: true })
  const byPlate = new Map<string, TypedFile[]>()
  for (const file of files) {
    if (file.type !== type) continue
    const plate = filePlate(file)
    if (!plate || !driveViewLink(file)) continue
    const list = byPlate.get(plate) || []
    list.push(file)
    byPlate.set(plate, list)
  }
  const missing: string[] = []
  for (const plate of byPlate.keys()) {
    if (!register.rows.has(plate) && !rowByLoosePlate(register, plate)) missing.push(plate)
  }
  const chipRequests: object[] = []
  const matched: string[] = []
  const seen = new Set<string>()
  let unnamed = 0

  function queue(row: StockRow, column: { col: number; value: string; uri?: string }, file: TypedFile) {
    const link = driveViewLink(file)
    if (!link || isDriveDocumentUri(column.uri)) return
    chipRequests.push(chipRequest(register.sheetId, row.row, column.col, link))
    column.value = chipTitle(file)
    column.uri = link
    if (!seen.has(row.plate)) {
      seen.add(row.plate)
      matched.push(row.plate)
    }
  }

  function take(pool: TypedFile[], prefer: (file: TypedFile) => boolean) {
    const index = pool.findIndex(prefer)
    const chosen = index >= 0 ? pool.splice(index, 1)[0] : pool.shift()
    return chosen
  }

  for (const row of register.rows.values()) {
    const pool = [...(byPlate.get(row.plate) || [])]
    if (!pool.length) continue
    if (type === 'certificate') {
      const column = row.columns.certificate
      if (column && !isDriveDocumentUri(column.uri)) {
        const canonical = pool.find((file) => hasCanonicalName(file))
        if (canonical) queue(row, column, canonical)
        else unnamed += 1
      }
      continue
    }
    if (type === 'logbook') {
      const column = row.columns.logbook
      if (column && !isDriveDocumentUri(column.uri)) {
        const canonical = pool.find((file) => hasCanonicalName(file))
        if (canonical) queue(row, column, canonical)
        else unnamed += 1
      }
      continue
    }
    const brandedColumn = row.columns.photoBranded
    if (brandedColumn && !isDriveDocumentUri(brandedColumn.uri)) {
      const brandedIndex = pool.findIndex((file) => /branded/i.test(file.name))
      if (brandedIndex >= 0) queue(row, brandedColumn, pool.splice(brandedIndex, 1)[0])
    }
    const photoColumn = row.columns.photo
    if (photoColumn && !isDriveDocumentUri(photoColumn.uri)) {
      const normal = brandedColumn ? pool.filter((file) => !/branded/i.test(file.name)) : pool
      const file = take(normal, (file) => canonicalFileName(file) && !/branded/i.test(file.name))
      if (file) queue(row, photoColumn, file)
    }
  }

  if (chipRequests.length) {
    await applyChipBatches(config.spreadsheetId, chipRequests)
    storeRegister(config.spreadsheetId, register)
  }
  return { written: chipRequests.length, matched, missing, unnamed, cells: cellsFromRegister(register) }
}

function chipTitle(file: { name?: string }) {
  return (file.name || '').replace(/\.(pdf|jpe?g|png|webp|gif|heic)$/i, '').trim()
}

function filePlate(file: TypedFile) {
  const raw = file.plate || extractKenyanPlate(file.name)
  return raw ? compactPlate(raw) : ''
}

function canonicalFileName(file: TypedFile) {
  if (file.type === 'logbook' || file.type === 'agreement') return hasCanonicalName(file)
  const plate = filePlate(file)
  if (!plate) return false
  if (file.type === 'photo') return /^photos\s+/i.test(file.name) && file.name.toUpperCase().includes(plate)
  if (file.type === 'certificate') return /^insurance\s*-/i.test(file.name) && file.name.toUpperCase().includes(plate)
  return file.name.toUpperCase().includes(plate)
}

async function ensureCollateralFolders(config: FleetConfig, mode: SheetSyncMode) {
  if (mode === 'match' || !config.spreadsheetId) return { written: 0, created: 0, cells: new Map() as SheetCells, more: false }
  const register = await loadStockRegister(config, { fresh: true })
  if (!register.rows.size) return { written: 0, created: 0, cells: cellsFromRegister(register), more: false }
  const requests: ReturnType<typeof chipRequest>[] = []
  let header: ReturnType<typeof headerRequest> | undefined
  let collateralCol = [...register.rows.values()][0]?.columns.collateral?.col
  if (!collateralCol) {
    collateralCol = register.nextColumn
    header = headerRequest(register.sheetId, register.headerRow, collateralCol, COLLATERAL_HEADER)
    for (const row of register.rows.values()) {
      row.columns.collateral = { col: collateralCol, value: '', uri: undefined }
    }
  }
  const createLimit = mode === 'full' ? 150 : 30
  const writeLimit = mode === 'full' ? 400 : 80
  const parentId = collateralParentId(config)
  const existing = await listChildFolders(parentId)
  const byName = new Map<string, typeof existing[number]>()
  for (const folder of existing) {
    byName.set(folder.name.trim().toLowerCase(), folder)
    const plate = extractKenyanPlate(folder.name)
    if (plate && !byName.has(plate.toLowerCase())) byName.set(plate.toLowerCase(), folder)
  }
  let created = 0
  function chipFolder(row: StockRow, folder: { id: string; name: string; webViewLink?: string }) {
    const column = row.columns.collateral
    if (!column || requests.length >= writeLimit) return
    const link = folderViewLink(folder.id, folder.webViewLink)
    requests.push(chipRequest(register.sheetId, row.row, column.col, link))
    column.value = folder.name
    column.uri = link
  }
  for (const row of register.rows.values()) {
    const column = row.columns.collateral
    if (!column || isDriveDocumentUri(column.uri)) continue
    const folder = byName.get(row.plate.toLowerCase()) || byName.get(row.rawPlate.trim().toLowerCase())
    if (folder) chipFolder(row, folder)
  }
  for (const row of register.rows.values()) {
    const column = row.columns.collateral
    if (!column || isDriveDocumentUri(column.uri)) continue
    if (created >= createLimit || requests.length >= writeLimit) break
    const folder = await createFolder(parentId, row.plate)
    created++
    byName.set(row.plate.toLowerCase(), folder)
    byName.set(folder.name.trim().toLowerCase(), folder)
    chipFolder(row, folder)
  }
  if (header || requests.length) {
    await applyChipBatches(config.spreadsheetId, requests, header ? [header] : [])
    register.nextColumn = Math.max(register.nextColumn, collateralCol + 1)
    storeRegister(config.spreadsheetId, register)
  }
  const stillOpen = [...register.rows.values()].some((row) => row.columns.collateral && !isDriveDocumentUri(row.columns.collateral.uri))
  const hitCap = created >= createLimit || requests.length >= writeLimit
  return { written: requests.length, created, cells: cellsFromRegister(register), more: hitCap && stillOpen }
}

function mergeStockColumns(current: StockRow['columns'], incoming: StockRow['columns']): StockRow['columns'] {
  const merged = { ...current }
  for (const key of Object.keys(incoming) as ColumnKey[]) {
    const next = incoming[key]
    const prev = merged[key]
    if (!next) continue
    if (!prev) {
      merged[key] = next
      continue
    }
    const nextLinked = isDriveDocumentUri(next.uri)
    const prevLinked = isDriveDocumentUri(prev.uri)
    if (nextLinked && !prevLinked) merged[key] = next
    else if (!prevLinked && (next.value || '').trim() && !(prev.value || '').trim()) merged[key] = next
  }
  return merged
}

function cellsFromRegister(register: StockRegister): SheetCells {
  const cells: SheetCells = new Map()
  for (const [plate, row] of register.rows) {
    cells.set(plate, {
      logbook: sheetCell(row.columns.logbook),
      certificate: sheetCell(row.columns.certificate),
      photo: sheetCell(row.columns.photo) || sheetCell(row.columns.photoBranded),
      collateral: sheetCell(row.columns.collateral),
      agreement: sheetCell(row.columns.agreement),
      brand: row.brand || undefined,
      commencement: row.commencement?.value || undefined,
      expiry: row.expiry?.value || undefined,
    })
  }
  return cells
}

function sheetCell(column?: { value: string; uri?: string }): SheetCell | undefined {
  const label = (column?.value || '').trim()
  const uri = column?.uri || parseSheetLink(label)
  if (!isDriveDocumentUri(uri)) return
  return { label: label && label !== '@' ? label : 'Already on STOCK DOCUMENTS', uri }
}

function rowByLoosePlate(register: StockRegister, plate: string) {
  return [...register.rows.values()].find((row) => compactPlate(row.plate) === plate) || null
}

function emptyVehicleFiles(): VehicleRecord['files'] {
  return { logbook: [], certificate: [], photo: [], agreement: [] }
}

function columnKeyForFile(type: DocType, name?: string): ColumnKey {
  if (type === 'photo' && /branded/i.test(name || '')) return 'photoBranded'
  return type
}

function emptySync() {
  return { plates: new Set<string>(), written: 0, missing: [] as string[], matched: [] as string[], hint: '', cells: new Map() as SheetCells, more: false }
}

async function readStockTab(spreadsheetId: string, title: string, sheetId: number, bounds?: { rows?: number; columns?: number }): Promise<StockRegister> {
  const { rowData, values, merges } = await readTabGrid(spreadsheetId, title, bounds)
  if (!values.length) throw new Error(`'${title}' is empty.`)
  const header = findHeader(values)
  if (!header) throw new Error(`'${title}' needs a header row with Registration Number.`)
  const rows = new Map<string, StockRow>()
  const plates = new Set<string>()
  const samples: string[] = []
  values.slice(header.index + 1).forEach((row, offset) => {
    const gridRow = header.index + 1 + offset
    const raw = String(row[header.plateIndex] || '').trim()
    if (raw && samples.length < 8) samples.push(raw.replace(/\s+/g, ' ').slice(0, 40))
    const plate = extractKenyanPlate(raw) || plateFromRow(row, header.plateIndex)
    if (!plate) return
    const cells = rowData[gridRow]?.values || []
    const stockRow: StockRow = {
      row: gridRow + 1,
      plate,
      rawPlate: raw,
      brand: brandFromRow(rowData, merges, gridRow, header.brandIndexes),
      columns: {
        logbook: columnFromCell(header.logbookIndex, cells[header.logbookIndex]),
        certificate: columnFromCell(header.insuranceIndex, cells[header.insuranceIndex]),
        photo: columnFromCell(header.photoIndex, cells[header.photoIndex]),
        ...(header.brandedIndex >= 0 ? { photoBranded: columnFromCell(header.brandedIndex, cells[header.brandedIndex]) } : {}),
        ...(header.collateralIndex >= 0 ? { collateral: columnFromCell(header.collateralIndex, cells[header.collateralIndex]) } : {}),
        ...(header.agreementIndex >= 0 ? { agreement: columnFromCell(header.agreementIndex, cells[header.agreementIndex]) } : {}),
      },
      commencement: dateColumnFromCell(header.commencementIndex, cells[header.commencementIndex]),
      expiry: dateColumnFromCell(header.expiryIndex, cells[header.expiryIndex]),
    }
    const existing = rows.get(plate)
    if (existing) {
      if (!existing.brand && stockRow.brand) existing.brand = stockRow.brand
      existing.columns = mergeStockColumns(existing.columns, stockRow.columns)
      if (!existing.commencement?.value && stockRow.commencement?.value) existing.commencement = stockRow.commencement
      if (!existing.expiry?.value && stockRow.expiry?.value) existing.expiry = stockRow.expiry
    } else {
      rows.set(plate, stockRow)
    }
    plates.add(plate)
  })
  return { title, sheetId, rows, plates, samples, headerRow: header.index + 1, nextColumn: Math.max(values[header.index]?.length || 0, 1) + 1 }
}

function columnFromCell(index: number, cell?: GridCell) {
  if (index < 0) return undefined
  const contents = cellContents(cell)
  return { col: index + 1, value: contents.value, uri: contents.uri }
}

function dateColumnFromCell(index: number, cell?: GridCell) {
  if (index < 0) return undefined
  return { col: index + 1, value: cellContents(cell).value }
}

function isCommencementHeader(cell: string) {
  if (!cell) return false
  if (cell.includes('expir')) return false
  return cell.includes('commencement') || cell.includes('cover start') || cell.includes('inception') || (cell.includes('period') && cell.includes('from'))
}

function isExpiryHeader(cell: string) {
  if (!cell) return false
  if (cell.includes('commencement')) return false
  return cell.includes('expir') || cell.includes('cover end') || (cell.includes('period') && (cell.includes('to') || cell.includes('until')))
}

function findHeader(values: string[][]) {
  for (let index = 0; index < Math.min(values.length, 25); index++) {
    const header = values[index].map(normalizeHeader)
    const next = (values[index + 1] || []).map(normalizeHeader)
    const plateIndex = header.findIndex(isPlateHeader)
    const logbookIndex = header.findIndex((cell) => cell.includes('logbook'))
    const agreementIndex = headerIndex(header, next, isAgreementHeader)
    const insuranceIndex = header.findIndex((cell) => cell.includes('insurance') || cell.includes('psv'))
    const brandedIndex = header.findIndex((cell) => (cell.includes('asset photo') || cell.includes('photo')) && cell.includes('branded'))
    const photoIndex = header.findIndex((cell, col) => isPhotoHeader(cell) && col !== brandedIndex)
    const collateralIndex = header.findIndex((cell) => cell.includes('collateral'))
    const commencementIndex = header.findIndex(isCommencementHeader)
    const expiryIndex = header.findIndex(isExpiryHeader)
    const brandIndexes = brandColumnIndexes(header, next.some((cell) => extractKenyanPlate(cell)) ? [] : next)
    if (plateIndex >= 0) {
      return { index, plateIndex, logbookIndex, agreementIndex, insuranceIndex, photoIndex, brandedIndex, collateralIndex, commencementIndex, expiryIndex, brandIndexes }
    }
  }
  return null
}

function isAgreementHeader(cell: string) {
  if (!cell) return false
  if (cell.includes('logbook')) return false
  return cell.includes('agreement')
}

function headerIndex(header: string[], next: string[], match: (cell: string) => boolean) {
  const top = header.findIndex(match)
  if (top >= 0) return top
  if (next.some((cell) => extractKenyanPlate(cell))) return -1
  return next.findIndex(match)
}

function isPlateHeader(cell: string) {
  return cell.includes('registration') || cell.includes('reg no') || cell.includes('reg. no') || cell.includes('reg number') || cell === 'plate' || cell.includes('number plate')
}

function isPhotoHeader(cell: string) {
  if (cell.includes('branded')) return false
  return cell.includes('asset photo') || cell.includes('asset image') || cell === 'photo' || cell.endsWith(' photo') || cell.startsWith('photo')
}

function isBrandHeader(cell: string) {
  if (!cell) return false
  if (cell.includes('photo') || cell.includes('branded') || cell.includes('collateral') || cell.includes('commencement') || cell.includes('expir')) return false
  if (/\bbrand\b/.test(cell)) return true
  return cell === 'make' || cell === 'oem' || cell === 'manufacturer'
}

function brandHeaderScore(cell: string) {
  if (cell === 'brand') return 0
  if (cell.startsWith('brand ') || cell.endsWith(' brand')) return 1
  if (/\bbrand\b/.test(cell)) return 2
  return 3
}

function brandColumnIndexes(header: string[], next: string[]) {
  const width = Math.max(header.length, next.length)
  const scored: { index: number; score: number }[] = []
  for (let index = 0; index < width; index++) {
    const top = header[index] || ''
    const bottom = next[index] || ''
    const combined = [top, bottom].filter(Boolean).join(' ')
    const label = [top, bottom, combined].find(isBrandHeader)
    if (!label) continue
    scored.push({ index, score: brandHeaderScore(label) })
  }
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  const brandCols = scored.filter((item) => item.score <= 2)
  return [...new Set((brandCols.length ? brandCols : scored).map((item) => item.index))]
}

function cleanBrand(value: string) {
  const brand = value.replace(/[\u00A0\u2000-\u200B]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!brand || brand === '@') return ''
  if (/^https?:\/\//i.test(brand) || /^=/i.test(brand)) return ''
  if (/^(n\/?a|na|none|nil|null|unassigned|-|—|–|no brand)$/i.test(brand)) return ''
  return brand
}

function brandFromRow(rowData: { values?: GridCell[] }[], merges: SheetMerge[], gridRow: number, brandIndexes: number[]) {
  for (const index of brandIndexes) {
    const merge = merges.find((item) => (
      gridRow >= item.startRowIndex
      && gridRow < item.endRowIndex
      && index >= item.startColumnIndex
      && index < item.endColumnIndex
    ))
    const row = merge?.startRowIndex ?? gridRow
    const col = merge?.startColumnIndex ?? index
    const cell = rowData[row]?.values?.[col]
    const brand = cleanBrand(cell?.formattedValue || '')
    if (brand) return brand
  }
  return ''
}

function plateFromRow(row: string[], plateIndex: number) {
  return extractKenyanPlate(row[plateIndex] || '') || row.map((cell) => extractKenyanPlate(cell || '')).find(Boolean) || null
}

function normalizeHeader(value: string) {
  return String(value || '').toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function formatSheetTime(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function sheetDocumentName(value: string) {
  if (/^=HYPERLINK/i.test(value) || /^https?:\/\//i.test(value) || value === '@') return 'On STOCK DOCUMENTS'
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.slice(0, 80) || 'On STOCK DOCUMENTS'
}

function sheetMeta(cells: SheetCells | undefined, plate: string) {
  return cells?.get(plate) || cells?.get(compactPlate(plate))
}

function buildRegister(files: TypedFile[], sync: Pick<ModuleSyncResult, 'keys' | 'cells'>) {
  const sheetPlates = sync.keys
  const sheetCells = sync.cells
  const onSheet = (plate: string | null) => onRegister(plate, sheetPlates)
  const duplicates = surplusCopies(files, sheetCells)
  const duplicateIds = new Set(duplicates.map((file) => file.id))
  const unmatched = files.filter((file) => !duplicateIds.has(file.id) && isUnmatchedFile(file, sheetPlates))
  const byPlate = new Map<string, VehicleRecord>()
  for (const plate of sheetPlates || []) {
    byPlate.set(plate, {
      plate,
      brand: sheetMeta(sheetCells, plate)?.brand || '',
      files: emptyVehicleFiles(),
      present: 0,
      total: 5 as const,
      status: 'Needs attention' as const,
      updated: '',
    })
  }
  for (const file of files) {
    if ((file.type === 'logbook' || file.type === 'agreement') && !hasCanonicalName(file)) continue
    if (!onSheet(file.plate) || !file.plate) continue
    const current = byPlate.get(file.plate) || {
      plate: file.plate,
      brand: sheetMeta(sheetCells, file.plate)?.brand || '',
      files: emptyVehicleFiles(),
      present: 0,
      total: 5 as const,
      status: 'Needs attention' as const,
      updated: file.modifiedTime || '',
    }
    current.files[file.type].push(file)
    if (!current.updated || (file.modifiedTime && file.modifiedTime > current.updated)) current.updated = file.modifiedTime || current.updated
    byPlate.set(file.plate, current)
  }
  if (sheetCells?.size) {
    for (const vehicle of byPlate.values()) {
      const cells = sheetMeta(sheetCells, vehicle.plate)
      if (cells?.brand) vehicle.brand = cells.brand
      else vehicle.brand = vehicle.brand || ''
      for (const type of ['logbook', 'certificate', 'photo', 'agreement'] as DocType[]) {
        const cell = cells?.[type]
        if (!cell?.uri || !isDriveDocumentUri(cell.uri)) {
          vehicle.files[type] = []
          continue
        }
        const targetId = driveIdFromUri(cell.uri)
        const linked = files.find((file) => (
          type === 'agreement'
            ? file.id === targetId || file.parents?.includes(targetId || '')
            : file.type === type && (file.id === targetId || file.parents?.includes(targetId || ''))
        ))
        const linkedPlate = linked ? compactPlate(linked.plate || extractKenyanPlate(linked.name) || '') : ''
        if (type === 'logbook' && linked && !hasCanonicalName(linked)) {
          vehicle.files[type] = []
          continue
        }
        if (type === 'agreement' && linked?.type === 'agreement' && !hasCanonicalName(linked)) {
          vehicle.files[type] = []
          continue
        }
        if (linked && linkedPlate && linkedPlate !== compactPlate(vehicle.plate)) {
          vehicle.files[type] = []
          continue
        }
        vehicle.files[type] = linked
          ? [{ ...linked, plate: vehicle.plate }]
          : [{
              id: `sheet:${type}:${vehicle.plate}`,
              name: sheetDocumentName(cell.label),
              webViewLink: cell.uri,
              type,
              plate: vehicle.plate,
            }]
      }
      const collateral = cells?.collateral
      vehicle.collateral = collateral?.uri && isDriveDocumentUri(collateral.uri)
        ? {
            id: driveIdFromUri(collateral.uri) || `sheet:collateral:${vehicle.plate}`,
            name: sheetDocumentName(collateral.label),
            webViewLink: collateral.uri,
          }
        : undefined
      const commencement = parseCoverDate(cells?.commencement || '')
      const expiry = parseCoverDate(cells?.expiry || '')
      if (commencement || expiry) vehicle.insurance = insuranceState({ commencement, expiry })
    }
  }
  const vehicles = [...byPlate.values()].map((vehicle) => {
    const linkedAgreement = vehicle.files.agreement[0]
    const agreement = linkedAgreement
      ? { id: linkedAgreement.id, name: linkedAgreement.name, webViewLink: linkedAgreement.webViewLink }
      : undefined
    const present = (['logbook', 'certificate', 'photo', 'agreement'] as DocType[]).filter((type) => vehicle.files[type].length > 0).length
      + (vehicle.collateral ? 1 : 0)
    return {
      ...vehicle,
      agreement,
      present,
      total: 5 as const,
      status: present === 5 ? 'Complete' as const : 'Needs attention' as const,
      updated: formatSheetTime(vehicle.updated),
    }
  }).sort((a, b) => a.plate.localeCompare(b.plate))
  return { vehicles, unmatched, duplicates }
}

async function sync(config: FleetConfig, files: TypedFile[], mode: SheetSyncMode): Promise<ModuleSyncResult> {
  if (!config.spreadsheetId) {
    return { moduleId: 'stock-documents', keys: new Set(), written: 0, missing: [], matched: [], hint: '', cells: new Map() }
  }
  const matches = await writeSheetMatches(config, files, mode)
  const collateral = mode === 'full'
    ? await ensureCollateralFolders(config, mode)
    : { written: 0, cells: matches.cells, more: false }
  return {
    moduleId: 'stock-documents',
    keys: matches.plates,
    written: matches.written + collateral.written,
    missing: matches.missing,
    matched: matches.matched,
    hint: matches.hint,
    cells: collateral.cells || matches.cells,
    more: Boolean(matches.more || collateral.more),
  }
}

export const stockDocumentsModule: SheetModule = {
  id: 'stock-documents',
  label: STOCK_TAB,
  description: 'Matches Drive logbooks, certificates, photos, and collateral folders to Registration Number rows on STOCK DOCUMENTS.',
  matchHint: ' Add that plate on the STOCK DOCUMENTS tab, then Scan folders to fill Asset Photo.',
  sync,
  buildRegister,
}

export { isDriveDocumentUri, driveIdFromUri }
export type { SheetCell, SheetCells, SheetDocKey }
