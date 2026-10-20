'use client'

import { signOut, useSession } from '@/lib/auth-client'
import { ClipboardList, LogOut, Truck } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function ModuleHome() {
  const router = useRouter()
  const { user, isPending } = useSession()

  useEffect(() => {
    if (!isPending && !user) router.replace('/sign-in')
  }, [isPending, user, router])

  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()

  return (
    <main className="module-home">
      <header className="module-bar">
        <div className="brand">
          <div className="brand-mark"><Truck size={18} /></div>
          <div><strong>Fleetwise</strong><span>Choose a module</span></div>
        </div>
        <div className="module-user">
          {user && <div><strong>{user.name}</strong><small>{user.email}</small></div>}
          <div className="workspace-avatar" aria-hidden="true">{initials}</div>
          <button type="button" className="button secondary module-logout" onClick={() => signOut()}><LogOut size={16} /> Log out</button>
        </div>
      </header>
      <section className="module-body">
        <span className="eyebrow">SIGNED IN</span>
        <h1>Where do you want to work?</h1>
        <p>Stock is the document console already in use. Fleet Management is the operating console we are building next.</p>
        <div className="module-grid">
          <Link className="module-card" href="/stock">
            <span className="module-icon"><ClipboardList size={22} /></span>
            <h2>Stock</h2>
            <p>Open the screens you already use: vehicles, insurance, logbooks, photos, processing, and STOCK DOCUMENTS matching.</p>
            <span className="button primary">Open Stock</span>
          </Link>
          <Link className="module-card" href="/fleet">
            <span className="module-icon"><Truck size={22} /></span>
            <h2>Fleet Management</h2>
            <p>Open the operating console for the daily fleet report: active bikes, mileage, rides, and earnings.</p>
            <span className="button primary">Open Fleet Management</span>
          </Link>
        </div>
      </section>
    </main>
  )
}
