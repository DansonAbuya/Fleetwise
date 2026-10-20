import { getGoogleAccessToken, googleFetch } from '@/lib/google'

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const CHIP_BATCH = 10

export type SheetTab = { sheetId: number; title: string; rowCount: number; columnCount: number }

export type GridCell = {
  formattedValue?: string
  hyperlink?: string
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean }
  userEnteredValue?: { stringValue?: string; formulaValue?: string; numberValue?: number }
  chipRuns?: { chip?: { richLinkProperties?: { uri?: string } } }[]
}

export type SheetMerge = {
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
}

export type CellContents = { value: string; uri?: string }

async function sheetsFetch(path: string, init: RequestInit = {}, attempt = 0) {
  const { token } = await getGoogleAccessToken()
  const res = await googleFetch(`${SHEETS}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (res.status === 429 && attempt < 2) {
    await sleep(15_000 * (attempt + 1))
    return sheetsFetch(path, init, attempt + 1)
  }
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 429 || text.includes('RATE_LIMIT_EXCEEDED') || text.includes('Quota exceeded')) {
      throw new Error('Google Sheets rate limit reached (60 reads per minute). Wait about a minute, then Scan folders once.')
    }
    throw new Error(text || `Sheets request failed (${res.status})`)
  }
  return res
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function quotedSheetTitle(title: string) {
  return `'${title.replace(/'/g, "''")}'`
}

export async function listTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const data = await sheetsFetch(`/${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`).then((res) => res.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[]
  }
  return (data.sheets || [])
    .map((sheet) => ({
      sheetId: sheet.properties?.sheetId ?? 0,
      title: sheet.properties?.title || '',
      rowCount: sheet.properties?.gridProperties?.rowCount || 1000,
      columnCount: sheet.properties?.gridProperties?.columnCount || 26,
    }))
    .filter((tab) => tab.title)
}

function columnLetters(count: number) {
  let n = Math.max(1, count)
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

const ROW_CHUNK = 500
const MAX_SHEET_ROWS = 25000
const MAX_SHEET_COLUMNS = 80

async function readGridRange(spreadsheetId: string, title: string, range: string) {
  const data = await sheetsFetch(
    `/${spreadsheetId}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=sheets(properties(title),merges,data(rowData(values(formattedValue,effectiveValue,hyperlink,userEnteredValue,chipRuns))))`,
  ).then((res) => res.json()) as {
    sheets?: {
      properties?: { title?: string }
      merges?: SheetMerge[]
      data?: { rowData?: { values?: GridCell[] }[] }[]
    }[]
  }
  const sheet = (data.sheets || []).find((item) => item.properties?.title === title)
    || (data.sheets || []).find((item) => item.data?.[0]?.rowData?.length)
  return {
    rowData: sheet?.data?.[0]?.rowData || [],
    merges: sheet?.merges || [],
  }
}

export async function readTabGrid(spreadsheetId: string, title: string, bounds?: { rows?: number; columns?: number }) {
  const totalRows = Math.min(Math.max(bounds?.rows || 1000, 1), MAX_SHEET_ROWS)
  const columns = Math.min(Math.max(bounds?.columns || 26, 8), MAX_SHEET_COLUMNS)
  const quoted = quotedSheetTitle(title)
  const rowData: { values?: GridCell[] }[] = []
  const merges: SheetMerge[] = []
  const seenMerges = new Set<string>()
  let emptyChunks = 0
  for (let start = 1; start <= totalRows; start += ROW_CHUNK) {
    const end = Math.min(totalRows, start + ROW_CHUNK - 1)
    const chunk = await readGridRange(spreadsheetId, title, `${quoted}!A${start}:${columnLetters(columns)}${end}`)
    for (const merge of chunk.merges) {
      const key = `${merge.startRowIndex}:${merge.endRowIndex}:${merge.startColumnIndex}:${merge.endColumnIndex}`
      if (seenMerges.has(key)) continue
      seenMerges.add(key)
      merges.push(merge)
    }
    if (!chunk.rowData.length) {
      emptyChunks += 1
      if (emptyChunks >= 2) break
      continue
    }
    emptyChunks = 0
    for (let index = 0; index < chunk.rowData.length; index += 1) {
      rowData[start - 1 + index] = chunk.rowData[index]
    }
  }
  const values = Array.from({ length: rowData.length }, (_, index) => (rowData[index]?.values || []).map((cell) => cellContents(cell).value))
  return { rowData, values, merges }
}

export async function applyChipBatches(spreadsheetId: string, chips: object[], extras: object[] = []) {
  if (extras.length) {
    await sheetsFetch(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: extras }),
    })
  }
  for (let index = 0; index < chips.length; index += CHIP_BATCH) {
    const batch = chips.slice(index, index + CHIP_BATCH)
    await sheetsFetch(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: batch }),
    })
    if (index + CHIP_BATCH < chips.length) await sleep(300)
  }
}

