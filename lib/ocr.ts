import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compactPlate, parseKenyanPlate, pickOcrPlate, plateConfidence, plateFromCertificateText } from '@/lib/plates'
import { isInsurancePdf, isPdfBytes } from '@/lib/pdf-registration'
import { extractPlateText, isServerlessHost, readPlateScriptPath } from '@/lib/read-plate-runner'

const execFileAsync = promisify(execFile)
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
  const documentPlate = parseKenyanPlate(plateFromCertificateText(ocr.text) || ocr.plate)
  if (documentPlate) {
    if (named.plate && compactPlate(named.plate) !== compactPlate(documentPlate)) {
      return { plate: documentPlate, confidence: 92 }
    }
    return { plate: documentPlate, confidence: Math.max(named.confidence, ocr.confidence, 88) }
  }
  return named
}

export async function plateFromImage(bytes: Buffer, mimeType?: string, filename?: string, kind?: string) {
  if (!isOcrImage(mimeType, filename) && !isPdfBytes(bytes)) return { plate: null as string | null, confidence: 0, text: '' }
  if (bytes.length === 0) return { plate: null, confidence: 0, text: '' }
  const ocrKind = ocrKindFor(bytes, mimeType, filename, kind)
  if (ocrKind === 'photo') {
    return readBikePhotoWithTesseract(bytes, mimeType, filename)
  }
  const readKind = isInsurancePdf(bytes, mimeType, filename) || ocrKind === 'pdf' ? 'pdf' : 'certificate'
  const text = await readTextWithTesseract(bytes, mimeType, filename, readKind)
  const labeled = parseKenyanPlate(plateFromCertificateText(text))
  if (labeled) return { plate: labeled, confidence: 94, text }
  const plate = parseKenyanPlate(pickOcrPlate(text, 'certificate'))
  if (!plate) return { plate: null, confidence: 0, text }
  return { plate, confidence: labeled === plate ? 94 : 86, text }
}

function ocrKindFor(bytes: Buffer, mimeType?: string, filename?: string, kind?: string) {
  if (kind === 'photo') return 'photo'
  if (isPdfFile(bytes, mimeType, filename) || kind === 'certificate' || kind === 'logbook') {
    if (isPdfFile(bytes, mimeType, filename)) return 'pdf'
    return 'certificate'
  }
  return 'photo'
}

async function readBikePhotoWithTesseract(bytes: Buffer, mimeType?: string, filename?: string) {
  const text = await readTextWithTesseract(bytes, mimeType, filename, 'photo')
  const plate = parseKenyanPlate(pickOcrPlate(text, 'photo'))
  if (!plate) return { plate: null, confidence: 0, text }
  return { plate, confidence: 86, text }
}

function isPdfFile(bytes: Buffer, mimeType?: string, filename?: string) {
  return isInsurancePdf(bytes, mimeType, filename)
}

function commandOutput(err: unknown) {
  if (!err || typeof err !== 'object') return { stdout: '', stderr: '', message: String(err) }
  const row = err as { stdout?: unknown; stderr?: unknown; message?: unknown; killed?: boolean; signal?: unknown; code?: unknown }
  return {
    stdout: String(row.stdout || ''),
    stderr: String(row.stderr || ''),
    message: `${row.message || ''}\n${row.stderr || ''}`,
    killed: Boolean(row.killed) || row.signal != null,
    code: row.code,
  }
}

function ocrCommandError(err: unknown, pdf: boolean) {
  const { message, killed } = commandOutput(err)
  if (killed || /timed out|etimedout|aborted due to timeout|sigterm|sigkill/i.test(message)) {
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
  const pdf = kind === 'pdf' || isPdfFile(bytes, mimeType, filename)
  try {
    return await extractPlateText(bytes, kind)
  } catch (err) {
    if (isServerlessHost()) throw new Error(ocrCommandError(err, pdf))
  }
  const imagePath = join(tmpdir(), `fleetwise-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`)
  await writeFile(imagePath, bytes)
  try {
    const { stdout } = await execFileAsync(process.execPath, [readPlateScriptPath(), imagePath, kind], {
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      cwd: process.cwd(),
    })
    return stdout || ''
  } catch (err) {
    const { stdout } = commandOutput(err)
    if (stdout.trim()) return stdout
    throw new Error(ocrCommandError(err, pdf))
  } finally {
    await unlink(imagePath).catch(() => {})
  }
}
