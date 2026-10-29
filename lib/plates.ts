import { z } from 'zod'

const PLATE_RE = /K[A-Z]{2,3}[\s\-._]*\d{3}[\s\-._]*[A-Z]/gi
const COMPACT_PLATE_RE = /K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z]/gi

/** Always one token, e.g. KMHE520A or KDA482M — never split across lines or spaces. */
export function compactPlate(raw: string) {
  return raw.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export const kenyanPlateSchema = z
  .string()
  .transform((value) => compactPlate(value))
  .pipe(z.string().regex(/^K[A-Z]{2}\d{3}[A-Z]$|^K[A-Z]{3}\d{3}[A-Z]$/, 'Not a Kenyan registration number'))

const photoPrefix = (process.env.PHOTO_PLATE_PREFIX || 'KM').toUpperCase().replace(/[^A-Z]/g, '') || 'KM'
const photoPattern = new RegExp(process.env.PHOTO_PLATE_PATTERN || `^${photoPrefix}[A-Z]{${Math.max(0, 4 - photoPrefix.length)}}\\d{3}[A-Z]$`)

export const photoRegistrationResultSchema = z.object({
  registrationNumber: z.string().nullable(),
  status: z.enum(['success', 'review_required', 'unreadable']),
  confidence: z.number().nullable(),
  reason: z.string().optional(),
  processingTimeMs: z.number(),
})

export function parsePhotoPlate(raw: string | null | undefined) {
  const plate = parseKenyanPlate(raw)
  return plate && photoPattern.test(plate) ? plate : null
}

export function parseKenyanPlate(raw: string | null | undefined) {
  const result = kenyanPlateSchema.safeParse(raw || '')
  return result.success ? result.data : null
}

export function isKenyanPlate(plate: string) {
  return Boolean(parseKenyanPlate(plate))
}

export function extractKenyanPlate(raw: string) {
  return kenyanPlatesIn(raw)[0] || null
}

export function kenyanPlatesIn(raw: string) {
  const compact = compactPlate(raw)
  const found: string[] = []
  for (const match of compact.matchAll(/K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z]/g)) {
    if (!found.includes(match[0])) found.push(match[0])
  }
  found.sort((a, b) => b.length - a.length)
  return found
}

export function normalizePlate(raw: string) {
  return parseKenyanPlate(raw) || compactPlate(raw)
}

export function platesFromText(text: string) {
  const found: string[] = []
  const add = (raw: string) => {
    const plate = parseKenyanPlate(raw)
    if (!plate || found.includes(plate)) return
    found.push(plate)
  }
  for (const match of text.matchAll(PLATE_RE)) add(match[0])
  const compactAll = compactPlate(text)
  for (const match of compactAll.matchAll(COMPACT_PLATE_RE)) add(match[0])
  const lines = text.split(/\r?\n/).map((line) => compactPlate(line)).filter(Boolean)
  for (const line of lines) {
    for (const match of line.matchAll(COMPACT_PLATE_RE)) add(match[0])
  }
  for (const joined of joinSplitPlateLines(lines)) add(joined)
  for (const candidate of ocrPlateCandidates(compactAll)) add(candidate)
  for (const candidate of pairSplitPlateParts(text)) add(candidate)
  found.sort((a, b) => b.length - a.length)
  return found
}

function pairSplitPlateParts(text: string) {
  const tokens = text.toUpperCase().match(/[A-Z0-9]+/g) || []
  const prefixes: { value: string; index: number }[] = []
  const suffixes: { value: string; index: number }[] = []
  tokens.forEach((token, index) => {
    if (/^\d{3}[A-Z]$/.test(token)) suffixes.push({ value: token, index })
    const moto = motorcyclePrefix(token)
    if (moto) prefixes.push({ value: moto, index })
  })
  const compact = compactPlate(text)
  for (const match of compact.matchAll(/\d{3}[A-Z]/g)) {
    suffixes.push({ value: match[0], index: match.index ?? 0 })
    const before = compact.slice(Math.max(0, (match.index ?? 0) - 8), match.index)
    for (let size = 4; size >= 3; size--) {
      const slice = before.slice(-size)
      const moto = motorcyclePrefix(slice)
      if (moto) prefixes.push({ value: moto, index: (match.index ?? 0) - size })
    }
  }
  const scored: { plate: string; distance: number }[] = []
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      scored.push({ plate: prefix.value + suffix.value, distance: Math.abs(prefix.index - suffix.index) })
    }
  }
  scored.sort((a, b) => a.distance - b.distance || b.plate.length - a.plate.length)
  return scored.map((item) => item.plate)
}

