import assert from 'node:assert/strict'
import test from 'node:test'
import { compactPlate, extractKenyanPlate, isKenyanPlate } from '../lib/plates.ts'

function documentBaseName(name) {
  return name.replace(/\.(pdf|jpe?g|png|webp|gif|heic)$/i, '').trim()
}

function suggestedLogbookName(plate) {
  return `${compactPlate(plate)} - Logbook`
}

function plateFromLogbookName(name) {
  const base = documentBaseName(name)
  const body = base.match(/^(.+?)\s*[-–—]?\s*logbook(?:\s+\d+)?$/i)?.[1]
    || base.match(/^logbook\s*[-–—]?\s*(.+)$/i)?.[1]
  const fromLabel = body ? compactPlate(body) : ''
  if (isKenyanPlate(fromLabel)) return fromLabel
  return extractKenyanPlate(base)
}

function isCanonicalLogbook(name) {
  const plate = plateFromLogbookName(name)
  if (!plate) return false
  const expected = suggestedLogbookName(plate)
  return name === expected || new RegExp(`^${expected} \\d+$`).test(name)
}

test('canonical logbook name is plate space hyphen space Logbook', () => {
  assert.equal(suggestedLogbookName('KMGY668X'), 'KMGY668X - Logbook')
  assert.equal(isCanonicalLogbook('KMGY668X - Logbook'), true)
})

test('wrong logbook formats are not canonical', () => {
  assert.equal(isCanonicalLogbook('KMGY668X-Logbook'), false)
  assert.equal(isCanonicalLogbook('KMGY668X Logbook'), false)
  assert.equal(isCanonicalLogbook('Logbook KMGY668X'), false)
  assert.equal(isCanonicalLogbook('KMGY668X - Logbook.pdf'), false)
  assert.equal(isCanonicalLogbook('KMGY668X.pdf'), false)
})

test('plate is still read from wrong logbook filenames', () => {
  assert.equal(plateFromLogbookName('KMGY668X-Logbook'), 'KMGY668X')
  assert.equal(plateFromLogbookName('Logbook - KMGY668X'), 'KMGY668X')
  assert.equal(plateFromLogbookName('KMGY668X.pdf'), 'KMGY668X')
  assert.equal(plateFromLogbookName('Copy of KMGY668X records.pdf'), 'KMGY668X')
})

test('wrong-format logbooks stay unmatched even when the plate is on the sheet', () => {
  const onSheet = new Set(['KMGY668X'])
  function unmatched(name) {
    if (!isCanonicalLogbook(name)) return true
    const plate = plateFromLogbookName(name)
    return !plate || !onSheet.has(plate)
  }
  assert.equal(unmatched('KMGY668X - Logbook'), false)
  assert.equal(unmatched('KMGY668X-Logbook'), true)
  assert.equal(unmatched('KMGY668X.pdf'), true)
})
