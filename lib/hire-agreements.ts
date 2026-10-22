import { downloadBinary, downloadNamedFile } from '@/lib/drive'
import { writeAgreementChips } from '@/lib/modules/stock-documents'
import { agreementReadList, clearAgreementReads, lastAction, persistProcessCursor, recordLastAction, rememberAgreementReads, type AgreementRead } from '@/lib/process-cursor'
import { inspectHirePurchase } from '@/lib/read-plate-runner'
import type { FleetConfig, TypedFile } from '@/lib/types'
import { listRegistrationNumbers } from '@/lib/plates'

// One pass has to keep the job at 10 or more agreements a minute once the folder list is cached.
const READ_CONCURRENCY = process.env.VERCEL ? 4 : 5
const READ_LIMIT = process.env.VERCEL ? 10 : 12
const READ_BUDGET_MS = process.env.VERCEL ? 22000 : 40000
const DOWNLOAD_TIMEOUT_MS = 12000

function readKey(file: { id: string; modifiedTime?: string }) {
  return `${file.id}:${file.modifiedTime || ''}`
}

function isAgreementPdf(file: TypedFile) {
  return file.type === 'agreement' && (/\.pdf$/i.test(file.name) || (file.mimeType || '').toLowerCase().includes('pdf'))
}

function agreementSettled(read?: AgreementRead) {
  return Boolean(read && (read.plate || (read.attempts || 0) >= 2))
}

function chooseSigned(reads: AgreementRead[]) {
  const chosen: AgreementRead[] = []
  let unsigned = 0
  let unread = 0
  const byPlate = new Map<string, AgreementRead[]>()
  for (const read of reads) {
    if (!read.plate) {
      if ((read.attempts || 0) >= 2) unread += 1
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
  const toWrite = chosen.filter((file) => linkedByPlate.get(file.plate)?.id !== file.id)
  if (!toWrite.length) return { written: 0, matched: [] as string[], missing: [] as string[], writtenIds: [] as string[], noColumn: false }
  const ownIds = new Set([...linkedByPlate.values()].map((read) => read.id))
  const linked = await writeAgreementChips(config, toWrite, ownIds)
  const writtenIds = new Set(linked.writtenIds)
  for (const read of reads) {
    if (!writtenIds.has(read.id)) continue
    const previous = linkedByPlate.get(read.plate)
    if (previous && previous !== read) previous.linked = false
    read.linked = true
  }
  return linked
}

export async function linkHirePurchaseAgreements(config: FleetConfig, files: TypedFile[]) {
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
  const pending = pdfs.filter((file) => !agreementSettled(stored.get(readKey(file))))
  const deadline = Date.now() + READ_BUDGET_MS
  let readNow = 0
  let cursor = 0
  async function readNext() {
    while (readNow < READ_LIMIT && Date.now() < deadline) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const file = pending[index]
      readNow += 1
      const key = readKey(file)
      const previous = stored.get(key)
      try {
        const bytes = (file.mimeType || '').includes('vnd.google-apps')
          ? (await downloadNamedFile(file.id)).bytes
          : await downloadBinary(file.id, 0, DOWNLOAD_TIMEOUT_MS)
        const info = await inspectHirePurchase(bytes)
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
      }
    }
  }
  const workers = Math.min(READ_CONCURRENCY, pending.length)
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => readNext()))
  const reads = pdfs.flatMap((file) => {
    const read = stored.get(readKey(file))
    return read ? [read] : []
  })
  const linked = await placeAgreementChips(config, reads).catch(() => ({ written: 0, matched: [] as string[], missing: [] as string[], writtenIds: [] as string[], noColumn: false }))
  rememberAgreementReads(reads)
  const checked = pdfs.filter((file) => agreementSettled(stored.get(readKey(file)))).length
  const remaining = pdfs.length - checked
  const linkedCount = new Set(reads.filter((read) => read.linked && read.plate).map((read) => read.plate)).size
  if (remaining > 0) {
    recordLastAction({
      focus: 'agreements',
      status: 'running',
      remaining,
      done: checked,
      detail: `Read ${checked} of ${pdfs.length} loan agreements. ${linkedCount} matched on Agreement Link.`,
    })
    await persistProcessCursor(config).catch(() => {})
    return {
      watching,
      attempted: readNow,
      renamed: linked.written,
      remaining,
      more: true,
      error: undefined as string | undefined,
      renamedFiles: [] as TypedFile[],
      started: true,
      focus: 'agreements' as const,
      notice: `Read ${checked} of ${pdfs.length} loan agreements. ${linkedCount} registration number${linkedCount === 1 ? ' is' : 's are'} matched on Agreement Link. File names stay as they are.`,
    }
  }
  const { unsigned, unread } = chooseSigned(reads)
  clearAgreementReads()
  const plates = listRegistrationNumbers(reads.filter((read) => read.linked).map((read) => read.plate))
  const skipped = [
    unread ? `Registration No. could not be read in ${unread} file${unread === 1 ? '' : 's'}.` : '',
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
