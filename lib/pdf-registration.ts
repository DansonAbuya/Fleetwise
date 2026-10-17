import { parseKenyanPlate, plateFromCertificateText, plateFromLogbookText } from '@/lib/plates'
import { extractPlateText } from '@/lib/read-plate-runner'

export function isPdfBytes(bytes: Buffer) {
  return bytes.subarray(0, Math.min(bytes.length, 65_536)).toString('latin1').includes('%PDF-')
}

export function isInsurancePdf(bytes: Buffer, mimeType?: string, filename?: string) {
  return isPdfBytes(bytes) || (mimeType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(filename || '')
}

/** Open an insurance PDF with pdfjs-dist and read REGISTRATION No from text, layout, and form fields. */
export async function registrationFromPdfjs(bytes: Buffer) {
  if (!bytes.length) return { text: '', plate: null as string | null }
  const text = await extractPlateText(bytes, 'pdfjs')
  return { text, plate: parseKenyanPlate(plateFromCertificateText(text) || plateFromLogbookText(text)) }
}
