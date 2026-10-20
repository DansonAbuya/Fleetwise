'use client'

import { importFleetBikes, listFleetBikes, saveFleetBike } from '@/modules/fleet/actions'
import { FormEvent, useEffect, useState } from 'react'

type Bike = Awaited<ReturnType<typeof listFleetBikes>>[number]

export function BikesView() {
  const [bikes, setBikes] = useState<Bike[]>([])
  const [plate, setPlate] = useState('')
  const [branded, setBranded] = useState(false)
  const [activatedOn, setActivatedOn] = useState('')
  const [repossessedOn, setRepossessedOn] = useState('')
  const [csv, setCsv] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload() {
    setBikes(await listFleetBikes())
  }

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : 'Could not load bikes.'))
  }, [])

  async function onSave(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await saveFleetBike({ plate, branded, activatedOn, repossessedOn })
      setPlate('')
      setRepossessedOn('')
      setMessage('Bike saved.')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the bike.')
    } finally {
      setBusy(false)
    }
  }

  async function onImport() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await importFleetBikes(csv)
      setMessage(`Saved ${result.saved} bike${result.saved === 1 ? '' : 's'}.${result.errors.length ? ` ${result.errors.join(' ')}` : ''}`)
      if (result.saved) setCsv('')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import bikes.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Bike register</h2>
            <p>A bike stays in the active book from its activation date until the day it is repossessed. Branded bikes are counted separately.</p>
          </div>
        </div>
        <form className="fleet-form" onSubmit={onSave}>
          <label className="field-label">Registration<input className="assign-input" value={plate} onChange={(event) => setPlate(event.target.value)} placeholder="KDA482M" required /></label>
          <label className="field-label">Activated<input className="assign-input" type="date" value={activatedOn} onChange={(event) => setActivatedOn(event.target.value)} required /></label>
          <label className="field-label">Repossessed<input className="assign-input" type="date" value={repossessedOn} onChange={(event) => setRepossessedOn(event.target.value)} /></label>
          <label className="check-label"><input type="checkbox" checked={branded} onChange={(event) => setBranded(event.target.checked)} /> Branded</label>
          <button className="button primary" type="submit" disabled={busy}>Save bike</button>
        </form>
        <div className="fleet-import">
          <label className="field-label">Import bikes<textarea className="assign-input fleet-csv" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder={'plate, branded, activated, repossessed\nKDA482M, yes, 2024-01-15,'} /></label>
          <button className="button secondary" type="button" onClick={onImport} disabled={busy || !csv.trim()}>Import</button>
        </div>
        {message ? <div className="success-banner">{message}</div> : null}
        {error ? <div className="auth-error" style={{ margin: '0 22px 18px' }}>{error}</div> : null}
      </section>
      <section className="panel table-panel">
        <div className="panel-heading"><div><h2>Bikes <span className="count-pill">{bikes.length}</span></h2><p>Active means activated and not yet repossessed.</p></div></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Registration</th><th>Branded</th><th>Activated</th><th>Repossessed</th></tr></thead>
            <tbody>
              {bikes.length === 0 ? <tr className="empty-row-tr"><td colSpan={4}>No bikes yet.</td></tr> : bikes.map((bike) => (
                <tr key={bike.id}>
                  <td><strong className="plate-id">{bike.plate}</strong></td>
                  <td>{bike.branded ? 'Yes' : 'No'}</td>
                  <td>{bike.activatedOn}</td>
                  <td>{bike.repossessedOn || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
