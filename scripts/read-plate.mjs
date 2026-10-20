import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import sharp from 'sharp'
import { createWorker } from 'tesseract.js'
import { z } from 'zod'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const langPath = [
  join(root, 'scripts', 'tessdata'),
  join(process.cwd(), 'scripts', 'tessdata'),
  join('/var/task', 'scripts', 'tessdata'),
].find((dir) => existsSync(join(dir, 'eng.traineddata.gz')) || existsSync(join(dir, 'eng.traineddata')))
  || join(root, 'scripts', 'tessdata')
const cachePath = join(tmpdir(), 'fleetwise-tesseract-cache')
const workerPath = require.resolve('tesseract.js/src/worker-script/node/index.js')
let corePath = ''
try {
  corePath = dirname(require.resolve('tesseract.js-core/package.json'))
} catch {
  corePath = ''
}

const MAX_WORKERS = process.env.VERCEL ? 1 : 5
const DETECT_MAX_EDGE = 1280
const pool = []
const waiters = []
let creating = 0
let pdfjsGetDocument

function photoPlateConfig() {
  const prefix = String(process.env.PHOTO_PLATE_PREFIX || 'KM').toUpperCase().replace(/[^A-Z]/g, '') || 'KM'
  const pattern = process.env.PHOTO_PLATE_PATTERN || `^${prefix}[A-Z]{${Math.max(0, 4 - prefix.length)}}\\d{3}[A-Z]$`
  return { prefix, pattern: new RegExp(pattern) }
}

const photoRegistrationSchema = z.object({
  registrationNumber: z.string().nullable(),
  status: z.enum(['success', 'review_required', 'unreadable']),
  confidence: z.number().nullable(),
  reason: z.string().optional(),
  processingTimeMs: z.number(),
  timings: z.object({
    detectMs: z.number(),
    preprocessMs: z.number(),
    ocrMs: z.number(),
    validateMs: z.number(),
  }).optional(),
  retry: z.boolean().optional(),
  bytes: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})

function labeledKenyanPlate(text) {
  return parseKenyanPlate(plateFromRegistrationField(text, false) || '')
}

export async function extractPdfjsRegistration(bytes) {
  const source = unwrapPdf(bytes)
  const pdf = await readPdf(source.pdf ? source.bytes : bytes, false)
  return withFoundPlate(pdf.text)
}

export async function warmOcr() {
  const workers = await Promise.all(Array.from({ length: MAX_WORKERS }, () => acquireWorker()))
  for (const worker of workers) releaseWorker(worker)
}

export async function extractPlateText(bytes, kind = 'photo') {
  const source = unwrapPdf(bytes)
  const chunks = []
  if (kind === 'pdfjs') return extractPdfjsRegistration(bytes)
  if (kind === 'photo' || kind === 'photo-json') {
    const result = await extractPhotoRegistration(source.bytes)
    if (kind === 'photo-json') return JSON.stringify(result)
    if (result.registrationNumber) return `REGISTRATION No: ${result.registrationNumber}`
    return result.reason || ''
  }
  if (source.pdf || kind === 'pdf' || kind === 'pdf-confirm') {
    const confirm = kind === 'pdf-confirm'
    const pdf = await readPdf(source.pdf ? source.bytes : bytes, confirm ? 'always' : true)
    if (pdf.text.trim()) chunks.push(pdf.text.trim())
    if (!confirm && labeledKenyanPlate(chunks.join('\n'))) return withFoundPlate(chunks.join('\n'))
    if (pdf.pages.length) {
      const ocrText = await ocrPrepared(pdf.pages, 'certificate')
      if (ocrText.trim()) chunks.push(ocrText.trim())
    }
    return withFoundPlate(chunks.join('\n'), 'pdf')
  }
  if (kind === 'certificate' || kind === 'logbook') {
    const documentText = await ocrPrepared([source.bytes], 'certificate')
    if (documentText.trim()) chunks.push(documentText.trim())
    return withFoundPlate(chunks.join('\n'), 'certificate')
  }
  const ocrText = await ocrPhoto(source.bytes)
  if (ocrText.trim()) chunks.push(ocrText.trim())
  return withFoundPlate(chunks.join('\n'), 'photo')
}

function withFoundPlate(text, kind = 'certificate') {
  const plate = kind === 'photo'
    ? pickPhotoPlate(text)
    : parseKenyanPlate(plateFromRegistrationField(text, false))
  if (!plate) return text
  if (new RegExp(`REGISTRATION No:\\s*${plate}`, 'i').test(text)) return text
  return `REGISTRATION No: ${plate}\n${text}`
}

function pickPhotoPlate(text) {
  const counts = new Map()
  const bump = (raw, weight = 1) => {
    const plate = parsePhotoPlate(asBikePlate(raw))
    if (!plate) return
    counts.set(plate, (counts.get(plate) || 0) + weight)
  }
  const compactAll = String(text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  bump(asBikePlate(compactAll), 1)
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean)
  const prefixes = []
  const suffixes = []
  for (const compact of lines) {
    bump(asBikePlate(compact), compact.length === 8 ? 8 : 2)
    const prefix = bikePrefixToken(compact)
    if (prefix) prefixes.push({ value: prefix, weight: compact === prefix ? 10 : 3 })
    const suffix = bikeSuffixToken(compact)
    if (suffix) suffixes.push({ value: suffix, weight: compact === suffix ? 12 : 4 })
  }
  if (!prefixes.length) {
    for (const compact of lines) {
      const repaired = repairBikePrefix(compact)
      if (repaired) prefixes.push({ value: repaired, weight: 4 })
    }
  }
  for (const prefix of prefixes) {
    for (const suffix of suffixes) bump(`${prefix.value}${suffix.value}`, 8 + prefix.weight + suffix.weight)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
  return ranked[0]?.[0] || ''
}

function bikePrefixToken(compact) {
  const km = compact.match(/KM[A-Z]{2}/)
  if (km) return km[0]
  if (/^M[A-Z]{2}$/.test(compact)) return `K${compact}`
  return repairBikePrefix(compact)
}

function bikeSuffixToken(compact) {
  if (/^\d{3}[A-Z]$/.test(compact)) return compact
  const loose = compact.match(/^(\d{3})[A-Z]*([A-Z])$/)
  if (loose && compact.length <= 6) return `${loose[1]}${loose[2]}`
  const embedded = compact.match(/\d{3}[A-Z]/)
  return embedded?.[0] || ''
}

function repairBikePrefix(compact) {
  const letters = String(compact || '').replace(/[^A-Z]/g, '')
  if (/^KM[A-Z]{2}$/.test(letters)) return letters
  if (letters.length === 3 && letters[0] === 'M') return `K${letters}`
  if (letters.length !== 4) return ''
  let [a, b, c, d] = letters
  if ('KXHFR'.includes(a)) a = 'K'
  if ('MNHWV'.includes(b)) b = 'M'
  if (a !== 'K' || b !== 'M') return ''
  return `${a}${b}${c}${d}`
}

function asBikePlate(raw) {
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const km = compact.match(/KM[A-Z]{2}\d{3}[A-Z]/)
  if (km) return km[0]
  const missingK = compact.match(/(?:^|[^A-Z])(M[A-Z]{2}\d{3}[A-Z])/)
  if (missingK) return `K${missingK[1]}`
  const prefix = bikePrefixToken(compact) || compact.match(/KM[A-Z]{2}/)?.[0]
  const suffix = bikeSuffixToken(compact)
  if (prefix && suffix) return `${prefix}${suffix}`
  return compact
}

export async function shutdownOcrWorkers() {
  const slots = pool.splice(0, pool.length)
  waiters.length = 0
  await Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => {})))
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height))
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, width)
    canvasAndContext.canvas.height = Math.max(1, height)
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

function pdfOffset(buffer) {
  const start = buffer.subarray(0, Math.min(buffer.length, 65_536)).toString('latin1').indexOf('%PDF-')
  return start
}

function unwrapPdf(buffer) {
  const start = pdfOffset(buffer)
  if (start < 0) return { pdf: false, bytes: buffer }
  return { pdf: true, bytes: start === 0 ? buffer : buffer.subarray(start) }
}

function isPdf(buffer) {
  return pdfOffset(buffer) >= 0
}

function pdfjsRoot() {
  try {
    return dirname(require.resolve('pdfjs-dist/package.json'))
  } catch {
    return join(root, 'node_modules', 'pdfjs-dist')
  }
}

function pdfAssetUrl(folder) {
  return pathToFileURL(join(pdfjsRoot(), folder) + '/').href
}

async function readPdf(buffer, raster = true) {
  try {
    return await readPdfDocument(buffer, raster)
  } catch {
    if (!raster) return { text: '', pages: [] }
    try {
      return await readPdfDocument(buffer, true)
    } catch {
      return { text: '', pages: [] }
    }
  }
}

async function loadPdfjs() {
  if (!pdfjsGetDocument) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjsGetDocument = mod.getDocument
  }
  return pdfjsGetDocument
}

async function readPdfDocument(buffer, raster = true) {
  const getDocument = await loadPdfjs()
  const data = Uint8Array.from(buffer)
  const canvasFactory = new NodeCanvasFactory()
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    disableRange: true,
    disableStream: true,
    verbosity: 0,
    useWasm: false,
    useWorkerFetch: false,
    cMapUrl: pdfAssetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfAssetUrl('standard_fonts'),
    wasmUrl: pdfAssetUrl('wasm'),
    iccUrl: pdfAssetUrl('iccs'),
  })
  const pdf = await loadingTask.promise
  const texts = []
  const pages = []
  try {
    const pageCount = Math.min(pdf.numPages, 2)
    const formText = await pdfFormText(pdf)
    if (formText.trim()) texts.push(formText)
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n)
      try {
        const content = await page.getTextContent()
        texts.push(layoutText(content.items))
        const raw = content.items.map((item) => String(item.str || '')).join(' ').replace(/\s+/g, ' ').trim()
        if (raw) texts.push(raw)
        const fields = await pageFieldText(page)
        if (fields.trim()) texts.push(fields)
      } catch {
        // Rasterize pages that have no usable text layer.
      }
    }
    const joined = texts.join('\n')
    const alwaysRaster = raster === 'always'
    if ((alwaysRaster || raster) && (alwaysRaster || !labeledKenyanPlate(joined))) {
      const page = await pdf.getPage(1)
      try {
        pages.push(await rasterPage(page, canvasFactory))
      } catch {
        try {
          pages.push(await rasterPage(page, canvasFactory, 1.15))
        } catch {
          // Text and form fields still run if a page cannot be rasterized.
        }
      }
    }
  } finally {
    try {
      pdf.cleanup?.()
    } catch {
      // pdf.js cleanup can throw after text is already extracted.
    }
  }
  return { text: texts.join('\n'), pages: pages.filter(Boolean) }
}

