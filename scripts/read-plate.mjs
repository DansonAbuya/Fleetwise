import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createWorker } from 'tesseract.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const langPath = join(root, 'scripts', 'tessdata')
const cachePath = join(root, '.tesseract-cache')
const workerPath = require.resolve('tesseract.js/src/worker-script/node/index.js')
let corePath = ''
try {
  corePath = dirname(require.resolve('tesseract.js-core/package.json'))
} catch {
  corePath = ''
}

const MAX_WORKERS = 1
const pool = []
const waiters = []
let creating = 0

export async function extractPlateText(bytes, kind = 'photo') {
  const source = unwrapPdf(bytes)
  const chunks = []
  if (source.pdf) {
    const pdf = await readPdf(source.bytes)
    if (pdf.text.trim()) chunks.push(pdf.text.trim())
    const pages = pdf.pages
    if (pages.length) {
      const ocrText = await ocrPrepared(pages, 'certificate')
      if (ocrText.trim()) chunks.push(ocrText.trim())
    }
    if (!registrationPlate(chunks.join('\n')) && !kenyanPlatesIn(chunks.join('\n'))[0] && pages.length) {
      const photoText = await ocrPrepared(pages.slice(0, 1), 'photo')
      if (photoText.trim()) chunks.push(photoText.trim())
    }
    return withFoundPlate(chunks.join('\n'))
  }
  if (kind === 'pdf' || kind === 'certificate' || kind === 'logbook') {
    const documentText = await ocrPrepared([source.bytes], 'certificate')
    if (documentText.trim()) chunks.push(documentText.trim())
    if (!registrationPlate(documentText) && !kenyanPlatesIn(documentText)[0]) {
      const photoText = await ocrPrepared([source.bytes], 'photo')
      if (photoText.trim()) chunks.push(photoText.trim())
    }
    return withFoundPlate(chunks.join('\n'))
  }
  const ocrText = await ocrPrepared([source.bytes], 'photo')
  if (ocrText.trim()) chunks.push(ocrText.trim())
  return withFoundPlate(chunks.join('\n'))
}

