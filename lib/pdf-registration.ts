import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { plateFromCertificateText } from '@/lib/plates'

const execFileAsync = promisify(execFile)

export function isPdfBytes(bytes: Buffer) {
  return bytes.subarray(0, Math.min(bytes.length, 65_536)).toString('latin1').includes('%PDF-')
}

export function isInsurancePdf(bytes: Buffer, mimeType?: string, filename?: string) {
  return isPdfBytes(bytes) || (mimeType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(filename || '')
}

/** Open an insurance PDF with pdfjs-dist and read REGISTRATION No from text, layout, and form fields. */
export async function registrationFromPdfjs(bytes: Buffer) {
  if (!bytes.length || !isPdfBytes(bytes)) return { text: '', plate: null as string | null }
  const pdfPath = join(tmpdir(), `fleetwise-pdfjs-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`)
  await writeFile(pdfPath, bytes)
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'read-plate.mjs'), pdfPath, 'pdfjs'], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      cwd: process.cwd(),
    })
    const text = stdout || ''
    return { text, plate: plateFromCertificateText(text) }
  } catch (err) {
    const stdout = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout?: unknown }).stdout || '') : ''
    if (stdout.trim()) return { text: stdout, plate: plateFromCertificateText(stdout) }
    return { text: '', plate: null }
  } finally {
    await unlink(pdfPath).catch(() => {})
  }
}