function motorcyclePrefix(token: string) {
  if (/^KM[A-Z]{2}$/.test(token)) return token
  if (/^M[A-Z]{2}$/.test(token)) return `K${token}`
  return null
}

function joinSplitPlateLines(lines: string[]) {
  const joined: string[] = []
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const a = lines[i]
      const b = lines[j]
      if (isPrefixLine(a) && isNumberLine(b)) joined.push(a + b)
      if (isPrefixLine(b) && isNumberLine(a)) joined.push(b + a)
      joined.push(a + b)
    }
  }
  return joined
}

function isPrefixLine(line: string) {
  return /^K[A-Z]{2,3}$/.test(line)
}

function isNumberLine(line: string) {
  return /^\d{3}[A-Z]$/.test(line)
}

function ocrPlateCandidates(compact: string) {
  const found: string[] = []
  for (let i = 0; i < compact.length - 6; i++) {
    if (compact[i] !== 'K') continue
    const motorcycle = repairKenyanPlate(compact.slice(i, i + 8), 3)
    if (motorcycle) found.push(motorcycle)
    const car = repairKenyanPlate(compact.slice(i, i + 7), 2)
    if (car) found.push(car)
  }
  return found
}

function repairKenyanPlate(raw: string, prefixLetters: 2 | 3) {
  const length = 1 + prefixLetters + 3 + 1
  if (raw.length !== length || raw[0] !== 'K') return null
  let cost = 0
  const letters: string[] = []
  for (let i = 0; i < prefixLetters; i++) {
    const ch = raw[i + 1]
    const next = toLetter(ch)
    if (!/[A-Z]/.test(next)) return null
    if (next !== ch) cost++
    letters.push(next)
  }
  const digits: string[] = []
  for (let i = 0; i < 3; i++) {
    const ch = raw[1 + prefixLetters + i]
    const next = toDigit(ch)
    if (!/\d/.test(next)) return null
    if (next !== ch) cost++
    digits.push(next)
  }
  const lastCh = raw[length - 1]
  const last = toLetter(lastCh)
  if (!/[A-Z]/.test(last)) return null
  if (last !== lastCh) cost++
  if (cost > 1) return null
  return `K${letters.join('')}${digits.join('')}${last}`
}

export function pickOcrPlate(text: string, kind: 'certificate' | 'photo' = 'photo') {
  if (kind === 'certificate') return plateFromCertificateText(text)
  const counts = new Map<string, number>()
  const bump = (plate: string, weight = 1) => {
    const valid = parseKenyanPlate(plate)
    if (!valid) return
    counts.set(valid, (counts.get(valid) || 0) + weight)
  }
  for (const line of String(text || '').split(/\r?\n/)) {
    const compact = compactPlate(line)
    if (!compact) continue
    const exact = kenyanPlatesIn(compact)
    for (const plate of exact) bump(plate, 3)
    if (!exact.length) {
      for (const plate of ocrPlateCandidates(compact)) bump(plate, 1)
    }
  }
  const labeled = plateFromCertificateText(text)
  if (labeled) bump(labeled, 8)
  for (const plate of pairSplitPlateParts(text)) bump(plate, 6)
  const compactAll = compactPlate(text)
  const missingK = compactAll.match(/(?:^|[^A-Z])(M[A-Z]{2}\d{3}[A-Z])/)
  if (missingK) bump(`K${missingK[1]}`, 3)
  const kmHits = compactAll.match(/KM[A-Z]{2}\d{3}[A-Z]/g) || []
  for (const plate of kmHits) bump(plate, 5)
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    const bike = Number(b[0].startsWith('KM') && b[0].length === 8) - Number(a[0].startsWith('KM') && a[0].length === 8)
    if (bike) return bike
    return b[0].length - a[0].length
  })
  const bikes = ranked.filter(([plate]) => plate.startsWith('KM') && plate.length === 8)
  if (kind === 'photo' && bikes[0]) return bikes[0][0]
  if (ranked[0]?.[1] >= 2) return ranked[0][0]
  if (kind === 'photo' && ranked.length === 1) return ranked[0][0]
  if (ranked[0] && ranked[0][1] > (ranked[1]?.[1] || 0)) return ranked[0][0]
  return kind === 'photo' ? null : plateFromText(text)
}

function toDigit(char: string) {
  if (/[0-9]/.test(char)) return char
  if (char === 'O' || char === 'Q' || char === 'D') return '0'
  if (char === 'I' || char === 'L') return '1'
  if (char === 'Z') return '2'
  if (char === 'S') return '5'
  if (char === 'G') return '6'
  if (char === 'B') return '8'
  return char
}

