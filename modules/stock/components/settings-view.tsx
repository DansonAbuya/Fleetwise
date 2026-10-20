'use client'

import { useEffect, useState } from 'react'
import { Database, FileSpreadsheet, FileText, Mail, ScanLine } from 'lucide-react'
import { DEFAULT_COLLATERAL_PARENT_ID, type DriveItem, type FleetSnapshot } from '@/lib/types'
import { Drawer } from '@/modules/stock/components/drawer'

export function SettingsView({ fleet, firstRun, busy, onSave, onImportDatabase, onBrowse, onBrowseSheets }: { fleet: FleetSnapshot | null; firstRun: boolean; busy: boolean; onSave: (input: { logbooksId: string; certificatesId: string; photosId: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }) => void; onImportDatabase: () => void; onBrowse: (parentId?: string, query?: string) => Promise<DriveItem[]>; onBrowseSheets: () => Promise<DriveItem[]> }) {
  const [logbooks, setLogbooks] = useState({ id: fleet?.config?.logbooksId || '', name: fleet?.config?.logbooksName || '' })
  const [certificates, setCertificates] = useState({ id: fleet?.config?.certificatesId || '', name: fleet?.config?.certificatesName || '' })
  const [photos, setPhotos] = useState({ id: fleet?.config?.photosId || '', name: fleet?.config?.photosName || '' })
  const [agreements, setAgreements] = useState({ id: fleet?.config?.agreementsId || '', name: fleet?.config?.agreementsName || '' })
  const [collateral, setCollateral] = useState({ id: fleet?.config?.collateralId || DEFAULT_COLLATERAL_PARENT_ID, name: fleet?.config?.collateralName || 'Collateral parent folder' })
  const [spreadsheet, setSpreadsheet] = useState({ id: fleet?.config?.spreadsheetId || '', name: fleet?.config?.spreadsheetName || '' })
  const [threshold, setThreshold] = useState(fleet?.config?.autoUploadThreshold ?? 85)
  const [insuranceInboxEmail, setInsuranceInboxEmail] = useState(fleet?.config?.insuranceInboxEmail || '')
  const [logbooksInboxEmail, setLogbooksInboxEmail] = useState(fleet?.config?.logbooksInboxEmail || '')
  const [mailboxError, setMailboxError] = useState('')
  const [picker, setPicker] = useState<'logbook' | 'certificate' | 'photo' | 'agreement' | 'collateral' | null>(null)
  const [sheetPicker, setSheetPicker] = useState(false)
  const savedFolders = [
    fleet?.config?.logbooksId || '',
    fleet?.config?.certificatesId || '',
    fleet?.config?.photosId || '',
    fleet?.config?.agreementsId || '',
    fleet?.config?.collateralId || '',
    fleet?.config?.spreadsheetId || '',
    fleet?.config?.insuranceInboxEmail || '',
    fleet?.config?.logbooksInboxEmail || '',
  ].join('|')
  useEffect(() => {
    setLogbooks({ id: fleet?.config?.logbooksId || '', name: fleet?.config?.logbooksName || '' })
    setCertificates({ id: fleet?.config?.certificatesId || '', name: fleet?.config?.certificatesName || '' })
    setPhotos({ id: fleet?.config?.photosId || '', name: fleet?.config?.photosName || '' })
    setAgreements({ id: fleet?.config?.agreementsId || '', name: fleet?.config?.agreementsName || '' })
    setCollateral({ id: fleet?.config?.collateralId || DEFAULT_COLLATERAL_PARENT_ID, name: fleet?.config?.collateralName || 'Collateral parent folder' })
    setSpreadsheet({ id: fleet?.config?.spreadsheetId || '', name: fleet?.config?.spreadsheetName || '' })
    setThreshold(fleet?.config?.autoUploadThreshold ?? 85)
    setInsuranceInboxEmail(fleet?.config?.insuranceInboxEmail || '')
    setLogbooksInboxEmail(fleet?.config?.logbooksInboxEmail || '')
  }, [savedFolders])
  function saveSettings() {
    const insurance = insuranceInboxEmail.trim()
    const logbooksMail = logbooksInboxEmail.trim()
    const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    if (insurance && !looksLikeEmail(insurance)) {
      setMailboxError('Enter a valid insurance inbox email, or leave it blank.')
      return
    }
    if (logbooksMail && !looksLikeEmail(logbooksMail)) {
      setMailboxError('Enter a valid logbook inbox email, or leave it blank.')
      return
    }
    setMailboxError('')
    onSave({ logbooksId: logbooks.id, certificatesId: certificates.id, photosId: photos.id, agreementsId: agreements.id || undefined, collateralId: collateral.id, spreadsheetId: spreadsheet.id, autoUploadThreshold: threshold, insuranceInboxEmail: insurance, logbooksInboxEmail: logbooksMail })
  }
  return <div className="settings-grid">
    {firstRun && <section className="panel settings-card setup-hero"><div className="panel-heading"><div><h2>Set up Drive folders and Sheets</h2><p>Choose the logbooks, certificates, photos, and agreements folders, then add the insurance and logbook inbox emails. Fleetwise updates the STOCK DOCUMENTS tab on Fleet Assets or Fleet Assets - KE: Logbook / Agreement, Agreement Link, PSV Insurance, and Asset Photo.</p></div></div></section>}
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Drive folders</h2><p>Includes My Drive, folders shared with you, and Shared drives you can access.</p></div></div>
      <FolderRow label="Logbooks" name={logbooks.name} id={logbooks.id} onChoose={() => setPicker('logbook')} />
      <FolderRow label="Certificates" name={certificates.name} id={certificates.id} onChoose={() => setPicker('certificate')} />
      <FolderRow label="Photos" name={photos.name} id={photos.id} onChoose={() => setPicker('photo')} />
      <FolderRow label="Agreements" name={agreements.name} id={agreements.id} onChoose={() => setPicker('agreement')} />
      <FolderRow label="Collateral parent" name={collateral.name} id={collateral.id} onChoose={() => setPicker('collateral')} />
      <div className="setting-toggle"><div><strong>Auto-upload threshold</strong><span>Gmail attachments at or above this confidence are renamed and stored in the matching folder. Insurance uses Insurance - {'{plate}'}; logbooks use {'{plate}'} - Logbook; agreements use {'{plate}'} - Agreement.</span></div><label className="field-label">Percent<input className="assign-input" type="number" min={50} max={99} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label></div>
      <div style={{ padding: '0 21px 18px' }}><button className="button primary" onClick={saveSettings} disabled={busy || !logbooks.id || !certificates.id || !photos.id}>{busy ? 'Saving…' : 'Save configuration'}</button></div>
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Gmail inboxes</h2><p>Use two addresses — one for insurance certificates and one for logbooks. Check inboxes searches the signed-in Gmail account for attachments sent to those addresses, then downloads, renames, and uploads them to the matching Drive folder. They are chipped on STOCK DOCUMENTS when the plate is on the register.</p></div></div>
      <label className="field-label mailbox-field">Insurance inbox<input className="assign-input" type="email" value={insuranceInboxEmail} onChange={(e) => { setInsuranceInboxEmail(e.target.value); setMailboxError('') }} placeholder="insurance@company.co.ke" autoComplete="off" /></label>
      <label className="field-label mailbox-field">Logbook inbox<input className="assign-input" type="email" value={logbooksInboxEmail} onChange={(e) => { setLogbooksInboxEmail(e.target.value); setMailboxError('') }} placeholder="logbooks@company.co.ke" autoComplete="off" /></label>
      {mailboxError ? <div className="auth-error" style={{ margin: '0 21px 12px' }}>{mailboxError}</div> : null}
      <div style={{ padding: '0 21px 18px' }}><button className="button primary" onClick={saveSettings} disabled={busy || !logbooks.id || !certificates.id || !photos.id}>{busy ? 'Saving…' : 'Save inboxes'}</button></div>
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Registration sheets</h2><p>Workbook is Fleet Assets - KE. The register lives on the STOCK DOCUMENTS tab — not a separate spreadsheet. Chips go on that tab’s Registration Number rows.</p></div></div>
      <FolderRow label="Fleet Assets - KE" name={spreadsheet.name} id={spreadsheet.id} onChoose={() => setSheetPicker(true)} />
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Neon Postgres</h2><p>After DATABASE_URL is set and you have run npx prisma db push, import the STOCK DOCUMENTS tab from Fleet Assets - KE. Drive still holds the PDFs; Neon stores plates and chips from that tab.</p></div></div>
      <div className="connection-row"><div className="connection-icon"><Database size={17} /></div><div><strong>Neon</strong><span>{fleet?.databaseConnected ? `${fleet.databaseVehicles || 0} rows from STOCK DOCUMENTS` : 'Not connected — add DATABASE_URL from Neon to .env'}</span></div></div>
      <div style={{ padding: '0 21px 18px' }}><button className="button primary" onClick={onImportDatabase} disabled={busy || !fleet?.config?.spreadsheetId}>{busy ? 'Importing…' : 'Import STOCK DOCUMENTS tab'}</button></div>
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Connections</h2><p>Google sign-in is identity. Drive folders and Sheets are the workspace. Neon holds the register once you import it. Gmail readonly reads both configured inboxes.</p></div></div>
      <div className="connection-row"><div className="connection-icon"><Database size={17} /></div><div><strong>Google Drive</strong><span>{fleet?.driveConnected ? 'Signed in' : 'Sign in required'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><FileSpreadsheet size={17} /></div><div><strong>Google Sheets</strong><span>{fleet?.sheetsConnected ? fleet.config?.spreadsheetName || 'Workbook connected' : 'Pick a workbook — then sign out and in if Sheets access was not granted'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><Database size={17} /></div><div><strong>Neon Postgres</strong><span>{fleet?.databaseConnected ? 'Connected' : 'Not connected'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><Mail size={17} /></div><div><strong>Gmail</strong><span>{fleet?.gmailConnected ? 'Inboxes have been checked' : 'Not checked yet — use Check inboxes on Insurance inbox or Logbook inbox'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><ScanLine size={17} /></div><div><strong>On-device OCR</strong><span>{fleet?.ocrConfigured ? 'Tesseract — reads plates locally, no Google billing' : 'OCR is not ready'}</span></div></div>
    </section>
    {picker && <FolderPicker title={`Choose ${picker} folder`} onClose={() => setPicker(null)} onBrowse={onBrowse} onSelect={(folder) => { if (picker === 'logbook') setLogbooks({ id: folder.id, name: folder.name }); if (picker === 'certificate') setCertificates({ id: folder.id, name: folder.name }); if (picker === 'photo') setPhotos({ id: folder.id, name: folder.name }); if (picker === 'agreement') setAgreements({ id: folder.id, name: folder.name }); if (picker === 'collateral') setCollateral({ id: folder.id, name: folder.name }); setPicker(null) }} />}
    {sheetPicker && <SpreadsheetPicker onClose={() => setSheetPicker(false)} onBrowse={onBrowseSheets} onSelect={(file) => { setSpreadsheet({ id: file.id, name: file.name }); setSheetPicker(false) }} />}
  </div>
}

export function FolderRow({ label, name, id, onChoose }: { label: string; name?: string; id: string; onChoose: () => void }) {
  return <div className="connection-row"><div className="connection-icon"><FileText size={17} /></div><div><strong>{label}</strong><span>{name || (id ? 'Selected folder' : 'Not selected')}</span></div><button className="button secondary" type="button" onClick={onChoose}>{id ? 'Change' : 'Choose folder'}</button></div>
}

export function SpreadsheetPicker({ onClose, onBrowse, onSelect }: { onClose: () => void; onBrowse: () => Promise<DriveItem[]>; onSelect: (file: DriveItem) => void }) {
  const [items, setItems] = useState<DriveItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    onBrowse()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to list spreadsheets'))
      .finally(() => setLoading(false))
  }, [onBrowse])
  return <Drawer title="Choose registration workbook" eyebrow="SHEETS" onClose={onClose}>
    {error && <div className="auth-error">{error}</div>}
    {loading ? <p className="drawer-copy">Loading spreadsheets…</p> : <div className="folder-list">{items.length === 0 ? <div className="empty-row">No Google Sheets found in Drive.</div> : items.map((item) => <div className="inbox-row" key={item.id}><div className="inbox-main"><strong>{item.name}</strong></div><button className="button secondary" type="button" onClick={() => onSelect(item)}>Select</button></div>)}</div>}
    <div className="drawer-actions"><button className="button secondary" onClick={onClose}>Cancel</button></div>
  </Drawer>
}

export function FolderPicker({ title, onClose, onBrowse, onSelect }: { title: string; onClose: () => void; onBrowse: (parentId?: string, query?: string) => Promise<DriveItem[]>; onSelect: (folder: DriveItem) => void }) {
  const [items, setItems] = useState<DriveItem[]>([])
  const [stack, setStack] = useState<{ id?: string; name: string }[]>([{ name: 'Google Drive' }])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  async function open(parentId?: string, name?: string, search?: string) {
    setError('')
    setLoading(true)
    try {
      const next = await onBrowse(parentId, search)
      setItems(next)
      if (search !== undefined) return
      if (name) setStack((current) => [...current, { id: parentId, name }])
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to list folders') }
    finally { setLoading(false) }
  }
  useEffect(() => { open() }, [])
  useEffect(() => {
    const value = query.trim()
    if (!value) return
    const timer = window.setTimeout(() => { open(undefined, undefined, value) }, 350)
    return () => window.clearTimeout(timer)
  }, [query])
  const current = stack[stack.length - 1]
  const searching = Boolean(query.trim())
  return <Drawer title={title} eyebrow="DRIVE" subtitle={searching ? 'Search results' : current?.name} onClose={onClose}>
    <label className="field-label">Find a nested folder<input className="assign-input" value={query} onChange={(event) => { const next = event.target.value; setQuery(next); if (!next.trim()) open(stack[stack.length - 1]?.id) }} placeholder="Type a folder name" /></label>
    {!searching && <div className="folder-crumbs">{stack.map((crumb, index) => <button key={`${crumb.id || 'root'}-${index}`} className="crumb-link" type="button" disabled={index === stack.length - 1} onClick={() => { const next = stack.slice(0, index + 1); setStack(next); open(next[next.length - 1]?.id) }}>{crumb.name}</button>)}</div>}
    {error && <div className="auth-error">{error}</div>}
    {loading ? <p className="drawer-copy">Loading folders…</p> : <div className="folder-list">{items.length === 0 ? <div className="empty-row">{searching ? 'No folders match that name.' : 'No subfolders here. Use this folder, go up, or search by name.'}</div> : items.map((item) => <div className="inbox-row" key={item.id}><button type="button" className="inbox-main" onClick={() => { if (searching) { setQuery(''); setStack([{ name: 'Google Drive' }, { id: item.id, name: item.name }]); open(item.id); return } open(item.id, item.name) }}><strong>{item.name}</strong><small>Open subfolders</small></button><button className="button secondary" type="button" onClick={() => onSelect(item)}>Select</button></div>)}</div>}
    <div className="drawer-actions">{!searching && stack.length > 1 && <button className="button secondary" onClick={() => { const next = stack.slice(0, -1); setStack(next); open(next[next.length - 1]?.id) }}>Up</button>}<button className="button primary" disabled={!current?.id} onClick={() => current?.id && onSelect({ id: current.id, name: current.name })}>Use this folder</button></div>
  </Drawer>
}
