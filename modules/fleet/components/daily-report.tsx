'use client'

import { getFleetReport } from '@/modules/fleet/actions'
import { formatFleetReport, formatReportDate, nairobiDate, type FleetReport } from '@/modules/fleet/report'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

const DEFINITIONS = [
  ['Total active bikes/loans', 'Activated on or before the report date, and not repossessed on or before that date.'],
  ['Last 30 days active Fleet', 'Bikes with a ride, kilometres, app mileage, or earnings on any of the 30 days ending on the report date.'],
  ['Fleet ratio', 'Last 30 days active fleet divided by total active bikes.'],
  ['Yesterday active Fleet', 'Bikes that worked on the report date. The report calls that date yesterday.'],
  ['Branded bikes', 'Active bikes marked branded.'],
  ['New Fleet accounts', 'Bikes activated on the report date.'],
  ['Repossessed fleet units', 'Bikes whose repossession date is the report date.'],
  ['Mileage', 'Sum of mileage kilometres. Current month runs from the 1st through the report date.'],
  ['Net earnings', 'Sum of net earnings on the report date.'],
  ['Fleet utilization', 'Bikes active that day divided by the fleet active in the 30 days ending that day. Last month is the average of those daily ratios.'],
  ['Rides completed', 'Sum of rides on the report date.'],
  ['Average mileage on app', 'Average of the app mileage recorded for each working bike. Last month uses the previous calendar month.'],
  ['Average daily net earning', 'Net earnings divided by bikes active on the report date.'],
  ['Median net earnings', 'The middle net earning among bikes that worked on the report date.'],
] as const

export function DailyReportView() {
  const [date, setDate] = useState(nairobiDate(-1))
  const [report, setReport] = useState<FleetReport | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setReport(null)
    setCopied(false)
    getFleetReport(date).then(setReport).catch((err) => setError(err instanceof Error ? err.message : 'Could not generate the report.'))
  }, [date])

  const text = report ? formatFleetReport(report) : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the report text and copy it.')
    }
  }

  return (
    <div className="view-stack">
      <section className="panel report-panel">
        <div className="panel-heading">
          <div>
            <h2>Fleet department daily report</h2>
            <p>Choose the day the report covers. {report ? `Generated for ${formatReportDate(report.date)}.` : 'Generating the report.'}</p>
          </div>
          <div className="heading-actions">
            <label className="field-label">Report date<input className="assign-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
            <button type="button" className="button primary" onClick={copy} disabled={!text}><Copy size={16} /> {copied ? 'Copied' : 'Copy report'}</button>
          </div>
        </div>
        {error ? <div className="auth-error" style={{ margin: '0 22px 18px' }}>{error}</div> : null}
        {text ? <pre className="report-sheet">{text}</pre> : <p className="empty-row">Preparing the report.</p>}
        {copied ? <p className="report-copied"><Check size={14} /> Copied. Paste it into the fleet message.</p> : null}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>How each line is calculated</h2><p>The report uses the bike register and the activity rows. It does not read STOCK DOCUMENTS.</p></div></div>
        <dl className="report-definitions">
          {DEFINITIONS.map(([title, detail]) => <div key={title}><dt>{title}</dt><dd>{detail}</dd></div>)}
        </dl>
      </section>
    </div>
  )
}
