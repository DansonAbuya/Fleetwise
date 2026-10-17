import assert from 'node:assert/strict'
import test from 'node:test'
import { plateFromLogbookText } from '../lib/plates.ts'

test('reads NTSA copy of records Registration Number beside Chassis Number', () => {
  const plate = plateFromLogbookText(`
    REPUBLIC OF KENYA
    NATIONAL TRANSPORT AND SAFETY AUTHORITY
    MOTOR VEHICLE COPY OF RECORDS
    Certificate of Registration
    Date of Registration 12/03/2024
    Registration Number Chassis Number
    KMHD764Y MB3JC1234567890
    Engine Number Make
    12345 HONDA
  `)
  assert.equal(plate, 'KMHD764Y')
})

test('reads registration mark and number on the following lines', () => {
  const plate = plateFromLogbookText(`
    Particulars of the vehicle
    Registration mark and number
    KMHD
    764Y
    Chassis
    MB3JC1234567890
  `)
  assert.equal(plate, 'KMHD764Y')
})

test('ignores Certificate of Registration title', () => {
  const plate = plateFromLogbookText(`
    CERTIFICATE OF REGISTRATION
    MOTOR VEHICLE
    Registration Number
    KMDX123A
  `)
  assert.equal(plate, 'KMDX123A')
})

test('reads REGISTRATION No on one line', () => {
  assert.equal(plateFromLogbookText('REGISTRATION No: KMHE520A MAKE HONDA'), 'KMHE520A')
})

test('reads spaced registration number under NTSA particulars', () => {
  assert.equal(plateFromLogbookText(`
    MOTOR VEHICLE COPY OF RECORDS
    Particulars of the Vehicle
    Registration Number
    KDA 123A
    Make
    TOYOTA
    Chassis Number
    AHTZZ8D32E0123456
  `), 'KDA123A')
})

test('skips chassis VIN that looks like it contains a plate', () => {
  assert.equal(plateFromLogbookText(`
    Certificate of Registration
    Registration Number Chassis Number
    KDA123A KMHCM81BP7U123456
    Engine Number
    1NZ1234567
  `), 'KDA123A')
})

test('joins registration mark wrapped onto the next lines', () => {
  assert.equal(plateFromLogbookText(`
    Identification mark and number
    of vehicle
    KMHD
    764Y
    Chassis Number
    MLHJC1234567890
  `), 'KMHD764Y')
})
