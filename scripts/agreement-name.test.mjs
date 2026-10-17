import assert from 'node:assert/strict'
import test from 'node:test'

function documentBaseName(name) {
  return name.replace(/\.(pdf|jpe?g|png|webp|gif|heic)$/i, '').trim()
}

function compactPlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function isKenyanPlate(value) {
  return /^K[A-Z]{2}\d{3}[A-Z]$/.test(value) || /^K[A-Z]{3}\d{3}[A-Z]$/.test(value)
}

function suggestedAgreementName(plate) {
  return `${compactPlate(plate)} - Agreement`
}

function plateFromAgreementName(name) {
  const base = documentBaseName(name)
  const body = base.match(/^(.+?)\s*[-–—]\s*agreement(?:\s+\d+)?$/i)?.[1]
    || base.match(/^agreement\s*[-–—]\s*(.+)$/i)?.[1]
  const plate = body ? compactPlate(body) : ''
  return isKenyanPlate(plate) ? plate : null
}

function isCanonicalAgreement(name) {
  const plate = plateFromAgreementName(name)
  if (!plate) return false
  return name === suggestedAgreementName(plate) || new RegExp(`^${suggestedAgreementName(plate)} \\d+$`).test(name)
}

function isAgreementHeader(cell) {
  const value = String(cell || '').toLowerCase()
  return value.includes('agreement') && !value.includes('logbook')
}

test('canonical agreement name is plate space hyphen space Agreement', () => {
  assert.equal(suggestedAgreementName('KMGY668X'), 'KMGY668X - Agreement')
  assert.equal(isCanonicalAgreement('KMGY668X - Agreement'), true)
})

test('logbook names are not treated as agreement files', () => {
  assert.equal(isCanonicalAgreement('KMGY668X - Logbook'), false)
})

test('Agreement Link is a separate column from Logbook / Agreement', () => {
  assert.equal(isAgreementHeader('Agreement Link'), true)
  assert.equal(isAgreementHeader('agreement link'), true)
  assert.equal(isAgreementHeader('Logbook / Agreement'), false)
  assert.equal(isAgreementHeader('PSV Insurance'), false)
})
