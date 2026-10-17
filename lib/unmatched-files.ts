import { hasCanonicalName, stripUnmatchedMark } from './document-names'
import { compactPlate, extractKenyanPlate } from './plates'
import type { TypedFile } from './types'

/** True when this plate is a Registration Number row on STOCK DOCUMENTS. */
export function onRegister(plate: string | null | undefined, sheetPlates?: Set<string>) {
  const compact = compactPlate(plate || '')
  if (!compact || !sheetPlates?.size) return false
  return sheetPlates.has(compact) || sheetPlates.has(plate || '')
}

/** Drive folder files that are not matched to a Registration Number on the sheet. */
export function isUnmatchedFile(file: TypedFile, sheetPlates?: Set<string>) {
  if ((file.type === 'logbook' || file.type === 'agreement') && !hasCanonicalName(file)) return true
  const plate = compactPlate(file.plate || extractKenyanPlate(stripUnmatchedMark(file.name) || file.name) || '')
  return !onRegister(plate, sheetPlates)
}