async function rasterPage(page, canvasFactory, scale) {
  const viewport = page.getViewport({ scale: scale || scaleFor(page) })
  const canvasAndContext = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvasAndContext.context
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvasAndContext.canvas.width, canvasAndContext.canvas.height)
  await page.render({
    canvasContext: ctx,
    canvas: canvasAndContext.canvas,
    viewport,
    canvasFactory,
    background: '#FFFFFF',
    intent: 'print',
  }).promise
  const png = canvasAndContext.canvas.toBuffer('image/png')
  canvasFactory.destroy(canvasAndContext)
  return png
}

function fieldValue(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((item) => fieldValue(item)).filter(Boolean).join(' ')
  if (typeof value === 'object') return String(value.str || value.name || '').trim()
  return String(value).trim()
}

async function pdfFormText(pdf) {
  try {
    const objects = await pdf.getFieldObjects?.()
    if (!objects) return ''
    const rows = []
    for (const [name, fields] of Object.entries(objects)) {
      for (const field of fields || []) {
        const value = fieldValue(field.value ?? field.fieldValue ?? field.displayValue)
        if (value) rows.push(`${name}: ${value}`)
      }
    }
    return rows.join('\n')
  } catch {
    return ''
  }
}

async function pageFieldText(page) {
  try {
    const annotations = await page.getAnnotations({ intent: 'display' })
    return annotations.map((annotation) => {
      const name = String(annotation.fieldName || annotation.title || '').trim()
      const value = fieldValue(annotation.fieldValue ?? annotation.contentsObj ?? annotation.contents)
      if (!name && !value) return ''
      return name ? `${name}: ${value}` : value
    }).filter(Boolean).join('\n')
  } catch {
    return ''
  }
}

function layoutText(items) {
  const tokens = items
    .filter((item) => item.str?.trim())
    .map((item) => ({
      str: String(item.str).replace(/\s+/g, ' ').trim(),
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const token of tokens) {
    const current = lines[lines.length - 1]
    if (current && Math.abs(current.y - token.y) <= 12) {
      current.parts.push(token)
      current.y = (current.y * (current.parts.length - 1) + token.y) / current.parts.length
    } else {
      lines.push({ y: token.y, parts: [token] })
    }
  }
  const rows = lines.map((line) => {
    line.parts.sort((a, b) => a.x - b.x)
    return line.parts.map((part) => part.str).join(' ')
  })
  const registration = registrationFromLayout(tokens, rows)
  return registration ? `REGISTRATION No: ${registration}\n${rows.join('\n')}` : rows.join('\n')
}

function kenyanPlatesIn(raw) {
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const found = []
  for (const match of compact.matchAll(/K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z]/g)) {
    if (match[0] && !found.includes(match[0])) found.push(match[0])
  }
  return found
}

function isPrefixToken(line) {
  return /^K[A-Z]{2,3}$/.test(line)
}

function isNumberToken(line) {
  return /^\d{3}[A-Z]$/.test(line)
}

function standaloneKenyanPlates(raw) {
  const found = []
  const add = (plate) => {
    const valid = parseKenyanPlate(plate)
    if (!valid || found.includes(valid)) return
    found.push(valid)
  }
  const tokens = String(raw || '').toUpperCase().match(/[A-Z0-9]+/g) || []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length > 10) {
      add(token.slice(0, 8))
      add(token.slice(0, 7))
      continue
    }
    add(token)
    const next = tokens[i + 1]
    if (next && isPrefixToken(token) && isNumberToken(next)) add(token + next)
  }
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length >= 7 && compact.length <= 10) add(compact)
  return found
}

function fixPlate(raw, prefixLetters) {
  const length = 1 + prefixLetters + 3 + 1
  if (!raw || raw.length !== length || raw[0] !== 'K') return ''
  const toLetter = (ch) => (/[A-Z]/.test(ch) ? ch : ch === '0' ? 'O' : ch === '1' ? 'I' : ch === '5' ? 'S' : ch === '8' ? 'B' : ch)
  const toDigit = (ch) => (/\d/.test(ch) ? ch : ch === 'O' || ch === 'Q' || ch === 'D' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch === 'Z' ? '2' : ch === 'S' ? '5' : ch === 'G' ? '6' : ch === 'B' ? '8' : ch)
  let cost = 0
  const letters = []
  for (let i = 0; i < prefixLetters; i++) {
    const ch = raw[i + 1]
    const next = toLetter(ch)
    if (!/[A-Z]/.test(next)) return ''
    if (next !== ch) cost++
    letters.push(next)
  }
  const digits = []
  for (let i = 0; i < 3; i++) {
    const ch = raw[1 + prefixLetters + i]
    const next = toDigit(ch)
    if (!/\d/.test(next)) return ''
    if (next !== ch) cost++
    digits.push(next)
  }
  const last = toLetter(raw[length - 1])
  if (!/[A-Z]/.test(last)) return ''
  if (last !== raw[length - 1]) cost++
  if (cost > 1) return ''
  return `K${letters.join('')}${digits.join('')}${last}`
}

function registrationPlate(raw) {
  return plateFromRegistrationField(raw, true)
}

function cutAtNextField(raw) {
  const index = String(raw || '').search(/\b(chassis|make|model|engine|body|colour|color|year|seating|tonnage|policy|insured|commencement|expiry|owner|pin|tare|gvw|cover|interpol|usage|cubic|certificate\s*no|date of)\b/i)
  return (index > 0 ? raw.slice(0, index) : raw).trim()
}

function registrationFieldValues(text) {
  const values = []
  const push = (raw) => {
    const value = cutAtNextField(String(raw || '').replace(/\s+/g, ' ').trim())
    if (value && !values.includes(value) && !/^(and\s+(?:number|no\.?)|of\s+(?:the\s+)?(?:motor\s+)?vehicle|of\s+trailer)$/i.test(value)) values.push(value)
  }
  const label = /\b(?:(?:vehicle|motor(?:\s+vehicle)?|m\.?\s*v\.?|identification)\s+)?(?:registration|reg(?:n)?\.?)[\s.:\-–]*?(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)\b|\bidentification\s+mark(?:\s+and\s+number)?\b/i
  const strip = /^.*?\b(?:(?:vehicle|motor(?:\s+vehicle)?|m\.?\s*v\.?|identification)\s+)?(?:registration|reg(?:n)?\.?)[\s.:\-–]*?(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)\b\.?\s*[:\-–.]*|^.*?\bidentification\s+mark(?:\s+and\s+number)?\b\.?\s*[:\-–.]*/i
  const nextField = /\b(chassis|make|model|engine|body|colour|color|year|seating|tonnage|policy|insured|commencement|expiry|owner|pin|tare|gvw|cover|interpol|usage|cubic|certificate\s*no|date of)\b/i
  const skip = /certificate of registration|registration certificate|date of (?:first )?registration|place of registration|registered (?:owner|keeper)/i
  const otherHeader = /^(chassis|make|model|engine|body|colour|color|year|owner|tare|gvw|class|type)\b/i
  const continuation = /^(and\s+(?:number|no\.?)|of\s+(?:the\s+)?(?:motor\s+)?vehicle|of\s+trailer)$/i
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    if (skip.test(lines[i]) || !label.test(lines[i])) continue
    let after = lines[i].replace(strip, '').trim()
    if (otherHeader.test(after) || skip.test(after) || continuation.test(after)) after = ''
    push(after)
    if (after && standaloneKenyanPlates(after).length) continue
    const extras = []
    for (let j = i + 1; j < lines.length && j < i + 7 && extras.length < 2; j++) {
      const line = lines[j]
      if (continuation.test(line) || skip.test(line)) continue
      if (label.test(line) || nextField.test(line) || otherHeader.test(line)) break
      extras.push(line)
      if (standaloneKenyanPlates(line).length && !isPrefixToken(line.replace(/[^A-Za-z0-9]/g, '').toUpperCase())) break
    }
    for (const extra of extras) push(extra)
    if (extras.length >= 2) push(extras.join(' '))
  }
  const flat = String(text || '').replace(/\s+/g, ' ')
  const global = new RegExp(label.source, 'gi')
  let match
  while ((match = global.exec(flat))) {
    const nearby = flat.slice(match.index, match.index + match[0].length + 12)
    if (skip.test(nearby)) continue
    push(flat.slice(match.index + match[0].length, match.index + match[0].length + 48))
  }
  return values
}

function plateFromRegistrationField(text, allowRepair = true) {
  for (const value of registrationFieldValues(text)) {
    const exact = standaloneKenyanPlates(value)[0]
    if (exact) return exact
  }
  if (!allowRepair) return ''
  for (const value of registrationFieldValues(text)) {
    const compact = String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    if (compact.length < 7 || compact.length > 14) continue
    const repaired = parseKenyanPlate(fixPlate(compact.slice(0, 8), 3) || fixPlate(compact.slice(0, 7), 2))
    if (repaired) return repaired
  }
  return ''
}

