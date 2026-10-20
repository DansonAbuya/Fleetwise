'use client'

import { useState } from 'react'
import { FileText, Image as ImageIcon, LoaderCircle, Mail, Play, RefreshCw, ScanLine, Square } from 'lucide-react'
import { processFocusLabel, type ProcessFocus } from '@/lib/process-focus'
import type { ProcessJob } from '@/lib/processing'
import type { DocType, FleetSnapshot, TypedFile } from '@/lib/types'
import { labelFor, PROCESS_TASKS, unmatchedSplitLabel } from '@/modules/stock/model'

export const PROCESS_STEPS = ['queued', 'opening', 'reading', 'renaming', 'matching', 'matched'] as const

export function processStageLabel(stage: string, plate?: string | null, detail?: string) {
  if (stage === 'queued') return 'Queued'
  if (stage === 'opening') return 'Opening'
  if (stage === 'reading') return 'Reading plate'
  if (stage === 'renaming') return 'Renaming'
  if (stage === 'matching') return 'Matching sheet'
  if (stage === 'matched') return 'Matched'
  if (stage === 'unmatched') {
    if (!plate) return 'Needs a plate'
    if (/not linked/i.test(detail || '')) return 'Not linked'
    return 'Not on register'
  }
  if (stage === 'error') return 'Could not process'
  return stage
}

export function ProcessThumb({ item }: { item: { fileId: string; name: string; preview: boolean; type: DocType; stage?: string } }) {
  const [broken, setBroken] = useState(false)
  const showPreview = item.preview && !broken && (item.stage === 'opening' || item.stage === 'reading' || item.stage === 'renaming' || item.stage === 'matching')
  if (showPreview) {
    return <img className="process-thumb-img" src={`/documents/${item.fileId}?preview=1`} alt={item.name} onError={() => setBroken(true)} />
  }
  return item.type === 'photo' ? <ImageIcon size={22} /> : <FileText size={22} />
}

