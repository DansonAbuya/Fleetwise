'use client'

import { signOut, useSession } from '@/lib/auth-client'
import { ChevronUp, LayoutGrid, LogOut, Menu, Truck } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { FleetOverview } from '@/modules/fleet/components/overview'
import { ActivityView } from '@/modules/fleet/components/activity'
import { BikesView } from '@/modules/fleet/components/bikes'
import { DailyReportView } from '@/modules/fleet/components/daily-report'
import { FLEET_NAV, type FleetView } from '@/modules/fleet/nav'

export function FleetApp() {
  const router = useRouter()
  const { user, isPending } = useSession()
  const [active, setActive] = useState<FleetView>('Overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!isPending && !user) router.replace('/sign-in')
  }, [isPending, user, router])

  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const current = FLEET_NAV.find((item) => item.label === active) || FLEET_NAV[0]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Truck size={18} /></div><div><strong>Fleetwise</strong><span>Fleet Management</span></div></div>
        <Link className="module-switch" href="/" onClick={() => setMobileNav(false)}><LayoutGrid size={16} /> All modules</Link>
        <nav className="nav-list" aria-label="Fleet Management">
          {FLEET_NAV.map(({ label, icon: Icon }) => (
            <button key={label} type="button" className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => { setActive(label); setMobileNav(false) }}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-wrap">
            {menuOpen && (
              <div className="profile-popover" role="menu">
                <div className="profile-popover-head"><strong>{user?.name || 'Fleetwise'}</strong><span>{user?.email || 'Signed in with Google'}</span></div>
                <button type="button" className="profile-logout" onClick={() => signOut()}><LogOut size={16} /> Log out</button>
              </div>
            )}
            <button type="button" className="profile profile-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <div className="profile-avatar">{initials}</div>
              <div><strong>{user?.name || 'Fleetwise'}</strong><small>{user?.email || 'Account'}</small></div>
              <ChevronUp size={16} className={menuOpen ? '' : 'profile-chevron'} />
            </button>
          </div>
        </div>
      </aside>
      {mobileNav && <button className="mobile-overlay" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Fleet Management</span><span>/</span><strong>{active}</strong></div>
        </header>
        <div className="page-wrap">
          <div className="page-heading">
            <div>
              <div className="date-label">FLEET MANAGEMENT</div>
              <h1>{active === 'Overview' ? 'Fleet Management' : active}</h1>
              <p>{current.detail}</p>
            </div>
          </div>
          {active === 'Overview' && <FleetOverview onOpenReport={() => setActive('Daily report')} />}
          {active === 'Bikes' && <BikesView />}
          {active === 'Activity' && <ActivityView />}
          {active === 'Daily report' && <DailyReportView />}
        </div>
      </main>
    </div>
  )
}
