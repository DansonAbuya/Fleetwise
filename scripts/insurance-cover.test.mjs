import assert from 'node:assert/strict'
import test from 'node:test'
import { insuranceState, parseInsuranceCover } from '../lib/insurance.ts'

const now = new Date('2026-10-16T09:00:00')

test('parses Kenyan commencement and expiry labels', () => {
  const cover = parseInsuranceCover(`
    CERTIFICATE OF INSURANCE
    REGISTRATION No KMHD764Y
    COMMENCEMENT DATE: 01/04/2026
    EXPIRY DATE: 31/03/2027
  `)
  assert.equal(cover.commencement, '2026-04-01')
  assert.equal(cover.expiry, '2027-03-31')
})

test('parses period of insurance from / to', () => {
  const cover = parseInsuranceCover('PERIOD OF INSURANCE From: 15.10.2026 To: 14.10.2027')
  assert.equal(cover.commencement, '2026-10-15')
  assert.equal(cover.expiry, '2027-10-14')
})

test('parses Kenyan statutory hours-on-the-Nth-day wording', () => {
  const cover = parseInsuranceCover(`
    CERTIFICATE OF MOTOR INSURANCE
    Issued in accordance with the provisions of the Insurance (Motor Vehicles Third Party Risks) Act
    REGISTRATION MARK KMHD764Y
    PERIOD OF INSURANCE
    From 00.01 hours on the 1st day of April 2026
    to 23.59 hours on the 31st day of March 2027
  `)
  assert.equal(cover.commencement, '2026-04-01')
  assert.equal(cover.expiry, '2027-03-31')
})

test('parses 01-Apr-2026 beside expiry', () => {
  const cover = parseInsuranceCover('COMMENCEMENT DATE EXPIRY DATE 01-Apr-2026 31-Mar-2027')
  assert.equal(cover.commencement, '2026-04-01')
  assert.equal(cover.expiry, '2027-03-31')
})

test('parses dotted dates with spaces after the dots', () => {
  const cover = parseInsuranceCover('Period of Insurance From 0001 Hrs 01. 07. 2025 To 2359 Hrs 30. 06. 2026')
  assert.equal(cover.commencement, '2025-07-01')
  assert.equal(cover.expiry, '2026-06-30')
})

test('parses midnight hours on numeric dates', () => {
  const cover = parseInsuranceCover('From 00:01 hrs on 25/03/2026 to 23:59 hrs on 24/03/2027')
  assert.equal(cover.commencement, '2026-03-25')
  assert.equal(cover.expiry, '2027-03-24')
})

test('notifies at one week and the last two days', () => {
  assert.equal(insuranceState({ commencement: '2026-01-01', expiry: '2026-10-23' }, now).alert, 'week')
  assert.equal(insuranceState({ commencement: '2026-01-01', expiry: '2026-10-18' }, now).alert, 'two-days')
  assert.equal(insuranceState({ commencement: '2026-01-01', expiry: '2026-10-16' }, now).alert, 'two-days')
  assert.equal(insuranceState({ commencement: '2026-01-01', expiry: '2026-10-15' }, now).alert, 'expired')
  assert.equal(insuranceState({ commencement: '2026-01-01', expiry: '2026-12-01' }, now).alert, null)
})
