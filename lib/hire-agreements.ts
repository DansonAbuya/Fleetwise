import { downloadBinary, downloadNamedFile } from '@/lib/drive'
import { linkedAgreementFileIds, writeAgreementChips } from '@/lib/modules/stock-documents'
import { compactPlate, listRegistrationNumbers } from '@/lib/plates'
import { beginProcessJob, endProcessJob, isProcessCancelled, isProcessRunning, touchProcessItem } from '@/lib/processing'
import { agreementReadList, clearAgreementReads, lastAction, persistProcessCursor, recordLastAction, rememberAgreementReads, type AgreementRead } from '@/lib/process-cursor'
import { inspectHirePurchase } from '@/lib/read-plate-runner'
import type { FleetConfig, TypedFile } from '@/lib/types'

// One pass has to keep the job at 10 or more agreements a minute once the folder list is cached.
const READ_CONCURRENCY = process.env.VERCEL ? 4 : 5
const READ_LIMIT = process.env.VERCEL ? 10 : 12
const READ_BUDGET_MS = process.env.VERCEL ? 22000 : 40000
const DOWNLOAD_TIMEOUT_MS = 12000
const HANDOFF_MS = process.env.VERCEL ? 18000 : 25000

let uploadedIdCache: { spreadsheetId: string; ids: Set<string> } | null = (globalThis as typeof globalThis & { __fleetwiseUploadedAgreements?: { spreadsheetId: string; ids: Set<string> } | null }).__fleetwiseUploadedAgreements || null

async function cachedUploadedIds(config: FleetConfig) {
  const store = globalThis as typeof globalThis & { __fleetwiseUploadedAgreements?: { spreadsheetId: string; ids: Set<string> } | null }
  if (store.__fleetwiseUploadedAgreements?.spreadsheetId === config.spreadsheetId) return store.__fleetwiseUploadedAgreements.ids
  if (uploadedIdCache?.spreadsheetId === config.spreadsheetId) return uploadedIdCache.ids
  const ids = await linkedAgreementFileIds(config).catch(() => new Set<string>())
  uploadedIdCache = { spreadsheetId: config.spreadsheetId || '', ids }
  store.__fleetwiseUploadedAgreements = uploadedIdCache
  return ids
}

function cardFile(file: TypedFile) {
  return { id: file.id, name: file.name, type: 'agreement' as const, mimeType: file.mimeType }
}

function showAgreement(file: TypedFile, stage: 'queued' | 'opening' | 'reading' | 'matching' | 'matched' | 'unmatched' | 'error', detail: string, plate?: string | null) {
  touchProcessItem(file.id, { stage, detail, plate, name: file.name, type: 'agreement', mimeType: file.mimeType })
}

function readKey(file: { id: string; modifiedTime?: string }) {
  return `${file.id}:${file.modifiedTime || ''}`
}

function isAgreementPdf(file: TypedFile) {
  return file.type === 'agreement' && (/\.pdf$/i.test(file.name) || (file.mimeType || '').toLowerCase().includes('pdf'))
}

function agreementSettled(read?: AgreementRead) {
  return Boolean(read && (read.skipped || read.plate || (read.attempts || 0) >= 2))
}

function skipLabel(name: string) {
  return name.replace(/\.pdf$/i, '')
}

function skipNotice(files: { name: string; plate?: string }[]) {
  if (!files.length) return ''
  const labels = files.map((file) => {
    const name = skipLabel(file.name)
    return file.plate ? `${name} (${file.plate})` : name
  })
  const shown = labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')}, and ${labels.length - 3} more`
  return `Skipped ${files.length} agreement${files.length === 1 ? '' : 's'} already on Agreement Link: ${shown}.`
}

function chooseSigned(reads: AgreementRead[]) {
  const chosen: AgreementRead[] = []
  let unsigned = 0
  let unread = 0
  const byPlate = new Map<string, AgreementRead[]>()
  for (const read of reads) {
    if (!read.plate || read.skipped) {
      if (!read.plate && (read.attempts || 0) >= 2) unread += 1
      continue
    }
    const list = byPlate.get(read.plate) || []
    list.push(read)
    byPlate.set(read.plate, list)
  }
  for (const list of byPlate.values()) {
    const signed = list.filter((read) => read.signed)
    const pool = signed.length ? signed : list
    if (!signed.length) unsigned += list.length
    pool.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    chosen.push(pool[0])
  }
  return { chosen, unsigned, unread }
}

