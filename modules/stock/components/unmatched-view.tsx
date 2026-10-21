'use client'

import { useState } from 'react'
import { FileText, ScanLine } from 'lucide-react'
import { parseKenyanPlate } from '@/lib/plates'
import type { DocType, TypedFile } from '@/lib/types'
import { isPhotoFile, labelFor, splitUnmatched, unmatchedSplitLabel, type UnmatchedKind } from '@/modules/stock/model'

export function UnmatchedView({ files, category, onCategory, busy, ocrConfigured, onAssign, onAssignMany, onOcr }: {
  files: TypedFile[]
  category: UnmatchedKind
  onCategory: (kind: UnmatchedKind) => void
  busy: boolean
  ocrConfigured: boolean
  onAssign: (input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) => Promise<void> | void
  onAssignMany: (inputs: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }[]) => Promise<void> | void
  onOcr: (fileId?: string) => Promise<void> | void
}) {
  const [drafts, setDrafts] = useState<Record<string, { plate: string; type: DocType }>>({})
  const [rowError, setRowError] = useState('')
  const [busyId, setBusyId] = useState('')
  const split = splitUnmatched(files)
  const groups = [
    { id: 'photo' as const, title: 'Photos', empty: 'No unmatched photos.', items: split.photos },
    { id: 'certificate' as const, title: 'Insurance', empty: 'No unmatched insurance files.', items: split.insurance },
    { id: 'logbook' as const, title: 'Logbooks', empty: 'No unmatched logbooks.', items: split.logbooks },
    { id: 'agreement' as const, title: 'Agreements', empty: 'No unmatched agreements.', items: split.agreements },
  ]
  const visible = category === 'all' ? groups : groups.filter((group) => group.id === category)
  const readableCount = files.filter((file) => isPhotoFile(file) || file.type === 'certificate' || file.type === 'logbook').length
  const queued = files.flatMap((item) => {
    const draft = drafts[item.id] || { plate: '', type: item.type }
    if (!draft.plate.trim()) return []
    return [{ fileId: item.id, plate: draft.plate, type: draft.type, currentType: item.type, name: item.name }]
  })

  function updateDraft(id: string, patch: Partial<{ plate: string; type: DocType }>, fallbackType: DocType) {
    setDrafts((current) => {
      const draft = current[id] || { plate: '', type: fallbackType }
      return { ...current, [id]: { ...draft, ...patch } }
    })
  }

  async function assignQueued() {
    if (!queued.length) {
      setRowError('Type registration numbers on the files you want, then assign them together.')
      return
    }
    const invalid = queued.filter((item) => !parseKenyanPlate(item.plate))
    if (invalid.length) {
      setRowError(`Not a Kenyan registration number: ${invalid.map((item) => item.name).join(', ')}. Example KMHE520A.`)
      return
    }
    setRowError('')
    setBusyId('batch')
    try {
      await onAssignMany(queued)
      const assigned = new Set(queued.map((item) => item.fileId))
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !assigned.has(id))))
    } finally {
      setBusyId('')
    }
  }

  return <section className="panel table-panel standalone">
    <div className="panel-heading">
      <div>
        <h2>Unmatched documents <span className="count-pill">{files.length}</span></h2>
        <p>{files.length ? unmatchedSplitLabel(files) : 'No unmatched files in the Drive folders.'} These are folder files not yet matched to a Registration Number on STOCK DOCUMENTS. Type plates, then assign them together. Files stay in their type folder as Photos KMHE520A, Insurance - KMHE520A, KMHE520A - Logbook, or KMHE520A - Agreement.</p>
      </div>
      <div className="heading-actions">
        {readableCount > 0 && <button className="button secondary" disabled={busy || busyId === 'batch' || !ocrConfigured} onClick={() => onOcr()}><ScanLine size={15} /> Read plates</button>}
        <button className="button primary" disabled={busy || Boolean(busyId) || !queued.length} onClick={() => void assignQueued()}>
          {busyId === 'batch' ? 'Assigning…' : queued.length ? `Assign ${queued.length}` : 'Assign all'}
        </button>
      </div>
    </div>
    <div className="unmatched-filters" role="tablist" aria-label="Unmatched file type">
      <button type="button" className={`filter-chip ${category === 'all' ? 'active' : ''}`} aria-pressed={category === 'all'} onClick={() => onCategory('all')}>All {files.length}</button>
      <button type="button" className={`filter-chip ${category === 'photo' ? 'active' : ''}`} aria-pressed={category === 'photo'} onClick={() => onCategory('photo')}>Photos {split.photos.length}</button>
      <button type="button" className={`filter-chip ${category === 'certificate' ? 'active' : ''}`} aria-pressed={category === 'certificate'} onClick={() => onCategory('certificate')}>Insurance {split.insurance.length}</button>
      <button type="button" className={`filter-chip ${category === 'logbook' ? 'active' : ''}`} aria-pressed={category === 'logbook'} onClick={() => onCategory('logbook')}>Logbooks {split.logbooks.length}</button>
      <button type="button" className={`filter-chip ${category === 'agreement' ? 'active' : ''}`} aria-pressed={category === 'agreement'} onClick={() => onCategory('agreement')}>Agreements {split.agreements.length}</button>
    </div>
    {!ocrConfigured && readableCount > 0 && <div className="auth-error" style={{ margin: '0 21px 12px' }}>OCR is not ready. Restart the app.</div>}
    {rowError && <div className="auth-error" style={{ margin: '0 21px 12px' }}>{rowError}</div>}
    {visible.map((group) => (
      <div className="unmatched-group" key={group.id}>
        <div className="unmatched-group-head">
          <h3>{group.title} <span className="count-pill">{group.items.length}</span></h3>
        </div>
        <div className="unmatched-list">
          {group.items.length === 0 ? <div className="empty-row">{group.empty}</div> : group.items.map((item) => {
            const draft = drafts[item.id] || { plate: '', type: item.type }
            return <div className="unmatched-row" key={item.id}>
              <div className="file-icon"><FileText size={18} /></div>
              <div className="file-info"><strong>{item.name}</strong><span>{labelFor(item.type)}</span></div>
              <label className="field-label">Plate<input className="assign-input" placeholder="KDA 482M" value={draft.plate} onChange={(e) => updateDraft(item.id, { plate: e.target.value }, item.type)} /></label>
              <label className="field-label">Type<select className="assign-input" value={draft.type} onChange={(e) => updateDraft(item.id, { type: e.target.value as DocType }, item.type)}><option value="logbook">Logbook</option><option value="agreement">Agreement</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>
              {(isPhotoFile(item) || item.type === 'certificate' || item.type === 'logbook') && <button className="button secondary" disabled={busy || Boolean(busyId) || !ocrConfigured} onClick={async () => { setRowError(''); setBusyId(item.id); try { await onOcr(item.id) } finally { setBusyId('') } }}>{busyId === item.id ? 'Reading…' : 'Read plate'}</button>}
              <button className="button secondary" disabled={busy || Boolean(busyId)} onClick={async () => {
                if (!draft.plate.trim()) { setRowError('Enter a registration plate.'); return }
                if (!parseKenyanPlate(draft.plate)) { setRowError(`Not a Kenyan registration number for ${item.name}. Example KMHE520A.`); return }
                setRowError('')
                setBusyId(item.id)
                try {
                  await onAssign({ fileId: item.id, plate: draft.plate, type: draft.type, currentType: item.type, name: item.name })
                  setDrafts((current) => { const next = { ...current }; delete next[item.id]; return next })
                } finally {
                  setBusyId('')
                }
              }}>{busyId === item.id ? 'Assigning…' : 'Assign'}</button>
            </div>
          })}
        </div>
      </div>
    ))}
  </section>
}
