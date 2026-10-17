import { compactPlate, extractKenyanPlate, isKenyanPlate, plateFromText } from './plates'
import type { DocType } from './types'

const UNMATCHED_PREFIX = /^unmatched\s+/i

export function documentBaseName(name: string) {
  return name.replace(/\.(pdf|jpe?g|png|webp|gif|heic)$/i, '').trim()
}

export function hasUnmatchedMark(name: string) {
  return UNMATCHED_PREFIX.test(documentBaseName(name))
}

export function stripUnmatchedMark(name: string) {
  return documentBaseName(name).replace(UNMATCHED_PREFIX, '').trim()
}

export function suggestedAgreementName(plate: string) {
  return `${compactPlate(plateFromText(plate) || plate)} - Agreement`
}

export function suggestedName(plate: string, type: DocType, _original?: string) {
  const registration = compactPlate(plateFromText(plate) || plate)
  if (type === 'photo') return `Photos ${registration}`
  if (type === 'certificate') return `Insurance - ${registration}`
  if (type === 'agreement') return suggestedAgreementName(registration)
  return `${registration} - Logbook`
}

export function uniqueSuggestedName(plate: string, type: DocType, original: string, taken?: Iterable<string>) {
  const base = suggestedName(plate, type, original)
  if (/^UNREADABLE$/i.test(compactPlate(plate))) return documentBaseName(original)
  if (!taken) return base
  const names = taken instanceof Set ? taken : new Set(taken)
  if (!names.has(base) || original === base || documentBaseName(original) === base) return base
  for (let n = 2; n < 80; n++) {
    const next = `${base} ${n}`
    if (!names.has(next)) return next
  }
  return `${base} ${Date.now()}`
}

/** Plate from Insurance -KMHC335S, Photos KMHC335S, KMGY668X - Logbook. */
export function plateFromTypedName(name: string, type: DocType) {
  const base = stripUnmatchedMark(name)
  if (type === 'certificate') {
    const body = base.match(/^insurance\s*-?\s*(.+)$/i)?.[1]
    const plate = body ? compactPlate(body) : ''
    return isKenyanPlate(plate) ? plate : null
  }
  if (type === 'photo') {
    const body = base.match(/^photos\s+(.+)$/i)?.[1]
    const plate = body ? compactPlate(body) : ''
    return isKenyanPlate(plate) ? plate : null
  }
  if (type === 'agreement') {
    const body = base.match(/^(.+?)\s*[-–—]\s*agreement(?:\s+\d+)?$/i)?.[1]
      || base.match(/^agreement\s*[-–—]\s*(.+)$/i)?.[1]
    const plate = body ? compactPlate(body) : extractKenyanPlate(base)
    return isKenyanPlate(plate) ? plate : null
  }
  const logbookBody = base.match(/^(.+?)\s*[-–—]?\s*logbook(?:\s+\d+)?$/i)?.[1]
    || base.match(/^logbook\s*[-–—]?\s*(.+)$/i)?.[1]
  const fromLabel = logbookBody ? compactPlate(logbookBody) : ''
  if (isKenyanPlate(fromLabel)) return fromLabel
  return extractKenyanPlate(base)
}

function matchesCanonical(name: string, expected: string) {
  if (name === expected) return true
  return new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+$`).test(name)
}

export function hasCanonicalAgreementName(file: { name: string; type?: DocType }) {
  if (file.type && file.type !== 'agreement') return false
  const plate = plateFromTypedName(file.name, 'agreement')
  if (!plate) return false
  return matchesCanonical(file.name, suggestedAgreementName(plate))
}

export function hasCanonicalName(file: { name: string; type: DocType }) {
  const plate = plateFromTypedName(file.name, file.type)
  if (!plate) return false
  const expected = suggestedName(plate, file.type, file.name)
  return matchesCanonical(file.name, expected)
}