export function ProcessingView({ lastSync, vehicles, unmatched, busy, configured, ocrConfigured, ingest, job, photosFolder, certificatesFolder, logbooksFolder, agreementsFolder, onScan, onGmail, onOcr, onStart, onStop, onLinkSheet }: { lastSync?: string; vehicles: number; unmatched: TypedFile[]; busy: boolean; configured: boolean; ocrConfigured: boolean; ingest?: FleetSnapshot['ingest']; job: ProcessJob | null; photosFolder?: string; certificatesFolder?: string; logbooksFolder?: string; agreementsFolder?: string; onScan: () => void; onGmail: () => void; onOcr: () => void; onStart: (focus: ProcessFocus) => void | Promise<void>; onStop: () => void | Promise<void>; onLinkSheet: (type: 'photo' | 'certificate' | 'logbook') => void | Promise<void> }) {
  const percent = job?.attempted ? Math.round((job.done / job.attempted) * 100) : 0
  const liveItems: ProcessJob['items'] = []
  const liveIds = new Set<string>()
  for (const item of job?.items || []) {
    if (liveIds.has(item.fileId)) continue
    liveIds.add(item.fileId)
    liveItems.push(item)
  }
  const waitingIds = new Set<string>()
  const waiting = unmatched.filter((file) => {
    if (liveIds.has(file.id) || waitingIds.has(file.id)) return false
    waitingIds.add(file.id)
    return true
  })
  const advancing = Boolean(job?.advancing || (!job?.running && ingest?.more))
  const live = Boolean(job?.running || advancing)
  const batch = job?.batch || 1
  const remaining = job?.remaining || ingest?.remaining || waiting.length
  const last = job?.lastAction || ingest?.lastAction
  const focusLabel = processFocusLabel(job?.focus || ingest?.focus || last?.focus)
  const lastWhen = last?.at ? new Date(last.at).toLocaleString() : ''
  return <div className="view-stack">
    <section className="panel process-hero">
      <div className="batch-percent">{percent}<span>%</span></div>
      <div><span className="eyebrow">{advancing ? 'NEXT BATCH' : job?.running ? `LIVE · ${focusLabel.toUpperCase()} · BATCH ${batch}` : last?.status === 'paused' ? 'PAUSED' : 'CHOOSE A JOB'}</span>
        <h2>{advancing ? `Batch ${batch} of ${focusLabel} finished — starting the next files` : job?.running ? `Reading ${focusLabel.toLowerCase()} · batch ${batch}` : last?.fileName ? `Resume from ${last.fileName}` : 'Pick what to process first'}</h2>
        <p>{advancing
          ? `${job?.lastRenamed ?? ingest?.renamed ?? 0} file(s) renamed in batch ${batch}. The next ${focusLabel.toLowerCase()} batch is starting now${remaining ? ` · ${remaining} still need a plate` : ''}.`
          : live
            ? `Running ${focusLabel.toLowerCase()}. Stop to pause; start the same job later to continue from the last file.`
            : last?.fileName
              ? `Last action: ${processFocusLabel(last.focus)} · ${last.fileName}${last.plate ? ` · ${last.plate}` : ''}${lastWhen ? ` · ${lastWhen}` : ''}. Start that job to continue from this point.`
              : `Start photos, insurance, logbooks, agreements, all waiting files, or a fix-wrong job. Stop pauses the job; starting the same one continues from the last file. Photos: ${photosFolder || 'not set'}. Insurance: ${certificatesFolder || 'not set'}. Logbooks: ${logbooksFolder || 'not set'}. Agreements: ${agreementsFolder || 'not set'}.`}</p>
      </div>
      {advancing && <div className="process-advance" role="status"><LoaderCircle size={16} className="spin-icon" /> Ending batch {batch} and opening the next {remaining ? `${Math.min(10, remaining)} of ${remaining}` : 'files'}.</div>}
      <div className="process-tasks" role="group" aria-label="Processing jobs">
        {PROCESS_TASKS.map((task) => {
          const current = (job?.focus || ingest?.focus) === task.id && live
          return <button key={task.id} type="button" className={`process-task ${current ? 'active' : ''}`} disabled={!configured || !ocrConfigured || (busy && !live) || current} onClick={() => onStart(task.id)}>
            <strong>{task.label}</strong>
            <span>{task.detail}</span>
            {current ? <em>Running</em> : last?.focus === task.id && last.status === 'paused' ? <em><Play size={12} /> Continue</em> : <em><Play size={12} /> Start</em>}
          </button>
        })}
      </div>
      <div className="big-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      <div className="process-stats"><span><strong>{vehicles}</strong> vehicles</span><span><strong>{unmatched.length}</strong> unmatched · {unmatchedSplitLabel(unmatched)}</span><span><strong>{job?.running ? `${job.done}/${job.attempted}` : lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</strong> {job?.running ? 'finished' : 'last sync'}</span></div>
      <div className="heading-actions" style={{ marginTop: 18 }}>
        <button className="button primary" onClick={onStop} disabled={!live && !job?.running}><Square size={15} /> Stop</button>
        <button className="button secondary" onClick={onScan} disabled={busy || !configured}><RefreshCw size={15} /> Scan folders</button>
        <button className="button secondary" onClick={onGmail} disabled={busy || !configured}><Mail size={15} /> Check inboxes</button>
        <button className="button secondary" onClick={onOcr} disabled={busy || !configured || !ocrConfigured}><ScanLine size={15} /> Read plates</button>
      </div>
      <div className="process-tasks" role="group" aria-label="Link documents onto the sheet">
        <button type="button" className="process-task" onClick={() => onLinkSheet('certificate')} disabled={busy || live || !configured}>
          <strong>Link all insurance</strong>
          <span>Write every insurance file that is not on its STOCK DOCUMENTS row yet. Rows that already have insurance are left alone.</span>
          <em>Link all</em>
        </button>
        <button type="button" className="process-task" onClick={() => onLinkSheet('logbook')} disabled={busy || live || !configured}>
          <strong>Link all logbooks</strong>
          <span>Write every logbook that is not on its STOCK DOCUMENTS row yet. Rows that already have a logbook are left alone.</span>
          <em>Link all</em>
        </button>
        <button type="button" className="process-task" onClick={() => onLinkSheet('photo')} disabled={busy || live || !configured}>
          <strong>Link all photos</strong>
          <span>Write every photo that is not on its STOCK DOCUMENTS row yet. Rows that already have a photo are left alone.</span>
          <em>Link all</em>
        </button>
      </div>
    </section>
    <section className="panel table-panel standalone">
      <div className="panel-heading"><div><h2>{advancing ? `Starting batch ${(job?.batch || 1) + 1}` : job?.running ? `Now processing · batch ${batch}` : 'Processing queue'} {(job?.items.length || waiting.length) ? <span className="count-pill">{(job?.items.length || 0) + waiting.length}</span> : null}</h2><p>{advancing ? 'This batch is complete. The next files are being opened, read, and matched.' : job?.running ? 'Each card updates as the file is opened, read, renamed, and matched. The next batch starts when this one finishes.' : 'Drop files in the photos, insurance, logbooks, or agreements folders, then watch them here until they match a Registration Number.'}</p></div>{job?.running ? <span className="live-pill"><LoaderCircle size={14} className="spin-icon" /> Live</span> : advancing ? <span className="live-pill"><LoaderCircle size={14} className="spin-icon" /> Next batch</span> : ingest?.more ? <span className="live-pill">Next batch</span> : null}</div>
      <div className="process-board">
        {(!job?.items.length && waiting.length === 0) ? <div className="empty-row">No files in the live queue. New photos, certificates, logbooks, and agreements appear here as they are processed.</div> : null}
        {liveItems.map((item) => {
          const stepIndex = PROCESS_STEPS.indexOf(item.stage as typeof PROCESS_STEPS[number])
          return <article className={`process-card stage-${item.stage}`} key={item.fileId}>
            <div className={`process-thumb ${item.stage === 'opening' || item.stage === 'reading' ? 'working' : ''}`}><ProcessThumb item={item} /></div>
            <div className="process-card-copy">
              <strong>{item.name}</strong>
              <span>{labelFor(item.type)}{item.plate ? ` · ${item.plate}` : ''}</span>
              <p>{item.detail}</p>
              <ol className="process-steps" aria-label="Processing steps">
                {PROCESS_STEPS.map((step, index) => {
                  const namedOffSheet = item.stage === 'unmatched' && Boolean(item.plate)
                  const failed = item.stage === 'error' || (item.stage === 'unmatched' && !item.plate)
                  const doneThrough = namedOffSheet ? PROCESS_STEPS.indexOf('matching') : stepIndex
                  const current = namedOffSheet ? step === 'matching' : stepIndex === index && item.stage !== 'matched'
                  const done = failed ? index === 0 : doneThrough >= index && !current
                  return <li key={step} className={failed ? (index === 0 ? 'is-done' : '') : current ? 'is-current' : done ? 'is-done' : ''}>{processStageLabel(step === 'matched' ? 'matched' : step)}</li>
                })}
              </ol>
            </div>
            <span className={`process-flag stage-${item.stage}`}>{item.stage === 'opening' || item.stage === 'reading' || item.stage === 'renaming' || item.stage === 'matching' ? <LoaderCircle size={14} className="spin-icon" /> : null}{processStageLabel(item.stage, item.plate, item.detail)}</span>
          </article>
        })}
        {waiting.map((file) => <article className="process-card stage-unmatched" key={file.id}>
          <div className="process-thumb"><ProcessThumb item={{ fileId: file.id, name: file.name, preview: false, type: file.type }} /></div>
          <div className="process-card-copy"><strong>{file.name}</strong><span>{labelFor(file.type)}{file.plate ? ` · ${file.plate}` : ''}</span><p>Waiting to match a Registration Number. Use Read plates, or assign the plate under Unmatched.</p></div>
          <span className="process-flag stage-unmatched">Waiting</span>
        </article>)}
      </div>
    </section>
  </div>
}
