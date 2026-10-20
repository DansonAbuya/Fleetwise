'use client'

import { useState } from 'react'
import type { DuplicateFile } from '@/lib/types'
import { labelFor, splitUnmatched, surplusGroups, type UnmatchedKind } from '@/modules/stock/model'

export function DuplicatesView({ files }: { files: DuplicateFile[] }) {
  const [category, setCategory] = useState<UnmatchedKind>('all')
  const split = splitUnmatched(files)
  const visible = category === 'all' ? files : files.filter((file) => file.type === category)
  const groups = surplusGroups(visible)
  return <section className="panel table-panel standalone">
    <div className="panel-heading">
      <div>
        <h2>Duplicates <span className="count-pill">{files.length}</span></h2>
        <p>{files.length ? `${split.photos.length} extra photo${split.photos.length === 1 ? '' : 's'} · ${split.insurance.length} extra insurance · ${split.logbooks.length} extra logbook${split.logbooks.length === 1 ? '' : 's'}` : 'No extra files.'} A registration number appears here only when it has more than one logbook, insurance file, or photo. Three logbooks show as one matched file and two extras. The matched file is not a duplicate.</p>
      </div>
    </div>
    <div className="unmatched-filters" role="tablist" aria-label="Duplicate file type">
      <button type="button" className={`filter-chip ${category === 'all' ? 'active' : ''}`} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All {files.length}</button>
      <button type="button" className={`filter-chip ${category === 'photo' ? 'active' : ''}`} aria-pressed={category === 'photo'} onClick={() => setCategory('photo')}>Photos {split.photos.length}</button>
      <button type="button" className={`filter-chip ${category === 'certificate' ? 'active' : ''}`} aria-pressed={category === 'certificate'} onClick={() => setCategory('certificate')}>Insurance {split.insurance.length}</button>
      <button type="button" className={`filter-chip ${category === 'logbook' ? 'active' : ''}`} aria-pressed={category === 'logbook'} onClick={() => setCategory('logbook')}>Logbooks {split.logbooks.length}</button>
    </div>
    <div className="duplicate-list">
      {groups.length === 0 ? <div className="empty-row">Nothing to show. This list stays empty until one registration number has two or more logbooks, insurance files, or photos, and one of them is the file linked on STOCK DOCUMENTS.</div> : groups.map((group) => (
        <article className="duplicate-card" key={group.key}>
          <header className="duplicate-card-head">
            <strong>{group.plate || 'No plate'}</strong>
            <span>{labelFor(group.type)}</span>
          </header>
          <div className="duplicate-pair">
            <div className="duplicate-side uploaded">
              <span className="eyebrow">Matched on the sheet</span>
              <strong>{group.uploadedName}</strong>
              {group.uploadedLink && <a href={group.uploadedLink} target="_blank" rel="noreferrer">Open matched file</a>}
            </div>
            <div className="duplicate-side surplus">
              <span className="eyebrow">Extra {group.surplus.length === 1 ? 'file' : 'files'} · not the sheet match</span>
              {group.surplus.map((file) => (
                <div className="surplus-file" key={file.id}>
                  <strong>{file.name}</strong>
                  {file.webViewLink && <a href={file.webViewLink} target="_blank" rel="noreferrer">Open extra file</a>}
                </div>
              ))}
            </div>
          </div>
        </article>
      ))}
    </div>
  </section>
}
