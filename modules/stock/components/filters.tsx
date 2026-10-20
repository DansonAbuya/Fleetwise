'use client'

import { MISSING_FILTERS, type MissingFilter } from '@/modules/stock/model'
import type { VehicleRecord } from '@/lib/types'

export function BrandFilter({ value, brands, unbrandedCount, onChange }: { value: string; brands: string[]; unbrandedCount: number; onChange: (next: string) => void }) {
  if (!brands.length && !unbrandedCount) return null
  return <label className="field-label brand-filter">Brand<select className="assign-input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter by brand">
    <option value="all">All brands</option>
    {unbrandedCount > 0 && <option value="__none">No brand</option>}
    {brands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
  </select></label>
}

export function MissingFilters({ value, onChange }: { value: MissingFilter[]; onChange: (next: MissingFilter[]) => void }) {
  function toggle(id: MissingFilter) {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
  }
  return <div className="filter-chips" role="group" aria-label="Show vehicles missing documents">
    {MISSING_FILTERS.map((filter) => <button type="button" key={filter.id} className={`filter-chip ${value.includes(filter.id) ? 'active' : ''}`} aria-pressed={value.includes(filter.id)} onClick={() => toggle(filter.id)}>{filter.label}</button>)}
    {value.length > 0 && <button type="button" className="text-button" onClick={() => onChange([])}>Clear</button>}
  </div>
}

export function StatusBadge({ status }: { status: VehicleRecord['status'] }) {
  const styles = status === 'Complete' ? 'status-complete' : 'status-attention'
  return <span className={`status-badge ${styles}`}><span className="status-dot" />{status}</span>
}
