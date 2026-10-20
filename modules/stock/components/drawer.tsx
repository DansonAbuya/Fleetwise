'use client'

import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { X } from 'lucide-react'

export function Drawer({ title, eyebrow, subtitle, onClose, wide, children }: { title: string; eyebrow: string; subtitle?: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-labelledby="drawer-title" className={`detail-drawer ${wide ? 'inbox-drawer' : ''}`} onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="drawer-title">{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
        </div>
        {children}
      </aside>
    </div>
  )
}