function registrationFromLayout(tokens, rows) {
  const labels = []
  tokens.forEach((token, index) => {
    if (/(?:registration|reg\.?)\s*(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)\b/i.test(token.str) || /\bidentification\s+mark\b/i.test(token.str)) {
      labels.push(token)
      return
    }
    if (/^reg(?:istration)?\.?$/i.test(token.str) && tokens[index + 1] && /^(no\.?|number|num|mark|#)$/i.test(tokens[index + 1].str)) {
      labels.push({ ...token, str: `${token.str} ${tokens[index + 1].str}` })
    }
  })
  const candidates = []
  function considerTokens(group, x, y) {
    const str = group.map((item) => item.str).join(' ')
    for (const plate of standaloneKenyanPlates(str)) {
      candidates.push({ plate, x, y, str, score: 0 })
    }
  }
  tokens.forEach((token, index) => {
    const group = [token]
    for (let n = 1; n <= 4; n++) {
      const next = tokens[index + n]
      if (!next) break
      if (Math.abs(token.y - next.y) < 14 && next.x - token.x < 520) group.push(next)
    }
    considerTokens(group, token.x, token.y)
  })
  const scored = []
  for (const label of labels) {
    const right = tokens.filter((item) => item.x > label.x - 8 && item.x - label.x < 520 && Math.abs(item.y - label.y) <= 22)
    considerTokens(right.sort((a, b) => a.x - b.x), label.x + 40, label.y)
    const below = tokens.filter((item) => item.y < label.y - 2 && label.y - item.y < 80 && Math.abs(item.x - label.x) < 240)
    considerTokens(below.sort((a, b) => b.y - a.y || a.x - b.x), label.x, label.y - 20)
    for (const item of candidates) {
      const dx = item.x - label.x
      const dy = item.y - label.y
      let score = 0
      if (dx > 4 && Math.abs(dy) <= 22) score += 80 - Math.abs(dy) * 2 - Math.min(dx, 480) / 12
      if (dy < -2 && dy > -80 && Math.abs(dx) < 240) score += 90 - Math.abs(dy) - Math.abs(dx) / 6
      if (dy > 2 && dy < 55 && Math.abs(dx) < 140) score += 40 - dy - Math.abs(dx) / 8
      if (item.str.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === item.plate) score += 35
      if (item.plate.length === 8) score += 8
      if (score > 0) scored.push({ plate: item.plate, score })
    }
  }
  if (!scored.length) {
    for (let i = 0; i < rows.length; i++) {
      if (!/(?:^|\b)(?:reg(?:istration)?\s*(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)|identification\s+mark)\b/i.test(rows[i])) continue
      if (/certificate of registration|date of (?:first )?registration/i.test(rows[i])) continue
      const after = rows[i].replace(/^.*?(reg(?:istration)?\s*(?:mark(?:\s+and\s+number)?|no\.?|number|num|#)|identification\s+mark)\.?\s*[:\-–.]*/i, '').trim()
      const nearby = [after, rows[i + 1], rows[i + 2], rows[i - 1]].filter(Boolean)
      for (const raw of nearby) {
        const plates = standaloneKenyanPlates(raw)
        if (plates[0] && raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === plates[0]) return plates[0]
        if (plates[0]) scored.push({ plate: plates[0], score: 10 })
      }
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.plate || ''
}

function scaleFor(page) {
  const base = page.getViewport({ scale: 1 })
  const longest = Math.max(base.width, base.height)
  if (!longest) return 2
  return Math.min(2.5, Math.max(1.8, 2200 / longest))
}

async function createOcrWorker() {
  await mkdir(cachePath, { recursive: true })
  const worker = await createWorker('eng', 1, {
    langPath,
    cachePath,
    gzip: true,
    workerPath,
    ...(corePath ? { corePath } : {}),
    logger: () => {},
    errorHandler: () => {},
  })
  return worker
}

async function acquireWorker() {
  const idle = pool.find((slot) => !slot.busy)
  if (idle) {
    idle.busy = true
    return idle.worker
  }
  if (pool.length + creating < MAX_WORKERS) {
    creating++
    try {
      const slot = { worker: await createOcrWorker(), busy: true }
      pool.push(slot)
      return slot.worker
    } finally {
      creating--
    }
  }
  return new Promise((resolve) => waiters.push(resolve))
}

function releaseWorker(worker) {
  const next = waiters.shift()
  if (next) {
    next(worker)
    return
  }
  const slot = pool.find((item) => item.worker === worker)
  if (slot) slot.busy = false
}

const kenyanPlateSchema = z.string().regex(/^K[A-Z]{2}\d{3}[A-Z]$|^K[A-Z]{3}\d{3}[A-Z]$/)

function parseKenyanPlate(raw) {
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const result = kenyanPlateSchema.safeParse(compact)
  return result.success ? result.data : ''
}

function parsePhotoPlate(raw) {
  const plate = parseKenyanPlate(raw)
  if (!plate) return ''
  const { pattern } = photoPlateConfig()
  return pattern.test(plate) ? plate : ''
}

function clampExtract(region, width, height) {
  const left = Math.max(0, Math.min(width - 8, Math.floor(region.left)))
  const top = Math.max(0, Math.min(height - 8, Math.floor(region.top)))
  return {
    left,
    top,
    width: Math.max(8, Math.min(width - left, Math.floor(region.width))),
    height: Math.max(8, Math.min(height - top, Math.floor(region.height))),
  }
}

function isPlatePixel(r, g, b, strict = false) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  const chroma = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b))
  const minc = Math.min(r, g, b)
  const white = luma > (strict ? 168 : 158) && chroma < (strict ? 48 : 58) && minc > (strict ? 130 : 120) && b >= g - 12 && (b - r) < 45
  const yellow = luma > (strict ? 120 : 95) && r > (strict ? 130 : 118) && g > (strict ? 118 : 108) && b < 200
    && (r - b) > (strict ? 36 : 30) && (g - b) > (strict ? 24 : 20) && (r - g) < (strict ? 22 : 28) && g >= r * (strict ? 0.88 : 0.85)
  return { luma, chroma, hit: white || yellow }
}

function isPlateInk(r, g, b, luma) {
  const chroma = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b))
  return luma < 110 && chroma < 48 && (r - b) < 42
}

function erodeMask(mask, width, height, radius) {
  const inverted = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) inverted[i] = mask[i] ? 0 : 1
  const grown = dilateMask(inverted, width, height, radius)
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = grown[i] ? 0 : 1
  return out
}

function integralSum(mask, width, height) {
  const stride = width + 1
  const sums = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x]
      sums[(y + 1) * stride + (x + 1)] = sums[y * stride + (x + 1)] + row
    }
  }
  return (x0, y0, x1, y1) => {
    const a = sums[y0 * stride + x0]
    const b = sums[y0 * stride + (x1 + 1)]
    const c = sums[(y1 + 1) * stride + x0]
    const d = sums[(y1 + 1) * stride + (x1 + 1)]
    return d - b - c + a
  }
}

function largestPaperBlob(mask, width, height) {
  const seen = new Uint8Array(mask.length)
  let best = { score: 0, c: 0, x0: 0, x1: width - 1, t: 0, b: height - 1 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (!mask[index] || seen[index]) continue
      let x0 = x
      let x1 = x
      let top = y
      let bottom = y
      let count = 0
      const stack = [index]
      seen[index] = 1
      while (stack.length) {
        const pixel = stack.pop()
        const py = Math.floor(pixel / width)
        const px = pixel % width
        count++
        x0 = Math.min(x0, px)
        x1 = Math.max(x1, px)
        top = Math.min(top, py)
        bottom = Math.max(bottom, py)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (!mask[next] || seen[next]) continue
          seen[next] = 1
          stack.push(next)
        }
      }
      const bw = x1 - x0 + 1
      const bh = bottom - top + 1
      const fill = count / Math.max(1, bw * bh)
      const aspect = bw / bh
      if (count < 80 || fill < 0.16 || aspect < 0.45 || aspect > 2.6) continue
      if (bw > width * 0.98 && bh > height * 0.9) continue
      const score = count * fill * (1.25 - Math.abs(aspect - 1.15) * 0.35)
      if (score > best.score) best = { score, c: count, x0, x1, t: top, b: bottom, fill, aspect }
    }
  }
  return best
}

function densePaperBox(mask, width, box) {
  let { x0, x1, t, b } = box
  const minRow = Math.max(6, (x1 - x0 + 1) * 0.32)
  const minCol = Math.max(6, (b - t + 1) * 0.22)
  while (t < b) {
    let n = 0
    for (let x = x0; x <= x1; x++) n += mask[t * width + x]
    if (n >= minRow) break
    t++
  }
  while (b > t) {
    let n = 0
    for (let x = x0; x <= x1; x++) n += mask[b * width + x]
    if (n >= minRow) break
    b--
  }
  while (x0 < x1) {
    let n = 0
    for (let y = t; y <= b; y++) n += mask[y * width + x0]
    if (n >= minCol) break
    x0++
  }
  while (x1 > x0) {
    let n = 0
    for (let y = t; y <= b; y++) n += mask[y * width + x1]
    if (n >= minCol) break
    x1--
  }
  return { x0, x1, t, b }
}

function topEdgeAngle(mask, width, box) {
  const tops = []
  const minCol = Math.max(4, (box.b - box.t + 1) * 0.22)
  for (let x = box.x0; x <= box.x1; x++) {
    let col = 0
    for (let y = box.t; y <= box.b; y++) col += mask[y * width + x]
    if (col < minCol) continue
    for (let y = box.t; y <= box.b; y++) {
      if (!mask[y * width + x]) continue
      tops.push([x, y])
      break
    }
  }
  if (tops.length < 16) return 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  const n = tops.length
  for (const [x, y] of tops) {
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const den = n * sxx - sx * sx
  if (!den) return 0
  const deg = Math.atan((n * sxy - sx * sy) / den) * (180 / Math.PI)
  return Math.max(-32, Math.min(32, deg))
}

function locatePlateWindow(paper, ink, width, height) {
  const paperAt = integralSum(paper, width, height)
  const inkAt = integralSum(ink, width, height)
  let best = null
  const step = Math.max(4, Math.round(width / 48))
  for (const frac of [0.34, 0.42, 0.5, 0.58, 0.66]) {
    const bw = Math.max(48, Math.round(width * frac))
    for (const aspect of [0.95, 1.1, 1.25, 1.4]) {
      const bh = Math.max(40, Math.round(bw / aspect))
      if (bh >= height || bh < height * 0.22 || bw < width * 0.38) continue
      for (let y = 0; y <= height - bh; y += step) {
        for (let x = 0; x <= width - bw; x += step) {
          const area = bw * bh
          const paperFill = paperAt(x, y, x + bw - 1, y + bh - 1) / area
          if (paperFill < 0.3 || paperFill > 0.9) continue
          const inkFill = inkAt(x, y, x + bw - 1, y + bh - 1) / area
          if (inkFill < 0.045 || inkFill > 0.28) continue
          const band = Math.max(8, Math.floor(bh / 4))
          const topInk = inkAt(x, y + band, x + bw - 1, y + band * 2 - 1) / (bw * band)
          const botInk = inkAt(x, y + band * 2, x + bw - 1, y + Math.min(y + bh - 1, y + band * 3) ) / (bw * band)
          if (topInk < 0.05 || botInk < 0.04) continue
          const score = paperFill + inkFill * 2.2 + topInk + botInk + (bw / width) * 0.8
          if (!best || score > best.score) best = { score, x, y, bw, bh }
        }
      }
    }
  }
  return best
}

function dilateMask(mask, width, height, radius) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          out[ny * width + nx] = 1
        }
      }
    }
  }
  return out
}

function smoothSeries(values, kernel) {
  const out = new Float32Array(values.length)
  const half = Math.max(1, Math.floor(kernel / 2))
  for (let i = 0; i < values.length; i++) {
    let sum = 0
    let n = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= values.length) continue
      sum += values[j]
      n++
    }
    out[i] = sum / Math.max(1, n)
  }
  return out
}

function lineBandsFromProjection(row, height) {
  const smoothed = smoothSeries(row, Math.max(5, Math.round(height / 16)))
  const max = Math.max(...smoothed, 1)
  const peaks = []
  for (let y = 2; y < height - 2; y++) {
    if (smoothed[y] < max * 0.2) continue
    if (smoothed[y] < smoothed[y - 1] || smoothed[y] < smoothed[y + 1]) continue
    const last = peaks[peaks.length - 1]
    if (!last || y - last.y > height * 0.14) peaks.push({ y, v: smoothed[y] })
    else if (smoothed[y] > last.v) peaks[peaks.length - 1] = { y, v: smoothed[y] }
  }
  const chosen = peaks.sort((a, b) => b.v - a.v).slice(0, 2).sort((a, b) => a.y - b.y)
  if (chosen.length === 2) {
    const half = Math.max(10, Math.round(height * 0.12))
    return chosen.map((peak) => [Math.max(0, peak.y - half), Math.min(height - 1, peak.y + half)])
  }
  const bands = []
  let inside = false
  let start = 0
  for (let y = 0; y < height; y++) {
    if (row[y] > max * 0.18) {
      if (!inside) {
        inside = true
        start = y
      }
    } else if (inside) {
      if (y - start >= Math.max(8, height * 0.08)) bands.push([start, y - 1])
      inside = false
    }
  }
  if (inside && height - start >= 8) bands.push([start, height - 1])
  return bands.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).sort((a, b) => a[0] - b[0]).slice(0, 2)
}

