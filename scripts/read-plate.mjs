import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createWorker } from 'tesseract.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const langPath = join(root, 'scripts', 'tessdata')
const cachePath = join(root, '.tesseract-cache')

const MAX_WORKERS = 2
const pool = []
const waiters = []
let creating = 0

export async function extractPlateText(bytes, kind = 'photo') {
  const chunks = []
  if (isPdf(bytes) || kind === 'pdf' || kind === 'certificate') {
    if (isPdf(bytes)) {
      const pdf = await readPdf(bytes)
      if (pdf.text.trim()) chunks.push(pdf.text.trim())
      if (!registrationPlate(pdf.text) && pdf.pages.length) {
        const ocrText = await ocrPrepared(pdf.pages, 'certificate')
        if (ocrText.trim()) chunks.push(ocrText.trim())
      }
      return chunks.join('\n')
    }
    const ocrText = await ocrPrepared([bytes], 'certificate')
    if (ocrText.trim()) chunks.push(ocrText.trim())
    return chunks.join('\n')
  }
  const ocrText = await ocrPrepared([bytes], 'photo')
  if (ocrText.trim()) chunks.push(ocrText.trim())
  return chunks.join('\n')
}

export async function shutdownOcrWorkers() {
  const slots = pool.splice(0, pool.length)
  waiters.length = 0
  await Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => {})))
}

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('read-plate.mjs')
if (isCli) {
  process.on('uncaughtException', (err) => {
    console.error(ocrStartError(err instanceof Error ? err.message : String(err)))
    process.exit(1)
  })
  const file = process.argv[2]
  const kind = process.argv[3] || 'photo'
  if (!file) {
    console.error('Usage: node scripts/read-plate.mjs <image-or-pdf-path> [photo|pdf|certificate]')
    process.exit(1)
  }
  try {
    const text = await extractPlateText(await readFile(file), kind)
    process.stdout.write(text)
    await shutdownOcrWorkers()
  } catch (err) {
    console.error(ocrStartError(err instanceof Error ? err.message : String(err)))
    await shutdownOcrWorkers()
    process.exit(1)
  }
}

function isPdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('utf8') === '%PDF-'
}

async function readPdf(buffer) {
  const data = Uint8Array.from(buffer)
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  })
  const pdf = await loadingTask.promise
  const texts = []
  const pages = []
  try {
    const pageCount = Math.min(pdf.numPages, 2)
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      texts.push(layoutText(content.items))
      const raw = content.items.map((item) => String(item.str || '')).join(' ').replace(/\s+/g, ' ').trim()
      if (raw) texts.push(raw)
    }
    const joined = texts.join('\n')
    if (!registrationPlate(joined)) {
      for (let n = 1; n <= pageCount; n++) {
        const page = await pdf.getPage(n)
        try {
          const viewport = page.getViewport({ scale: scaleFor(page) })
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
          const canvasContext = canvas.getContext('2d')
          await page.render({ canvasContext, canvas, viewport }).promise
          pages.push(canvas.toBuffer('image/png'))
        } catch {
          // Text extraction still runs if a page cannot be rasterized.
        }
      }
    }
  } finally {
    await Promise.resolve(pdf.cleanup?.()).catch(() => {})
    await Promise.resolve(loadingTask.destroy?.()).catch(() => {})
  }
  return { text: texts.join('\n'), pages }
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
    if (!found.includes(match[0])) found.push(match[0])
  }
  return found
}

function registrationPlate(raw) {
  const text = String(raw || '')
  const label = /\b(?:vehicle\s+|motor(?:\s+vehicle)?\s+)?(?:registration(?:\s*(?:no\.?|number|num|mark|#))?|reg\.?\s*(?:no\.?|number|num|#))\.?/gi
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
    errorHandler: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(ocrStartError(message))
    },
  })
  await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })
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
      const modes = kind === 'photo' ? (index === 0 ? ['6', '11', '7'] : ['7']) : ['6', '7']
      for (const mode of modes) {
        await worker.setParameters({ tessedit_pageseg_mode: mode })
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
        const top = [...seen.entries()].sort((a, b) => b[1] - a[1])[0]
        if (top && top[1] >= (kind === 'photo' ? 2 : 3)) return chunks.join('\n')
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
  const rects = kind === 'photo' ? photoRects(img) : documentRects(img)
  const cropScale = kind === 'photo' ? Math.max(scale, 2) : scale
  const variants = [renderPrepared(img, { scale, invert: false })]
  if (kind === 'photo') variants.push(renderPrepared(img, { scale, invert: true }))
  for (const rect of rects) {
    variants.push(renderPrepared(img, { scale: cropScale, invert: false, rect }))
  }
  if (kind !== 'photo') variants.push(renderPrepared(img, { scale, invert: true }))
  const invertCount = kind === 'photo' ? Math.min(4, rects.length) : 1
  for (const rect of rects.slice(0, invertCount)) {
    variants.push(renderPrepared(img, { scale: cropScale, invert: true, rect }))
  }
  return variants
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
    v = v < 110 ? Math.max(0, v * 0.72) : Math.min(255, 210 + (v - 110) * 0.4)
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toBuffer('image/png')
}

function photoRects(img) {
  const { width, height } = img
  const rects = [plateBand(img), ...colorPlateBoxes(img)]
  const tile = 0.5
  const steps = [0, 0.25, 0.5]
  for (const y of steps) {
    for (const x of steps) {
      rects.push({
        left: Math.floor(width * x),
        top: Math.floor(height * y),
        width: Math.floor(width * tile),
        height: Math.floor(height * tile),
      })
    }
  }
  rects.push(
    { left: 0, top: 0, width, height: Math.floor(height * 0.42) },
    { left: 0, top: Math.floor(height * 0.29), width, height: Math.floor(height * 0.42) },
    { left: 0, top: Math.floor(height * 0.58), width, height: Math.floor(height * 0.42) },
    { left: 0, top: 0, width: Math.floor(width * 0.46), height },
    { left: Math.floor(width * 0.27), top: 0, width: Math.floor(width * 0.46), height },
    { left: Math.floor(width * 0.54), top: 0, width: Math.floor(width * 0.46), height },
  )
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
    { left: 0, top: 0, width, height: Math.floor(height * 0.48) },
    { left: Math.floor(width * 0.35), top: 0, width: Math.floor(width * 0.65), height: Math.floor(height * 0.55) },
    { left: 0, top: Math.floor(height * 0.12), width, height: Math.floor(height * 0.35) },
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
