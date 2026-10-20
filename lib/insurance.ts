export type InsuranceCover = {
  commencement: string | null
  expiry: string | null
}

export type InsuranceAlertKind = 'week' | 'two-days' | 'expired'

export type InsuranceCoverState = InsuranceCover & {
  daysLeft: number | null
  alert: InsuranceAlertKind | null
}

export type InsuranceAlert = InsuranceCoverState & {
  plate: string
  kind: InsuranceAlertKind
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const NUMERIC_DATE = String.raw`(\d{1,2})[\/.\-]\s*(\d{1,2})[\/.\-]\s*(\d{2,4})|(\d{4})[\/.\-]\s*(\d{1,2})[\/.\-]\s*(\d{1,2})`
const NAMED_DATE = String.raw`(?:the\s+)?(\d{1,2}|[lI])(?:st|nd|rd|th)?(?:\s+day\s+of)?[\s,.\-/]+(${MONTH})[\s,.\-/]+(\d{2,4})`
const MONTH_FIRST = String.raw`(${MONTH})[\s,.\-/]+(\d{1,2}|[lI])(?:st|nd|rd|th)?[\s,.\-/]+(\d{2,4})`
const DATE = `(?:${NAMED_DATE}|${MONTH_FIRST}|${NUMERIC_DATE})`
const START_LABEL = /\b(?:commenc\w*(?:\s+date)?|inception(?:\s+date)?|effective(?:\s+date)?(?:\s+of\s+commencement)?|cover\s+start|start(?:\s+date)?|period(?:\s+of\s+(?:insurance|cover)))\b/i
const END_LABEL = /\b(?:expir\w*(?:\s+date)?|date of expiry|cover\s+end|end(?:\s+date)?|valid\s+(?:until|to|till))\b/i

export function parseInsuranceCover(raw: string): InsuranceCover {
  const text = String(raw || '').replace(/\s+/g, ' ').trim()
  const fromTo = pairFromTo(text)
  const columns = columnDates(text)
  const commencement = dateAfterLabel(text, START_LABEL) || fromTo[0] || columns[0] || null
  let expiry = dateAfterLabel(text, END_LABEL) || fromTo[1] || columns[1] || null
  if (expiry && commencement && expiry === commencement) expiry = fromTo[1] || columns[1] || expiry
  return { commencement, expiry }
}

export function insuranceState(cover: InsuranceCover, now = new Date()): InsuranceCoverState {
  const daysLeft = cover.expiry ? daysUntil(cover.expiry, now) : null
  return {
    commencement: cover.commencement,
    expiry: cover.expiry,
    daysLeft,
    alert: alertForDays(daysLeft),
  }
}

export function insuranceAlerts(covers: Record<string, InsuranceCover>, now = new Date()): InsuranceAlert[] {
  return Object.entries(covers)
    .map(([plate, cover]) => {
      const state = insuranceState(cover, now)
      if (!state.alert) return null
      return { plate, kind: state.alert, ...state }
    })
    .filter((item): item is InsuranceAlert => Boolean(item))
    .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || a.plate.localeCompare(b.plate))
}

export function parseCoverDate(value: string | null | undefined) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = parseDateToken(raw)
  if (parsed) return parsed
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw))
    if (serial > 20000 && serial < 90000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
    }
  }
  return null
}

export function formatCoverDate(iso: string | null | undefined) {
  if (!iso) return 'Not read'
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function coverAlertLabel(state: Pick<InsuranceCoverState, 'daysLeft' | 'alert'>) {
  if (state.alert === 'expired') return state.daysLeft === 0 ? 'Expires today' : `Expired ${Math.abs(state.daysLeft || 0)} day${Math.abs(state.daysLeft || 0) === 1 ? '' : 's'} ago`
  if (state.alert === 'two-days') return state.daysLeft === 0 ? 'Expires today' : state.daysLeft === 1 ? 'Expires tomorrow' : `${state.daysLeft} days left`
  if (state.alert === 'week') return `${state.daysLeft} days left`
  if (state.daysLeft == null) return ''
  return `${state.daysLeft} days left`
}

function alertForDays(daysLeft: number | null): InsuranceAlertKind | null {
  if (daysLeft == null) return null
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= 2) return 'two-days'
  if (daysLeft <= 7) return 'week'
  return null
}

function daysUntil(iso: string, now: Date) {
  const [year, month, day] = iso.split('-').map(Number)
  const expiry = Date.UTC(year, month - 1, day)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((expiry - today) / 86400000)
}

function dateAfterLabel(text: string, label: RegExp) {
  const pattern = new RegExp(label.source, label.flags.includes('g') ? label.flags : `${label.flags}g`)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const parsed = firstDateIn(text.slice(match.index + match[0].length, match.index + match[0].length + 160))
    if (parsed) return parsed
  }
  return null
}

function pairFromTo(text: string) {
  const pattern = /\bfrom\b/gi
  let from: RegExpExecArray | null
  while ((from = pattern.exec(text))) {
    const window = text.slice(from.index, from.index + 240)
    const to = window.match(/\b(?:to|until|till)\b/i)
    if (!to || to.index == null) continue
    const start = firstDateIn(window.slice(0, to.index))
    const end = firstDateIn(window.slice(to.index + to[0].length))
    if (start && end) return [start, end] as const
  }
  return [null, null] as const
}

function columnDates(text: string) {
  const start = text.search(/commenc|inception|period of (?:insurance|cover)/i)
  const end = text.search(/expir|cover end/i)
  if (start < 0) return [null, null] as const
  const dates = allDates(text.slice(Math.min(start, end < 0 ? start : end), Math.max(start, end) + 200))
  if (dates.length < 2) return [dates[0] || null, dates[1] || null] as const
  if (end >= 0 && end < start) return [dates[1], dates[0]] as const
  return [dates[0], dates[1]] as const
}

function firstDateIn(value: string) {
  return allDates(value)[0] || null
}

function allDates(value: string) {
  const found: string[] = []
  const pattern = new RegExp(DATE, 'ig')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    const parsed = parseDateToken(match[0])
    if (parsed && !found.includes(parsed)) found.push(parsed)
  }
  return found
}

function parseDateToken(value: string) {
  const token = value.trim().replace(/^[lI](?=st\b)/i, '1')
  if (!token) return null
  const named = token.match(new RegExp(`^${NAMED_DATE}$`, 'i'))
  if (named) return toIso(expandYear(named[3]), MONTHS[named[2].toLowerCase()], Number(named[1] === 'l' || named[1] === 'I' ? 1 : named[1]))
  const monthFirst = token.match(new RegExp(`^${MONTH_FIRST}$`, 'i'))
  if (monthFirst) {
    const day = monthFirst[2] === 'l' || monthFirst[2] === 'I' ? 1 : Number(monthFirst[2])
    return toIso(expandYear(monthFirst[3]), MONTHS[monthFirst[1].toLowerCase()], day)
  }
  const numeric = token.match(new RegExp(`^${NUMERIC_DATE}$`))
  if (!numeric) return null
  if (numeric[4]) return toIso(Number(numeric[4]), Number(numeric[5]), Number(numeric[6]))
  const first = Number(numeric[1])
  const second = Number(numeric[2])
  const year = expandYear(numeric[3])
  if (first > 12 && second <= 12) return toIso(year, second, first)
  if (second > 12 && first <= 12) return toIso(year, first, second)
  return toIso(year, second, first)
}

function expandYear(value: string) {
  const year = Number(value)
  if (value.length === 2) return year >= 70 ? 1900 + year : 2000 + year
  return year
}

function toIso(year: number, month: number, day: number) {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
