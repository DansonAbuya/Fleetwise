import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plateFromLogbookText, printedRegistrationPlate } from '@/lib/plates'

export type PhotoRegistrationResult = {
  registrationNumber: string | null
  status: 'success' | 'review_required' | 'unreadable'
  confidence: number | null
  reason?: string
  processingTimeMs: number
  retry?: boolean
  bytes?: number
  width?: number
  height?: number
  timings?: { detectMs: number; preprocessMs: number; ocrMs: number; validateMs: number }
}

type PlateReader = {
  extractPlateText: (data: Buffer, readKind: string) => Promise<string>
  extractPhotoRegistration?: (data: Buffer) => Promise<PhotoRegistrationResult>
  inspectHirePurchase?: (data: Buffer) => Promise<string>
  warmOcr?: () => Promise<void>
}

let reader: PlateReader | undefined

export function isServerlessHost() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

export function readPlateScriptPath() {
  const candidates = [
    join(process.cwd(), 'scripts', 'read-plate.mjs'),
    join(process.cwd(), 'scripts/read-plate.mjs'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  throw new Error("Couldn't start document OCR. scripts/read-plate.mjs is missing from the server bundle. Keep that file and scripts/tessdata/eng.traineddata.gz in the repo, then redeploy.")
}

async function loadReader() {
  if (reader) return reader
  const href = pathToFileURL(readPlateScriptPath()).href
  const importer = new Function('u', 'return import(u)') as (url: string) => Promise<PlateReader>
  reader = await importer(href)
  return reader
}

export async function warmPlateReader() {
  const mod = await loadReader()
  await mod.warmOcr?.()
}

export async function inspectHirePurchase(bytes: Buffer) {
  const mod = await loadReader()
  if (!mod.inspectHirePurchase) return { plate: null as string | null, signed: false, date: '' }
  const raw = await mod.inspectHirePurchase(bytes)
  const parsed = JSON.parse(raw) as { plate?: string | null; signed?: boolean; date?: string; text?: string }
  const plate = parsed.plate || (parsed.text ? plateFromLogbookText(parsed.text) || printedRegistrationPlate(parsed.text) : null)
  return {
    plate: plate || null,
    signed: Boolean(parsed.signed),
    date: parsed.date || '',
  }
}

export async function extractPlateText(bytes: Buffer, kind: string) {
  const mod = await loadReader()
  return mod.extractPlateText(bytes, kind)
}

export async function extractPhotoRegistration(bytes: Buffer): Promise<PhotoRegistrationResult> {
  const mod = await loadReader()
  if (mod.extractPhotoRegistration) return mod.extractPhotoRegistration(bytes)
  const text = await mod.extractPlateText(bytes, 'photo')
  const match = text.match(/REGISTRATION No:\s*([A-Z0-9]+)/i)
  return {
    registrationNumber: match?.[1] || null,
    status: match?.[1] ? 'success' : 'unreadable',
    confidence: match?.[1] ? 80 : null,
    processingTimeMs: 0,
  }
}
