'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { signOut, useSession } from '@/lib/auth-client'
import { assignUnmatched, assignUnmatchedBatch, continueProcessing, getProcessingJob, linkPerceivedMatches, listDriveFolders, listSpreadsheets, loadFleet, loadVehiclePage, loadWorkspace, loadWorkspacePanels, ocrUnmatchedPhotos, runProcessing, saveFolderConfig, stopProcessing, syncGmail, syncRegisterToDatabase, uploadDocument } from '@/modules/stock/actions'
import { coverAlertLabel, formatCoverDate } from '@/lib/insurance'
import { processFocusLabel, type ProcessFocus } from '@/lib/process-focus'
import type { ProcessJob } from '@/lib/processing'
import type { DocType, FleetSnapshot, VehicleRecord } from '@/lib/types'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Check,
  ChevronUp,
  CircleHelp,
  ClipboardCheck,
  Clock,
  Copy,
  Download,
  FileText,
  LayoutGrid,
  LoaderCircle,
  Mail,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
  Upload,
  X,
} from 'lucide-react'
import { AuditView } from '@/modules/stock/components/audit-view'
import { ProfileMenu, RecordsSkeleton, ConsoleShell } from '@/modules/stock/components/chrome'
import { Coverage } from '@/modules/stock/components/coverage'
import { DuplicatesView } from '@/modules/stock/components/duplicates-view'
import { BrandFilter, MissingFilters, StatusBadge } from '@/modules/stock/components/filters'
import { Drawer } from '@/modules/stock/components/drawer'
import { HelpDrawer } from '@/modules/stock/components/help-drawer'
import { InboxView } from '@/modules/stock/components/inbox-view'
import { ProcessingView } from '@/modules/stock/components/processing-view'
import { SettingsView } from '@/modules/stock/components/settings-view'
import { UnmatchedView } from '@/modules/stock/components/unmatched-view'
import { UploadDialog } from '@/modules/stock/components/upload-dialog'
import { VehicleTable } from '@/modules/stock/components/vehicle-table'
import { exportCsv } from '@/modules/stock/export-register'
import {
  downloadableFileId,
  EMPTY_BRANDS,
  exportAudit,
  greeting,
  hasRegisterItem,
  inboxKind,
  isAuthError,
  keepVehicles,
  labelFor,
  nav,
  TO_SLUG,
  readSavedFolders,
  rememberVehicleGrowth,
  shareLabel,
  shareParts,
  splitUnmatched,
  stubFleet,
  unmatchedSplitLabel,
  unmatchedTitle,
  viewFromSearch,
  writeSavedFolders,
  type MissingFilter,
  type NavKey,
  type StatusFilter,
  type UnmatchedKind,
} from '@/modules/stock/model'