async function findPlateBoxes(rotated, width, height) {
  const sampleW = 240
  const sampleH = Math.max(48, Math.round((height * sampleW) / width))
  const { data, info } = await sharp(rotated, { failOn: 'none' })
    .resize(sampleW, sampleH)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const mask = new Uint8Array(info.width * info.height)
  const ink = new Uint8Array(mask.length)
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (y < info.height * 0.04) continue
      const i = (y * info.width + x) * info.channels
      const pixel = isPlatePixel(data[i], data[i + 1], data[i + 2])
      if (pixel.hit) mask[y * info.width + x] = 1
      if (isPlateInk(data[i], data[i + 1], data[i + 2], pixel.luma)) ink[y * info.width + x] = 1
    }
  }
  const window = locatePlateWindow(mask, ink, info.width, info.height)
  const seen = new Uint8Array(mask.length)
  const blobs = []
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = y * info.width + x
      if (!mask[idx] || seen[idx]) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0
      const stack = [idx]
      seen[idx] = 1
      while (stack.length) {
        const pixel = stack.pop()
        const py = Math.floor(pixel / info.width)
        const px = pixel % info.width
        count++
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue
          const next = ny * info.width + nx
          if (!mask[next] || seen[next]) continue
          seen[next] = 1
          stack.push(next)
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const fill = count / Math.max(1, bw * bh)
      const aspect = bw / bh
      if (count < 48 || bw < 10 || bh < 10) continue
      if (aspect < 0.5 || aspect > 2.6) continue
      if (bw > info.width * 0.99 || bh > info.height * 0.9) continue
      if (fill < 0.18) continue
      let ink = 0
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          const pi = (yy * info.width + xx) * info.channels
          const luma = 0.299 * data[pi] + 0.587 * data[pi + 1] + 0.114 * data[pi + 2]
          if (luma < 92) ink++
        }
      }
      const inkRatio = ink / Math.max(1, bw * bh)
      if (inkRatio < 0.045 || inkRatio > 0.42) continue
      const score = count * fill * inkRatio * (1.25 - Math.abs(aspect - 1.12) * 0.35)
      blobs.push({ score, minX, minY, bw, bh })
    }
  }
  blobs.sort((a, b) => b.score - a.score)
  const scaleX = width / info.width
  const scaleY = height / info.height
  const boxes = []
  if (window) {
    boxes.push(clampExtract({
      left: (window.x - 4) * scaleX,
      top: (window.y - window.bh * 0.28) * scaleY,
      width: (window.bw + 8) * scaleX,
      height: (window.bh * 1.55) * scaleY,
    }, width, height))
  }
  boxes.push(...blobs.slice(0, 3).map((blob) => clampExtract({
    left: (blob.minX - 3) * scaleX,
    top: (blob.minY - 3) * scaleY,
    width: (blob.bw + 6) * scaleX,
    height: (blob.bh + 6) * scaleY,
  }, width, height)))
  boxes.push(clampExtract({ left: width * 0.12, top: height * 0.12, width: width * 0.76, height: height * 0.62 }, width, height))
  const unique = []
  for (const box of boxes) {
    if (unique.some((item) => Math.abs(item.left - box.left) < 12 && Math.abs(item.top - box.top) < 12 && Math.abs(item.width - box.width) < 18)) continue
    unique.push(box)
  }
  return unique
}

async function renderPlateCrop(rotated, box) {
  return sharp(rotated, { failOn: 'none' })
    .extract(box)
    .resize({ width: 520, height: 440, fit: 'inside', withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .normalize()
    .png({ compressionLevel: 3 })
    .toBuffer()
}

async function plateLineImages(cropBytes) {
  const { data, info } = await sharp(cropBytes, { failOn: 'none' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const gray = new Uint8Array(width * height)
  const bright = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * info.channels]
    const g = data[i * info.channels + 1]
    const b = data[i * info.channels + 2]
    const pixel = isPlatePixel(r, g, b)
    gray[i] = pixel.luma
    if (pixel.hit) bright[i] = 1
  }
  const cover = dilateMask(bright, width, height, 4)
  const images = []
  const seen = new Set()
  const pushBand = async (y0, y1, ink, grayscale = false) => {
    let x0 = width
    let x1 = 0
    let count = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < width; x++) {
        if (!ink[y * width + x]) continue
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        count++
      }
    }
    if (x1 < x0 || count < 18 || x1 - x0 < 36 || y1 - y0 < 10) return
    const key = `${y0}:${y1}:${x0}:${x1}`
    if (seen.has(key)) return
    seen.add(key)
    const pad = 6
    const left = Math.max(0, x0 - pad)
    const top = Math.max(0, y0)
    const w = Math.min(width - left, x1 - x0 + 1 + pad * 2)
    const h = Math.min(height - top, y1 - y0 + 1)
    if (w < 12 || h < 8) return
    const canvas = Buffer.alloc(w * h, 255)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (ink[(top + y) * width + (left + x)]) canvas[y * w + x] = 0
      }
    }
    const binary = await sharp(canvas, { raw: { width: w, height: h, channels: 1 } })
      .resize({ height: 52, kernel: sharp.kernel.lanczos3 })
      .extend({ top: 12, bottom: 12, left: 18, right: 18, background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer()
    images.push(binary)
    if (grayscale) {
      images.push(await sharp(cropBytes, { failOn: 'none' })
        .extract({ left, top, width: w, height: h })
        .grayscale()
        .normalize()
        .linear(1.35, -12)
        .resize({ height: 52 })
        .extend({ top: 12, bottom: 12, left: 18, right: 18, background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer())
    }
  }
  const marginY = Math.floor(height * 0.07)
  for (const threshold of [115, 100, 132]) {
    const ink = new Uint8Array(width * height)
    for (let i = 0; i < ink.length; i++) ink[i] = cover[i] && gray[i] < threshold ? 1 : 0
    const row = new Float32Array(height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) row[y] += ink[y * width + x]
    }
    const bands = lineBandsFromProjection(row, height)
    const useGray = bands.length === 2
    if (bands.length >= 2) {
      for (const [y0, y1] of bands.slice(0, 2)) await pushBand(y0, y1, ink, useGray)
    } else {
      await pushBand(marginY, Math.floor(height * 0.52), ink, true)
      await pushBand(Math.floor(height * 0.4), height - 1 - marginY, ink, true)
    }
    if (images.length >= 8) break
  }
  return images
}

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0)
  for (const value of gray) hist[value]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let max = 0
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > max) {
      max = between
      threshold = t
    }
  }
  return threshold
}

function holeFeatures(bin, width, height) {
  const seen = new Uint8Array(width * height)
  const queue = []
  const push = (index) => {
    if (seen[index]) return
    seen[index] = 1
    queue.push(index)
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (queue.length) {
    const pixel = queue.pop()
    const y = Math.floor(pixel / width)
    const x = pixel % width
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (!seen[next] && !bin[next]) push(next)
    }
  }
  let holes = 0
  let holeY = 0
  for (let i = 0; i < bin.length; i++) {
    if (seen[i] || bin[i]) continue
    holes++
    let cy = 0
    let count = 0
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const pixel = stack.pop()
      const y = Math.floor(pixel / width)
      const x = pixel % width
      cy += y
      count++
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const next = ny * width + nx
        if (!seen[next] && !bin[next]) {
          seen[next] = 1
          stack.push(next)
        }
      }
    }
    holeY += count ? cy / count / height : 0
  }
  return { holes, holeY: holes ? holeY / holes : 0 }
}

function zoneFeatures(bin, width, height) {
  const zone = new Float32Array(9)
  const counts = new Float32Array(9)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const col = Math.min(2, Math.floor((x * 3) / width))
      const row = Math.min(2, Math.floor((y * 3) / height))
      const index = row * 3 + col
      zone[index] += bin[y * width + x]
      counts[index]++
    }
  }
  for (let i = 0; i < 9; i++) zone[i] /= Math.max(1, counts[i])
  return zone
}

const PLATE_PROTOS = [
  { ch: 'K', holes: 0, z: [0.2, 0.25, 0.31, 0.38, 0.72, 0.23, 0.3, 0.3, 0.13] },
  { ch: 'K', holes: 0, z: [0.13, 0.15, 0.21, 0.7, 0.85, 0.33, 0.17, 0.23, 0.21] },
  { ch: 'M', holes: 1, z: [0.05, 0.05, 0.21, 0.45, 0.75, 0.48, 0.15, 0.15, 0.1] },
  { ch: 'M', holes: 1, z: [0.15, 0.13, 0.23, 0.7, 0.78, 0.71, 0.2, 0.2, 0.13] },
  { ch: 'H', holes: 0, z: [0.2, 0.25, 0.27, 0.28, 0.45, 0.54, 0.15, 0.35, 0.21] },
  { ch: 'H', holes: 0, z: [0.2, 0.05, 0.29, 0.65, 0.6, 0.79, 0.15, 0.23, 0.17] },
  { ch: 'D', holes: 1, z: [0.25, 0.42, 0.38, 0.15, 0.65, 0.56, 0.33, 0.5, 0.17] },
  { ch: 'D', holes: 1, z: [0.3, 0.47, 0.25, 0.53, 0.4, 0.73, 0.1, 0.38, 0.19] },
  { ch: 'Y', holes: 0, z: [0.13, 0.07, 0.1, 0.2, 0.68, 0.4, 0.23, 0.03, 0.35] },
  { ch: 'Y', holes: 0, z: [0.23, 0.05, 0.44, 0.2, 0.72, 0.5, 0, 0.17, 0.27] },
  { ch: '7', holes: 0, z: [0.3, 0.55, 0.46, 0.13, 0, 0.48, 0, 0, 0.58] },
  { ch: '7', holes: 0, z: [0.4, 0.6, 0.58, 0.1, 0.3, 0.52, 0, 0.53, 0.29] },
  { ch: '7', holes: 0, z: [0.42, 0.57, 0.63, 0.03, 0.25, 0.54, 0, 0.33, 0.38] },
  { ch: '6', holes: 0, z: [0.13, 0.33, 0.04, 0.75, 0.4, 0.5, 0.42, 0.53, 0.44] },
  { ch: '6', holes: 1, z: [0.23, 0.45, 0.19, 0.6, 0.55, 0.58, 0.17, 0.53, 0.42] },
  { ch: '4', holes: 1, z: [0, 0.68, 0.1, 0.25, 0.53, 0.54, 0.35, 0.38, 0.65] },
  { ch: '9', holes: 1, z: [0.28, 0.52, 0.32, 0.22, 0.32, 0.48, 0.12, 0.38, 0.22] },
  { ch: '9', holes: 1, z: [0.22, 0.48, 0.28, 0.18, 0.4, 0.42, 0.1, 0.45, 0.18] },
]

let canvasProtos