function toLetter(char: string) {
  if (/[A-Z]/.test(char)) return char
  if (char === '0') return 'O'
  if (char === '1') return 'I'
  if (char === '5') return 'S'
  if (char === '8') return 'B'
  return char
}

export function plateFromText(text: string) {
  return platesFromText(text)[0] || null
}

export function listRegistrationNumbers(plates: string[]) {
  const unique = [...new Set(plates.map((plate) => compactPlate(plate)).filter(Boolean))]
  if (!unique.length) return ''
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  if (unique.length <= 6) return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`
  return `${unique.slice(0, 5).join(', ')}, and ${unique.length - 5} more`
}

const REG_LABEL = /\b(?:(?:vehicle|motor(?:\s+vehicle)?|m\.?\s*v\.?|identification)\s+)?(?:registration|reg(?:n)?\.?)[\s.:\-–]*?(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)\b|\bidentification\s+mark(?:\s+and\s+number)?\b/i
const NEXT_FIELD = /\b(chassis|make|model|engine|body|colour|color|year|seating|tonnage|policy|insured|commencement|expiry|owner|pin|tare|gvw|cover|interpol|usage|cubic|certificate\s*no|date of)\b/i
const REG_LABEL_GLOBAL = new RegExp(REG_LABEL.source, 'gi')
const LABEL_STRIP = /^.*?\b(?:(?:vehicle|motor(?:\s+vehicle)?|m\.?\s*v\.?|identification)\s+)?(?:registration|reg(?:n)?\.?)[\s.:\-–]*?(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)\b\.?\s*[:\-–.]*|^.*?\bidentification\s+mark(?:\s+and\s+number)?\b\.?\s*[:\-–.]*/i
const SKIP_REG_LINE = /certificate of registration|registration certificate|date of (?:first )?registration|place of registration|registered (?:owner|keeper)/i
const OTHER_HEADER = /^(chassis|make|model|engine|body|colour|color|year|owner|tare|gvw|class|type)\b/i
const LABEL_CONTINUATION = /^(and\s+(?:number|no\.?)|of\s+(?:the\s+)?(?:motor\s+)?vehicle|of\s+trailer)$/i

function cutAtNextField(raw: string) {
  const index = raw.search(NEXT_FIELD)
  return (index > 0 ? raw.slice(0, index) : raw).trim()
}

function isLabelContinuation(line: string) {
  return LABEL_CONTINUATION.test(line.replace(/[.:\-–]/g, '').trim())
}

function registrationValueLines(lines: string[], start: number) {
  const extras: string[] = []
  for (let j = start; j < lines.length && j < start + 6 && extras.length < 2; j++) {
    const line = lines[j]
    if (isLabelContinuation(line) || SKIP_REG_LINE.test(line)) continue
    if (REG_LABEL.test(line) || NEXT_FIELD.test(line) || OTHER_HEADER.test(line)) break
    extras.push(line)
    if (standaloneKenyanPlates(line).length && !isPrefixLine(compactPlate(line))) break
  }
  return extras
}

function registrationFieldValues(text: string) {
  const values: string[] = []
  const push = (raw?: string) => {
    const value = cutAtNextField(String(raw || '').replace(/\s+/g, ' ').trim())
    if (value && !OTHER_HEADER.test(value) && !isLabelContinuation(value) && !values.includes(value)) values.push(value)
  }
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    if (SKIP_REG_LINE.test(lines[i]) || !REG_LABEL.test(lines[i])) continue
    let afterLabel = lines[i].replace(LABEL_STRIP, '').trim()
    if (OTHER_HEADER.test(afterLabel) || SKIP_REG_LINE.test(afterLabel) || isLabelContinuation(afterLabel)) afterLabel = ''
    push(afterLabel)
    if (afterLabel && standaloneKenyanPlates(afterLabel).length) continue
    const extras = registrationValueLines(lines, i + 1)
    for (const extra of extras) push(extra)
    if (extras.length >= 2) push(extras.join(' '))
  }
  const flat = text.replace(/\s+/g, ' ')
  for (const match of flat.matchAll(REG_LABEL_GLOBAL)) {
    const nearby = flat.slice(match.index || 0, (match.index || 0) + match[0].length + 48)
    if (SKIP_REG_LINE.test(nearby.slice(0, match[0].length + 12))) continue
    const start = (match.index || 0) + match[0].length
    push(flat.slice(start, start + 48))
  }
  return values
}

function standaloneKenyanPlates(raw: string) {
  const found: string[] = []
  const add = (plate: string | null | undefined) => {
    const valid = parseKenyanPlate(plate)
    if (!valid || found.includes(valid)) return
    found.push(valid)
  }
  const tokens = String(raw || '').toUpperCase().match(/[A-Z0-9]+/g) || []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length > 10) {
      add(token.slice(0, 8))
      add(token.slice(0, 7))
      continue
    }
    add(token)
    const next = tokens[i + 1]
    if (next && isPrefixLine(token) && isNumberLine(next)) add(token + next)
  }
  const compact = compactPlate(raw)
  if (compact.length >= 7 && compact.length <= 10) add(compact)
  return found
}

function platesFromRegistrationValue(raw: string) {
  const found: { plate: string; exact: boolean }[] = []
  const add = (plate: string | null, exact: boolean) => {
    const valid = parseKenyanPlate(plate)
    if (!valid || found.some((row) => row.plate === valid)) return
    found.push({ plate: valid, exact })
  }
  for (const plate of standaloneKenyanPlates(raw)) add(plate, true)
  const compact = compactPlate(raw)
  if (!found.length && compact.length >= 7 && compact.length <= 14) {
    add(repairKenyanPlate(compact.slice(0, 8), 3), false)
    add(repairKenyanPlate(compact.slice(0, 7), 2), false)
  }
  return found
}

export function certificatePlateCandidates(text: string) {
  if (!text?.trim()) return [] as { plate: string; exact: boolean; weight: number }[]
  const scored: { plate: string; exact: boolean; weight: number }[] = []
  const add = (plate: string, exact: boolean, weight: number) => {
    let score = weight + (exact ? 40 : 0)
    if (plate.length === 8) score += 6
    scored.push({ plate, exact, weight: score })
  }
  for (const value of registrationFieldValues(text)) {
    const plates = platesFromRegistrationValue(value)
    const compact = compactPlate(value)
    for (const row of plates) add(row.plate, row.exact, compact === row.plate ? 110 : 90)
  }
  if (!scored.length) {
    for (const plate of kenyanPlatesIn(text)) add(plate, true, 20)
  }
  const merged = new Map<string, { plate: string; exact: boolean; weight: number }>()
  for (const row of scored) {
    const current = merged.get(row.plate)
    if (!current || row.weight > current.weight) merged.set(row.plate, row)
    else if (row.exact) current.exact = true
  }
  return [...merged.values()].sort((a, b) => b.weight - a.weight || Number(b.exact) - Number(a.exact) || b.plate.length - a.plate.length)
}

/** Exact REGISTRATION No printed on the certificate — never a nearby fleet plate. */
export function printedRegistrationPlate(text: string) {
  const exact = certificatePlateCandidates(text).find((row) => row.exact)
  return exact?.plate || null
}

/** Use the value of REGISTRATION / REGISTRATION No on a logbook or insurance certificate. */
export function plateFromCertificateText(text: string, _sheetPlates?: Set<string>) {
  return printedRegistrationPlate(text) || certificatePlateCandidates(text)[0]?.plate || null
}

/** NTSA logbook / copy of records: Registration Number or Registration mark, including two-line plates. */
export function plateFromLogbookText(text: string) {
  for (const value of registrationFieldValues(text)) {
    const exact = platesFromRegistrationValue(value).find((row) => row.exact)
    if (exact) return exact.plate
  }
  for (const value of registrationFieldValues(text)) {
    const repaired = platesFromRegistrationValue(value)[0]?.plate
    if (repaired) return repaired
  }
  return printedRegistrationPlate(text)
}

/** Printed field first. Do not morph digits toward STOCK DOCUMENTS. */
export function matchCertificateToRegister(text: string, guess?: string | null, _sheetPlates?: Set<string>) {
  return printedRegistrationPlate(text) || parseKenyanPlate(guess) || certificatePlateCandidates(text)[0]?.plate || null
}

export function plateConfidence(filename: string, subject = '', body = '') {
  const inName = plateFromText(filename)
  if (inName) return { plate: inName, confidence: 96 }
  const inSubject = plateFromText(subject)
  if (inSubject) return { plate: inSubject, confidence: 88 }
  const inBody = plateFromText(body)
  if (inBody) return { plate: inBody, confidence: 72 }
  return { plate: null as string | null, confidence: 0 }
}

export const APP_FILE_NAMES = new Set([
  'fleetwise-config.json',
  'fleetwise-audit.jsonl',
  'fleetwise-gmail-state.json',
  'fleetwise-process.json',
  'fleetwise-insurance-cover.json',
  'fleetwise-register-sync.json',
])
