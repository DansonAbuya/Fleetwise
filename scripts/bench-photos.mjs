import { readdir, readFile } from 'node:fs/promises'
import { extractPhotoRegistration, shutdownOcrWorkers } from './read-plate.mjs'

const expected = new Map([
  ['tmp-p1-rear.jpg', 'KMHD764Y'],
  ['tmp-p2-rear.jpg', 'KMHD767Y'],
  ['tmp-p3-rear.jpg', 'KMHD439Y'],
  ['tmp-loc-p1.jpg', 'KMHD764Y'],
  ['tmp-loc-p2.jpg', 'KMHD767Y'],
  ['tmp-loc-p3.jpg', 'KMHD439Y'],
])

const files = (await readdir('.')).filter((name) => /^(tmp-p[123]-rear|tmp-loc-p[123])\.jpg$/i.test(name))
const times = []
let correct = 0
let review = 0
let wrong = 0
const cpuStart = process.cpuUsage()
const memStart = process.memoryUsage().heapUsed
const wallStart = Date.now()
for (const file of files) {
  const bytes = await readFile(file)
  const result = await extractPhotoRegistration(bytes)
  times.push(result.processingTimeMs)
  const want = expected.get(file)
  if (result.status === 'success' && result.registrationNumber === want) correct++
  else if (result.status === 'success' && want && result.registrationNumber !== want) wrong++
  else review++
  console.log(JSON.stringify({ file, ...result, expected: want || null }))
}
times.sort((a, b) => a - b)
const totalMs = Date.now() - wallStart
const pct = (p) => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))] || 0
const cpu = process.cpuUsage(cpuStart)
console.log(JSON.stringify({
  totalPhotos: files.length,
  correctlyExtracted: correct,
  manualReview: review,
  incorrect: wrong,
  averageMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
  medianMs: pct(0.5),
  p95Ms: pct(0.95),
  imagesPerMinute: totalMs ? Number(((files.length * 60000) / totalMs).toFixed(2)) : 0,
  heapDeltaMb: Number(((process.memoryUsage().heapUsed - memStart) / 1024 / 1024).toFixed(2)),
  cpuUserMs: Math.round(cpu.user / 1000),
  cpuSystemMs: Math.round(cpu.system / 1000),
}, null, 2))
await shutdownOcrWorkers().catch(() => {})
