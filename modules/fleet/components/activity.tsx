'use client'

import { importFleetActivity, listFleetActivity, saveFleetActivity } from '@/modules/fleet/actions'
import { nairobiDate } from '@/modules/fleet/report'
import { FormEvent, useEffect, useState } from 'react'

type Activity = Awaited<ReturnType<typeof listFleetActivity>>[number]

export function ActivityView() {
  const [date, setDate] = useState(nairobiDate(-1))
  const [rows, setRows] = useState<Activity[]>([])
  const [plate, setPlate] = useState('')
  const [rides, setRides] = useState('0')
  const [mileageKm, setMileageKm] = useState('0')
  const [appMileageKm, setAppMileageKm] = useState('')
  const [netEarnings, setNetEarnings] = useState('0')
  const [csv, setCsv] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload(next = date) {
    setRows(await listFleetActivity(next))
  }

  useEffect(() => {
    reload(date).catch((err) => setError(err instanceof Error ? err.message : 'Could not load activity.'))
  }, [date])

  async function onSave(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await saveFleetActivity({
        plate,
        date,
        rides: Number(rides),
        mileageKm: Number(mileageKm),
        appMileageKm: appMileageKm.trim() ? Number(appMileageKm) : null,
        netEarnings: Number(netEarnings),
      })
      setPlate('')
      setMessage('Activity saved.')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save activity.')
    } finally {
      setBusy(false)
    }
  }

  async function onImport() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await importFleetActivity(csv)
      setMessage(`Saved ${result.saved} activity row${result.saved === 1 ? '' : 's'}.${result.errors.length ? ` ${result.errors.join(' ')}` : ''}`)
      if (result.saved) setCsv('')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import activity.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Daily activity</h2>
            <p>A bike counts as active on a day when it has a ride, kilometres, app mileage, or earnings. Add the bike under Bikes before recording its day.</p>
          </div>
          <label className="field-label">Date<input className="assign-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </div>
        <form className="fleet-form" onSubmit={onSave}>
          <label className="field-label">Registration<input className="assign-input" value={plate} onChange={(event) => setPlate(event.target.value)} placeholder="KDA482M" required /></label>
          <label className="field-label">Rides<input className="assign-input" type="number" min={0} value={rides} onChange={(event) => setRides(event.target.value)} /></label>
          <label className="field-label">Mileage km<input className="assign-input" type="number" min={0} step="0.1" value={mileageKm} onChange={(event) => setMileageKm(event.target.value)} /></label>
          <label className="field-label">App mileage km<input className="assign-input" type="number" min={0} step="0.1" value={appMileageKm} onChange={(event) => setAppMileageKm(event.target.value)} placeholder="Optional" /></label>
          <label className="field-label">Net earnings KES<input className="assign-input" type="number" min={0} value={netEarnings} onChange={(event) => setNetEarnings(event.target.value)} /></label>
          <button className="button primary" type="submit" disabled={busy}>Save day</button>
        </form>
        <div className="fleet-import">
          <label className="field-label">Import activity<textarea className="assign-input fleet-csv" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder={'plate, date, rides, mileage km, app mileage km, net earnings\nKDA482M, 2026-10-15, 4, 48.2, 6.7, 1400'} /></label>
          <button className="button secondary" type="button" onClick={onImport} disabled={busy || !csv.trim()}>Import</button>
        </div>
        {message ? <div className="success-banner">{message}</div> : null}
        {error ? <div className="auth-error" style={{ margin: '0 22px 18px' }}>{error}</div> : null}
      </section>
      <section className="panel table-panel">
        <div className="panel-heading"><div><h2>Recorded on this date <span className="count-pill">{rows.length}</span></h2></div></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Registration</th><th>Rides</th><th>Mileage km</th><th>App km</th><th>Net earnings</th></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr className="empty-row-tr"><td colSpan={5}>No activity on this date.</td></tr> : rows.map((row) => (
                <tr key={row.id}>
                  <td><strong className="plate-id">{row.plate}</strong></td>
                  <td>{row.rides}</td>
                  <td>{row.mileageKm}</td>
                  <td>{row.appMileageKm ?? '—'}</td>
                  <td>{row.netEarnings.toLocaleString('en-KE')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