function canvasGlyphProtos() {
  if (canvasProtos) return canvasProtos
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const fonts = ['Georgia', 'Times New Roman', 'Arial Black', 'serif']
  canvasProtos = []
  for (const font of fonts) {
    for (const ch of chars) {
      const width = 24
      const height = 36
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#000000'
      ctx.strokeStyle = '#000000'
      ctx.lineWidth = 1.4
      ctx.font = `bold 28px ${font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.strokeText(ch, width / 2, height / 2 + 1)
      ctx.fillText(ch, width / 2, height / 2 + 1)
      const { data } = ctx.getImageData(0, 0, width, height)
      const bin = new Uint8Array(width * height)
      for (let i = 0; i < bin.length; i++) bin[i] = data[i * 4] < 160 ? 1 : 0
      const holes = holeFeatures(bin, width, height)
      canvasProtos.push({ ch, holes: holes.holes, z: zoneFeatures(bin, width, height) })
    }
  }
  return canvasProtos
}

function nearestGlyph(feat, alphabet) {
  let best = { ch: '', d: 1e9 }
  const real = PLATE_PROTOS
  const generated = canvasGlyphProtos()
  const consider = (proto, weight) => {
    if (!alphabet.includes(proto.ch)) return
    if (feat.holes === 0 && 'B8DOQ0AP'.includes(proto.ch)) return
    if (feat.holes >= 1 && proto.holes === 0 && 'CEFGHIJKLNSTUVWXYZ'.includes(proto.ch)) return
    let distance = Math.abs((proto.holes || 0) - feat.holes) * 1.2
    for (let i = 0; i < 9; i++) {
      const delta = feat.z[i] - proto.z[i]
      distance += delta * delta
    }
    distance *= weight
    if (distance < best.d) best = { ch: proto.ch, d: distance }
  }
  for (const proto of real) consider(proto, 0.35)
  for (const proto of generated) consider(proto, 1)
  if ((best.ch === 'V' || best.ch === 'U') && feat.z[4] > 0.5 && feat.z[0] > 0.08 && feat.z[2] > 0.08) {
    if (alphabet.includes('Y')) return { ch: 'Y', d: best.d }
  }
  if (best.d > 3.2) return { ch: '', d: best.d }
  return best
}

function classifyPlateDigit(feat) {
  if (feat.holes >= 2) return '8'
  if (feat.holes === 1) {
    if (feat.holeY >= 0.56) return '6'
    if (feat.z[6] > 0.28 && feat.z[8] > 0.22 && feat.z[1] < 0.4) return '4'
    if (feat.holeY > 0 && feat.holeY < 0.45) return nearestGlyph(feat, '94').ch
    return nearestGlyph(feat, '0469').ch
  }
  if (feat.z[0] > 0.22 && feat.z[1] > 0.32 && feat.z[2] > 0.22 && feat.z[6] < 0.14 && feat.z[7] < 0.22) return '7'
  if (feat.z[5] > feat.z[3] && feat.z[2] > 0.18 && feat.z[8] > 0.12 && feat.z[6] < 0.22 && feat.z[4] < 0.45) return '3'
  return nearestGlyph(feat, '123567').ch
}

function classifyPlateLetter(feat) {
  if (feat.holes >= 2) return 'B'
  const left = (feat.z[0] + feat.z[3] + feat.z[6]) / 3
  const right = (feat.z[2] + feat.z[5] + feat.z[8]) / 3
  const bottomWide = feat.z[6] > 0.14 && feat.z[8] > 0.14
  const stem = feat.z[7] > 0.12 && feat.z[6] < 0.22 && feat.z[8] < 0.28
  if (feat.holes === 0) {
    if (feat.z[4] > 0.28 && Math.abs(left - right) < 0.22 && left > 0.12 && right > 0.12 && bottomWide) return 'H'
    if (feat.z[4] > 0.32 && stem && feat.z[0] > 0.08 && feat.z[2] > 0.08) return 'Y'
  }
  if (feat.holes === 1) {
    if (feat.z[5] > feat.z[3] + 0.04 && feat.z[0] > 0.12) return 'D'
    return nearestGlyph(feat, 'ADOPQRM').ch
  }
  return nearestGlyph(feat, 'CEFGHIJKLNSTUVWXYZ').ch
}

function inkBounds(dark, width, box) {
  let x0 = box.x1
  let x1 = box.x0
  let t = box.b
  let b = box.t
  let count = 0
  for (let y = box.t; y <= box.b; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (!dark[y * width + x]) continue
      count++
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      t = Math.min(t, y)
      b = Math.max(b, y)
    }
  }
  if (count < 12 || x1 < x0) return { ...box, bw: box.x1 - box.x0 + 1, bh: box.b - box.t + 1, c: count, cx: (box.x0 + box.x1) / 2, cy: (box.t + box.b) / 2 }
  return { x0, x1, t, b, bw: x1 - x0 + 1, bh: b - t + 1, c: count, cx: (x0 + x1) / 2, cy: (t + b) / 2 }
}

function gridPlateGlyphs(dark, width, height) {
  let x0 = width
  let x1 = 0
  let y0 = height
  let y1 = 0
  let ink = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!dark[y * width + x]) continue
      ink++
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  if (ink < 80 || x1 - x0 < width * 0.35 || y1 - y0 < height * 0.35) return null
  const padX = Math.max(2, Math.floor((x1 - x0) * 0.03))
  const padY = Math.max(2, Math.floor((y1 - y0) * 0.04))
  x0 = Math.max(0, x0 - padX)
  x1 = Math.min(width - 1, x1 + padX)
  y0 = Math.max(0, y0 - padY)
  y1 = Math.min(height - 1, y1 + padY)
  const colW = (x1 - x0 + 1) / 4
  const rowH = (y1 - y0 + 1) / 2
  const rows = [[], []]
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const cell = {
        x0: Math.floor(x0 + col * colW),
        x1: Math.floor(x0 + (col + 1) * colW) - 1,
        t: Math.floor(y0 + row * rowH),
        b: Math.floor(y0 + (row + 1) * rowH) - 1,
      }
      rows[row].push(inkBounds(dark, width, cell))
    }
  }
  return rows
}

function splitWideGlyphs(items) {
  const out = []
  for (const item of items) {
    if (item.bw > item.bh * 0.95 && items.length < 4) {
      const mid = item.x0 + Math.floor(item.bw / 2)
      out.push({ ...item, x1: mid - 1, bw: mid - item.x0, cx: (item.x0 + mid) / 2 })
      out.push({ ...item, x0: mid, bw: item.x1 - mid + 1, cx: (mid + item.x1) / 2 })
    } else {
      out.push(item)
    }
  }
  return out.sort((a, b) => a.x0 - b.x0).slice(0, 4)
}

function segmentPlateGlyphs(dark, width, height) {
  const seen = new Uint8Array(width * height)
  const comps = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (!dark[index] || seen[index]) continue
      let x0 = x
      let x1 = x
      let top = y
      let bottom = y
      let count = 0
      const stack = [index]
      seen[index] = 1
      while (stack.length) {
        const pixel = stack.pop()
        const py = Math.floor(pixel / width)
        const px = pixel % width
        count++
        x0 = Math.min(x0, px)
        x1 = Math.max(x1, px)
        top = Math.min(top, py)
        bottom = Math.max(bottom, py)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (dark[next] && !seen[next]) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
      const bw = x1 - x0 + 1
      const bh = bottom - top + 1
      const fill = count / Math.max(1, bw * bh)
      if (count < 40 || bh < height * 0.12 || bh > height * 0.58 || bw > width * 0.42 || bw < 5) continue
      if (fill < 0.12 || fill > 0.72) continue
      comps.push({ x0, x1, t: top, b: bottom, bw, bh, c: count, cx: (x0 + x1) / 2, cy: (top + bottom) / 2 })
    }
  }
  comps.sort((a, b) => a.cy - b.cy)
  const medianH = comps.map((item) => item.bh).sort((a, b) => a - b)[comps.length >> 1] || height / 4
  const rows = []
  for (const item of comps) {
    const last = rows[rows.length - 1]
    if (!last || Math.abs(item.cy - last.cy) > medianH * 0.5) rows.push({ cy: item.cy, items: [item] })
    else {
      last.items.push(item)
      last.cy = last.items.reduce((sum, row) => sum + row.cy, 0) / last.items.length
    }
  }
  return rows
    .filter((row) => row.items.length >= 3)
    .sort((a, b) => a.cy - b.cy)
    .slice(0, 2)
    .map((row) => splitWideGlyphs(row.items))
}

function glyphFeatFromBox(dark, width, box) {
  const sizeW = 24
  const sizeH = 36
  const bin = new Uint8Array(sizeW * sizeH)
  const scale = Math.min((sizeW - 2) / box.bw, (sizeH - 2) / box.bh)
  const drawW = Math.max(1, Math.round(box.bw * scale))
  const drawH = Math.max(1, Math.round(box.bh * scale))
  const ox = Math.floor((sizeW - drawW) / 2)
  const oy = Math.floor((sizeH - drawH) / 2)
  for (let y = 0; y < drawH; y++) {
    for (let x = 0; x < drawW; x++) {
      const sx = box.x0 + Math.min(box.bw - 1, Math.floor(x / scale))
      const sy = box.t + Math.min(box.bh - 1, Math.floor(y / scale))
      bin[(oy + y) * sizeW + (ox + x)] = dark[sy * width + sx]
    }
  }
  const holes = holeFeatures(bin, sizeW, sizeH)
  return { z: zoneFeatures(bin, sizeW, sizeH), holes: holes.holes, holeY: holes.holeY }
}

const GLYPH_W = 20
const GLYPH_H = 32
let glyphTemplates

function resampleBin(src, sw, sh, tw, th) {
  const out = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      let acc = 0
      let n = 0
      const x0 = Math.floor((x * sw) / tw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / tw))
      const y0 = Math.floor((y * sh) / th)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / th))
      for (let sy = y0; sy < y1 && sy < sh; sy++) {
        for (let sx = x0; sx < x1 && sx < sw; sx++) {
          acc += src[sy * sw + sx]
          n++
        }
      }
      out[y * tw + x] = acc / Math.max(1, n) > 0.4 ? 1 : 0
    }
  }
  return out
}

function packGlyph(dark, width, box) {
  const trimmed = inkBounds(dark, width, box)
  if (trimmed.bw < 2 || trimmed.bh < 4) return new Uint8Array(GLYPH_W * GLYPH_H)
  const src = new Uint8Array(trimmed.bw * trimmed.bh)
  for (let y = 0; y < trimmed.bh; y++) {
    for (let x = 0; x < trimmed.bw; x++) {
      src[y * trimmed.bw + x] = dark[(trimmed.t + y) * width + (trimmed.x0 + x)]
    }
  }
  return resampleBin(src, trimmed.bw, trimmed.bh, GLYPH_W, GLYPH_H)
}

function bitmapScore(a, b) {
  let best = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let same = 0
      for (let y = 0; y < GLYPH_H; y++) {
        const sy = y + dy
        if (sy < 0 || sy >= GLYPH_H) continue
        for (let x = 0; x < GLYPH_W; x++) {
          const sx = x + dx
          if (sx < 0 || sx >= GLYPH_W) continue
          if (a[y * GLYPH_W + x] === b[sy * GLYPH_W + sx]) same++
        }
      }
      best = Math.max(best, same / (GLYPH_W * GLYPH_H))
    }
  }
  return best
}

function buildGlyphTemplates() {
  if (glyphTemplates) return glyphTemplates
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const fonts = ['Georgia', 'Times New Roman', 'Times', 'serif', 'Arial Black', 'Arial']
  const byChar = new Map()
  for (const font of fonts) {
    for (const ch of chars) {
      const canvas = createCanvas(GLYPH_W, GLYPH_H)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, GLYPH_W, GLYPH_H)
      ctx.fillStyle = '#000000'
      ctx.font = `bold ${Math.floor(GLYPH_H * 0.84)}px ${font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(ch, GLYPH_W / 2, GLYPH_H / 2 + 1)
      const { data } = ctx.getImageData(0, 0, GLYPH_W, GLYPH_H)
      const raw = new Uint8Array(GLYPH_W * GLYPH_H)
      for (let i = 0; i < raw.length; i++) raw[i] = data[i * 4] < 160 ? 1 : 0
      const holes = holeFeatures(raw, GLYPH_W, GLYPH_H)
      const list = byChar.get(ch) || []
      list.push({ bin: raw, holes: holes.holes })
      byChar.set(ch, list)
    }
  }
  glyphTemplates = byChar
  return glyphTemplates
}

function matchCharBitmap(bin, alphabet, holes) {
  const templates = buildGlyphTemplates()
  let best = { ch: '', score: -1 }
  let second = 0
  for (const ch of alphabet) {
    for (const proto of templates.get(ch) || []) {
      if (holes === 0 && 'B8DOQ0AP'.includes(ch) && proto.holes >= 1) continue
      if (holes >= 1 && proto.holes === 0 && 'CEFGHIJKLNSTUVWXYZ17'.includes(ch)) continue
      const score = bitmapScore(bin, proto.bin)
      if (score > best.score) {
        second = best.score
        best = { ch, score }
      } else if (score > second) second = score
    }
  }
  if (best.score < 0.58) return { ch: '', score: best.score, margin: 0 }
  return { ch: best.ch, score: best.score, margin: best.score - second }
}

function fourGlyphsInBand(dark, width, y0, y1) {
  const col = new Float32Array(width)
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < width; x++) col[x] += dark[y * width + x]
  }
  const smoothed = smoothSeries(col, Math.max(3, Math.round(width / 42)))
  const max = Math.max(...smoothed, 1)
  const runs = []
  let inside = false
  let start = 0
  for (let x = 0; x < width; x++) {
    if (smoothed[x] > max * 0.12) {
      if (!inside) {
        inside = true
        start = x
      }
    } else if (inside) {
      if (x - start >= 3) runs.push({ x0: start, x1: x - 1 })
      inside = false
    }
  }
  if (inside && width - start >= 3) runs.push({ x0: start, x1: width - 1 })
  const merged = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run.x0 - last.x1 <= 2) last.x1 = run.x1
    else merged.push({ ...run })
  }
  let chosen = merged.filter((run) => run.x1 - run.x0 >= 4)
  if (chosen.length > 4) chosen = chosen.slice(-4)
  if (chosen.length !== 4 && merged.length) {
    const x0 = merged[0].x0
    const x1 = merged[merged.length - 1].x1
    const span = (x1 - x0 + 1) / 4
    chosen = [0, 1, 2, 3].map((i) => ({ x0: Math.floor(x0 + i * span), x1: Math.floor(x0 + (i + 1) * span) - 1 }))
  }
  return chosen.map((run) => inkBounds(dark, width, { x0: run.x0, x1: run.x1, t: y0, b: y1 }))
}