function withFoundPlate(text) {
  const plate = registrationPlate(text) || kenyanPlatesIn(text)[0]
  if (!plate) return text
  if (new RegExp(`REGISTRATION No:\\s*${plate}`, 'i').test(text)) return text
  return `REGISTRATION No: ${plate}\n${text}`
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

function pdfAssetUrl(folder) {
  return pathToFileURL(join(root, 'node_modules', 'pdfjs-dist', folder) + '/').href
}

async function readPdf(buffer) {
  try {
    return await readPdfDocument(buffer)
  } catch {
    return { text: '', pages: [] }
  }
}

async function readPdfDocument(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = Uint8Array.from(buffer)
  const canvasFactory = new NodeCanvasFactory()
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: true,
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
    const pageCount = Math.min(pdf.numPages, 3)
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
    if (!registrationPlate(joined)) {
      for (let n = 1; n <= pageCount; n++) {
        const page = await pdf.getPage(n)
        try {
          pages.push(await rasterPage(page, canvasFactory))
        } catch {
          try {
            pages.push(await rasterPage(page, canvasFactory, 1.4))
          } catch {
            // Text and form fields still run if a page cannot be rasterized.
          }
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
  const add = (plate) => {
    if (plate && !found.includes(plate)) found.push(plate)
  }
  for (const match of compact.matchAll(/K[A-Z]{3}\d{3}[A-Z]|K[A-Z]{2}\d{3}[A-Z]/g)) add(match[0])
  for (let i = 0; i < compact.length - 6; i++) {
    if (compact[i] !== 'K') continue
    add(fixPlate(compact.slice(i, i + 8), 3))
    add(fixPlate(compact.slice(i, i + 7), 2))
  }
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
  const text = String(raw || '')
  const label = /\b(?:vehicle\s+|motor(?:\s+vehicle)?\s+|m\.?\s*v\.?\s*)?(?:registration|reg)(?:[\s.:\-–]*?(?:no\.?|number|num|mark|#))?(?![A-Za-z])/gi
  let match
  while ((match = label.exec(text))) {
    const window = text.slice(match.index, match.index + 280)
    const nearby = kenyanPlatesIn(window)
    if (nearby[0]) return nearby[0]
  }
  return ''
}

function registrationFromLayout(tokens, rows) {
  const labels = []
  tokens.forEach((token, index) => {
    if (/(?:registration(?:\s*(?:no\.?|number|num|mark|#))?|reg\.?\s*(?:no\.?|number|num|mark|#))\b/i.test(token.str)) {
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
    for (const plate of kenyanPlatesIn(str)) {
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
      if (!/(?:^|\b)reg(?:istration)?(?:\s*(?:no\.?|number|num|mark))?\.?(?:\b|$)/i.test(rows[i])) continue
      const after = rows[i].replace(/^.*?(reg(?:istration)?(?:\s*(?:no\.?|number|num|mark))?\.?\s*[:\-–.]*)/i, '').trim()
      const nearby = [after, rows[i + 1], rows[i + 2], rows[i - 1]].filter(Boolean)
      for (const raw of nearby) {
        const plates = kenyanPlatesIn(raw)
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
  return Math.min(2.6, Math.max(1.8, 2000 / longest))
}

async function createOcrWorker() {
  await mkdir(cachePath, { recursive: true })
  const worker = await createWorker('eng', 1, {
    langPath,
    cachePath,
    gzip: true,
    workerPath,
    ...(corePath ? { corePath } : {}),
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

async function ocrPrepared(images, kind) {
  const variants = []
  for (const image of images) {
    variants.push(...(await imageVariants(image, kind)))
  }
  const worker = await acquireWorker()
  const chunks = []
  const seen = new Map()
  try {
    for (let index = 0; index < variants.length; index++) {
      const modes = kind === 'photo'
        ? (index === 0 ? ['11', '6', '7'] : index < 4 ? ['7', '8'] : ['8'])
        : (index === 0 ? ['4', '6', '11'] : ['6', '7'])
      const whitelist = kind === 'photo'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -'
        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -./:()#'
      for (const mode of modes) {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: mode,
            tessedit_char_whitelist: whitelist,
          })
          const { data } = await worker.recognize(variants[index])
          const text = data.text?.trim()
          if (!text) continue
          chunks.push(text)
          const labeled = registrationPlate(text)
          if (labeled) {
            seen.set(labeled, (seen.get(labeled) || 0) + 4)
            if (kind !== 'photo') return chunks.join('\n')
          }
          for (const plate of kenyanPlatesIn(text)) {
            seen.set(plate, (seen.get(plate) || 0) + 1)
          }
          const top = [...seen.entries()].sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1]
            return Number(b[0].startsWith('KM')) - Number(a[0].startsWith('KM')) || b[0].length - a[0].length
          })[0]
          if (kind === 'photo' && top && (top[1] >= 2 || (top[0].startsWith('KM') && top[0].length === 8 && (data.confidence || 0) >= 78))) return chunks.join('\n')
          if (kind !== 'photo' && (labeled || (top && top[1] >= 2))) return chunks.join('\n')
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
    return []
  }
  const scale = scaleForImage(img, kind)
  const rects = kind === 'photo' ? photoRects(img).slice(0, 6) : documentRects(img)
  const cropScale = kind === 'photo' ? Math.max(scale, 2.4) : Math.max(scale, 1.8)
  const variants = [
    renderPlain(img, { scale }),
    renderPrepared(img, { scale, invert: false }),
  ]
  if (kind === 'photo') {
    variants.push(renderPrepared(img, { scale, invert: true }))
    variants.push(renderYellowBoost(img, { scale }))
  }
  for (const rect of rects) {
    variants.push(renderPlain(img, { scale: cropScale, rect }))
    variants.push(renderPrepared(img, { scale: cropScale, invert: false, rect }))
  }
  if (kind === 'photo' && rects[0]) {
    variants.push(renderRotated(img, -8, rects[0], cropScale))
    variants.push(renderRotated(img, 8, rects[0], cropScale))
    variants.push(renderYellowBoost(img, { scale: cropScale, rect: rects[0] }))
  }
  if (kind !== 'photo') variants.push(renderPrepared(img, { scale, invert: true }))
  return variants
}

function renderRotated(img, angle, rect, scale = 2) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const pad = Math.max(source.width, source.height) * 0.15
  const w = Math.max(1, Math.round((source.width + pad * 2) * scale))
  const h = Math.max(1, Math.round((source.height + pad * 2) * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2, h / 2)
  ctx.rotate((angle * Math.PI) / 180)
  ctx.drawImage(img, source.left, source.top, source.width, source.height, -w / 2, -h / 2, w, h)
  return canvas.toBuffer('image/png')
}

function renderYellowBoost(img, { scale = 1, rect } = {}) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, source.left, source.top, source.width, source.height, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const yellow = r > 140 && g > 120 && b < 140 && r + g > b * 1.8
    const v = yellow ? 0 : 255
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toBuffer('image/png')
}

function renderPlain(img, { scale = 1, rect } = {}) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, source.left, source.top, source.width, source.height, 0, 0, w, h)
  return canvas.toBuffer('image/png')
}

function scaleForImage(img, kind) {
  const longest = Math.max(img.width, img.height)
  const shortest = Math.min(img.width, img.height)
  if (kind === 'photo') {
    if (shortest < 400) return 3
    if (shortest < 900) return 2
    if (longest > 2800) return 2200 / longest
    return 1
  }
  if (longest < 1600) return Math.min(2.2, 2000 / Math.max(longest, 1))
  if (longest > 2800) return 2200 / longest
  return 1
}

function renderPrepared(img, { scale = 1, invert = false, rect } = {}) {
  const source = rect || { left: 0, top: 0, width: img.width, height: img.height }
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
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

function photoRects(img) {
  const { width, height } = img
  const rects = [
    plateBand(img),
    ...colorPlateBoxes(img),
    { left: 0, top: 0, width: Math.floor(width * 0.55), height: Math.floor(height * 0.55) },
    { left: Math.floor(width * 0.45), top: 0, width: Math.floor(width * 0.55), height: Math.floor(height * 0.55) },
    { left: 0, top: Math.floor(height * 0.45), width: Math.floor(width * 0.55), height: Math.floor(height * 0.55) },
    { left: Math.floor(width * 0.45), top: Math.floor(height * 0.45), width: Math.floor(width * 0.55), height: Math.floor(height * 0.55) },
    { left: 0, top: Math.floor(height * 0.28), width, height: Math.floor(height * 0.44) },
  ]
  return uniqueRects(rects.map((rect) => clampRect(rect, width, height)))
}

function uniqueRects(rects) {
  const seen = new Set()
  const unique = []
  for (const rect of rects) {
    const key = `${Math.round(rect.left / 8)}:${Math.round(rect.top / 8)}:${Math.round(rect.width / 8)}:${Math.round(rect.height / 8)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(rect)
  }
  return unique
}

function colorPlateBoxes(img) {
  const { width, height } = img
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  const cols = 6
  const rows = 6
  const cellW = Math.max(8, Math.floor(width / cols))
  const cellH = Math.max(8, Math.floor(height / rows))
  const cells = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * cellW
      const y0 = row * cellH
      let yellow = 0
      let white = 0
      for (let y = y0; y < Math.min(height, y0 + cellH); y += 2) {
        for (let x = x0; x < Math.min(width, x0 + cellW); x += 2) {
          const i = (y * width + x) * 4
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          const luma = 0.299 * r + 0.587 * g + 0.114 * b
          if (r > 145 && g > 125 && b < 120 && r + g > b * 2.2) yellow++
          if (luma > 185 && Math.abs(r - g) < 35 && Math.abs(g - b) < 35) white++
        }
      }
      cells.push({ score: yellow * 4 + white, x0, y0 })
    }
  }
  cells.sort((a, b) => b.score - a.score)
  const floor = Math.max(6, (cells[0]?.score || 0) * 0.22)
  return cells.filter((cell) => cell.score >= floor).slice(0, 5).map((cell) => ({
    left: Math.max(0, cell.x0 - Math.floor(cellW * 0.4)),
    top: Math.max(0, cell.y0 - Math.floor(cellH * 0.4)),
    width: Math.floor(cellW * 1.8),
    height: Math.floor(cellH * 1.8),
  }))
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

function plateBand(img) {
  const { width, height } = img
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  const scores = new Array(height).fill(0)
  for (let y = 0; y < height; y++) {
    let yellow = 0
    let bright = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (r > 145 && g > 125 && b < 120 && r + g > b * 2.2) yellow++
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      if (luma > 175 && Math.abs(r - g) < 40) bright++
    }
    scores[y] = yellow * 4 + bright
  }
  const win = Math.max(16, Math.floor(height * 0.14))
  let best = -1
  let bestY = Math.floor(height * 0.4)
  let sum = 0
  for (let y = 0; y < height; y++) {
    sum += scores[y]
    if (y >= win) sum -= scores[y - win]
    if (y >= win - 1 && sum > best) {
      best = sum
      bestY = y - win + 1
    }
  }
  const pad = Math.floor(win * 0.35)
  const top = Math.max(0, bestY - pad)
  return {
    left: Math.floor(width * 0.04),
    top,
    width: Math.floor(width * 0.92),
    height: Math.min(height - top, win + pad * 2),
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
    console.error('Usage: node scripts/read-plate.mjs <image-or-pdf-path> [photo|pdf|certificate]')
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
