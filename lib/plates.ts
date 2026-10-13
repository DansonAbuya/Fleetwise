const PLATE_RE = /K[A-Z]{2,3}[\s\-._]*\d{3}[\s\-._]*[A-Z]/gi
const COMPACT_PLATE_RE = /K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z]/gi
const COMPACT_PLATE_ID = /^K[A-Z]{2,3}\d{3}[A-Z]$/

export function isKenyanPlate(plate: string) {
  return COMPACT_PLATE_ID.test(compactPlate(plate))
}

/** Always one token, e.g. KMHE520A or KDA482M — never split across lines or spaces. */
export function compactPlate(raw: string) {
  return raw.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
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
  const compact = compactPlate(raw)
  if (/^(K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z])$/.test(compact)) return compact
  return compact
}

export function platesFromText(text: string) {
  const found: string[] = []
  const add = (raw: string) => {
    const plate = normalizePlate(raw)
    if (!isKenyanPlate(plate)) return
    if (!found.includes(plate)) found.push(plate)
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
  if (kind === 'certificate') {
    const labeled = plateFromCertificateText(text)
    if (labeled) return labeled
  }
  const counts = new Map<string, number>()
  const bump = (plate: string, weight = 1) => {
    if (!isKenyanPlate(plate)) return
    counts.set(plate, (counts.get(plate) || 0) + weight)
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
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    const bike = Number(b[0].startsWith('KM')) - Number(a[0].startsWith('KM'))
    if (bike) return bike
    return b[0].length - a[0].length
  })
  if (ranked[0]?.[1] >= 2) return ranked[0][0]
  if (kind === 'photo' && ranked[0]?.[0].startsWith('KM') && ranked[0][0].length === 8) return ranked[0][0]
  if (kind === 'photo' && ranked.length === 1) return ranked[0][0]
  if (ranked[0] && ranked[0][1] > (ranked[1]?.[1] || 0)) return ranked[0][0]
  return plateFromText(text)
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

const REG_LABEL = /(?:^|\b)(?:vehicle\s+|motor(?:\s+vehicle)?\s+|m\.?\s*v\.?\s+)?(?:registration(?:\s*(?:no\.?|number|num|mark|#))?|reg(?:istration)?\.?\s*(?:no\.?|number|num|mark|#)?)\.?(?:\b|$)/i
const NEXT_FIELD = /\b(chassis|make|model|engine|body|colour|color|year|seating|tonnage|policy|insured|commencement|expiry|owner|pin|tare|gvw)\b/i
const REG_LABEL_GLOBAL = /\b(?:vehicle\s+|motor(?:\s+vehicle)?\s+|m\.?\s*v\.?\s+)?(?:registration(?:\s*(?:no\.?|number|num|mark|#))?|reg(?:istration)?\.?\s*(?:no\.?|number|num|mark|#)?)\.?/gi

/** Use the value of REGISTRATION / REGISTRATION No on a logbook or insurance certificate. */
export function plateFromCertificateText(text: string) {
  if (!text?.trim()) return null
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const scored: { plate: string; weight: number }[] = []
  const add = (raw: string, weight: number) => {
    if (!raw) return
    for (const plate of [...kenyanPlatesIn(raw), ...platesFromText(raw)]) {
      let score = weight
      if (compactPlate(raw) === plate) score += 50
      if (plate.length === 8) score += 8
      scored.push({ plate, weight: score })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!REG_LABEL.test(lines[i])) continue
    const afterLabel = lines[i]
      .replace(/^.*?(?:registration(?:\s*(?:no\.?|number|num|mark|#))?|reg\.?\s*(?:no\.?|number|num|mark|#))\.?\s*[:\-–.]*/i, '')
      .trim()
    add(afterLabel, 90)
    if (i > 0 && !NEXT_FIELD.test(lines[i - 1])) add(lines[i - 1], 55)
    if (lines[i + 1] && !NEXT_FIELD.test(lines[i + 1]) && !REG_LABEL.test(lines[i + 1])) add(lines[i + 1], 80)
    if (lines[i + 2] && !NEXT_FIELD.test(lines[i + 2]) && !REG_LABEL.test(lines[i + 2])) add(lines[i + 2], 40)
    add([afterLabel, lines[i + 1], lines[i + 2]].filter(Boolean).join(' '), 70)
  }
  const flat = text.replace(/\s+/g, ' ')
  for (const match of flat.matchAll(REG_LABEL_GLOBAL)) {
    const start = (match.index || 0) + match[0].length
    add(flat.slice(start, start + 180), 85)
  }
  scored.sort((a, b) => b.weight - a.weight || b.plate.length - a.plate.length)
  return scored[0]?.plate || null
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
])
