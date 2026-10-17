import { compactPlate } from '@/lib/plates'
import { insuranceAlerts, insuranceState, type InsuranceCover } from '@/lib/insurance'
import type { DocType, FleetStats, VehicleRecord } from '@/lib/types'

export type VehicleStatusFilter = 'all' | 'Complete' | 'Needs attention'
export type VehicleMissingFilter = 'logbook' | 'certificate' | 'photo' | 'collateral' | 'agreement'

export type VehicleQuery = {
  query?: string
  status?: VehicleStatusFilter
  brand?: string
  missing?: VehicleMissingFilter[]
  page?: number
  pageSize?: number
}

export type { FleetStats }

export const EMPTY_STATS: FleetStats = {
  total: 0,
  complete: 0,
  attention: 0,
  logbook: 0,
  certificate: 0,
  photo: 0,
  collateral: 0,
  agreement: 0,
  brands: [],
  unbranded: 0,
  newPlates: [],
  insuranceWeek: 0,
  insuranceTwoDays: 0,
  insuranceExpired: 0,
}

export function hasRegisterItem(vehicle: VehicleRecord, item: VehicleMissingFilter) {
  if (item === 'collateral') return Boolean(vehicle.collateral)
  if (item === 'agreement') return Boolean(vehicle.agreement)
  return vehicle.files[item].length > 0
}

export function filterVehicles(vehicles: VehicleRecord[], input: VehicleQuery) {
  const needle = (input.query || '').trim().toLowerCase()
  const status = input.status || 'all'
  const brand = input.brand || 'all'
  const missing = input.missing || []
  return vehicles.filter((vehicle) => {
    const matchesQuery = !needle || vehicle.plate.toLowerCase().includes(needle) || (vehicle.brand || '').toLowerCase().includes(needle)
    const matchesStatus = status === 'all' || vehicle.status === status
    const matchesBrand = brand === 'all'
      || (brand === '__none' ? !(vehicle.brand || '').trim() : (vehicle.brand || '').trim().toLowerCase() === brand.toLowerCase())
    const matchesMissing = missing.every((item) => !hasRegisterItem(vehicle, item))
    return matchesQuery && matchesStatus && matchesBrand && matchesMissing
  })
}

export function fleetStats(vehicles: VehicleRecord[], previousPlates: string[] = []): FleetStats {
  const brands = [...new Set(vehicles.map((vehicle) => (vehicle.brand || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const previous = new Set(previousPlates)
  const newPlates = previous.size && vehicles.length > previous.size
    ? vehicles.map((vehicle) => vehicle.plate).filter((plate) => !previous.has(plate))
    : []
  return {
    total: vehicles.length,
    complete: vehicles.filter((vehicle) => vehicle.status === 'Complete').length,
    attention: vehicles.filter((vehicle) => vehicle.status !== 'Complete').length,
    logbook: vehicles.filter((vehicle) => vehicle.files.logbook.length).length,
    certificate: vehicles.filter((vehicle) => vehicle.files.certificate.length).length,
    photo: vehicles.filter((vehicle) => vehicle.files.photo.length).length,
    collateral: vehicles.filter((vehicle) => vehicle.collateral).length,
    agreement: vehicles.filter((vehicle) => (vehicle.files.agreement || []).length > 0 || Boolean(vehicle.agreement)).length,
    brands,
    unbranded: vehicles.filter((vehicle) => !(vehicle.brand || '').trim()).length,
    newPlates,
    insuranceWeek: vehicles.filter((vehicle) => vehicle.insurance?.alert === 'week').length,
    insuranceTwoDays: vehicles.filter((vehicle) => vehicle.insurance?.alert === 'two-days').length,
    insuranceExpired: vehicles.filter((vehicle) => vehicle.insurance?.alert === 'expired').length,
  }
}

export function attachInsurance(vehicles: VehicleRecord[], covers: Record<string, InsuranceCover>): VehicleRecord[] {
  return vehicles.map((vehicle) => {
    const stored = covers[compactPlate(vehicle.plate)] || covers[vehicle.plate]
    const cover = {
      commencement: stored?.commencement || vehicle.insurance?.commencement || null,
      expiry: stored?.expiry || vehicle.insurance?.expiry || null,
    }
    return { ...vehicle, insurance: insuranceState(cover) }
  })
}

export function insuranceAlertsFor(covers: Record<string, InsuranceCover>) {
  return insuranceAlerts(covers)
}

export function slimVehicle(vehicle: VehicleRecord): VehicleRecord {
  return {
    plate: vehicle.plate,
    brand: vehicle.brand,
    present: vehicle.present,
    total: vehicle.total,
    status: vehicle.status,
    updated: vehicle.updated,
    files: {
      logbook: slimFiles(vehicle.files.logbook || []),
      certificate: slimFiles(vehicle.files.certificate || []),
      photo: slimFiles(vehicle.files.photo || []),
      agreement: slimFiles(vehicle.files.agreement || []),
    },
    collateral: vehicle.collateral
      ? { id: vehicle.collateral.id, name: vehicle.collateral.name, webViewLink: vehicle.collateral.webViewLink }
      : undefined,
    agreement: vehicle.agreement
      ? { id: vehicle.agreement.id, name: vehicle.agreement.name, webViewLink: vehicle.agreement.webViewLink }
      : undefined,
    insurance: vehicle.insurance,
  }
}

function slimFiles(files: VehicleRecord['files'][DocType]) {
  const file = files[0]
  if (!file) return []
  return [{ id: file.id, name: file.name, type: file.type, plate: file.plate, webViewLink: file.webViewLink, modifiedTime: file.modifiedTime }]
}