async function findPaperBox(cropBytes, strict) {
  const { data, info } = await sharp(cropBytes, { failOn: 'none' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const bright = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * info.channels]
    const g = data[i * info.channels + 1]
    const b = data[i * info.channels + 2]
    if (isPlatePixel(r, g, b, strict).hit) bright[i] = 1
  }
  const seen = new Uint8Array(width * height)
  let best = { c: 0 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (!bright[index] || seen[index]) continue
      let x0 = x
      let x1 = x
      let top = y
      let bottom = y
      let count = 0
      const stack = [index]
      seen[index] = 1
      while (stack.length) {
        const pixel = stack.pop()
        const py = Math.floor(pixel / width)
        const px = pixel % width
        count++
        x0 = Math.min(x0, px)
        x1 = Math.max(x1, px)
        top = Math.min(top, py)
        bottom = Math.max(bottom, py)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (bright[next] && !seen[next]) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
      if (count > best.c) best = { c: count, x0, x1, top, bottom }
    }
  }
  if (!best.c) return null
  const pad = 6
  const box = clampExtract({
    left: best.x0 - pad,
    top: best.top - pad,
    width: best.x1 - best.x0 + 1 + pad * 2,
    height: best.bottom - best.top + 1 + pad * 2,
  }, width, height)
  const area = box.width * box.height
  if (area > width * height * 0.94 || area < width * height * 0.12) return null
  if (box.width < 48 || box.height < 40) return null
  return sharp(cropBytes, { failOn: 'none' }).extract(box).toBuffer()
}

async function innerBrightPlate(cropBytes) {
  return (await findPaperBox(cropBytes, true)) || (await findPaperBox(cropBytes, false)) || cropBytes
}

function inkIoU(a, b) {
  let best = 0
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let inter = 0
      let union = 0
      for (let y = 0; y < GLYPH_H; y++) {
        for (let x = 0; x < GLYPH_W; x++) {
          const sx = x + dx
          const sy = y + dy
          const av = a[y * GLYPH_W + x]
          const bv = sx >= 0 && sy >= 0 && sx < GLYPH_W && sy < GLYPH_H ? b[sy * GLYPH_W + sx] : 0
          if (av || bv) union++
          if (av && bv) inter++
        }
      }
      best = Math.max(best, union ? inter / union : 0)
    }
  }
  return best
}

function matchGlyphChar(bin, alphabet, holes) {
  const templates = buildGlyphTemplates()
  let best = { ch: '', score: -1 }
  for (const ch of alphabet) {
    for (const proto of templates.get(ch) || []) {
      if (holes === 0 && 'B8DOQ0AP9'.includes(ch) && proto.holes >= 1) continue
      if (holes >= 1 && proto.holes === 0 && 'CEFGHIJKLNSTUVWXYZ17'.includes(ch)) continue
      const score = inkIoU(bin, proto.bin)
      if (score > best.score) best = { ch, score }
    }
  }
  if (best.score < 0.26) return { ch: '', score: best.score }
  return best
}

function refinePlateChar(ch, bin, holes, index) {
  const z = zoneFeatures(bin, GLYPH_W, GLYPH_H)
  if (index === 0 && 'NHR'.includes(ch) && z[3] > 0.22) return 'K'
  if (index === 3 && 'HNU'.includes(ch) && z[5] > z[3] - 0.02) return 'D'
  if (index === 4 && holes === 0 && '931'.includes(ch) && z[2] > 0.2 && z[6] < 0.18) return '7'
  if (index === 7 && (ch === 'X' || ( 'VHN'.includes(ch) && z[7] >= z[6] ))) return 'Y'
  return ch
}

async function masksFromImage(bytes) {
  const { data, info } = await sharp(bytes, { failOn: 'none' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const paper = new Uint8Array(width * height)
  const ink = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * info.channels]
    const g = data[i * info.channels + 1]
    const b = data[i * info.channels + 2]
    const pixel = isPlatePixel(r, g, b)
    if (pixel.hit) paper[i] = 1
    if (isPlateInk(r, g, b, pixel.luma)) ink[i] = 1
  }
  return { data, info, width, height, paper, ink }
}

async function deskewPaper(bytes, paper, width, box) {
  const deg = -topEdgeAngle(paper, width, box)
  if (Math.abs(deg) < 1.4) return bytes
  return sharp(bytes, { failOn: 'none' }).rotate(deg, { background: { r: 32, g: 32, b: 32 } }).toBuffer()
}

