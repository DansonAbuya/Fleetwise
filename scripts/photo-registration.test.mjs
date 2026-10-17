import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import sharp from 'sharp'
import { extractPhotoRegistration, shutdownOcrWorkers } from './read-plate.mjs'

async function readSample(file, expected) {
  const result = await extractPhotoRegistration(await readFile(file))
  assert.notEqual(result.registrationNumber, 'UNREADABLE')
  if (result.status === 'success') assert.equal(result.registrationNumber, expected)
  else assert.ok(result.status === 'review_required' || result.status === 'unreadable')
  return result
}

test('clear yellow two-line plate reads KMHD764Y', async () => {
  const result = await extractPhotoRegistration(await readFile('tmp-p1-rear.jpg'))
  assert.equal(result.status, 'success')
  assert.equal(result.registrationNumber, 'KMHD764Y')
})

test('partial white plate is review or KMHD767Y, never a different plate', async () => {
  await readSample('tmp-p2-rear.jpg', 'KMHD767Y')
})

test('white two-line plate with shadows reads KMHD439Y', async () => {
  const result = await extractPhotoRegistration(await readFile('tmp-p3-rear.jpg'))
  assert.equal(result.status, 'success')
  assert.equal(result.registrationNumber, 'KMHD439Y')
})

test('photos with no readable registration are not invented', async () => {
  const bytes = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 40, b: 40 } },
  }).jpeg().toBuffer()
  const result = await extractPhotoRegistration(bytes)
  assert.ok(result.status === 'unreadable' || result.status === 'review_required')
  assert.equal(result.registrationNumber, null)
})

test('unreadable buffers do not invent a registration', async () => {
  const result = await extractPhotoRegistration(Buffer.from('not-an-image'))
  assert.notEqual(result.status, 'success')
  assert.equal(result.registrationNumber, null)
})

test('uncertain results never use a fabricated registration value', async () => {
  const bytes = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 220, g: 220, b: 80 } },
  }).jpeg().toBuffer()
  const result = await extractPhotoRegistration(bytes)
  assert.notEqual(result.registrationNumber, 'UNREADABLE')
  if (result.status !== 'success') assert.equal(result.registrationNumber, null)
})

test.after(async () => {
  await shutdownOcrWorkers().catch(() => {})
})
