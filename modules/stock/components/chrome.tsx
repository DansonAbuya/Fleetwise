'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { BrandMark } from '@/modules/shared/brand-mark'
import { LayoutGrid, LogOut } from 'lucide-react'
import { nav } from '@/modules/stock/model'

export function RecordsSkeleton() {
  return <div className="records-skeleton" role="status" aria-live="polite" aria-label="Loading records">
    <div className="skeleton-kpis">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><span className="skeleton-bone bone-icon" /><div><span className="skeleton-bone bone-label" /><span className="skeleton-bone bone-value" /></div></div>)}</div>
    <section className="panel table-panel">
      <div className="panel-heading"><div><span className="skeleton-bone bone-title" /><span className="skeleton-bone bone-copy" /></div></div>
      <div className="skeleton-rows">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-row" key={index}><span className="skeleton-bone bone-plate" /><span className="skeleton-bone bone-cell" /><span className="skeleton-bone bone-cell short" /><span className="skeleton-bone bone-cell short" /><span className="skeleton-bone bone-status" /></div>)}</div>
    </section>
  </div>
}

export function ConsoleShell({ user, children }: { user?: { name?: string; email?: string } | null; children?: ReactNode }) {
  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><BrandMark /><div><strong>Fleetwise</strong><span>Stock</span></div></div>
      <Link className="module-switch" href="/"><LayoutGrid size={16} /> All modules</Link>
      <div className="workspace-card"><div className="workspace-avatar">{initials}</div><div><span>Google Drive</span><small>{user?.email || 'Opening console'}</small></div></div>
      <nav className="nav-list" aria-label="Primary navigation">{nav.map(({ label, icon: Icon }) => <span key={label} className={`nav-item ${label === 'Overview' ? 'active' : ''}`}><Icon size={18} /><span>{label}</span></span>)}</nav>
    </aside>
    <main className="main-content">
      {children || <div className="page-wrap"><RecordsSkeleton /></div>}
    </main>
  </div>
}

export function ProfileMenu({ name, email, onLogout }: { name: string; email: string; onLogout: () => void }) {
  return <div className="profile-popover" role="menu">
    <div className="profile-popover-head">
      <strong>{name}</strong>
      <span>{email || 'Signed in with Google'}</span>
    </div>
    <button type="button" className="profile-logout" role="menuitem" onClick={onLogout}><LogOut size={16} /> Log out</button>
  </div>
}
