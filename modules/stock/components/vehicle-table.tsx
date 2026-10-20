'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { coverAlertLabel, formatCoverDate } from '@/lib/insurance'
import type { VehicleRecord } from '@/lib/types'
import { pageNumbers } from '@/modules/stock/model'
import { StatusBadge } from '@/modules/stock/components/filters'

export function VehicleTable({ vehicles, total, page, pageSize, pageSizes, loading, onPageChange, onPageSizeChange, onSelect }: { vehicles: VehicleRecord[]; total: number; page: number; pageSize: number; pageSizes?: number[]; loading?: boolean; onPageChange?: (page: number) => void; onPageSizeChange?: (size: number) => void; onSelect: (vehicle: VehicleRecord) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(page * pageSize, total)
  return <div>
    <div className="table-scroll"><table><thead><tr><th>Vehicle</th><th>Brand</th><th>Logbook</th><th>Agreement</th><th>Certificate</th><th>Commencement</th><th>Expiry</th><th>Photo</th><th>Collateral</th><th>Status</th><th>Last updated</th></tr></thead><tbody>{loading ? Array.from({ length: Math.min(pageSize, 8) }, (_, index) => <tr className="skeleton-table-row" key={index}><td colSpan={11}><span className="skeleton-bone bone-row" /></td></tr>) : !vehicles.length ? <tr className="empty-row-tr"><td colSpan={11}>No plates found in the configured folders yet.</td></tr> : vehicles.map((vehicle) => <tr key={vehicle.plate} onClick={() => onSelect(vehicle)}><td><strong className="plate-id">{vehicle.plate}</strong><span className="muted-cell">{vehicle.present} / {vehicle.total} documents</span></td><td>{vehicle.brand || '—'}</td><td className={vehicle.files.logbook.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.logbook.length ? 'Yes' : 'Missing'}</td><td className={vehicle.agreement ? 'cell-yes' : 'cell-no'}>{vehicle.agreement ? 'Yes' : 'Missing'}</td><td className={vehicle.files.certificate.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.certificate.length ? 'Yes' : 'Missing'}</td><td className="cell-cover">{formatCoverDate(vehicle.insurance?.commencement)}</td><td className={`cell-cover ${vehicle.insurance?.alert ? `cover-${vehicle.insurance.alert}` : ''}`}>{formatCoverDate(vehicle.insurance?.expiry)}{vehicle.insurance?.alert ? <span className={`cover-flag ${vehicle.insurance.alert}`}>{coverAlertLabel(vehicle.insurance)}</span> : null}</td><td className={vehicle.files.photo.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.photo.length ? 'Yes' : 'Missing'}</td><td className={vehicle.collateral ? 'cell-yes' : 'cell-no'}>{vehicle.collateral ? 'Yes' : 'Missing'}</td><td><StatusBadge status={vehicle.status} /></td><td className="muted-cell">{vehicle.updated}</td></tr>)}</tbody></table></div>
    {total > 0 && <div className="table-pagination">
      <span className="table-pagination-meta">Showing {from}–{to} of {total}</span>
      {pageSizes && pageSizes.length > 1 && <label className="field-label table-page-size">Rows<select className="assign-input" value={pageSize} onChange={(e) => onPageSizeChange?.(Number(e.target.value))} aria-label="Rows per page">{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
      <div className="table-pagination-controls">
        <button type="button" className="button secondary pagination-nav" onClick={() => onPageChange?.(Math.max(1, page - 1))} disabled={page <= 1 || !onPageChange} aria-label="Previous page"><ChevronLeft size={16} /> Previous</button>
        {pageNumbers(page, totalPages).map((item, index) => item === '…' ? <span key={`gap-${index}`} className="pagination-gap">…</span> : <button type="button" key={item} className={`pagination-page ${page === item ? 'active' : ''}`} onClick={() => onPageChange?.(item)} aria-current={page === item ? 'page' : undefined}>{item}</button>)}
        <button type="button" className="button secondary pagination-nav" onClick={() => onPageChange?.(Math.min(totalPages, page + 1))} disabled={page >= totalPages || !onPageChange} aria-label="Next page">Next <ChevronRight size={16} /></button>
      </div>
    </div>}
  </div>
}
