'use server'

import { requireSession } from '@/lib/session'
import { buildFleetReport, reportWindowStart } from '@/modules/fleet/report'
import { newFleetId, readFleetStore, updateFleetStore } from '@/modules/fleet/store'

export type FleetBikeInput = {
  plate: string
  branded: boolean
  activatedOn: string
  repossessedOn?: string
}

export type FleetActivityInput = {
  plate: string
  date: string
  rides: number
  mileageKm: number
  appMileageKm?: number | null
  netEarnings: number
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function plateOf(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '')
}

function requireDate(value: string, label: string) {
  if (!DATE.test(value)) throw new Error(`${label} must be a date.`)
  return value
}

function requireNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be zero or more.`)
  return value
}

function rowsOf(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(',').map((cell) => cell.trim()))
}

function skipHeader(rows: string[][], markers: string[]) {
  const first = (rows[0]?.[0] || '').toLowerCase()
  return markers.includes(first) ? rows.slice(1) : rows
}

export async function listFleetBikes() {
  await requireSession()
  const store = await readFleetStore()
  return [...store.bikes].sort((a, b) => a.plate.localeCompare(b.plate))
}

export async function saveFleetBike(input: FleetBikeInput) {
  await requireSession()
  const plate = plateOf(input.plate)
  if (!plate) throw new Error('Enter the bike registration.')
  const activatedOn = requireDate(input.activatedOn, 'Activation date')
  const repossessedOn = input.repossessedOn?.trim() ? requireDate(input.repossessedOn, 'Repossession date') : null
  if (repossessedOn && repossessedOn < activatedOn) throw new Error('Repossession cannot be before activation.')
  await updateFleetStore((store) => {
    const current = store.bikes.find((bike) => bike.plate === plate)
    if (current) {
      current.branded = input.branded
      current.activatedOn = activatedOn
      current.repossessedOn = repossessedOn
    } else {
      store.bikes.push({ id: newFleetId(), plate, branded: input.branded, activatedOn, repossessedOn })
    }
  })
}

export async function importFleetBikes(csv: string) {
  await requireSession()
  const rows = skipHeader(rowsOf(csv), ['plate', 'registration', 'bike'])
  if (!rows.length) throw new Error('Paste bike rows: plate, branded, activated date, repossessed date.')
  if (rows.length > 20000) throw new Error('Import 20,000 bikes or fewer at a time.')
  const ready: FleetBikeInput[] = []
  const errors: string[] = []
  for (const [index, row] of rows.entries()) {
    try {
      const plate = plateOf(row[0] || '')
      if (!plate) throw new Error('Enter the bike registration.')
      const activatedOn = requireDate(row[2] || '', 'Activation date')
      const repossessedOn = row[3]?.trim() ? requireDate(row[3], 'Repossession date') : ''
      if (repossessedOn && repossessedOn < activatedOn) throw new Error('Repossession cannot be before activation.')
      ready.push({ plate, branded: /^(1|y|yes|true|branded)$/i.test(row[1] || ''), activatedOn, repossessedOn })
    } catch (err) {
      errors.push(`Row ${index + 1}: ${err instanceof Error ? err.message : 'Could not read bike.'}`)
    }
  }
  await updateFleetStore((store) => {
    for (const input of ready) {
      const repossessedOn = input.repossessedOn?.trim() || null
      const current = store.bikes.find((bike) => bike.plate === input.plate)
      if (current) {
        current.branded = input.branded
        current.activatedOn = input.activatedOn
        current.repossessedOn = repossessedOn
      } else {
        store.bikes.push({ id: newFleetId(), plate: input.plate, branded: input.branded, activatedOn: input.activatedOn, repossessedOn })
      }
    }
  })
  return { saved: ready.length, errors: errors.slice(0, 8) }
}

export async function listFleetActivity(date: string) {
  await requireSession()
  requireDate(date, 'Activity date')
  const store = await readFleetStore()
  const plates = new Map(store.bikes.map((bike) => [bike.id, bike.plate]))
  return store.days
    .filter((day) => day.date === date)
    .map((day) => ({ ...day, plate: plates.get(day.bikeId) || '' }))
    .sort((a, b) => a.plate.localeCompare(b.plate))
}

export async function saveFleetActivity(input: FleetActivityInput) {
  await requireSession()
  const plate = plateOf(input.plate)
  const date = requireDate(input.date, 'Activity date')
  const rides = Math.round(requireNumber(input.rides, 'Rides'))
  const mileageKm = requireNumber(input.mileageKm, 'Mileage')
  const netEarnings = Math.round(requireNumber(input.netEarnings, 'Net earnings'))
  const appMileageKm = input.appMileageKm == null ? null : requireNumber(Number(input.appMileageKm), 'App mileage')
  await updateFleetStore((store) => {
    const bike = store.bikes.find((item) => item.plate === plate)
    if (!bike) throw new Error(`${plate} is not on the bike register. Add it under Bikes first.`)
    const current = store.days.find((day) => day.bikeId === bike.id && day.date === date)
    if (current) {
      current.rides = rides
      current.mileageKm = mileageKm
      current.appMileageKm = appMileageKm
      current.netEarnings = netEarnings
    } else {
      store.days.push({ id: newFleetId(), bikeId: bike.id, date, rides, mileageKm, appMileageKm, netEarnings })
    }
  })
}

export async function importFleetActivity(csv: string) {
  await requireSession()
  const rows = skipHeader(rowsOf(csv), ['plate', 'registration', 'bike'])
  if (!rows.length) throw new Error('Paste activity rows: plate, date, rides, mileage km, app mileage km, net earnings.')
  if (rows.length > 20000) throw new Error('Import 20,000 activity rows or fewer at a time.')
  const ready: FleetActivityInput[] = []
  const errors: string[] = []
  for (const [index, row] of rows.entries()) {
    try {
      const plate = plateOf(row[0] || '')
      const date = requireDate(row[1] || '', 'Activity date')
      const rides = Math.round(requireNumber(Number(row[2] || 0), 'Rides'))
      const mileageKm = requireNumber(Number(row[3] || 0), 'Mileage')
      const app = row[4]?.trim()
      const appMileageKm = app ? requireNumber(Number(app), 'App mileage') : null
      const netEarnings = Math.round(requireNumber(Number(row[5] || 0), 'Net earnings'))
      ready.push({ plate, date, rides, mileageKm, appMileageKm, netEarnings })
    } catch (err) {
      errors.push(`Row ${index + 1}: ${err instanceof Error ? err.message : 'Could not read activity.'}`)
    }
  }
  await updateFleetStore((store) => {
    const bikes = new Map(store.bikes.map((bike) => [bike.plate, bike]))
    for (const input of ready) {
      const bike = bikes.get(input.plate)
      if (!bike) {
        errors.push(`${input.plate} is not on the bike register.`)
        continue
      }
      const current = store.days.find((day) => day.bikeId === bike.id && day.date === input.date)
      const appMileageKm = input.appMileageKm ?? null
      if (current) {
        current.rides = input.rides
        current.mileageKm = input.mileageKm
        current.appMileageKm = appMileageKm
        current.netEarnings = input.netEarnings
      } else {
        store.days.push({
          id: newFleetId(),
          bikeId: bike.id,
          date: input.date,
          rides: input.rides,
          mileageKm: input.mileageKm,
          appMileageKm,
          netEarnings: input.netEarnings,
        })
      }
    }
  })
  const missing = errors.filter((item) => item.includes('not on the bike register')).length
  return { saved: ready.length - missing, errors: errors.slice(0, 8) }
}

export async function getFleetReport(date: string) {
  await requireSession()
  requireDate(date, 'Report date')
  const from = reportWindowStart(date)
  const store = await readFleetStore()
  const days = store.days.filter((day) => day.date >= from && day.date <= date)
  return buildFleetReport(store.bikes, days, date)
}