export function StockApp() {
  const router = useRouter()
  const { user, isPending } = useSession()
  const [active, setActive] = useState<NavKey>('Overview')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [brandFilter, setBrandFilter] = useState('all')
  const [missingFilters, setMissingFilters] = useState<MissingFilter[]>([])
  const [mobileNav, setMobileNav] = useState(false)
  const [selected, setSelected] = useState<VehicleRecord | null>(null)
  const [uploadType, setUploadType] = useState<DocType>('certificate')
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileMenu, setProfileMenu] = useState<'side' | 'top' | null>(null)
  const configured = Boolean(fleet?.config)
  const [dateLabel, setDateLabel] = useState('')
  const [hello, setHello] = useState('Welcome')
  const [mounted, setMounted] = useState(false)
  const [lastSyncLabel, setLastSyncLabel] = useState('Not synced')
  const [vehiclePage, setVehiclePage] = useState(1)
  const [vehiclePageSize, setVehiclePageSize] = useState(25)
  const [vehicleTotal, setVehicleTotal] = useState(0)
  const [tableBusy, setTableBusy] = useState(false)
  const [recordsReady, setRecordsReady] = useState(false)
  const [registerTick, setRegisterTick] = useState(0)
  const [unmatchedKind, setUnmatchedKind] = useState<UnmatchedKind>('all')
  const [processJob, setProcessJob] = useState<ProcessJob | null>(null)
  const [batchNotice, setBatchNotice] = useState('')
  const batchCountRef = useRef(0)
  const lastBatchKey = useRef('')
  const unmatchedLenRef = useRef(0)
  const panelsLoaded = useRef(false)
  useEffect(() => {
    setMounted(true)
    setActive(viewFromSearch())
    setDateLabel(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase())
    setHello(greeting())
    const folders = readSavedFolders()
    if (folders) {
      setFleet((current) => current || stubFleet({ name: 'Fleetwise', email: '' }, folders))
    }
    function onPop() {
      setActive(viewFromSearch())
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    setLastSyncLabel(fleet?.lastSync ? new Date(fleet.lastSync).toLocaleString() : 'Not synced')
  }, [fleet?.lastSync])

  function go(view: NavKey, replace = false, kind?: UnmatchedKind) {
    setMobileNav(false)
    setNotificationsOpen(false)
    setProfileMenu(null)
    if (view === 'Unmatched') setUnmatchedKind(kind || 'all')
    setActive(view)
    const url = `/stock?view=${TO_SLUG[view]}`
    if (typeof window === 'undefined') return
    if (replace) window.history.replaceState(null, '', url)
    else if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, '', url)
  }

  function toggleProfileMenu(source: 'side' | 'top') {
    setNotificationsOpen(false)
    setProfileMenu((current) => current === source ? null : source)
  }

  const autoScanLock = useRef(false)
  const activeRef = useRef(active)
  const moreWorkRef = useRef(false)
  activeRef.current = active

  function applySnapshot(next: FleetSnapshot, ok?: string) {
    moreWorkRef.current = Boolean(next.ingest?.more)
    if (next.ingest?.attempted) {
      const marker = `${next.ingest.more ? 'more' : 'done'}:${next.ingest.remaining}:${next.ingest.attempted}:${next.ingest.renamed}`
      if (marker !== lastBatchKey.current) {
        lastBatchKey.current = marker
        if (next.ingest.more) {
          batchCountRef.current += 1
          const finished = batchCountRef.current
          const waiting = next.ingest.remaining ? `${next.ingest.remaining} file${next.ingest.remaining === 1 ? '' : 's'} still waiting` : 'more files are queued'
          setBatchNotice(`Batch ${finished} finished — ${next.ingest.renamed} renamed of ${next.ingest.attempted}. Starting batch ${finished + 1}. ${waiting}.`)
        } else if (batchCountRef.current > 0) {
          setBatchNotice(`Batch ${batchCountRef.current} finished — ${next.ingest.renamed} renamed of ${next.ingest.attempted}. No more files waiting.`)
          batchCountRef.current = 0
        }
      }
    }
    setFleet((current) => keepVehicles(current, next))
    const unmatchedCount = next.unmatched?.length || 0
    if (unmatchedCount !== unmatchedLenRef.current || next.ingest?.renamed) {
      unmatchedLenRef.current = unmatchedCount
      setRegisterTick((tick) => tick + 1)
    }
    if (next.ingest?.notice) setSuccess(ok ? `${ok} ${next.ingest.notice}` : next.ingest.notice)
    else if (ok) setSuccess(ok)
  }

  async function runSync(loader: Promise<FleetSnapshot>, ok?: string) {
    autoScanLock.current = true
    setError('')
    try {
      let next = await loader
      let failures = 0
      while (true) {
        applySnapshot(next, ok)
        ok = undefined
        if (!next.ingest?.more) break
        try {
          next = next.ingest?.follow === 'gmail' ? await syncGmail() : await continueProcessing()
          failures = 0
        } catch (err) {
          failures += 1
          if (failures > 2) throw err
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Drive')
    } finally {
      autoScanLock.current = false
    }
  }

  async function refresh(loader: Promise<FleetSnapshot> = loadFleet(), ok?: string, wait = true) {
    if (wait) {
      setBusy(ok ? 'Working…' : 'Loading Drive…')
      setSuccess('')
    }
    try {
      await runSync(loader, ok)
    } finally {
      if (wait) setBusy('')
    }
  }

  const restoredFolders = useRef(false)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    async function boot() {
      setError('')
      try {
        const workspace = await loadWorkspace()
        if (cancelled) return
        setFleet((current) => keepVehicles(current, workspace))
        autoScanLock.current = true
        try {
          const next = await loadFleet('auto', false, 'off')
          if (!cancelled) applySnapshot(next, next.ingest?.notice)
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Drive')
        } finally {
          autoScanLock.current = false
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Drive')
      } finally {
        if (!cancelled) setRecordsReady(true)
      }
    }
    boot()
    return () => { cancelled = true }
  }, [user])
  useEffect(() => {
    if (!fleet?.config || restoredFolders.current) return
    restoredFolders.current = true
    const local = readSavedFolders()
    if (!local) return
    const foldersChanged = local.logbooksId !== fleet.config.logbooksId || local.certificatesId !== fleet.config.certificatesId || local.photosId !== fleet.config.photosId || (local.agreementsId || '') !== (fleet.config.agreementsId || '')
    const insuranceMailbox = local.insuranceInboxEmail || ''
    const logbooksMailbox = local.logbooksInboxEmail || ''
    const mailboxesChanged = Boolean(insuranceMailbox || logbooksMailbox) && (
      insuranceMailbox !== (fleet.config.insuranceInboxEmail || '') ||
      logbooksMailbox !== (fleet.config.logbooksInboxEmail || '')
    )
    if (foldersChanged || mailboxesChanged) {
      refresh(saveFolderConfig({
        ...local,
        insuranceInboxEmail: insuranceMailbox || fleet.config.insuranceInboxEmail,
        logbooksInboxEmail: logbooksMailbox || fleet.config.logbooksInboxEmail,
      }), 'Restored your saved Drive folders and mailboxes.')
    }
  }, [fleet?.config])
  useEffect(() => {
    if (!user) return
    async function watchFolders() {
      if (document.hidden || autoScanLock.current || activeRef.current === 'Settings') return
      if (activeRef.current !== 'Processing' && activeRef.current !== 'Overview') return
      autoScanLock.current = true
      try {
        const next = await loadFleet('auto', false, 'off')
        applySnapshot(next, next.ingest?.notice)
      } catch {
        // Keep watching; the next tick retries.
      } finally {
        autoScanLock.current = false
      }
    }
    const timer = window.setInterval(watchFolders, 90_000)
    return () => window.clearInterval(timer)
  }, [user])
  useEffect(() => {
    const focus = processJob?.focus || fleet?.ingest?.focus || fleet?.ingest?.lastAction?.focus
    const more = Boolean(fleet?.ingest?.more || processJob?.advancing)
    const paused = processJob?.cancelled || fleet?.ingest?.lastAction?.status === 'paused' || fleet?.ingest?.lastAction?.status === 'done'
    if (!user || !more || paused || autoScanLock.current) return
    refresh(continueProcessing(), undefined, false)
  }, [user, fleet?.ingest?.more, processJob?.advancing, processJob?.focus, fleet?.ingest?.focus])
  useEffect(() => {
    if (fleet && !fleet.config && active !== 'Settings') go('Settings', true)
  }, [fleet, active])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNotificationsOpen(false)
        setProfileMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!profileMenu) return
    function onPointer(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (target.closest('.profile-wrap')) return
      setProfileMenu(null)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [profileMenu])
  const vehicles = fleet?.vehicles || []
  const unmatched = fleet?.unmatched || []
  const duplicates = fleet?.duplicates || []
  const unmatchedParts = splitUnmatched(unmatched)
  const inbox = fleet?.inbox || []
  const stats = fleet?.stats
  const insuranceInbox = inbox.filter((item) => inboxKind(item) === 'certificate')
  const logbookInbox = inbox.filter((item) => inboxKind(item) === 'logbook')
  const insuranceReviewCount = insuranceInbox.filter((item) => item.status === 'Needs review').length
  const logbookReviewCount = logbookInbox.filter((item) => item.status === 'Needs review').length
  const reviewCount = insuranceReviewCount + logbookReviewCount
  const brands = stats?.brands || EMPTY_BRANDS
  const unbrandedCount = stats?.unbranded || 0
  const complete = stats?.complete || 0
  const attention = stats?.attention || 0
  const vehicleCount = stats?.total || 0
  const spreadsheetId = fleet?.config?.spreadsheetId || ''
  const missingKey = missingFilters.join(',')
  const brandsKey = brands.join('|')
  const newPlatesKey = (stats?.newPlates || EMPTY_BRANDS).join('|')
  useEffect(() => {
    if (brandFilter === 'all') return
    if (brandFilter === '__none') {
      if (unbrandedCount === 0) setBrandFilter('all')
      return
    }
    if (brandsKey && !brandsKey.split('|').includes(brandFilter)) setBrandFilter('all')
  }, [brandFilter, unbrandedCount, brandsKey])
  useEffect(() => {
    if (!mounted || !vehicleCount) return
    const growth = rememberVehicleGrowth(vehicleCount, stats?.newPlates || EMPTY_BRANDS)
    if (!growth) return
    setSuccess((current) => current && current !== growth ? `${growth} ${current}` : growth)
  }, [mounted, vehicleCount, newPlatesKey])
  useEffect(() => {
    if (!spreadsheetId) return
    if (active !== 'Overview' && active !== 'Vehicles') return
    let cancelled = false
    const page = active === 'Overview' ? 1 : vehiclePage
    const pageSize = active === 'Overview' ? 10 : vehiclePageSize
    const timer = window.setTimeout(async () => {
      setTableBusy(true)
      try {
        const result = await loadVehiclePage({
          query,
          status: active === 'Vehicles' ? statusFilter : 'all',
          brand: brandFilter,
          missing: missingFilters,
          page,
          pageSize,
        })
        if (cancelled) return
        setVehicleTotal(result.total)
        setFleet((current) => current ? { ...current, vehicles: result.vehicles, stats: result.stats, insuranceAlerts: result.insuranceAlerts || current.insuranceAlerts, sheetsError: result.error || current.sheetsError } : current)
        if (active === 'Vehicles' && result.page !== vehiclePage) setVehiclePage(result.page)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load vehicles')
      } finally {
        if (!cancelled) setTableBusy(false)
      }
    }, query ? 280 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, query, statusFilter, brandFilter, missingKey, vehiclePage, vehiclePageSize, spreadsheetId, registerTick])
  useEffect(() => {
    if (!user) return
    const live = Boolean(processJob?.running || processJob?.advancing || fleet?.ingest?.more)
    if (!live && active !== 'Processing') return
    let cancelled = false
    async function tick() {
      try {
        const next = await getProcessingJob()
        if (!cancelled) setProcessJob(next)
      } catch {
        // Keep the last live board if a poll fails.
      }
    }
    tick()
    const timer = window.setInterval(tick, live ? 700 : 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [user, active, processJob?.running, processJob?.advancing, fleet?.ingest?.more])
  useEffect(() => {
    if (active !== 'Insurance inbox' && active !== 'Logbook inbox' && active !== 'Audit log') return
    if (panelsLoaded.current) return
    let cancelled = false
    loadWorkspacePanels().then((data) => {
      if (cancelled) return
      panelsLoaded.current = true
      setFleet((current) => current ? {
        ...current,
        inbox: data.inbox.length ? data.inbox : current.inbox,
        audit: data.audit.length ? data.audit : current.audit,
        gmailConnected: data.gmailConnected || current.gmailConnected,
      } : current)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [active])
  const insuranceAlerts = fleet?.insuranceAlerts || []
  const notifications = [
    ...insuranceAlerts.map((alert) => ({
      id: `ins-${alert.kind}-${alert.plate}`,
      title: alert.kind === 'expired' ? 'Insurance expired' : alert.kind === 'two-days' ? 'Insurance expires in 2 days' : 'Insurance expires in a week',
      message: `${alert.plate} · ${coverAlertLabel(alert)}${alert.expiry ? ` · expiry ${formatCoverDate(alert.expiry)}` : ''}`,
      time: alert.expiry ? formatCoverDate(alert.expiry) : '',
      view: 'Vehicles' as NavKey,
      query: alert.plate,
      tone: (alert.kind === 'week' ? 'week' : 'urgent') as 'week' | 'urgent',
    })),
    ...unmatched.slice(0, 8).map((file) => ({ id: file.id, title: unmatchedTitle(file), message: file.name, time: file.modifiedTime || '', view: 'Unmatched' as NavKey, kind: file.type as UnmatchedKind })),
    ...inbox.filter((item) => item.status === 'Needs review').map((item) => ({ id: item.id, title: inboxKind(item) === 'logbook' ? 'Logbook needs review' : 'Certificate needs review', message: `${item.vehicle} · ${item.attachment}`, time: item.received, view: (inboxKind(item) === 'logbook' ? 'Logbook inbox' : 'Insurance inbox') as NavKey })),
  ]
  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const title = active === 'Overview' ? `${hello}, ${user?.name?.split(' ')[0] || 'there'}` : active
  const subtitle = active === 'Overview'
    ? 'New Drive files are detected, renamed with the plate, and matched to registration rows in Sheets.'
    : active === 'Unmatched'
      ? 'Photos, insurance, and logbook files still in their Drive folders that are not matched to a Registration Number on STOCK DOCUMENTS.'
      : active === 'Duplicates'
        ? 'Shown only when one registration number has more than one logbook, insurance file, or photo. The file matched on the sheet is not a duplicate.'
      : active === 'Insurance inbox'
        ? 'Insurance PDFs from the insurance mailbox are downloaded, renamed Insurance - {plate}, and stored in the certificates folder.'
        : active === 'Logbook inbox'
          ? 'Logbook PDFs from the logbook mailbox are downloaded, renamed {plate} - Logbook, and stored in the logbooks folder.'
      : `Review and manage your ${active.toLowerCase()} workspace.`

  function openUpload(type?: DocType) {
    if (!configured) {
      setError('Configure the three Drive folders in Settings before uploading.')
      go('Settings')
      return
    }
    if (type) setUploadType(type)
    else {
      const missing = selected ? (['logbook', 'agreement', 'certificate', 'photo'] as DocType[]).find((item) => selected.files[item].length === 0) : undefined
      setUploadType(missing || 'certificate')
    }
    setUploadOpen(true)
  }

  if (!isPending && !user) {
    router.replace('/sign-in')
    return <ConsoleShell />
  }
  if (isPending && !user) {
    return <ConsoleShell />
  }
  const sessionUser = user || { name: 'Fleetwise', email: '' }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Truck size={18} /></div><div><strong>Fleetwise</strong><span>Stock</span></div></div>
        <Link className="module-switch" href="/"><LayoutGrid size={16} /> All modules</Link>
        <div className="workspace-card"><div className="workspace-avatar">{initials}</div><div><span>Google Drive</span><small>{sessionUser.email}</small></div></div>
      <nav className="nav-list" aria-label="Primary navigation">{nav.map(({ label, icon: Icon }) => {
        const remaining = processJob?.running ? Math.max(0, processJob.attempted - processJob.done) : 0
        const count = label === 'Unmatched' ? unmatched.length : label === 'Duplicates' ? duplicates.length : label === 'Insurance inbox' ? insuranceReviewCount : label === 'Logbook inbox' ? logbookReviewCount : label === 'Processing' ? remaining : 0
        return <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => go(label)}><Icon size={18} /><span>{label}</span>{count ? <b>{count}</b> : null}</button>
      })}</nav>
      <div className="sidebar-bottom">
        <div className="sync-card"><div className="sync-header"><span><span className="live-dot" /> System status</span><strong>{configured ? 'Folders set' : 'Setup needed'}</strong></div><div className="sync-line"><span>Last sync</span><span>{lastSyncLabel}</span></div></div>
        <button className="help-link" type="button" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /> How Fleetwise files</button>
        <div className="profile-wrap">
          {profileMenu === 'side' && <ProfileMenu name={sessionUser.name} email={sessionUser.email} onLogout={() => signOut()} />}
          <button type="button" className="profile profile-button" aria-haspopup="menu" aria-expanded={profileMenu === 'side'} onClick={() => toggleProfileMenu('side')}><div className="profile-avatar">{initials}</div><div><strong>{sessionUser.name}</strong><small>{sessionUser.email || 'Account'}</small></div><ChevronUp size={16} className={profileMenu === 'side' ? '' : 'profile-chevron'} /></button>
        </div>
      </div>
    </aside>
    {mobileNav && <button className="mobile-overlay" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Stock</span><span>/</span><strong>{active}</strong></div><div className="top-actions"><div className="notification-wrap"><button className="icon-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => { setProfileMenu(null); setNotificationsOpen(!notificationsOpen) }}><Bell size={19} />{notifications.length > 0 && <i />}</button>{notificationsOpen && <div className="notification-popover" role="menu"><div className="notification-head"><div><strong>Notifications</strong><span>{notifications.length} open</span></div></div><div className="notification-list">{notifications.length === 0 ? <div className="notification-item read"><span /><span><strong>All clear</strong><small>No unmatched files, insurance expiry alerts, or certificates waiting.</small></span></div> : notifications.map((notification) => <button className="notification-item" key={notification.id} onClick={() => { if ('query' in notification && notification.query) { setQuery(notification.query); setVehiclePage(1) } go(notification.view, false, 'kind' in notification ? notification.kind : undefined) }}><span className={`notification-icon ${'tone' in notification && notification.tone === 'urgent' ? 'urgent' : 'tone' in notification && notification.tone === 'week' ? 'week' : ''}`}>{('tone' in notification && notification.tone) ? <Clock size={15} /> : <ShieldCheck size={15} />}</span><span><strong>{notification.title}</strong><small>{notification.message}</small><time>{notification.time}</time></span><b /></button>)}</div></div>}</div><div className="profile-wrap profile-wrap-top"><button type="button" className="top-avatar" aria-label="Open account menu" aria-haspopup="menu" aria-expanded={profileMenu === 'top'} onClick={() => toggleProfileMenu('top')}>{initials}</button>{profileMenu === 'top' && <ProfileMenu name={sessionUser.name} email={sessionUser.email} onLogout={() => signOut()} />}</div></div></header>
      <div className="page-wrap">
        <div className="page-heading"><div><div className="date-label">{dateLabel}</div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions"><button className="button secondary" onClick={() => exportCsv({ query, status: statusFilter, brand: brandFilter, missing: missingFilters })} disabled={!vehicleCount}><ArrowDownToLine size={16} /> Export report</button><button className="button primary" onClick={() => openUpload()} disabled={!configured}><Upload size={16} /> Upload documents</button></div></div>
        {busy && recordsReady && <div className="busy-banner" role="status">{busy}</div>}
        {batchNotice && <div className="busy-banner process-batch-banner" role="status"><LoaderCircle size={16} className="spin-icon" /><span>{batchNotice}</span>{active !== 'Processing' && <button type="button" onClick={() => go('Processing')}>Watch live</button>}<button type="button" onClick={() => setBatchNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {processJob?.running && active !== 'Processing' && <button type="button" className="busy-banner process-live-banner" onClick={() => go('Processing')}>{processJob.advancing ? `Batch ${processJob.batch || 1} of ${processFocusLabel(processJob.focus)} finished — starting the next files` : processJob.currentId ? `${processFocusLabel(processJob.focus)} live · ${processJob.done} of ${processJob.attempted} finished` : processFocusLabel(processJob.focus)} — open the live board</button>}
        {success && <div className="success-banner" role="status">{success}<button type="button" onClick={() => setSuccess('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {error && <div className={`auth-error banner-error`} role="alert">{error}{isAuthError(error) && <a className="text-button" href="/sign-in">Sign in again</a>}<button type="button" className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
        {fleet?.sheetsError && <div className="auth-error banner-error" role="alert">{/403|PERMISSION|ACCESS_TOKEN|insufficient/i.test(fleet.sheetsError) ? 'Sheets matching failed. Enable the Google Sheets API, then sign out and in again to grant spreadsheet access.' : fleet.sheetsError}</div>}
        {fleet?.ingest?.error && <div className="auth-error banner-error" role="alert">{fleet.ingest.error}</div>}
        {!recordsReady ? <RecordsSkeleton /> : <>
        {active === 'Overview' && <>
          <div className="kpi-grid">
            <button type="button" className="kpi-card kpi-card-button" onClick={() => go('Vehicles')}><div className="kpi-icon blue"><Truck size={19} /></div><div><p className="eyebrow">Total vehicles</p><div className="kpi-value">{vehicleCount}</div><p className="kpi-detail">{fleet?.config?.spreadsheetName || 'Plates from Sheets, filenames, and photo OCR'}</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => { setStatusFilter('Complete'); setVehiclePage(1); go('Vehicles') }}><div className="kpi-icon green"><ClipboardCheck size={19} /></div><div><p className="eyebrow">Complete packs</p><div className="kpi-value">{complete}</div><p className="kpi-detail">{shareLabel(complete, vehicleCount)} complete · logbook, agreement, certificate, photo, collateral</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => { setStatusFilter('Needs attention'); setVehiclePage(1); go('Vehicles') }}><div className="kpi-icon orange"><AlertCircle size={19} /></div><div><p className="eyebrow">Need attention</p><div className="kpi-value">{attention}</div><p className="kpi-detail">{shareLabel(attention, vehicleCount)} missing a document</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => go('Processing')}><div className="kpi-icon purple"><RefreshCw size={19} /></div><div><p className="eyebrow">Last sync</p><div className="kpi-value">{fleet?.lastSync ? 'Synced' : '—'}</div><p className="kpi-detail">{configured ? lastSyncLabel : 'Folders not configured'}</p></div></button>
          </div>
              <div className="content-grid"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Folder coverage</h2><p>STOCK DOCUMENTS chips: Logbook / Agreement, Agreement Link, PSV Insurance, Asset Photo, and Collateral Files</p></div></div><Coverage stats={stats} onSelect={(item) => { setMissingFilters((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item]); setVehiclePage(1) }} /></section>
            <section className="panel attention-panel"><div className="panel-heading"><div><h2>Needs your attention</h2><p>{unmatched.length} unmatched · {unmatchedSplitLabel(unmatched)}</p></div><button type="button" className="text-button" onClick={() => go('Unmatched')}>Open unmatched <ArrowUpRight size={15} /></button></div>
              <div className="unmatched-overview" role="group" aria-label="Unmatched by type">
                <button type="button" className="unmatched-overview-card" onClick={() => go('Unmatched', false, 'photo')}>
                  <span>Unmatched photos</span>
                  <strong>{unmatchedParts.photos.length}</strong>
                  <em>{fleet?.config?.photosName || 'Photos folder'}</em>
                </button>
                <button type="button" className="unmatched-overview-card" onClick={() => go('Unmatched', false, 'certificate')}>
                  <span>Unmatched insurance</span>
                  <strong>{unmatchedParts.insurance.length}</strong>
                  <em>{fleet?.config?.certificatesName || 'Insurance folder'}</em>
                </button>
                <button type="button" className="unmatched-overview-card" onClick={() => go('Unmatched', false, 'logbook')}>
                  <span>Unmatched logbooks</span>
                  <strong>{unmatchedParts.logbooks.length}</strong>
                  <em>{fleet?.config?.logbooksName || 'Logbooks folder'}</em>
                </button>
                <button type="button" className="unmatched-overview-card" onClick={() => go('Unmatched', false, 'agreement')}>
                  <span>Unmatched agreements</span>
                  <strong>{unmatchedParts.agreements.length}</strong>
                  <em>{fleet?.config?.agreementsName || 'Agreements folder'}</em>
                </button>
              </div>
              <div className="attention-list">
                <button type="button" className="attention-item" onClick={() => go('Duplicates')}><div className="attention-icon blue"><Copy size={17} /></div><div><strong>{duplicates.length} extra file{duplicates.length === 1 ? '' : 's'}</strong><span>Registration numbers with more than one logbook, insurance file, or photo. The sheet match is not counted.</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => { setStatusFilter('Needs attention'); setVehiclePage(1); go('Vehicles') }}><div className="attention-icon yellow"><FileText size={17} /></div><div><strong>{attention} vehicles incomplete ({shareParts(complete, vehicleCount).missingPct}%)</strong><span>{shareLabel(attention, vehicleCount)} missing logbook, agreement, certificate, photo, or collateral</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => go('Vehicles')}><div className="attention-icon yellow"><Clock size={17} /></div><div><strong>{(stats?.insuranceWeek || 0) + (stats?.insuranceTwoDays || 0) + (stats?.insuranceExpired || 0)} insurance covers need a date check</strong><span>{stats?.insuranceTwoDays || 0} in the last 2 days · {stats?.insuranceWeek || 0} in the next week{stats?.insuranceExpired ? ` · ${stats.insuranceExpired} expired` : ''}</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => go('Insurance inbox')}><div className="attention-icon blue"><Mail size={17} /></div><div><strong>{insuranceReviewCount} certificates need review</strong><span>{fleet?.config?.insuranceInboxEmail || 'Insurance mailbox'} · Gmail attachments below the match threshold</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => go('Logbook inbox')}><div className="attention-icon blue"><FileText size={17} /></div><div><strong>{logbookReviewCount} logbooks need review</strong><span>{fleet?.config?.logbooksInboxEmail || 'Logbook mailbox'} · Gmail attachments below the match threshold</span></div><ArrowUpRight size={16} /></button>
              </div>
            </section>
          </div>
          <section className="panel table-panel"><div className="panel-heading"><div><h2>Vehicle document register</h2><p>Completeness is 5 of 5: logbook, agreement link, certificate, photo, collateral files</p></div><button className="text-button" onClick={() => go('Vehicles')}>View all vehicles <ArrowUpRight size={15} /></button></div><div className="table-toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setVehiclePage(1) }} placeholder="Search plate or brand..." aria-label="Search plate or brand" /></div><BrandFilter value={brandFilter} brands={brands} unbrandedCount={unbrandedCount} onChange={(next) => { setBrandFilter(next); setVehiclePage(1) }} /><MissingFilters value={missingFilters} onChange={(next) => { setMissingFilters(next); setVehiclePage(1) }} /></div><VehicleTable vehicles={vehicles} total={vehicleTotal} page={1} pageSize={10} loading={tableBusy} onSelect={setSelected} /></section>
        </>}
        {active === 'Vehicles' && <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>All vehicles</h2><p>{fleet?.databaseConnected && fleet.databaseVehicles ? `The register follows every Registration Number on STOCK DOCUMENTS in ${fleet.config.spreadsheetName || 'Fleet Assets'}.` : fleet?.config?.spreadsheetId ? `Matched to Registration Number rows on STOCK DOCUMENTS in ${fleet.config.spreadsheetName || 'Fleet Assets'}.` : 'Vehicles come from STOCK DOCUMENTS on Fleet Assets or Fleet Assets - KE once Sheets access is granted.'}</p></div><button className="button primary" onClick={() => openUpload()} disabled={!configured}><Plus size={16} /> Upload document</button></div><div className="table-toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setVehiclePage(1) }} placeholder="Search plate or brand..." aria-label="Search plate or brand" /></div><label className="field-label">Status<select className="assign-input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setVehiclePage(1) }}><option value="all">All</option><option value="Complete">Complete</option><option value="Needs attention">Needs attention</option></select></label><BrandFilter value={brandFilter} brands={brands} unbrandedCount={unbrandedCount} onChange={(next) => { setBrandFilter(next); setVehiclePage(1) }} /><MissingFilters value={missingFilters} onChange={(next) => { setMissingFilters(next); setVehiclePage(1) }} /></div><VehicleTable vehicles={vehicles} total={vehicleTotal} page={vehiclePage} pageSize={vehiclePageSize} pageSizes={[25, 50, 100]} loading={tableBusy} onPageChange={setVehiclePage} onPageSizeChange={(size) => { setVehiclePageSize(size); setVehiclePage(1) }} onSelect={setSelected} /></section>}
        {active === 'Insurance inbox' && <InboxView kind="certificate" inbox={insuranceInbox} config={fleet?.config ?? null} gmailConnected={Boolean(fleet?.gmailConnected)} ocrConfigured={Boolean(fleet?.ocrConfigured)} busy={Boolean(busy)} onSync={() => refresh(syncGmail(), 'Insurance and logbook mailboxes checked.')} onAssign={(input) => refresh(assignUnmatched(input), `Assigned ${input.plate}.`)} />}
        {active === 'Logbook inbox' && <InboxView kind="logbook" inbox={logbookInbox} config={fleet?.config ?? null} gmailConnected={Boolean(fleet?.gmailConnected)} ocrConfigured={Boolean(fleet?.ocrConfigured)} busy={Boolean(busy)} onSync={() => refresh(syncGmail(), 'Insurance and logbook mailboxes checked.')} onAssign={(input) => refresh(assignUnmatched(input), `Assigned ${input.plate}.`)} />}
        {active === 'Processing' && <ProcessingView lastSync={fleet?.lastSync} vehicles={vehicleCount} unmatched={unmatched} busy={Boolean(busy)} configured={configured} ocrConfigured={Boolean(fleet?.ocrConfigured)} ingest={fleet?.ingest} job={processJob} photosFolder={fleet?.config?.photosName} certificatesFolder={fleet?.config?.certificatesName} logbooksFolder={fleet?.config?.logbooksName} agreementsFolder={fleet?.config?.agreementsName} onScan={() => refresh(loadFleet('full', false, 'off'), 'Folders scanned. No OCR ran — start photos, insurance, logbooks, agreements, or fix wrong plates below.')} onGmail={() => refresh(syncGmail(), 'Insurance and logbook mailboxes checked.')} onOcr={() => refresh(ocrUnmatchedPhotos(), 'Read plates from unmatched photos, insurance, logbook, and agreement files.', false)} onStart={async (focus) => { if ((processJob?.running || processJob?.advancing) && processJob.focus && processJob.focus !== focus) await stopProcessing(); const prior = processJob?.lastAction || fleet?.ingest?.lastAction; const resume = prior?.focus === focus && (prior.status === 'paused' || prior.status === 'running'); setProcessJob((current) => ({ running: true, watching: current?.watching || '', attempted: current?.attempted || 0, done: current?.done || 0, matched: current?.matched || 0, failed: current?.failed || 0, batch: current?.batch || 1, remaining: current?.remaining || 0, lastRenamed: current?.lastRenamed || 0, advancing: false, focus, items: current?.items || [], lastAction: current?.lastAction || prior })); return refresh(runProcessing(focus), resume ? `Continuing ${processFocusLabel(focus)} from ${prior?.fileName || 'the last file'}.` : `Started ${processFocusLabel(focus)}. Stop to pause; start the same job to continue from there.`, false) }} onStop={async () => { const next = await stopProcessing(); setProcessJob(next); moreWorkRef.current = false; setFleet((current) => current?.ingest ? { ...current, ingest: { ...current.ingest, more: false, remaining: next.lastAction?.remaining || current.ingest.remaining, lastAction: next.lastAction } } : current); setBusy(''); setBatchNotice(''); setSuccess(next.lastAction?.fileName ? `Paused after ${next.lastAction.fileName}. Start the same job to continue.` : 'Paused. Start the same job to continue from this point.') }} onLinkSheet={(type) => refresh(linkPerceivedMatches(type))} />}
        {active === 'Unmatched' && <UnmatchedView files={unmatched} category={unmatchedKind} onCategory={setUnmatchedKind} busy={Boolean(busy)} ocrConfigured={Boolean(fleet?.ocrConfigured)} onAssign={(input) => refresh(assignUnmatched(input), `Assigned ${input.plate}.`)} onAssignMany={(inputs) => refresh(assignUnmatchedBatch(inputs), `Assigned ${inputs.length} registration number${inputs.length === 1 ? '' : 's'}.`)} onOcr={(fileId) => refresh(ocrUnmatchedPhotos(fileId), fileId ? 'Read plate from file.' : 'Read plates from unmatched photos, insurance, logbook, and agreement files.', false)} />}
        {active === 'Duplicates' && <DuplicatesView files={duplicates} />}
        {active === 'Audit log' && <AuditView events={fleet?.audit || []} onExport={() => exportAudit(fleet?.audit || [])} />}
        {active === 'Settings' && <SettingsView fleet={fleet} firstRun={!configured} busy={Boolean(busy)} onSave={(input) => { writeSavedFolders(input); return refresh(saveFolderConfig(input), 'Folder and sheet configuration saved.') }} onImportDatabase={() => refresh(syncRegisterToDatabase(), 'STOCK DOCUMENTS tab on Fleet Assets - KE copied into Neon.')} onBrowse={listDriveFolders} onBrowseSheets={listSpreadsheets} />}
        </>}
      </div>
    </main>
    {selected && <Drawer title={selected.plate} eyebrow="VEHICLE DETAILS" subtitle={`${selected.brand ? `${selected.brand} · ` : ''}${selected.present} / ${selected.total} required documents`} onClose={() => setSelected(null)}>
      <div className="detail-summary"><StatusBadge status={selected.status} /><strong>{selected.present} / {selected.total} documents</strong>{selected.brand ? <span className="muted-cell">{selected.brand}</span> : null}</div>
      <div className="cover-card">
        <div className="cover-card-head"><Clock size={16} /><strong>Insurance cover</strong>{selected.insurance?.alert ? <span className={`cover-flag ${selected.insurance.alert}`}>{coverAlertLabel(selected.insurance)}</span> : null}</div>
        <div className="cover-card-dates">
          <div><span>Commencement</span><strong>{formatCoverDate(selected.insurance?.commencement)}</strong></div>
          <div><span>Expiry</span><strong>{formatCoverDate(selected.insurance?.expiry)}</strong></div>
        </div>
      </div>
      <div className="document-list">{(['logbook', 'agreement', 'certificate', 'photo'] as DocType[]).map((type) => { const file = selected.files[type][0]; const downloadId = downloadableFileId(file); return <div className="document-row" key={type}><div className={`doc-icon ${file ? '' : 'missing'}`}><FileText size={16} /></div><div><strong>{type === 'agreement' ? 'Agreement link' : labelFor(type)}</strong><span>{file ? file.name : type === 'agreement' ? 'No Drive chip on Agreement Link' : 'Missing document'}</span>{type === 'certificate' ? <span className="cover-inline">Commencement {formatCoverDate(selected.insurance?.commencement)} · Expiry {formatCoverDate(selected.insurance?.expiry)}</span> : null}</div>{file ? <div className="doc-actions">{file.webViewLink ? <a className="doc-action" href={file.webViewLink} target="_blank" rel="noreferrer" aria-label={`Open ${labelFor(type)} in Drive`}><ArrowUpRight size={16} /></a> : null}{downloadId ? <a className="doc-action" href={`/documents/${downloadId}`} aria-label={`Download ${labelFor(type)}`}><Download size={16} /></a> : null}{!file.webViewLink && !downloadId ? <Check size={17} className="check-text" /> : null}</div> : <AlertCircle size={17} className="missing-text" />}</div> })}
        <div className="document-row"><div className={`doc-icon ${selected.collateral ? '' : 'missing'}`}><FileText size={16} /></div><div><strong>Collateral files</strong><span>{selected.collateral ? selected.collateral.name : 'No folder chip on STOCK DOCUMENTS'}</span></div>{selected.collateral?.webViewLink ? <a href={selected.collateral.webViewLink} target="_blank" rel="noreferrer"><ArrowUpRight size={17} /></a> : <AlertCircle size={17} className="missing-text" />}</div>
      </div>
      <button className="button primary full" onClick={() => openUpload()} disabled={!configured}>Upload missing document</button>
    </Drawer>}
    {uploadOpen && <UploadDialog defaultType={uploadType} onClose={() => setUploadOpen(false)} onUpload={async (form) => { await refresh(uploadDocument(form), 'Document uploaded to Drive.'); setUploadOpen(false) }} />}
    {helpOpen && <HelpDrawer onClose={() => setHelpOpen(false)} />}
  </div>
}
