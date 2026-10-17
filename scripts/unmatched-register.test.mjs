import assert from 'node:assert/strict'
import test from 'node:test'
import { compactPlate, extractKenyanPlate } from '../lib/plates.ts'

function onRegister(plate, sheetPlates) {
  const compact = compactPlate(plate || '')
  if (!compact || !sheetPlates?.size) return false
  return sheetPlates.has(compact)
}

function isUnmatched(file, sheetPlates) {
  const plate = compactPlate(file.plate || extractKenyanPlate(file.name) || '')
  return !onRegister(plate, sheetPlates)
}

test('unnamed folder files are unmatched', () => {
  assert.equal(isUnmatched({ id: 'scan', name: 'Motor Vehicle Copy of Records.pdf', type: 'logbook', plate: null }, new Set(['KMHD764Y'])), true)
})

test('folder file named with a sheet registration is matched only by plate', () => {
  assert.equal(isUnmatched({ id: 'named', name: 'KMHD764Y - Logbook', type: 'logbook', plate: 'KMHD764Y' }, new Set(['KMHD764Y'])), false)
})

test('folder file whose plate is not on STOCK DOCUMENTS is unmatched', () => {
  assert.equal(isUnmatched(
    { id: 'off', name: 'KDA123A - Logbook', type: 'logbook', plate: 'KDA123A' },
    new Set(['KMHD764Y']),
  ), true)
})
