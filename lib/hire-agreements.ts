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

function chooseSigned(reads: AgreementRead[]) {
  const chosen: AgreementRead[] = []
  let unsigned = 0
  const byPlate = new Map<string, AgreementRead[]>()
  for (const read of reads) {
    if (!read.plate) continue
    const list = byPlate.get(read.plate) || []
    list.push(read)
    byPlate.set(read.plate, list)
  }
  for (const list of byPlate.values()) {
    const signed = list.filter((read) => read.signed)
    if (!signed.length) {
      unsigned += list.length
      continue
    }
    signed.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    chosen.push(signed[0])
  }
  return { chosen, unsigned }
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
  const pending = pdfs.filter((file) => !stored.has(readKey(file)))
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
  rememberAgreementReads(reads)
  const remaining = pdfs.length - reads.length
  if (remaining > 0) {
    recordLastAction({
      focus: 'agreements',
      status: 'running',
      remaining,
      done: reads.length,
      detail: `Read ${reads.length} of ${pdfs.length} loan agreements.`,
    })
    await persistProcessCursor(config).catch(() => {})
    return {
      watching,
      attempted: readNow,
      renamed: 0,
      remaining,
      more: true,
      error: undefined as string | undefined,
      renamedFiles: [] as TypedFile[],
      started: true,
      focus: 'agreements' as const,
      notice: `Read ${reads.length} of ${pdfs.length} loan agreements. The rest are still being checked.`,
    }
  }
  const { chosen, unsigned } = chooseSigned(reads)
  const linked = await writeAgreementChips(config, chosen)
  clearAgreementReads()
  const plates = listRegistrationNumbers(linked.matched)
  const skipped = [
    unsigned ? `${unsigned} unsigned file${unsigned === 1 ? '' : 's'} stayed in the folder.` : '',
    linked.missing.length ? `${linked.missing.length} registration number${linked.missing.length === 1 ? ' is' : 's are'} not on STOCK DOCUMENTS.` : '',
  ].filter(Boolean).join(' ')
  const notice = linked.written
    ? `Linked ${linked.written} signed agreement${linked.written === 1 ? '' : 's'} onto empty Agreement Link cells${plates ? ` for ${plates}` : ''}.${skipped ? ` ${skipped}` : ''}`
    : `No empty Agreement Link cells needed a signed agreement.${skipped ? ` ${skipped}` : ''}`
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
    renamed: linked.written,
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
