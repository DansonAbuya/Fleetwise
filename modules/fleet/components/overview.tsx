'use client'

import { formatFleetReport, formatReportDate, nairobiDate, type FleetReport } from '@/modules/fleet/report'
import { getFleetReport } from '@/modules/fleet/actions'
import { useEffect, useState } from 'react'

export function FleetOverview({ onOpenReport }: { onOpenReport: () => void }) {
  const [report, setReport] = useState<FleetReport | null>(null)
  const [error, setError] = useState('')
  const date = nairobiDate(-1)

  useEffect(() => {
    getFleetReport(date).then(setReport).catch((err) => setError(err instanceof Error ? err.message : 'Could not load the report.'))
  }, [date])

  return (
    <section className="panel report-panel">
      <div className="panel-heading">
        <div>
          <h2>Fleet department daily report</h2>
          <p>Figures for {formatReportDate(date)}, calculated from the bike register and each bike’s activity.</p>
        </div>
        <button type="button" className="button primary" onClick={onOpenReport}>Open full report</button>
      </div>
      {error ? <div className="auth-error" style={{ margin: '0 22px 18px' }}>{error}</div> : null}
      {report ? <pre className="report-sheet">{formatFleetReport(report)}</pre> : <p className="empty-row">Preparing yesterday’s report.</p>}
    </section>
  )
}
