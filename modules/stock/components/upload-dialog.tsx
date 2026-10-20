'use client'

import { useState, type FormEvent } from 'react'
import type { DocType } from '@/lib/types'
import { Drawer } from '@/modules/stock/components/drawer'

export function UploadDialog({ defaultType, onClose, onUpload }: { defaultType: DocType; onClose: () => void; onUpload: (form: FormData) => Promise<void> }) {
  const [type, setType] = useState<DocType>(defaultType)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    form.set('type', type)
    setBusy(true); setError('')
    try { await onUpload(form) }
    catch (err) { setError(err instanceof Error ? err.message : 'Upload failed') }
    finally { setBusy(false) }
  }
  return <Drawer title="Add a document" eyebrow="UPLOAD" subtitle="Files go to the configured type folder. Photos are OCR’d locally for a Kenyan plate." onClose={onClose}>
    <form className="upload-form" onSubmit={submit}>
      <label className="field-label">Document type<select value={type} onChange={(e) => setType(e.target.value as DocType)}><option value="logbook">Logbook</option><option value="agreement">Agreement</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>
      <label className="field-label">File<input name="file" type="file" required /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload to Drive'}</button>
    </form>
  </Drawer>
}