export function clearChipRequest(sheetId: number, row: number, column: number) {
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: '' } }] }],
      fields: 'userEnteredValue,chipRuns',
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: column - 1,
        endColumnIndex: column,
      },
    },
  }
}

export function chipRequest(sheetId: number, row: number, column: number, uri: string) {
  return {
    updateCells: {
      rows: [{
        values: [{
          userEnteredValue: { stringValue: '@' },
          chipRuns: [{
            startIndex: 0,
            chip: { richLinkProperties: { uri } },
          }],
        }],
      }],
      fields: 'userEnteredValue,chipRuns',
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: column - 1,
        endColumnIndex: column,
      },
    },
  }
}

export function headerRequest(sheetId: number, headerRow: number, column: number, title: string) {
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: title } }] }],
      fields: 'userEnteredValue',
      range: {
        sheetId,
        startRowIndex: headerRow - 1,
        endRowIndex: headerRow,
        startColumnIndex: column - 1,
        endColumnIndex: column,
      },
    },
  }
}

export function parseSheetLink(value: string) {
  const hyperlink = value.match(/HYPERLINK\s*\(\s*"([^"]+)"/i)
  if (hyperlink) return hyperlink[1]
  const url = value.match(/https?:\/\/[^\s"']+/)
  return url ? url[0] : undefined
}

export function isDriveDocumentUri(uri?: string) {
  if (!uri || !/^https?:\/\//i.test(uri.trim())) return false
  try {
    const host = new URL(uri.trim()).hostname.replace(/^www\./, '')
    return host === 'drive.google.com' || host === 'docs.google.com'
  } catch {
    return false
  }
}

export function driveIdFromUri(uri?: string) {
  if (!uri) return
  return uri.match(/\/(?:file\/d|folders)\/([a-zA-Z0-9_-]+)/)?.[1]
    || uri.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1]
}

export function driveViewLink(file: { id?: string; webViewLink?: string }) {
  if (file.webViewLink) return file.webViewLink
  if (file.id) return `https://drive.google.com/file/d/${file.id}/view`
  return ''
}

export function cellContents(cell?: GridCell): CellContents {
  if (!cell) return { value: '' }
  const uri = cell.hyperlink
    || cell.chipRuns?.[0]?.chip?.richLinkProperties?.uri
    || parseSheetLink(cell.userEnteredValue?.formulaValue || cell.formattedValue || '')
  const formula = cell.userEnteredValue?.formulaValue || ''
  const raw = (
    cell.formattedValue
    || cell.effectiveValue?.stringValue
    || cell.userEnteredValue?.stringValue
    || (cell.effectiveValue?.numberValue != null ? String(cell.effectiveValue.numberValue) : '')
    || (cell.userEnteredValue?.numberValue != null ? String(cell.userEnteredValue.numberValue) : '')
    || (formula.startsWith('=') ? '' : formula)
    || ''
  ).trim()
  return { value: raw, uri }
}

export function mergedCellValue(values: string[][], merges: SheetMerge[], rowIndex: number, colIndex: number) {
  if (colIndex < 0) return ''
  const merge = merges.find((item) => (
    rowIndex >= item.startRowIndex
    && rowIndex < item.endRowIndex
    && colIndex >= item.startColumnIndex
    && colIndex < item.endColumnIndex
  ))
  const row = merge?.startRowIndex ?? rowIndex
  const col = merge?.startColumnIndex ?? colIndex
  return String(values[row]?.[col] || '').replace(/\s+/g, ' ').trim()
}

export function pickTab(tabs: SheetTab[], wanted: string, aliases: RegExp[] = []) {
  return tabs.find((tab) => tab.title.toLowerCase() === wanted.toLowerCase())
    || aliases.map((pattern) => tabs.find((tab) => pattern.test(tab.title))).find(Boolean)
    || null
}
