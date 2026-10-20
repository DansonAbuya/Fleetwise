export type FleetBikeRow = {
  id: string
  plate: string
  branded: boolean
  activatedOn: string
  repossessedOn: string | null
}

export type FleetDayRow = {
  bikeId: string
  date: string
  rides: number
  mileageKm: number
  appMileageKm: number | null
  netEarnings: number
}

export type FleetReport = {
  date: string
  totalActive: number
  active30: number
  fleetRatio: number
  activeOnDate: number
  branded: number
  activated: number
  repossessed: number
  mileage: number
  mileageMonth: number
  earnings: number
  utilization: number
  utilizationLastMonth: number
  rides: number
  appMileage: number | null
  appMileageLastMonth: number | null
  averageEarning: number
  medianEarning: number
}

export function addDays(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function monthStart(iso: string) {
  return `${iso.slice(0, 8)}01`
}

export function previousMonth(iso: string) {
  const end = addDays(monthStart(iso), -1)
  return { start: monthStart(end), end }
}

export function reportWindowStart(iso: string) {
  return addDays(previousMonth(iso).start, -29)
}

export function nairobiDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date())
  return addDays(today, offsetDays)
}

function worked(day: FleetDayRow) {
  return day.rides > 0 || day.mileageKm > 0 || day.netEarnings > 0 || (day.appMileageKm ?? 0) > 0
}

function onBook(bike: FleetBikeRow, date: string) {
  return bike.activatedOn <= date && (!bike.repossessedOn || bike.repossessedOn > date)
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values: number[]) {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function buildFleetReport(bikes: FleetBikeRow[], days: FleetDayRow[], date: string): FleetReport {
  const byDate = new Map<string, FleetDayRow[]>()
  for (const day of days) {
    const list = byDate.get(day.date)
    if (list) list.push(day)
    else byDate.set(day.date, [day])
  }

  function activeIds(day: string) {
    const ids = new Set<string>()
    for (const row of byDate.get(day) || []) {
      if (worked(row)) ids.add(row.bikeId)
    }
    return ids
  }

  function trailingActive(day: string) {
    const ids = new Set<string>()
    const start = addDays(day, -29)
    for (const [key, rows] of byDate) {
      if (key < start || key > day) continue
      for (const row of rows) {
        if (worked(row)) ids.add(row.bikeId)
      }
    }
    return ids.size
  }

  const book = bikes.filter((bike) => onBook(bike, date))
  const todayRows = (byDate.get(date) || []).filter(worked)
  const todayIds = activeIds(date)
  const monthRows = days.filter((day) => day.date >= monthStart(date) && day.date <= date)
  const last = previousMonth(date)
  const lastRows = days.filter((day) => day.date >= last.start && day.date <= last.end && day.appMileageKm != null)
  const earnings = todayRows.map((row) => row.netEarnings)
  const trailing = trailingActive(date)
  const utilizationDays: number[] = []
  for (let cursor = last.start; cursor <= last.end; cursor = addDays(cursor, 1)) {
    const base = trailingActive(cursor)
    if (!base) continue
    utilizationDays.push((activeIds(cursor).size / base) * 100)
  }

  return {
    date,
    totalActive: book.length,
    active30: trailing,
    fleetRatio: book.length ? (trailing / book.length) * 100 : 0,
    activeOnDate: todayIds.size,
    branded: book.filter((bike) => bike.branded).length,
    activated: bikes.filter((bike) => bike.activatedOn === date).length,
    repossessed: bikes.filter((bike) => bike.repossessedOn === date).length,
    mileage: todayRows.reduce((sum, row) => sum + row.mileageKm, 0),
    mileageMonth: monthRows.reduce((sum, row) => sum + row.mileageKm, 0),
    earnings: earnings.reduce((sum, value) => sum + value, 0),
    utilization: trailing ? (todayIds.size / trailing) * 100 : 0,
    utilizationLastMonth: utilizationDays.length ? utilizationDays.reduce((sum, value) => sum + value, 0) / utilizationDays.length : 0,
    rides: todayRows.reduce((sum, row) => sum + row.rides, 0),
    appMileage: mean(todayRows.flatMap((row) => row.appMileageKm == null ? [] : [row.appMileageKm])),
    appMileageLastMonth: mean(lastRows.flatMap((row) => row.appMileageKm == null ? [] : [row.appMileageKm])),
    averageEarning: todayIds.size ? earnings.reduce((sum, value) => sum + value, 0) / todayIds.size : 0,
    medianEarning: median(earnings),
  }
}

function count(value: number) {
  return String(Math.round(value))
}

function grouped(value: number) {
  return Math.round(value).toLocaleString('en-KE')
}

function money(value: number) {
  const rounded = Math.round(value)
  return `KES ${Math.abs(rounded) >= 10000 ? rounded.toLocaleString('en-KE') : String(rounded)}`
}

function percent(value: number) {
  return `${value.toFixed(1)}%`
}

function appKm(value: number | null) {
  return value == null ? '0.0KM' : `${value.toFixed(1)}KM`
}

export function formatReportDate(iso: string) {
  const [year, month, day] = iso.split('-')
  return `${day}/${month}/${year}`
}

export function formatFleetReport(report: FleetReport) {
  const lines = [
    `Fleet department daily report (${formatReportDate(report.date)}):`,
    `Total active bikes/loans - ${count(report.totalActive)}`,
    `Last 30 days active Fleet - ${count(report.active30)}`,
    `Fleet ratio - ${percent(report.fleetRatio)}`,
    `Yesterday active Fleet - ${count(report.activeOnDate)}`,
    `Branded bikes in the fleet - ${count(report.branded)}`,
    `New Fleet accounts activated yesterday - ${count(report.activated)}`,
    `Repossessed fleet units yesterday - ${count(report.repossessed)}`,
    `Mileage yesterday - ${grouped(report.mileage)}KM`,
    `Mileage current month - ${grouped(report.mileageMonth)}`,
    `Net Earnings yesterday - ${money(report.earnings)}`,
    `Fleet utilization last month - ${percent(report.utilizationLastMonth)}`,
    `Fleet Utilization yesterday - ${percent(report.utilization)}`,
    `Rides completed yesterday - ${count(report.rides)}`,
    `Average mileage on app last month - ${appKm(report.appMileageLastMonth)}`,
    `Average mileage on app yesterday - ${appKm(report.appMileage)}`,
    `Average daily net earning on platform - ${money(report.averageEarning)}`,
    `Median net earnings - ${money(report.medianEarning)}`,
  ]
  return lines.join('\n')
}
