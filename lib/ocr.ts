import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compactPlate, pickOcrPlate, plateConfidence, plateFromCertificateText } from '@/lib/plates'

const execFileAsync = promisify(execFile)
const MAX_BYTES = 12 * 1024 * 1024

export function ocrConfigured() {
  return true
}

export function isOcrImage(mimeType?: string, filename?: string) {
  const mime = (mimeType || '').toLowerCase()
  const name = filename || ''
  if (mime.includes('pdf') || /\.pdf$/i.test(name)) return true
  if (mime === 'image/svg+xml' || mime.includes('heic') || mime.includes('heif') || /\.(heic|heif)$/i.test(name)) return false
  if (mime.startsWith('image/')) return true
  if (/\.(png|jpe?g|webp|gif|bmp|tif?f)$/i.test(name)) return true
  if (!name.includes('.') && (!mime || mime === 'application/octet-stream')) return true
  if (mime === 'application/octet-stream') return true
  return false
}

export async function resolvePlateFromFile(input: {
  filename: string
  subject?: string
  body?: string
  bytes?: Buffer
  mimeType?: string
}) {
  const named = plateConfidence(input.filename, input.subject, input.body)
  if (!input.bytes || (!isOcrImage(input.mimeType, input.filename) && !isPdfBytes(input.bytes))) return named
  const ocr = await plateFromImage(input.bytes, input.mimeType, input.filename)
  const documentPlate = plateFromCertificateText(ocr.text) || ocr.plate
  if (documentPlate) {
    if (named.plate && compactPlate(named.plate) !== compactPlate(documentPlate)) {
      return { plate: documentPlate, confidence: 92 }
    }
    return { plate: documentPlate, confidence: Math.max(named.confidence, ocr.confidence, 88) }
  }
  return named
}

function isPdfBytes(bytes: Buffer) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('utf8') === '%PDF-'
}

export async function plateFromImage(bytes: Buffer, mimeType?: string, filename?: string, kind?: string) {
  if ((!isOcrImage(mimeType, filename) && !isPdfBytes(bytes)) || bytes.length === 0 || bytes.length > MAX_BYTES) {
    return { plate: null as string | null, confidence: 0, text: '' }
  }
  const ocrKind = ocrKindFor(bytes, mimeType, filename, kind)
  const text = await readTextWithTesseract(bytes, mimeType, filename, ocrKind)
  const plateKind = ocrKind === 'photo' ? 'photo' : 'certificate'
  const labeled = plateFromCertificateText(text)
  if (ocrKind !== 'photo' && labeled) return { plate: labeled, confidence: 94, text }
  const plate = pickOcrPlate(text, plateKind)
  if (!plate) return { plate: null, confidence: 0, text }
  return { plate, confidence: labeled === plate ? 94 : 86, text }
}

function ocrKindFor(bytes: Buffer, mimeType?: string, filename?: string, kind?: string) {
  if (kind === 'photo') return 'photo'
  if (kind === 'certificate' || kind === 'logbook') return 'certificate'
  if (isPdfFile(bytes, mimeType, filename)) return 'pdf'
  return 'photo'
}

function isPdfFile(bytes: Buffer, mimeType?: string, filename?: string) {
  return isPdfBytes(bytes) || (mimeType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(filename || '')
}

function ocrCommandError(err: unknown, pdf: boolean) {
  const message = err instanceof Error ? `${err.message}\n${'stderr' in err ? String((err as { stderr?: string }).stderr || '') : ''}` : String(err)
  if (/timed out|etimedout|aborted due to timeout/i.test(message)) {
    return pdf
      ? "Couldn't finish reading that PDF in time. Try a smaller file, or open Unmatched and type the plate."
      : "Couldn't finish reading that photo in time. Try a closer crop of the plate, or type the plate on Unmatched."
  }
  if (/fetch failed|network error|enotfound|econnreset|traineddata|tessdata/i.test(message)) {
    return 'Document OCR could not start because Tesseract language data was missing. Keep scripts/tessdata/eng.traineddata.gz in the project and retry.'
  }
  const fromScript = message.match(/(?:Photo OCR|Document OCR|Couldn't)[^\n]+/)?.[0]
  if (fromScript) return fromScript.replace(/^Photo OCR/, 'Document OCR')
  return pdf
    ? "Couldn't read that PDF. Open Unmatched and type the plate if you can see it, or use a clearer scan."
    : "Couldn't read that photo. Try a closer shot of the plate, or type the registration number on Unmatched."
}

async function readTextWithTesseract(bytes: Buffer, mimeType?: string, filename?: string, kind = 'photo') {
  const imagePath = join(tmpdir(), `fleetwise-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`)
  await writeFile(imagePath, bytes)
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'read-plate.mjs'), imagePath, kind], {
      timeout: 180_000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout || ''
  } catch (err) {
    throw new Error(ocrCommandError(err, kind !== 'photo'))
  } finally {
    await unlink(imagePath).catch(() => {})
  }
}