async function isolatePlateCrop(bytes) {
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const srcW = meta.width || 1
  const srcH = meta.height || 1
  const sampleW = 280
  const sampleH = Math.max(48, Math.round((srcH * sampleW) / srcW))
  const sample = await sharp(bytes, { failOn: 'none' }).resize(sampleW, sampleH).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const paper = new Uint8Array(sample.info.width * sample.info.height)
  const ink = new Uint8Array(paper.length)
  for (let i = 0; i < paper.length; i++) {
    const r = sample.data[i * sample.info.channels]
    const g = sample.data[i * sample.info.channels + 1]
    const b = sample.data[i * sample.info.channels + 2]
    const pixel = isPlatePixel(r, g, b)
    if (pixel.hit) paper[i] = 1
    if (isPlateInk(r, g, b, pixel.luma)) ink[i] = 1
  }
  const paperFill = paper.reduce((n, v) => n + v, 0) / paper.length
  const window = paperFill < 0.3 ? locatePlateWindow(paper, ink, sample.info.width, sample.info.height) : null
  const blob = largestPaperBlob(paper, sample.info.width, sample.info.height)
  const dense = densePaperBox(paper, sample.info.width, blob)
  const pick = window
    ? { left: window.x, top: window.y, width: window.bw, height: window.bh }
    : { left: dense.x0, top: dense.t, width: dense.x1 - dense.x0 + 1, height: dense.b - dense.t + 1 }
  const scaleX = srcW / sample.info.width
  const scaleY = srcH / sample.info.height
  const pad = Math.round(Math.max(pick.width, pick.height) * 0.06)
  const box = clampExtract({
    left: pick.left * scaleX - pad,
    top: pick.top * scaleY - pad,
    width: pick.width * scaleX + pad * 2,
    height: pick.height * scaleY + pad * 2,
  }, srcW, srcH)
  if (box.width < 40 || box.height < 36) return bytes
  let crop = await sharp(bytes, { failOn: 'none' }).extract(box).toBuffer()
  const cropped = await masksFromImage(crop)
  const paperBox = densePaperBox(cropped.paper, cropped.width, largestPaperBlob(cropped.paper, cropped.width, cropped.height))
  crop = await deskewPaper(crop, cropped.paper, cropped.width, paperBox)
  const upright = await masksFromImage(crop)
  const tight = densePaperBox(upright.paper, upright.width, largestPaperBlob(upright.paper, upright.width, upright.height))
  const inner = clampExtract({
    left: tight.x0 - 4,
    top: tight.t - 4,
    width: tight.x1 - tight.x0 + 9,
    height: tight.b - tight.t + 9,
  }, upright.width, upright.height)
  return sharp(crop, { failOn: 'none' })
    .extract(inner)
    .resize({ width: 480, height: 400, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .toBuffer()
}

async function readGlyphPlateDetail(cropBytes) {
  let work = cropBytes
  let image = await masksFromImage(work)
  const paperFill = image.paper.reduce((n, v) => n + v, 0) / image.paper.length
  if (paperFill < 0.24 && Math.max(image.width, image.height) > 700) {
    const sampleW = 280
    const sampleH = Math.max(48, Math.round((image.height * sampleW) / image.width))
    const sampleBytes = await sharp(work, { failOn: 'none' }).resize(sampleW, sampleH).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const sp = new Uint8Array(sampleBytes.info.width * sampleBytes.info.height)
    const si = new Uint8Array(sp.length)
    for (let i = 0; i < sp.length; i++) {
      const r = sampleBytes.data[i * sampleBytes.info.channels]
      const g = sampleBytes.data[i * sampleBytes.info.channels + 1]
      const b = sampleBytes.data[i * sampleBytes.info.channels + 2]
      const pixel = isPlatePixel(r, g, b)
      if (pixel.hit) sp[i] = 1
      if (isPlateInk(r, g, b, pixel.luma)) si[i] = 1
    }
    const located = locatePlateWindow(sp, si, sampleBytes.info.width, sampleBytes.info.height)
    if (process.env.PHOTO_OCR_LOG) console.log(JSON.stringify({ locate: located, sample: [sampleBytes.info.width, sampleBytes.info.height], paperFill }))
    if (located) {
      const scaleX = image.width / sampleBytes.info.width
      const scaleY = image.height / sampleBytes.info.height
      const padX = Math.round(located.bw * scaleX * 0.1)
      const padY = Math.round(located.bh * scaleY * 0.32)
      const box = clampExtract({
        left: located.x * scaleX - padX,
        top: located.y * scaleY - padY,
        width: located.bw * scaleX + padX * 2,
        height: located.bh * scaleY + padY * 2,
      }, image.width, image.height)
      work = await sharp(work, { failOn: 'none' }).extract(box).toBuffer()
      image = await masksFromImage(work)
    }
  }
  const firstBox = densePaperBox(image.paper, image.width, largestPaperBlob(image.paper, image.width, image.height))
  if (process.env.PHOTO_OCR_LOG) console.log(JSON.stringify({ deskewFrom: firstBox, angle: -topEdgeAngle(image.paper, image.width, firstBox) }))
  work = await deskewPaper(work, image.paper, image.width, firstBox)
  image = await masksFromImage(work)
  const { width, height, paper } = image
  const interior = erodeMask(paper, width, height, 3)
  const cover = dilateMask(interior, width, height, 10)
  const ink = new Uint8Array(width * height)
  for (let i = 0; i < ink.length; i++) ink[i] = image.ink[i] && cover[i] ? 1 : 0
  const paperBox = densePaperBox(paper, width, largestPaperBlob(paper, width, height))
  const x0 = paperBox.x0
  const x1 = paperBox.x1
  const top = paperBox.t
  const bottom = paperBox.b
  const pw = x1 - x0 + 1
  const ph = bottom - top + 1
  if (pw < 40 || ph < 32) return { plate: '', minScore: 0, meanScore: 0, chars: [] }
  const mx = Math.floor(pw * 0.07)
  const my = Math.floor(ph * 0.1)
  const ix0 = x0 + mx
  const ix1 = x1 - mx
  const iy0 = top + my
  const iy1 = bottom - my
  const colW = (ix1 - ix0 + 1) / 4
  const rowH = (iy1 - iy0 + 1) / 2
  const alphabets = [
    'ABCDEFGHJKLMNPRSTUVWXYZ',
    'ABCDEFGHJKLMNPRSTUVWXYZ',
    'ABCDEFGHJKLMNPRSTUVWXYZ',
    'ABCDEFGHJKLMNPRSTUVWXYZ',
    '0123456789',
    '0123456789',
    '0123456789',
    'ABCDEFGHJKLMNPRSTUVWXYZ',
  ]
  const chars = []
  const scores = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const cell = {
        x0: Math.floor(ix0 + col * colW),
        x1: Math.floor(ix0 + (col + 1) * colW) - 1,
        t: Math.floor(iy0 + row * rowH),
        b: Math.floor(iy0 + (row + 1) * rowH) - 1,
      }
      const box = inkBounds(ink, width, cell)
      const bin = packGlyph(ink, width, box)
      const holes = holeFeatures(bin, GLYPH_W, GLYPH_H)
      const matched = matchGlyphChar(bin, alphabets[row * 4 + col], holes.holes)
      const ch = matched.ch ? refinePlateChar(matched.ch, bin, holes.holes, row * 4 + col) : ''
      if (process.env.PHOTO_OCR_LOG) {
        console.log(JSON.stringify({
          glyphTry: { i: chars.length, ch, raw: matched.ch, score: Number(matched.score.toFixed(3)), holes: holes.holes },
        }))
      }
      if (!ch) return { plate: '', minScore: 0, meanScore: 0, chars }
      chars.push(ch)
      scores.push(matched.score)
    }
  }
  const plate = parsePhotoPlate(chars.join(''))
  const minScore = Math.min(...scores)
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length
  if (process.env.PHOTO_OCR_LOG) console.log(JSON.stringify({ glyphChars: chars, plate, minScore, meanScore, box: paperBox }))
  return { plate: plate || '', minScore, meanScore, chars }
}

async function readGlyphPlate(cropBytes) {
  const detail = await readGlyphPlateDetail(cropBytes)
  return detail.minScore >= 0.28 && detail.plate && detail.chars?.[0] === 'K' ? detail.plate : ''
}