async function placeAgreementChips(config: FleetConfig, reads: AgreementRead[]) {
  const { chosen } = chooseSigned(reads)
  const linkedByPlate = new Map<string, AgreementRead>()
  for (const read of reads) {
    if (read.linked && read.plate) linkedByPlate.set(read.plate, read)
  }
  const toWrite = chosen.filter((file) => !file.skipped && linkedByPlate.get(file.plate)?.id !== file.id)
  if (!toWrite.length) return { written: 0, matched: [] as string[], missing: [] as string[], writtenIds: [] as string[], skipped: [] as { id: string; name: string; plate: string }[], noColumn: false }
  const ownIds = new Set([...linkedByPlate.values()].map((read) => read.id))
  const linked = await writeAgreementChips(config, toWrite, ownIds)
  const writtenIds = new Set(linked.writtenIds)
  const skippedPlates = new Set(linked.skipped.map((file) => file.plate))
  for (const read of reads) {
    if (read.plate && skippedPlates.has(read.plate)) read.skipped = true
    if (!writtenIds.has(read.id)) continue
    const previous = linkedByPlate.get(read.plate)
    if (previous && previous !== read) previous.linked = false
    read.linked = true
    read.skipped = false
  }
  return linked
}

async function readAgreementPass(config: FleetConfig, files: TypedFile[], budgetMs: number) {
  const watching = config.agreementsName || 'agreements'
  if (!config.agreementsId) {
    return { watching, attempted: 0, renamed: 0, remaining: 0, more: false, error: 'Choose the Loan Agreements folder in Settings first.', renamedFiles: [] as TypedFile[], started: true, focus: 'agreements' as const, notice: 'Choose the Loan Agreements folder in Settings first.' }
  }
  if (!config.spreadsheetId) {
    return { watching, attempted: 0, renamed: 0, remaining: 0, more: false, error: 'Choose the Fleet Assets workbook in Settings first.', renamedFiles: [] as TypedFile[], started: true, focus: 'agreements' as const, notice: 'Choose the Fleet Assets workbook in Settings first.' }
  }
  const pdfs = files.filter(isAgreementPdf)
  if (!pdfs.length) {
    clearAgreementReads()
    recordLastAction({ focus: 'agreements', status: 'done', remaining: 0, detail: 'No agreement PDFs were found.' })
    await persistProcessCursor(config).catch(() => {})
    return { watching, attempted: 0, renamed: 0, remaining: 0, more: false, error: undefined as string | undefined, renamedFiles: [] as TypedFile[], started: true, focus: 'agreements' as const, notice: 'No agreement PDFs were found in the agreements folder.' }
  }
  const stored = new Map(agreementReadList().map((read) => [readKey(read), read]))
  const uploadedIds = await cachedUploadedIds(config)
  const skippedNow: TypedFile[] = []
  for (const file of pdfs) {
    const key = readKey(file)
    const previous = stored.get(key)
    if (previous?.linked || previous?.skipped) continue
    const ids = [file.id, file.shortcutDetails?.targetId].filter((id): id is string => Boolean(id))
    if (!ids.some((id) => uploadedIds.has(id))) continue
    stored.set(key, {
      id: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime,
      webViewLink: file.webViewLink,
      plate: previous?.plate || '',
      signed: Boolean(previous?.signed),
      date: previous?.date || '',
      attempts: previous?.attempts,
      linked: previous?.linked,
      skipped: true,
    })
    skippedNow.push(file)
  }
  const pending = pdfs.filter((file) => !agreementSettled(stored.get(readKey(file))))
  if (isProcessCancelled()) {
    recordLastAction({ focus: 'agreements', status: 'paused', remaining: pending.length, detail: 'Stopped.' })
    return { watching, attempted: 0, renamed: 0, remaining: pending.length, more: false, error: undefined as string | undefined, renamedFiles: [] as TypedFile[], started: true, focus: 'agreements' as const, notice: 'Stopped. Start Agreements Only again to continue from here.' }
  }
  const batch = pending.slice(0, READ_LIMIT)
  const shownSkips = skippedNow.slice(0, 8)
  if (batch.length || shownSkips.length) {
    if (isProcessRunning()) endProcessJob(undefined, { remaining: pending.length })
    beginProcessJob(watching, [...batch, ...shownSkips].map(cardFile), 'agreements')
    for (const file of shownSkips) showAgreement(file, 'matched', 'Already on Agreement Link. Skipped.')
  }
  const deadline = Date.now() + Math.min(READ_BUDGET_MS, Math.max(4000, budgetMs))
  let readNow = 0
  let cursor = 0
  async function readNext() {
    while (readNow < READ_LIMIT && Date.now() < deadline) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const file = pending[index]
      if (isProcessCancelled()) return
      readNow += 1
      const key = readKey(file)
      const previous = stored.get(key)
      try {
        showAgreement(file, 'opening', `Opening ${file.name}`)
        const bytes = (file.mimeType || '').includes('vnd.google-apps')
          ? (await downloadNamedFile(file.id)).bytes
          : await downloadBinary(file.id, 0, DOWNLOAD_TIMEOUT_MS)
        if (isProcessCancelled()) return
        showAgreement(file, 'reading', `Reading Registration No. in ${file.name}`)
        const info = await Promise.race([
          inspectHirePurchase(bytes),
          new Promise<Awaited<ReturnType<typeof inspectHirePurchase>>>((_, reject) => {
            setTimeout(() => reject(new Error('Agreement read timed out')), 36000)
          }),
        ])
        stored.set(key, {
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime,
          webViewLink: file.webViewLink,
          plate: info.plate || '',
          signed: info.signed,
          date: info.date,
          attempts: info.plate ? 0 : (previous?.attempts || 0) + 1,
          linked: Boolean(previous?.linked && previous.plate === (info.plate || '')),
        })
        showAgreement(file, 'matching', info.plate ? `Matching ${info.plate} on Agreement Link. The file name stays as it is.` : `No Registration No. found in ${file.name}.`, info.plate || null)
      } catch {
        stored.set(key, {
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime,
          webViewLink: file.webViewLink,
          plate: '',
          signed: false,
          date: '',
          attempts: (previous?.attempts || 0) + 1,
          linked: previous?.linked,
        })
        const attempts = (previous?.attempts || 0) + 1
        showAgreement(file, attempts >= 2 ? 'unmatched' : 'error', attempts >= 2 ? `Couldn't read ${file.name}. Moving to the next agreement.` : `Couldn't open ${file.name}. It will be tried once more.`)
      }
    }
  }
  const workers = Math.min(READ_CONCURRENCY, pending.length)
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => readNext()))
  const reads = pdfs.flatMap((file) => {
    const read = stored.get(readKey(file))
    return read ? [read] : []
  })
  const linked = await Promise.race([
    placeAgreementChips(config, reads),
    new Promise<Awaited<ReturnType<typeof placeAgreementChips>>>((resolve) => {
      setTimeout(() => resolve({ written: 0, matched: [] as string[], missing: [] as string[], writtenIds: [] as string[], skipped: [] as { id: string; name: string; plate: string }[], noColumn: false }), 15000)
    }),
  ]).catch(() => ({ written: 0, matched: [] as string[], missing: [] as string[], writtenIds: [] as string[], skipped: [] as { id: string; name: string; plate: string }[], noColumn: false }))
  for (const id of linked.writtenIds) uploadedIds.add(id)
  const writtenIds = new Set(linked.writtenIds)
  const skippedIds = new Set(linked.skipped.map((file) => file.id))
  const missingPlates = new Set(linked.missing.map((plate) => compactPlate(plate)))
  for (const file of batch) {
    const read = stored.get(readKey(file))
    if (!read) continue
    const plate = read.plate || ''
    if (writtenIds.has(file.id) || read.linked) showAgreement(file, 'matched', `Linked on Agreement Link for ${plate}. The file name stays as it is.`, plate)
    else if (read.skipped || skippedIds.has(file.id)) showAgreement(file, 'matched', `Already on Agreement Link${plate ? ` for ${plate}` : ''}. Skipped.`, plate || null)
    else if (plate && missingPlates.has(compactPlate(plate))) showAgreement(file, 'unmatched', `${plate} is not on STOCK DOCUMENTS, so Agreement Link was left unchanged.`, plate)
    else if (linked.noColumn && plate) showAgreement(file, 'error', 'STOCK DOCUMENTS has no Agreement Link column.', plate)
    else if (plate) showAgreement(file, 'matched', `Read ${plate}. Agreement Link uses the latest copy. The file name stays as it is.`, plate)
    else if (!plate && (read.attempts || 0) >= 2) showAgreement(file, 'unmatched', `Couldn't read Registration No. in ${file.name}.`)
    else if (!plate) showAgreement(file, 'error', `Couldn't read Registration No. in ${file.name}. Trying once more.`)
  }
  rememberAgreementReads(reads)
  const checked = pdfs.filter((file) => agreementSettled(stored.get(readKey(file)))).length
  const remaining = pdfs.length - checked
  const linkedCount = new Set(reads.filter((read) => read.linked && read.plate).map((read) => read.plate)).size
  const skippedNote = skipNotice(reads.filter((read) => read.skipped))
  if (remaining > 0) {
    recordLastAction({
      focus: 'agreements',
      status: 'running',
      remaining,
      done: checked,
      detail: `Read ${checked} of ${pdfs.length} loan agreements. ${linkedCount} matched on Agreement Link. ${skippedNote}`,
    })
    void persistProcessCursor(config).catch(() => {})
    return {
      watching,
      attempted: readNow,
      renamed: linked.written,
      remaining,
      more: !isProcessCancelled(),
      error: undefined as string | undefined,
      renamedFiles: [] as TypedFile[],
      started: true,
      focus: 'agreements' as const,
      notice: `Read ${checked} of ${pdfs.length} loan agreements. ${linkedCount} registration number${linkedCount === 1 ? ' is' : 's are'} matched on Agreement Link. File names stay as they are.${skippedNote ? ` ${skippedNote}` : ''}`,
    }
  }
  const { unsigned, unread } = chooseSigned(reads)
  clearAgreementReads()
  const plates = listRegistrationNumbers(reads.filter((read) => read.linked).map((read) => read.plate))
  const skipped = [
    unread ? `Registration No. could not be read in ${unread} file${unread === 1 ? '' : 's'}.` : '',
    skippedNote,
    linked.noColumn ? 'STOCK DOCUMENTS has no Agreement Link column.' : '',
    linked.missing.length ? `${linked.missing.length} registration number${linked.missing.length === 1 ? ' is' : 's are'} not on STOCK DOCUMENTS.` : '',
  ].filter(Boolean).join(' ')
  const notice = linkedCount
    ? `Linked ${linkedCount} agreement${linkedCount === 1 ? '' : 's'} onto Agreement Link cells${plates ? ` for ${plates}` : ''}. File names were left as they are.${skipped ? ` ${skipped}` : ''}${unsigned ? ` ${unsigned} file${unsigned === 1 ? '' : 's'} had no signature mark, so the latest copy was used.` : ''}`
    : `No agreement was written to an Agreement Link cell.${skipped ? ` ${skipped}` : ' The registration number is read from inside the PDF.'}`
  recordLastAction({
    focus: 'agreements',
    status: 'done',
    remaining: 0,
    done: pdfs.length,
    detail: notice,
  })
  await persistProcessCursor(config).catch(() => {})
  return {
    watching,
    attempted: pdfs.length,
    renamed: linkedCount,
    remaining: 0,
    more: false,
    error: undefined as string | undefined,
    renamedFiles: [] as TypedFile[],
    started: true,
    focus: 'agreements' as const,
    notice,
    lastAction: lastAction(),
  }
}

export async function linkHirePurchaseAgreements(config: FleetConfig, files: TypedFile[]) {
  const stopAt = Date.now() + HANDOFF_MS
  let attempted = 0
  let written = 0
  let result = await readAgreementPass(config, files, Math.min(READ_BUDGET_MS, HANDOFF_MS))
  if (!result.more) return result
  attempted += result.attempted
  written += result.renamed
  while (Date.now() < stopAt) {
    const budget = Math.min(READ_BUDGET_MS, stopAt - Date.now())
    if (budget < 4000) break
    const next = await readAgreementPass(config, files, budget)
    attempted += next.attempted
    if (!next.more) return next
    written += next.renamed
    result = { ...next, attempted, renamed: written }
  }
  return { ...result, attempted, renamed: written }
}
