'use client'

import { exportVehicleRegister } from '@/modules/stock/actions'
import type { MissingFilter, StatusFilter } from '@/modules/stock/model'

export async function exportCsv(input: { query: string; status: StatusFilter; brand: string; missing: MissingFilter[] }) {
  const csv = await exportVehicleRegister({ query: input.query, status: input.status, brand: input.brand, missing: input.missing })
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'fleetwise-register.csv'
  link.click()
  URL.revokeObjectURL(url)
}