async function workingPhoto(bytes) {
  const rotated = await sharp(bytes, { failOn: 'none', sequentialRead: true }).rotate().toBuffer()
  const meta = await sharp(rotated, { failOn: 'none' }).metadata()
  const width = meta.width || 1
  const height = meta.height || 1
  if (Math.max(width, height) <= DETECT_MAX_EDGE) return { bytes: rotated, width, height }
  const resized = await sharp(rotated, { failOn: 'none' })
    .resize({ width: DETECT_MAX_EDGE, height: DETECT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .toBuffer()
  const next = await sharp(resized, { failOn: 'none' }).metadata()
  return { bytes: resized, width: next.width || width, height: next.height || height }
}

async function bikePlateCrops(bytes) {
  const photo = await workingPhoto(bytes)
  const boxes = await findPlateBoxes(photo.bytes, photo.width, photo.height)
  const crops = []
  for (const box of boxes.slice(0, 3)) crops.push(await renderPlateCrop(photo.bytes, box))
  return { photo, crops }
}

async function recognizeSafe(worker, bytes) {
  const result = await recognizeLine(worker, bytes)
  return result.text
}

async function recognizeLine(worker, bytes) {
  if (!bytes || bytes.length < 800) return { text: '', confidence: 0 }
  try {
    const { data } = await worker.recognize(bytes)
    return { text: data.text?.trim() || '', confidence: Number(data.confidence) || 0 }
  } catch {
    return { text: '', confidence: 0 }
  }
}

async function preprocessPlateLine(cropBytes, region, width, height, invert = false) {
  const box = clampExtract(region, width, height)
  if (box.width < 24 || box.height < 12) return Buffer.alloc(0)
  let image = sharp(cropBytes, { failOn: 'none' })
    .extract(box)
    .grayscale()
    .normalize()
    .linear(1.28, -10)
  if (invert) image = image.negate()
  return image
    .resize({ height: 80, kernel: sharp.kernel.lanczos3 })
    .extend({ top: 16, bottom: 16, left: 28, right: 28, background: invert ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer()
}

async function defaultPlateLines(cropBytes, invert = false) {
  const { width = 1, height = 1 } = await sharp(cropBytes, { failOn: 'none' }).metadata()
  const top = await preprocessPlateLine(cropBytes, { left: 0, top: 0, width, height: Math.floor(height * 0.56) }, width, height, invert)
  const bot = await preprocessPlateLine(cropBytes, { left: 0, top: Math.floor(height * 0.4), width, height: height - Math.floor(height * 0.4) }, width, height, invert)
  return [top, bot]
}

async function tessPlateFromCrop(worker, cropBytes) {
  const crop = await innerBrightPlate(cropBytes)
  for (const invert of [false, true]) {
    const lines = await defaultPlateLines(crop, invert)
    const top = await recognizeLine(worker, lines[0])
    const bot = await recognizeLine(worker, lines[1])
    const plate = plateFromLinePair(top.text, bot.text)
    const minConf = Math.min(top.confidence || 0, bot.confidence || 0)
    const maxConf = Math.max(top.confidence || 0, bot.confidence || 0)
    if (plate && (minConf >= 35 || maxConf >= 50)) {
      return { plate, confidence: Math.round(Math.max(minConf, 45)), text: `${top.text}\n${bot.text}` }
    }
  }
  const prepared = await sharp(crop, { failOn: 'none' })
    .grayscale()
    .normalize()
    .resize({ height: 110, kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
    .png()
    .toBuffer()
  const whole = await recognizeLine(worker, prepared)
  const plate = parsePhotoPlate(asBikePlate(whole.text)) || pickPhotoPlate(whole.text)
  if (plate && whole.confidence >= 28) {
    return { plate, confidence: Math.round(Math.max(whole.confidence, 40)), text: whole.text }
  }
  return null
}

function plateFromLinePair(topText, botText) {
  const top = String(topText || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const bot = String(botText || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const prefix = bikePrefixToken(top)
  const suffix = bikeSuffixToken(bot)
  if (prefix && suffix) return parsePhotoPlate(`${prefix}${suffix}`)
  return parsePhotoPlate(top + bot) || parsePhotoPlate(pickPhotoPlate(`${top}\n${bot}`))
}

async function plateFill(cropBytes) {
  const { data, info } = await sharp(cropBytes, { failOn: 'none' }).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let hit = 0
  let ink = 0
  const n = info.width * info.height
  for (let i = 0; i < n; i++) {
    const r = data[i * info.channels]
    const g = data[i * info.channels + 1]
    const b = data[i * info.channels + 2]
    const pixel = isPlatePixel(r, g, b)
    if (pixel.hit) hit++
    if (pixel.luma < 92) ink++
  }
  const paper = hit / n
  const inkRatio = ink / n
  if (inkRatio < 0.04 || inkRatio > 0.45) return paper * 0.15
  return paper + inkRatio
}

function photoResult(input) {
  return photoRegistrationSchema.parse({
    registrationNumber: input.registrationNumber ?? null,
    status: input.status,
    confidence: input.confidence ?? null,
    reason: input.reason,
    processingTimeMs: input.processingTimeMs,
    timings: input.timings,
    retry: input.retry,
    bytes: input.bytes,
    width: input.width,
    height: input.height,
  })
}

export async function extractPhotoRegistration(bytes) {
  const started = Date.now()
  const timings = { detectMs: 0, preprocessMs: 0, ocrMs: 0, validateMs: 0 }
  if (!bytes?.length) {
    return photoResult({ status: 'unreadable', reason: 'Empty image.', processingTimeMs: 0, timings })
  }
  let detectStarted = Date.now()
  let photo
  let crops
  try {
    const located = await bikePlateCrops(bytes)
    photo = located.photo
    crops = located.crops
  } catch {
    return photoResult({ status: 'unreadable', reason: 'That file is not a readable photo.', processingTimeMs: Date.now() - started, timings })
  }
  timings.detectMs = Date.now() - detectStarted
  const ranked = []
  const prepStarted = Date.now()
  for (const crop of crops) ranked.push({ crop, fill: await plateFill(crop) })
  ranked.sort((a, b) => b.fill - a.fill)
  timings.preprocessMs = Date.now() - prepStarted
  const candidates = []
  let retry = false
  const ocrStarted = Date.now()
  const queue = ranked.filter((row) => row.fill >= 0.08).slice(0, 2)
  if (!queue.length && crops[0]) queue.push({ crop: crops[0], fill: 0.2 })
  if (queue.length) {
    const worker = await acquireWorker()
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: '7',
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        user_defined_dpi: '120',
      })
      for (let index = 0; index < queue.length; index++) {
        const crop = queue[index].crop
        if (process.env.PHOTO_OCR_DEBUG) await sharp(crop).jpeg({ quality: 90 }).toFile(`tmp-ocr-crop-${index}.jpg`)
        const tess = await tessPlateFromCrop(worker, crop)
        if (tess?.plate) {
          candidates.push({ plate: tess.plate, confidence: tess.confidence, source: 'tess' })
          break
        }
        retry = true
      }
    } finally {
      releaseWorker(worker)
    }
  }
  if (!candidates.length) {
    for (let index = 0; index < Math.min(queue.length, 1); index++) {
      const glyph = await readGlyphPlateDetail(queue[index].crop)
      if (glyph.plate && glyph.minScore >= 0.26 && glyph.chars?.[0] === 'K') {
        candidates.push({ plate: glyph.plate, confidence: Math.round(glyph.meanScore * 100), source: 'glyph' })
        break
      }
      if (glyph.plate) retry = true
    }
  }
  timings.ocrMs = Date.now() - ocrStarted
  const validateStarted = Date.now()
  const unique = [...new Map(candidates.map((row) => [row.plate, row])).values()]
  unique.sort((a, b) => b.confidence - a.confidence)
  const best = unique[0] && (unique.length === 1 || unique[0].confidence - (unique[1]?.confidence || 0) >= 8)
    ? unique[0]
    : unique.length === 1
      ? unique[0]
      : null
  timings.validateMs = Date.now() - validateStarted
  const processingTimeMs = Date.now() - started
  const log = {
    bytes: bytes.length,
    width: photo.width,
    height: photo.height,
    timings,
    retry,
    processingTimeMs,
  }
  if (process.env.PHOTO_OCR_LOG) console.log(JSON.stringify({ photoOcr: true, ...log, plates: unique }))
  if (unique.length > 1 && !best) {
    return photoResult({ ...log, status: 'review_required', reason: 'More than one registration was read from this photo.', confidence: unique[0]?.confidence ?? null })
  }
  if (!best?.plate) {
    return photoResult({ ...log, status: crops.length ? 'review_required' : 'unreadable', reason: crops.length ? 'The plate crop was ambiguous.' : 'No paper plate was found.' })
  }
  if (best.source === 'glyph' && best.confidence < 26) {
    return photoResult({ ...log, status: 'review_required', reason: 'The plate was located, but OCR was not confident enough to rename.', confidence: best.confidence, registrationNumber: null })
  }
  return photoResult({
    ...log,
    registrationNumber: best.plate,
    status: 'success',
    confidence: Math.round(best.confidence),
  })
}

async function ocrPhoto(bytes) {
  const result = await extractPhotoRegistration(bytes)
  if (result.registrationNumber) return `REGISTRATION No: ${result.registrationNumber}`
  return result.reason || ''
}

async function prepareImageForOcr(bytes, kind = 'photo') {
  try {
    if (kind === 'photo') {
      const { crops } = await bikePlateCrops(bytes)
      return crops[0] || bytes
    }
    return await sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: 'inside',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .normalize()
      .sharpen({ sigma: 1.5, m1: 1.2, m2: 0.6 })
      .png({ compressionLevel: 3 })
      .toBuffer()
  } catch {
    return bytes
  }
}

function rasterIsUsable(bytes) {
  if (!bytes || bytes.length < 800) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    return width >= 64 && height >= 64 && Math.min(width, height) >= 48
  }
  return true
}

async function ocrPrepared(images, kind) {
  const variants = []
  for (const image of images) {
    const prepared = await prepareImageForOcr(image, kind)
    variants.push(...(await imageVariants(prepared, kind)))
  }
  const usable = variants.filter((image) => rasterIsUsable(image))
  const worker = await acquireWorker()
  const chunks = []
  const seen = new Map()
  try {
    for (let index = 0; index < usable.length; index++) {
      const modes = kind === 'photo' ? ['11'] : (index === 0 ? ['6', '4'] : ['6'])
      const whitelist = kind === 'photo'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -'
        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -./:()#'
      for (const mode of modes) {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: mode,
            tessedit_char_whitelist: whitelist,
          })
          const { data } = await worker.recognize(usable[index])
          const text = data.text?.trim()
          if (!text) continue
          chunks.push(text)
          const labeled = parseKenyanPlate(plateFromRegistrationField(text, false))
          if (labeled && kind !== 'photo') return chunks.join('\n')
          const photoPlate = pickPhotoPlate(chunks.join('\n'))
          if (kind === 'photo' && photoPlate) return chunks.join('\n')
          for (const plate of kenyanPlatesIn(text)) {
            const valid = parseKenyanPlate(plate)
            if (valid) seen.set(valid, (seen.get(valid) || 0) + 1)
          }
          const top = [...seen.entries()].sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1]
            return Number(b[0].startsWith('KM')) - Number(a[0].startsWith('KM')) || b[0].length - a[0].length
          })[0]
          if (kind !== 'photo' && top && top[1] >= 2 && parseKenyanPlate(top[0])) return chunks.join('\n')
        } catch {
          // Try the next crop or page-seg mode.
        }
      }
    }
  } finally {
    releaseWorker(worker)
  }
  return chunks.join('\n')
}

async function imageVariants(bytes, kind) {
  let img
  try {
    img = await loadImage(bytes)
  } catch {
    return [bytes]
  }
  const scale = scaleForImage(img, kind)
  if (kind === 'photo') {
    const mid = {
      left: 0,
      top: Math.floor(img.height * 0.28),
      width: img.width,
      height: Math.max(96, Math.floor(img.height * 0.44)),
    }
    return [
      renderPrepared(img, { scale }),
      renderPlain(img, { scale }),
      renderPrepared(img, { scale, invert: true }),
      renderPrepared(img, { scale: Math.max(scale, 1.15), rect: mid }),
    ]
  }
  const header = documentRects(img)[0]
  const bandH = Math.max(96, Math.floor(img.height * 0.28))
  const band = { left: 0, top: 0, width: img.width, height: bandH }
  return [
    renderPrepared(img, { scale }),
    header && header.height >= 96 ? renderPrepared(img, { scale: Math.max(scale, 1.2), rect: header }) : null,
    renderPrepared(img, { scale: Math.max(scale, 1.2), rect: band }),
  ].filter(Boolean)
}

function renderRotated(img, angle, rect, scale = 2) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const pad = Math.max(source.width, source.height) * 0.15
  const w = Math.max(1, Math.round((source.width + pad * 2) * scale))
  const h = Math.max(1, Math.round((source.height + pad * 2) * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2, h / 2)
  ctx.rotate((angle * Math.PI) / 180)
  ctx.drawImage(img, source.left, source.top, source.width, source.height, -w / 2, -h / 2, w, h)
  return canvas.toBuffer('image/png')
}

function renderPlain(img, { scale = 1, rect } = {}) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, source.left, source.top, source.width, source.height, 0, 0, w, h)
  return canvas.toBuffer('image/png')
}

function scaleForImage(img, kind) {
  const longest = Math.max(img.width, img.height, 1)
  if (kind === 'photo') {
    const target = 3200
    if (longest < target) return Math.min(4, target / longest)
    return 1
  }
  const target = 2400
  if (longest < target) return Math.min(2.2, target / longest)
  return 1
}

function renderPrepared(img, { scale = 1, invert = false, rect } = {}) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, source.left, source.top, source.width, source.height, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const d = imageData.data
  let min = 255
  let max = 0
  const gray = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    gray[p] = g
    if (g < min) min = g
    if (g > max) max = g
  }
  const range = Math.max(1, max - min)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = ((gray[p] - min) / range) * 255
    if (invert) v = 255 - v
    const mid = 128
    v = Math.max(0, Math.min(255, mid + (v - mid) * 1.35))
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toBuffer('image/png')
}

function documentRects(img) {
  const { width, height } = img
  return [
    { left: 0, top: 0, width, height: Math.floor(height * 0.42) },
    { left: Math.floor(width * 0.4), top: 0, width: Math.floor(width * 0.6), height: Math.floor(height * 0.38) },
    { left: 0, top: 0, width: Math.floor(width * 0.55), height: Math.floor(height * 0.45) },
    { left: Math.floor(width * 0.32), top: 0, width: Math.floor(width * 0.68), height: Math.floor(height * 0.5) },
    { left: 0, top: Math.floor(height * 0.08), width, height: Math.floor(height * 0.4) },
    { left: Math.floor(width * 0.08), top: Math.floor(height * 0.18), width: Math.floor(width * 0.84), height: Math.floor(height * 0.28) },
  ].map((rect) => clampRect(rect, width, height))
}

function clampRect(rect, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(rect.left || 0)))
  const top = Math.max(0, Math.min(height - 1, Math.floor(rect.top || 0)))
  return {
    left,
    top,
    width: Math.max(8, Math.min(width - left, Math.floor(rect.width || width))),
    height: Math.max(8, Math.min(height - top, Math.floor(rect.height || height))),
  }
}

function ocrStartError(message) {
  if (/fetch failed|network error|enotfound|econnreset|undici/i.test(message)) {
    return 'Document OCR could not load English language data. Keep scripts/tessdata/eng.traineddata.gz in the project and retry.'
  }
  const clean = message.replace(/\s+/g, ' ').trim()
  return clean ? `Couldn't read that file: ${clean}` : "Couldn't read that file."
}

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('read-plate.mjs')
if (isCli) {
  const file = process.argv[2]
  const kind = process.argv[3] || 'photo'
  if (!file) {
    console.error('Usage: node scripts/read-plate.mjs <image-or-pdf-path> [photo|pdf|certificate|pdfjs]')
    process.exit(1)
  }
  try {
    const text = await extractPlateText(await readFile(file), kind)
    process.stdout.write(text ? `${text}\n` : '')
  } catch (err) {
    console.error(ocrStartError(err instanceof Error ? err.message : String(err)))
  } finally {
    await shutdownOcrWorkers().catch(() => {})
  }
}
