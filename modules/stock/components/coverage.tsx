'use client'

import type { FleetSnapshot } from '@/lib/types'
import { labelFor, shareParts, type MissingFilter } from '@/modules/stock/model'

export function Coverage({ stats, onSelect }: { stats?: FleetSnapshot['stats']; onSelect?: (item: MissingFilter) => void }) {
  const total = stats?.total || 0
  const rows: { key: MissingFilter; label: string; have: number }[] = [
    { key: 'logbook', label: labelFor('logbook'), have: stats?.logbook || 0 },
    { key: 'agreement', label: 'Agreements', have: stats?.agreement || 0 },
    { key: 'certificate', label: labelFor('certificate'), have: stats?.certificate || 0 },
    { key: 'photo', label: labelFor('photo'), have: stats?.photo || 0 },
    { key: 'collateral', label: 'Collateral files', have: stats?.collateral || 0 },
  ]
  return <div className="coverage-list">{rows.map((row) => {
    const { complete, missing, completePct, missingPct } = shareParts(row.have, total)
    return <button type="button" className="coverage-row" key={row.key} onClick={() => onSelect?.(row.key)}>
      <span>{row.label}</span>
      <div className="coverage-track">
        <div className="big-progress coverage-bar" aria-hidden="true"><span style={{ width: `${completePct}%` }} /></div>
        <div className="coverage-counts">
          <span className="coverage-have">{complete} complete ({completePct}%)</span>
          <span className="coverage-miss">{missing} missing ({missingPct}%)</span>
        </div>
      </div>
    </button>
  })}</div>
}
