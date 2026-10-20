import { hasCanonicalName, stripUnmatchedMark } from './document-names'
import type { SheetCells } from './modules/types'
import { compactPlate, extractKenyanPlate } from './plates'
import { driveIdFromUri, isDriveDocumentUri } from './sheets/client'
import type { DocType, DuplicateFile, TypedFile } from './types'

/** True when this plate is a Registration Number row on STOCK DOCUMENTS. */
export function onRegister(plate: string | null | undefined, sheetPlates?: Set<string>) {
  const compact = compactPlate(plate || '')
  if (!compact || !sheetPlates?.size) return false
  return sheetPlates.has(compact) || sheetPlates.has(plate || '')
}

export function filePlate(file: Pick<TypedFile, 'name' | 'plate'>) {
  return compactPlate(file.plate || extractKenyanPlate(stripUnmatchedMark(file.name) || file.name) || '')
}

function sheetDocument(cells: SheetCells | undefined, plate: string, type: DocType) {
  if (!plate || !cells?.size) return
  const row = cells.get(plate) || cells.get(compactPlate(plate))
  const cell = row?.[type]
  if (!cell?.uri || !isDriveDocumentUri(cell.uri)) return
  return cell
}

function sameUploadedFile(file: TypedFile, linkedId: string) {
  if (file.id === linkedId || file.shortcutDetails?.targetId === linkedId) return true
  if (file.parents?.includes(linkedId)) return true
  return driveIdFromUri(file.webViewLink) === linkedId
}

const DUPLICATE_TYPES = new Set<DocType>(['logbook', 'certificate', 'photo'])

/**
 * Extra logbook, insurance, or photo files for one registration number.
 * A group exists only when that plate has more than one file of the same type
 * and one of those files is the one linked on STOCK DOCUMENTS.
 * The linked file is not a duplicate.
 */
export function surplusCopies(files: TypedFile[], cells?: SheetCells): DuplicateFile[] {
  const groups = new Map<string, TypedFile[]>()
  for (const file of files) {
    if (!DUPLICATE_TYPES.has(file.type)) continue
    const plate = filePlate(file)
    if (!plate) continue
    const key = `${file.type}:${plate}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(file)
    else groups.set(key, [file])
  }
  const extras: DuplicateFile[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const plate = filePlate(group[0])
    const type = group[0].type
    const cell = sheetDocument(cells, plate, type)
    const linkedId = cell?.uri ? driveIdFromUri(cell.uri) : ''
    if (!linkedId) continue
    const matched = group.find((file) => sameUploadedFile(file, linkedId))
    if (!matched) continue
    for (const file of group) {
      if (sameUploadedFile(file, linkedId)) continue
      extras.push({
        ...file,
        plate,
        sheetLabel: matched.name,
        uploadedId: matched.id,
        uploadedName: matched.name,
        uploadedLink: matched.webViewLink || cell?.uri,
      })
    }
  }
  return extras
}

/** Drive folder files that are not matched to a Registration Number on the sheet. */
export function isUnmatchedFile(file: TypedFile, sheetPlates?: Set<string>) {
  if ((file.type === 'logbook' || file.type === 'agreement') && !hasCanonicalName(file)) return true
  return !onRegister(filePlate(file), sheetPlates)
}
