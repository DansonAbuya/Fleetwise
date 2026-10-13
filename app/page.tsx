'use client'

import { FormEvent, ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signOut, useSession } from '@/lib/auth-client'
import { assignUnmatched, exportVehicleRegister, getProcessingJob, listDriveFolders, listSpreadsheets, loadFleet, loadVehiclePage, loadWorkspace, ocrUnmatchedPhotos, runProcessing, saveFolderConfig, stopProcessing, syncGmail, uploadDocument } from '@/app/actions/fleet'
import { listRegistrationNumbers } from '@/lib/plates'
import { processFocusLabel, type ProcessFocus, type ProcessJob } from '@/lib/processing'
import { EMPTY_STATS } from '@/lib/vehicles'
import { DEFAULT_COLLATERAL_PARENT_ID, type DocType, type DriveItem, type FleetSnapshot, type InboxItem, type TypedFile, type VehicleRecord } from '@/lib/types'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  ClipboardCheck,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  Play,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Truck,
  Upload,
  UserRound,
  X,
} from 'lucide-react'

type NavKey = 'Overview' | 'Vehicles' | 'Insurance inbox' | 'Processing' | 'Unmatched' | 'Audit log' | 'Settings'
type ViewSlug = 'overview' | 'vehicles' | 'inbox' | 'processing' | 'unmatched' | 'audit' | 'settings'
type StatusFilter = 'all' | 'Complete' | 'Needs attention'
type MissingFilter = 'logbook' | 'certificate' | 'photo' | 'collateral'

const MISSING_FILTERS: { id: MissingFilter; label: string }[] = [
  { id: 'logbook', label: 'Without logbook' },
  { id: 'certificate', label: 'Without certificate' },
  { id: 'photo', label: 'Without photo' },
  { id: 'collateral', label: 'Without collateral' },
]

const PROCESS_TASKS: { id: ProcessFocus; label: string; detail: string }[] = [
  { id: 'photos', label: 'Photos only', detail: 'Read plates from the photos folder and rename them.' },
  { id: 'certificates', label: 'Insurance only', detail: 'Read registration from insurance PDFs and photos.' },
  { id: 'all', label: 'All waiting files', detail: 'Photos, insurance, and other waiting documents.' },
  { id: 'repair', label: 'Fix wrong matches', detail: 'Recheck unmatched and wrongly named plates.' },
]

const SLUGS: Record<ViewSlug, NavKey> = {
  overview: 'Overview',
  vehicles: 'Vehicles',
  inbox: 'Insurance inbox',
  processing: 'Processing',
  unmatched: 'Unmatched',
  audit: 'Audit log',
  settings: 'Settings',
}

const TO_SLUG: Record<NavKey, ViewSlug> = {
  Overview: 'overview',
  Vehicles: 'vehicles',
  'Insurance inbox': 'inbox',
  Processing: 'processing',
  Unmatched: 'unmatched',
  'Audit log': 'audit',
  Settings: 'settings',
}

const nav = [
  { label: 'Overview' as const, icon: LayoutDashboard },
  { label: 'Vehicles' as const, icon: Truck },
  { label: 'Insurance inbox' as const, icon: Mail },
  { label: 'Processing' as const, icon: RefreshCw },
  { label: 'Unmatched' as const, icon: AlertCircle },
  { label: 'Audit log' as const, icon: History },
  { label: 'Settings' as const, icon: Settings },
]

const FOLDER_STORE = 'fleetwise-folders'
const VEHICLE_COUNT_STORE = 'fleetwise-vehicle-count'
const EMPTY_BRANDS: string[] = []

function rememberVehicleGrowth(count: number, newcomers: string[] = []) {
  if (!count) return ''
  try {
    const previousCount = Number(localStorage.getItem(VEHICLE_COUNT_STORE) || 0)
    let message = ''
    if (previousCount > 0 && count > previousCount) {
      const added = count - previousCount
      const listed = listRegistrationNumbers(newcomers)
      message = `The vehicle register grew by ${added}, from ${previousCount} to ${count}.${listed ? ` New Registration Number ${listed}.` : ''}`
    }
    localStorage.setItem(VEHICLE_COUNT_STORE, String(count))
    return message
  } catch {
    return ''
  }
}

function writeSavedFolders(input: { logbooksId: string; certificatesId: string; photosId: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number }) {
  try {
    localStorage.setItem(FOLDER_STORE, JSON.stringify({
      logbooksId: input.logbooksId,
      certificatesId: input.certificatesId,
      photosId: input.photosId,
      collateralId: input.collateralId,
      spreadsheetId: input.spreadsheetId,
      autoUploadThreshold: input.autoUploadThreshold ?? 85,
    }))
  } catch { /* ignore quota */ }
}

function readSavedFolders() {
  try {
    const raw = localStorage.getItem(FOLDER_STORE)
    if (!raw) return null
    const stored = JSON.parse(raw) as { logbooksId?: string; certificatesId?: string; photosId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number }
    if (!stored.logbooksId || !stored.certificatesId || !stored.photosId) return null
    return {
      logbooksId: stored.logbooksId,
      certificatesId: stored.certificatesId,
      photosId: stored.photosId,
      collateralId: stored.collateralId,
      spreadsheetId: stored.spreadsheetId,
      autoUploadThreshold: stored.autoUploadThreshold ?? 85,
    }
  } catch {
    return null
  }
}

function keepVehicles(current: FleetSnapshot | null, next: FleetSnapshot) {
  return {
    ...next,
    config: next.config || current?.config || null,
    vehicles: next.vehicles.length ? next.vehicles : current?.vehicles || [],
    stats: next.stats?.total ? next.stats : current?.stats || next.stats,
    sheetsError: next.sheetsError || current?.sheetsError,
    inbox: next.inbox.length ? next.inbox : current?.inbox || next.inbox,
    audit: next.audit.length ? next.audit : current?.audit || next.audit,
  }
}

function LoadingCard({ title, detail }: { title: string; detail: string }) {
  return <main className="auth-page"><div className="auth-card"><span className="eyebrow">FLEETWISE</span><h1>{title}</h1><p>{detail}</p></div></main>
}

function ConsoleShell({ user, children }: { user?: { name?: string; email?: string } | null; children?: ReactNode }) {
  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Truck size={18} /></div><div><strong>Fleetwise</strong><span>Kenya fleet ops</span></div></div>
      <div className="workspace-card"><div className="workspace-avatar">{initials}</div><div><span>Google Drive</span><small>{user?.email || 'Opening console'}</small></div></div>
      <nav className="nav-list" aria-label="Primary navigation">{nav.map(({ label, icon: Icon }) => <span key={label} className={`nav-item ${label === 'Overview' ? 'active' : ''}`}><Icon size={18} /><span>{label}</span></span>)}</nav>
    </aside>
    <main className="main-content">
      {children || <div className="page-wrap"><div className="busy-banner" role="status">Opening the operations console…</div></div>}
    </main>
  </div>
}

function ProfileMenu({ name, email, onLogout }: { name: string; email: string; onLogout: () => void }) {
  return <div className="profile-popover" role="menu">
    <div className="profile-popover-head">
      <strong>{name}</strong>
      <span>{email || 'Signed in with Google'}</span>
    </div>
    <button type="button" className="profile-logout" role="menuitem" onClick={onLogout}><LogOut size={16} /> Log out</button>
  </div>
}

function stubFleet(user: { name: string; email: string; image?: string }, folders: ReturnType<typeof readSavedFolders>): FleetSnapshot {
  return {
    user,
    config: folders ? {
      logbooksId: folders.logbooksId,
      certificatesId: folders.certificatesId,
      photosId: folders.photosId,
      collateralId: folders.collateralId,
      spreadsheetId: folders.spreadsheetId,
      autoUploadThreshold: folders.autoUploadThreshold ?? 85,
    } : null,
    vehicles: [],
    unmatched: [],
    inbox: [],
    audit: [],
    stats: EMPTY_STATS,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: true,
    sheetsConnected: Boolean(folders?.spreadsheetId),
  }
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function labelFor(type: DocType) {
  if (type === 'logbook') return 'Logbook'
  if (type === 'certificate') return 'Insurance certificate'
  return 'Vehicle photo'
}

function isPhotoFile(file: TypedFile) {
  const mime = (file.mimeType || '').toLowerCase()
  if (mime.includes('svg') || mime.includes('heic') || mime.includes('heif')) return false
  if (mime.startsWith('image/') || mime.includes('pdf')) return true
  return /\.(png|jpe?g|webp|gif|bmp|tif?f|pdf)$/i.test(file.name)
}

function isAuthError(message: string) {
  return /unauthorized|sign in|expired|google session/i.test(message)
}

function downloadableFileId(file?: { id?: string; webViewLink?: string }) {
  if (!file) return
  if (file.webViewLink && /\/folders\//i.test(file.webViewLink)) return
  if (file.id && !file.id.startsWith('sheet:')) return file.id
  return file.webViewLink?.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)?.[1]
    || file.webViewLink?.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1]
}

function hasRegisterItem(vehicle: VehicleRecord, item: MissingFilter) {
  if (item === 'collateral') return Boolean(vehicle.collateral)
  return vehicle.files[item].length > 0
}

function BrandFilter({ value, brands, unbrandedCount, onChange }: { value: string; brands: string[]; unbrandedCount: number; onChange: (next: string) => void }) {
  if (!brands.length && !unbrandedCount) return null
  return <label className="field-label brand-filter">Brand<select className="assign-input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter by brand">
    <option value="all">All brands</option>
    {unbrandedCount > 0 && <option value="__none">No brand</option>}
    {brands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
  </select></label>
}

function MissingFilters({ value, onChange }: { value: MissingFilter[]; onChange: (next: MissingFilter[]) => void }) {
  function toggle(id: MissingFilter) {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
  }
  return <div className="filter-chips" role="group" aria-label="Show vehicles missing documents">
    {MISSING_FILTERS.map((filter) => <button type="button" key={filter.id} className={`filter-chip ${value.includes(filter.id) ? 'active' : ''}`} aria-pressed={value.includes(filter.id)} onClick={() => toggle(filter.id)}>{filter.label}</button>)}
    {value.length > 0 && <button type="button" className="text-button" onClick={() => onChange([])}>Clear</button>}
  </div>
}

function StatusBadge({ status }: { status: VehicleRecord['status'] }) {
  const styles = status === 'Complete' ? 'status-complete' : 'status-attention'
  return <span className={`status-badge ${styles}`}><span className="status-dot" />{status}</span>
}

function Drawer({ title, eyebrow, subtitle, onClose, wide, children }: { title: string; eyebrow: string; subtitle?: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
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

function FleetApp() {
  const router = useRouter()
  const params = useSearchParams()
  const { user, isPending } = useSession()
  const slug = (params.get('view') as ViewSlug) || 'overview'
  const active = SLUGS[slug] || 'Overview'
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
  const [registerTick, setRegisterTick] = useState(0)
  const [processJob, setProcessJob] = useState<ProcessJob | null>(null)
  const [batchNotice, setBatchNotice] = useState('')
  const batchCountRef = useRef(0)
  const lastBatchKey = useRef('')
  useEffect(() => {
    setMounted(true)
    setDateLabel(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase())
    setHello(greeting())
    const folders = readSavedFolders()
    if (folders) {
      setFleet((current) => current || stubFleet({ name: 'Fleetwise', email: '' }, folders))
    }
  }, [])
  useEffect(() => {
    setLastSyncLabel(fleet?.lastSync ? new Date(fleet.lastSync).toLocaleString() : 'Not synced')
  }, [fleet?.lastSync])

  function go(view: NavKey) {
    setMobileNav(false)
    setNotificationsOpen(false)
    setProfileMenu(null)
    router.push(`/?view=${TO_SLUG[view]}`)
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
    setRegisterTick((tick) => tick + 1)
    if (next.ingest?.notice) setSuccess(ok ? `${ok} ${next.ingest.notice}` : next.ingest.notice)
    else if (ok) setSuccess(ok)
  }

  async function refresh(loader: Promise<FleetSnapshot> = loadFleet(), ok?: string) {
    autoScanLock.current = true
    setBusy(ok ? 'Working…' : 'Loading Drive…')
    setError('')
    setSuccess('')
    try {
      let next = await loader
      while (true) {
        applySnapshot(next, ok)
        ok = undefined
        if (!next.ingest?.more) break
        const left = next.ingest.remaining ? ` · ${next.ingest.remaining} still need a plate` : ''
        setBusy(`Starting the next batch${left}`)
        next = await loadFleet('auto')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Drive')
    } finally {
      autoScanLock.current = false
      setBusy('')
    }
  }

  const restoredFolders = useRef(false)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    async function boot() {
      setBusy('Opening console…')
      setError('')
      try {
        const workspace = await loadWorkspace()
        if (cancelled) return
        setFleet((current) => keepVehicles(current, workspace))
        setBusy('Loading the vehicle register…')
        autoScanLock.current = true
        try {
          let next = await loadFleet()
          while (true) {
            if (!cancelled) applySnapshot(next, next.ingest?.notice)
            else moreWorkRef.current = Boolean(next.ingest?.more)
            if (!next.ingest?.more) break
            if (!cancelled) {
              const left = next.ingest.remaining ? ` · ${next.ingest.remaining} still need a plate` : ''
              setBusy(`Starting the next batch${left}`)
            }
            next = await loadFleet('auto')
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Drive')
        } finally {
          autoScanLock.current = false
          if (!cancelled) setBusy('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Drive')
        setBusy('')
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
    if (local.logbooksId !== fleet.config.logbooksId || local.certificatesId !== fleet.config.certificatesId || local.photosId !== fleet.config.photosId) {
      refresh(saveFolderConfig(local), 'Restored your saved Drive folders.')
    }
  }, [fleet?.config])
  useEffect(() => {
    if (!user) return
    async function watchFolders() {
      if (document.hidden || autoScanLock.current || activeRef.current === 'Settings') return
      autoScanLock.current = true
      try {
        let next = await loadFleet('auto')
        while (true) {
          applySnapshot(next, next.ingest?.notice)
          if (!next.ingest?.more) break
          next = await loadFleet('auto')
        }
      } catch {
        // Keep watching; the next tick retries.
      } finally {
        autoScanLock.current = false
      }
    }
    const timer = window.setInterval(watchFolders, 45_000)
    document.addEventListener('visibilitychange', watchFolders)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', watchFolders)
    }
  }, [user])
  useEffect(() => {
    if (!user || !fleet?.ingest?.more) return
    const timer = window.setInterval(() => {
      if (autoScanLock.current || document.hidden || activeRef.current === 'Settings') return
      refresh(loadFleet('auto'))
    }, 800)
    return () => window.clearInterval(timer)
  }, [user, fleet?.ingest?.more])
  useEffect(() => {
    if (params.get('view') && !SLUGS[slug]) router.replace('/?view=overview')
  }, [params, slug, router])
  useEffect(() => {
    if (fleet && !fleet.config && slug !== 'settings') router.replace('/?view=settings')
  }, [fleet, slug, router])
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
  const inbox = fleet?.inbox || []
  const stats = fleet?.stats
  const reviewCount = inbox.filter((item) => item.status === 'Needs review').length
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
        setFleet((current) => current ? { ...current, vehicles: result.vehicles, stats: result.stats, sheetsError: result.error || current.sheetsError } : current)
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
    const timer = window.setInterval(tick, processJob?.running || fleet?.ingest?.more ? 700 : 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [user, active, processJob?.running])
  const notifications = [
    ...unmatched.slice(0, 8).map((file) => ({ id: file.id, title: 'Unmatched document', message: file.name, time: file.modifiedTime || '', view: 'Unmatched' as NavKey })),
    ...inbox.filter((item) => item.status === 'Needs review').map((item) => ({ id: item.id, title: 'Certificate needs review', message: `${item.vehicle} · ${item.attachment}`, time: item.received, view: 'Insurance inbox' as NavKey })),
  ]
  const initials = (user?.name || 'FW').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const title = active === 'Overview' ? `${hello}, ${user?.name?.split(' ')[0] || 'there'}` : active
  const subtitle = active === 'Overview' ? 'New Drive files are detected, renamed with the plate, and matched to registration rows in Sheets.' : `Review and manage your ${active.toLowerCase()} workspace.`

  function openUpload(type?: DocType) {
    if (!configured) {
      setError('Configure the three Drive folders in Settings before uploading.')
      go('Settings')
      return
    }
    if (type) setUploadType(type)
    else {
      const missing = selected ? (['logbook', 'certificate', 'photo'] as DocType[]).find((item) => selected.files[item].length === 0) : undefined
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
      <div className="brand"><div className="brand-mark"><Truck size={18} /></div><div><strong>Fleetwise</strong><span>Kenya fleet ops</span></div></div>
        <div className="workspace-card"><div className="workspace-avatar">{initials}</div><div><span>Google Drive</span><small>{sessionUser.email}</small></div></div>
      <nav className="nav-list" aria-label="Primary navigation">{nav.map(({ label, icon: Icon }) => {
        const remaining = processJob?.running ? Math.max(0, processJob.attempted - processJob.done) : 0
        const count = label === 'Unmatched' ? unmatched.length : label === 'Insurance inbox' ? reviewCount : label === 'Processing' ? remaining : 0
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
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Operations</span><span>/</span><strong>{active}</strong></div><div className="top-actions"><div className="notification-wrap"><button className="icon-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => { setProfileMenu(null); setNotificationsOpen(!notificationsOpen) }}><Bell size={19} />{notifications.length > 0 && <i />}</button>{notificationsOpen && <div className="notification-popover" role="menu"><div className="notification-head"><div><strong>Notifications</strong><span>{notifications.length} open</span></div></div><div className="notification-list">{notifications.length === 0 ? <div className="notification-item read"><span /><span><strong>All clear</strong><small>No unmatched files or certificates waiting.</small></span></div> : notifications.map((notification) => <button className="notification-item" key={notification.id} onClick={() => go(notification.view)}><span className="notification-icon"><ShieldCheck size={15} /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><time>{notification.time}</time></span><b /></button>)}</div></div>}</div><div className="profile-wrap profile-wrap-top"><button type="button" className="top-avatar" aria-label="Open account menu" aria-haspopup="menu" aria-expanded={profileMenu === 'top'} onClick={() => toggleProfileMenu('top')}>{initials}</button>{profileMenu === 'top' && <ProfileMenu name={sessionUser.name} email={sessionUser.email} onLogout={() => signOut()} />}</div></div></header>
      <div className="page-wrap">
        <div className="page-heading"><div><div className="date-label">{dateLabel}</div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions"><button className="button secondary" onClick={() => exportCsv({ query, status: statusFilter, brand: brandFilter, missing: missingFilters })} disabled={!vehicleCount}><ArrowDownToLine size={16} /> Export report</button><button className="button primary" onClick={() => openUpload()} disabled={!configured}><Upload size={16} /> Upload documents</button></div></div>
        {busy && <div className="busy-banner" role="status">{busy}</div>}
        {batchNotice && <div className="busy-banner process-batch-banner" role="status"><LoaderCircle size={16} className="spin-icon" /><span>{batchNotice}</span>{active !== 'Processing' && <button type="button" onClick={() => go('Processing')}>Watch live</button>}<button type="button" onClick={() => setBatchNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {processJob?.running && active !== 'Processing' && <button type="button" className="busy-banner process-live-banner" onClick={() => go('Processing')}>{processJob.advancing ? `Batch ${processJob.batch || 1} of ${processFocusLabel(processJob.focus)} finished — starting the next files` : processJob.currentId ? `${processFocusLabel(processJob.focus)} live · ${processJob.done} of ${processJob.attempted} finished` : processFocusLabel(processJob.focus)} — open the live board</button>}
        {success && <div className="success-banner" role="status">{success}<button type="button" onClick={() => setSuccess('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {error && <div className={`auth-error banner-error`} role="alert">{error}{isAuthError(error) && <a className="text-button" href="/sign-in">Sign in again</a>}<button type="button" className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
        {fleet?.sheetsError && <div className="auth-error banner-error" role="alert">{/403|PERMISSION|ACCESS_TOKEN|insufficient/i.test(fleet.sheetsError) ? 'Sheets matching failed. Enable the Google Sheets API, then sign out and in again to grant spreadsheet access.' : fleet.sheetsError}</div>}
        {fleet?.ingest?.error && <div className="auth-error banner-error" role="alert">{fleet.ingest.error}</div>}
        {active === 'Overview' && <>
          <div className="kpi-grid">
            <button type="button" className="kpi-card kpi-card-button" onClick={() => go('Vehicles')}><div className="kpi-icon blue"><Truck size={19} /></div><div><p className="eyebrow">Total vehicles</p><div className="kpi-value">{vehicleCount}</div><p className="kpi-detail">{fleet?.config?.spreadsheetName || 'Plates from Sheets, filenames, and photo OCR'}</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => { setStatusFilter('Complete'); setVehiclePage(1); go('Vehicles') }}><div className="kpi-icon green"><ClipboardCheck size={19} /></div><div><p className="eyebrow">Complete packs</p><div className="kpi-value">{complete}</div><p className="kpi-detail">Logbook + certificate + photo + collateral</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => go('Unmatched')}><div className="kpi-icon orange"><AlertCircle size={19} /></div><div><p className="eyebrow">Need attention</p><div className="kpi-value">{attention}</div><p className="kpi-detail">{unmatched.length} unmatched files</p></div></button>
            <button type="button" className="kpi-card kpi-card-button" onClick={() => go('Processing')}><div className="kpi-icon purple"><RefreshCw size={19} /></div><div><p className="eyebrow">Last sync</p><div className="kpi-value">{fleet?.lastSync ? 'Synced' : '—'}</div><p className="kpi-detail">{configured ? lastSyncLabel : 'Folders not configured'}</p></div></button>
          </div>
          <div className="content-grid"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Folder coverage</h2><p>Share of vehicles that have each document type</p></div></div><Coverage stats={stats} /></section>
            <section className="panel attention-panel"><div className="panel-heading"><div><h2>Needs your attention</h2><p>Open the queue that needs a review</p></div></div>
              <div className="attention-list">
                <button type="button" className="attention-item" onClick={() => go('Unmatched')}><div className="attention-icon orange"><AlertCircle size={17} /></div><div><strong>{unmatched.length} unmatched documents</strong><span>Watching {fleet?.config?.photosName || 'the photos folder'} — drop files there, then Scan folders</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => { setStatusFilter('Needs attention'); setVehiclePage(1); go('Vehicles') }}><div className="attention-icon yellow"><FileText size={17} /></div><div><strong>{attention} vehicles incomplete</strong><span>Missing logbook, certificate, photo, or collateral folder</span></div><ArrowUpRight size={16} /></button>
                <button type="button" className="attention-item" onClick={() => go('Insurance inbox')}><div className="attention-icon blue"><Mail size={17} /></div><div><strong>{reviewCount} certificates need review</strong><span>Gmail attachments below the match threshold</span></div><ArrowUpRight size={16} /></button>
              </div>
            </section>
          </div>
          <section className="panel table-panel"><div className="panel-heading"><div><h2>Vehicle document register</h2><p>Completeness is 4 of 4: logbook, certificate, photo, collateral files</p></div><button className="text-button" onClick={() => go('Vehicles')}>View all vehicles <ArrowUpRight size={15} /></button></div><div className="table-toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setVehiclePage(1) }} placeholder="Search plate or brand..." aria-label="Search plate or brand" /></div><BrandFilter value={brandFilter} brands={brands} unbrandedCount={unbrandedCount} onChange={(next) => { setBrandFilter(next); setVehiclePage(1) }} /><MissingFilters value={missingFilters} onChange={(next) => { setMissingFilters(next); setVehiclePage(1) }} /></div><VehicleTable vehicles={vehicles} total={vehicleTotal} page={1} pageSize={10} loading={tableBusy} onSelect={setSelected} /></section>
        </>}
        {active === 'Vehicles' && <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>All vehicles</h2><p>{fleet?.config?.spreadsheetId ? `Matched to Registration Number rows on STOCK DOCUMENTS in ${fleet.config.spreadsheetName || 'Fleet Assets'}.` : 'Vehicles come from STOCK DOCUMENTS on Fleet Assets or Fleet Assets - KE once Sheets access is granted.'}</p></div><button className="button primary" onClick={() => openUpload()} disabled={!configured}><Plus size={16} /> Upload document</button></div><div className="table-toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setVehiclePage(1) }} placeholder="Search plate or brand..." aria-label="Search plate or brand" /></div><label className="field-label">Status<select className="assign-input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setVehiclePage(1) }}><option value="all">All</option><option value="Complete">Complete</option><option value="Needs attention">Needs attention</option></select></label><BrandFilter value={brandFilter} brands={brands} unbrandedCount={unbrandedCount} onChange={(next) => { setBrandFilter(next); setVehiclePage(1) }} /><MissingFilters value={missingFilters} onChange={(next) => { setMissingFilters(next); setVehiclePage(1) }} /></div><VehicleTable vehicles={vehicles} total={vehicleTotal} page={vehiclePage} pageSize={vehiclePageSize} pageSizes={[25, 50, 100]} loading={tableBusy} onPageChange={setVehiclePage} onPageSizeChange={(size) => { setVehiclePageSize(size); setVehiclePage(1) }} onSelect={setSelected} /></section>}
        {active === 'Insurance inbox' && <InboxView inbox={inbox} config={fleet?.config ?? null} gmailConnected={Boolean(fleet?.gmailConnected)} ocrConfigured={Boolean(fleet?.ocrConfigured)} busy={Boolean(busy)} onSync={() => refresh(syncGmail(), 'Gmail inbox checked.')} onAssign={(input) => refresh(assignUnmatched(input), `Assigned ${input.plate}.`)} />}
        {active === 'Processing' && <ProcessingView lastSync={fleet?.lastSync} vehicles={vehicleCount} unmatched={unmatched} busy={Boolean(busy)} configured={configured} ocrConfigured={Boolean(fleet?.ocrConfigured)} ingest={fleet?.ingest} job={processJob} photosFolder={fleet?.config?.photosName} certificatesFolder={fleet?.config?.certificatesName} onScan={() => refresh(loadFleet('full', false, 'off'), 'Folders scanned. No OCR ran — start photos, insurance, or match repair below.')} onGmail={() => refresh(syncGmail(), 'Gmail inbox checked.')} onOcr={() => refresh(ocrUnmatchedPhotos(), 'Read plates from unmatched photos and insurance files.')} onStart={async (focus) => { if ((processJob?.running || processJob?.advancing) && processJob.focus && processJob.focus !== focus) await stopProcessing(); const prior = processJob?.lastAction || fleet?.ingest?.lastAction; const resume = prior?.focus === focus && (prior.status === 'paused' || prior.status === 'running'); return refresh(runProcessing(focus), resume ? `Continuing ${processFocusLabel(focus)} from ${prior?.fileName || 'the last file'}.` : `Started ${processFocusLabel(focus)}. Stop to pause; start the same job to continue from there.`) }} onStop={async () => { const next = await stopProcessing(); setProcessJob(next); moreWorkRef.current = false; setFleet((current) => current?.ingest ? { ...current, ingest: { ...current.ingest, more: false, remaining: next.lastAction?.remaining || current.ingest.remaining, lastAction: next.lastAction } } : current); setBusy(''); setBatchNotice(''); setSuccess(next.lastAction?.fileName ? `Paused after ${next.lastAction.fileName}. Start the same job to continue.` : 'Paused. Start the same job to continue from this point.') }} />}
        {active === 'Unmatched' && <UnmatchedView files={unmatched} busy={Boolean(busy)} ocrConfigured={Boolean(fleet?.ocrConfigured)} onAssign={(input) => refresh(assignUnmatched(input), `Assigned ${input.plate}.`)} onOcr={(fileId) => refresh(ocrUnmatchedPhotos(fileId), fileId ? 'Read plate from file.' : 'Read plates from unmatched photos and insurance files.')} />}
        {active === 'Audit log' && <AuditView events={fleet?.audit || []} onExport={() => exportAudit(fleet?.audit || [])} />}
        {active === 'Settings' && <SettingsView fleet={fleet} firstRun={!configured} busy={Boolean(busy) && busy !== 'Loading Drive…' && busy !== 'Opening console…' && busy !== 'Loading the vehicle register…'} onSave={(input) => { writeSavedFolders(input); return refresh(saveFolderConfig(input), 'Folder and sheet configuration saved.') }} onBrowse={listDriveFolders} onBrowseSheets={listSpreadsheets} />}
      </div>
    </main>
    {selected && <Drawer title={selected.plate} eyebrow="VEHICLE DETAILS" subtitle={`${selected.brand ? `${selected.brand} · ` : ''}${selected.present} / ${selected.total} required documents`} onClose={() => setSelected(null)}>
      <div className="detail-summary"><StatusBadge status={selected.status} /><strong>{selected.present} / {selected.total} documents</strong>{selected.brand ? <span className="muted-cell">{selected.brand}</span> : null}</div>
      <div className="document-list">{(['logbook', 'certificate', 'photo'] as DocType[]).map((type) => { const file = selected.files[type][0]; const downloadId = downloadableFileId(file); return <div className="document-row" key={type}><div className={`doc-icon ${file ? '' : 'missing'}`}><FileText size={16} /></div><div><strong>{labelFor(type)}</strong><span>{file ? file.name : 'Missing document'}</span></div>{file ? <div className="doc-actions">{file.webViewLink ? <a className="doc-action" href={file.webViewLink} target="_blank" rel="noreferrer" aria-label={`Open ${labelFor(type)} in Drive`}><ArrowUpRight size={16} /></a> : null}{downloadId ? <a className="doc-action" href={`/documents/${downloadId}`} aria-label={`Download ${labelFor(type)}`}><Download size={16} /></a> : null}{!file.webViewLink && !downloadId ? <Check size={17} className="check-text" /> : null}</div> : <AlertCircle size={17} className="missing-text" />}</div> })}
        <div className="document-row"><div className={`doc-icon ${selected.collateral ? '' : 'missing'}`}><FileText size={16} /></div><div><strong>Collateral files</strong><span>{selected.collateral ? selected.collateral.name : 'No folder chip on STOCK DOCUMENTS'}</span></div>{selected.collateral?.webViewLink ? <a href={selected.collateral.webViewLink} target="_blank" rel="noreferrer"><ArrowUpRight size={17} /></a> : <AlertCircle size={17} className="missing-text" />}</div>
      </div>
      <button className="button primary full" onClick={() => openUpload()} disabled={!configured}>Upload missing document</button>
    </Drawer>}
    {uploadOpen && <UploadDialog defaultType={uploadType} onClose={() => setUploadOpen(false)} onUpload={async (form) => { await refresh(uploadDocument(form), 'Document uploaded to Drive.'); setUploadOpen(false) }} />}
    {helpOpen && <HelpDrawer onClose={() => setHelpOpen(false)} />}
  </div>
}

function Coverage({ stats }: { stats?: FleetSnapshot['stats'] }) {
  const total = stats?.total || 0
  const counts = {
    logbook: stats?.logbook || 0,
    certificate: stats?.certificate || 0,
    photo: stats?.photo || 0,
    collateral: stats?.collateral || 0,
  }
  return <div className="coverage-list">{(['logbook', 'certificate', 'photo'] as const).map((type) => <div className="coverage-row" key={type}><span>{labelFor(type)}</span><div className="big-progress coverage-bar"><span style={{ width: `${total ? Math.round((counts[type] / total) * 100) : 0}%` }} /></div><strong>{total ? Math.round((counts[type] / total) * 100) : 0}%</strong></div>)}
    <div className="coverage-row"><span>Collateral files</span><div className="big-progress coverage-bar"><span style={{ width: `${total ? Math.round((counts.collateral / total) * 100) : 0}%` }} /></div><strong>{total ? Math.round((counts.collateral / total) * 100) : 0}%</strong></div>
  </div>
}

function VehicleTable({ vehicles, total, page, pageSize, pageSizes, loading, onPageChange, onPageSizeChange, onSelect }: { vehicles: VehicleRecord[]; total: number; page: number; pageSize: number; pageSizes?: number[]; loading?: boolean; onPageChange?: (page: number) => void; onPageSizeChange?: (size: number) => void; onSelect: (vehicle: VehicleRecord) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(page * pageSize, total)
  return <div>
    {loading && <div className="busy-banner" role="status">Loading vehicles…</div>}
    <div className="table-scroll"><table><thead><tr><th>Vehicle</th><th>Brand</th><th>Logbook</th><th>Certificate</th><th>Photo</th><th>Collateral</th><th>Status</th><th>Last updated</th></tr></thead><tbody>{!vehicles.length ? <tr className="empty-row-tr"><td colSpan={8}>{loading ? 'Loading the register…' : 'No plates found in the configured folders yet.'}</td></tr> : vehicles.map((vehicle) => <tr key={vehicle.plate} onClick={() => onSelect(vehicle)}><td><strong className="plate-id">{vehicle.plate}</strong><span className="muted-cell">{vehicle.present} / {vehicle.total} documents</span></td><td>{vehicle.brand || '—'}</td><td className={vehicle.files.logbook.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.logbook.length ? 'Yes' : 'Missing'}</td><td className={vehicle.files.certificate.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.certificate.length ? 'Yes' : 'Missing'}</td><td className={vehicle.files.photo.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.photo.length ? 'Yes' : 'Missing'}</td><td className={vehicle.collateral ? 'cell-yes' : 'cell-no'}>{vehicle.collateral ? 'Yes' : 'Missing'}</td><td><StatusBadge status={vehicle.status} /></td><td className="muted-cell">{vehicle.updated}</td></tr>)}</tbody></table></div>
    {total > 0 && <div className="table-pagination">
      <span className="table-pagination-meta">Showing {from}–{to} of {total}</span>
      {pageSizes && pageSizes.length > 1 && <label className="field-label table-page-size">Rows<select className="assign-input" value={pageSize} onChange={(e) => onPageSizeChange?.(Number(e.target.value))} aria-label="Rows per page">{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
      <div className="table-pagination-controls">
        <button type="button" className="button secondary pagination-nav" onClick={() => onPageChange?.(Math.max(1, page - 1))} disabled={page <= 1 || !onPageChange} aria-label="Previous page"><ChevronLeft size={16} /> Previous</button>
        {pageNumbers(page, totalPages).map((item, index) => item === '…' ? <span key={`gap-${index}`} className="pagination-gap">…</span> : <button type="button" key={item} className={`pagination-page ${page === item ? 'active' : ''}`} onClick={() => onPageChange?.(item)} aria-current={page === item ? 'page' : undefined}>{item}</button>)}
        <button type="button" className="button secondary pagination-nav" onClick={() => onPageChange?.(Math.min(totalPages, page + 1))} disabled={page >= totalPages || !onPageChange} aria-label="Next page">Next <ChevronRight size={16} /></button>
      </div>
    </div>}
  </div>
}

function pageNumbers(page: number, totalPages: number) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const items: Array<number | '…'> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(totalPages - 1, page + 1)
  if (start > 2) items.push('…')
  for (let value = start; value <= end; value++) items.push(value)
  if (end < totalPages - 1) items.push('…')
  items.push(totalPages)
  return items
}

function InboxView({ inbox, config, gmailConnected, ocrConfigured, busy, onSync, onAssign }: { inbox: InboxItem[]; config: FleetSnapshot['config']; gmailConnected: boolean; ocrConfigured: boolean; busy: boolean; onSync: () => void; onAssign: (input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) => Promise<void> | void }) {
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [plate, setPlate] = useState('')
  const [assignError, setAssignError] = useState('')
  const foldersSet = Boolean(config)
  return <div className="view-stack"><section className="panel inbox-summary"><div><span className="eyebrow">GMAIL INTAKE</span><h2>Insurance certificates</h2><p>Attachments are matched by plate in the filename, email, or photo OCR, then stored in {config?.certificatesName || 'the certificates folder'}.{ocrConfigured ? '' : ' Photo OCR is off.'}</p></div><div className="inbox-summary-actions"><span className={`connected-pill ${gmailConnected ? '' : 'muted'}`}>{gmailConnected ? 'Gmail checked' : 'Gmail not checked yet'}</span><span className={`connected-pill ${foldersSet ? '' : 'muted'}`}>{foldersSet ? 'Folders configured' : 'Folders not set'}</span></div></section><div className="inbox-kpis"><div><span>In queue</span><strong>{inbox.length}</strong></div><div><span>Auto-uploaded</span><strong className="green-text">{inbox.filter((item) => item.status === 'Auto-uploaded').length}</strong></div><div><span>Needs review</span><strong className="orange-text">{inbox.filter((item) => item.status === 'Needs review').length}</strong></div><div><span>Destination</span><strong>{config?.certificatesName || 'Certificates'}</strong></div></div><section className="panel table-panel standalone"><div className="panel-heading"><div><h2>Insurance inbox</h2><p>Low-confidence files stay unmatched until you assign a plate.</p></div><button className="button secondary" onClick={onSync} disabled={busy || !foldersSet}><RefreshCw size={15} /> Check inbox</button></div><div className="inbox-list">{inbox.length === 0 ? <div className="empty-row">No Gmail attachments processed yet.</div> : inbox.map((item) => <button className="inbox-row" key={item.id} onClick={() => { setSelected(item); setPlate(item.vehicle.includes(' ') || /^K[A-Z]{2}/i.test(item.vehicle) ? item.vehicle : ''); setAssignError('') }}><div className={`mail-icon ${item.status === 'Needs review' ? 'review' : 'uploaded'}`}><Mail size={18} /></div><div className="inbox-main"><strong>{item.subject}</strong><span>{item.sender} · {item.received}</span><small><FileText size={13} /> {item.attachment}</small></div><div className="inbox-match"><span>Registration number</span><strong>{item.vehicle}</strong><small>{item.confidence}% confidence</small></div><div className="inbox-destination"><span>Destination</span><strong>{item.folder}</strong></div><span className={`inbox-status ${item.status === 'Needs review' ? 'needs-review' : 'uploaded'}`}>{item.status}</span><ArrowUpRight size={16} className="inbox-open" /></button>)}</div></section>
    {selected && <Drawer title={selected.attachment} eyebrow="EMAIL INTAKE DETAIL" subtitle={selected.sender} wide onClose={() => setSelected(null)}>
      <div className="detail-summary"><span className={`inbox-status ${selected.status === 'Needs review' ? 'needs-review' : 'uploaded'}`}>{selected.status}</span><strong>{selected.confidence}% match confidence</strong></div>
      {selected.status === 'Needs review' && selected.fileId ? <form className="upload-form" onSubmit={async (event) => { event.preventDefault(); if (!plate.trim()) { setAssignError('Enter a registration plate.'); return } await onAssign({ fileId: selected.fileId!, plate, type: 'certificate', currentType: 'certificate', name: selected.attachment }); setSelected(null) }}><label className="field-label">Registration plate<input className="assign-input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="KDA 482M" /></label>{assignError && <div className="auth-error">{assignError}</div>}<div className="drawer-actions"><button className="button primary" type="submit" disabled={busy}>Assign to plate</button><button className="button secondary" type="button" onClick={() => setSelected(null)}>Close</button></div></form> : <><p className="drawer-copy">This certificate is already in the certificates folder with a plate filename.</p><button className="button secondary" onClick={() => setSelected(null)}>Close</button></>}
    </Drawer>}
  </div>
}

const PROCESS_STEPS = ['queued', 'opening', 'reading', 'renaming', 'matching', 'matched'] as const

function processStageLabel(stage: string, plate?: string | null) {
  if (stage === 'queued') return 'Queued'
  if (stage === 'opening') return 'Opening'
  if (stage === 'reading') return 'Reading plate'
  if (stage === 'renaming') return 'Renaming'
  if (stage === 'matching') return 'Matching sheet'
  if (stage === 'matched') return 'Matched'
  if (stage === 'unmatched') return plate ? 'Not on register' : 'Needs a plate'
  if (stage === 'error') return 'Could not process'
  return stage
}

function ProcessThumb({ item }: { item: { fileId: string; name: string; preview: boolean; type: DocType } }) {
  const [broken, setBroken] = useState(false)
  if (item.preview && !broken) {
    return <img className="process-thumb-img" src={`/documents/${item.fileId}?preview=1`} alt={item.name} onError={() => setBroken(true)} />
  }
  return item.type === 'photo' ? <ImageIcon size={22} /> : <FileText size={22} />
}

function ProcessingView({ lastSync, vehicles, unmatched, busy, configured, ocrConfigured, ingest, job, photosFolder, certificatesFolder, onScan, onGmail, onOcr, onStart, onStop }: { lastSync?: string; vehicles: number; unmatched: TypedFile[]; busy: boolean; configured: boolean; ocrConfigured: boolean; ingest?: FleetSnapshot['ingest']; job: ProcessJob | null; photosFolder?: string; certificatesFolder?: string; onScan: () => void; onGmail: () => void; onOcr: () => void; onStart: (focus: ProcessFocus) => void | Promise<void>; onStop: () => void | Promise<void> }) {
  const percent = job?.attempted ? Math.round((job.done / job.attempted) * 100) : 0
  const liveIds = new Set((job?.items || []).map((item) => item.fileId))
  const waiting = unmatched.filter((file) => !liveIds.has(file.id))
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
              : `Start photos, insurance, all waiting files, or only wrong matches. Stop pauses the job; starting the same one continues from the last file. Photos folder: ${photosFolder || 'not set'}. Insurance folder: ${certificatesFolder || 'not set'}.`}</p>
      </div>
      {advancing && <div className="process-advance" role="status"><LoaderCircle size={16} className="spin-icon" /> Ending batch {batch} and opening the next {remaining ? `${Math.min(12, remaining)} of ${remaining}` : 'files'}.</div>}
      <div className="process-tasks" role="group" aria-label="Processing jobs">
        {PROCESS_TASKS.map((task) => {
          const current = (job?.focus || ingest?.focus) === task.id && live
          return <button key={task.id} type="button" className={`process-task ${current ? 'active' : ''}`} disabled={!configured || !ocrConfigured || (busy && !live)} onClick={() => onStart(task.id)}>
            <strong>{task.label}</strong>
            <span>{task.detail}</span>
            {current ? <em>Running</em> : last?.focus === task.id && last.status === 'paused' ? <em><Play size={12} /> Continue</em> : <em><Play size={12} /> Start</em>}
          </button>
        })}
      </div>
      <div className="big-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      <div className="process-stats"><span><strong>{vehicles}</strong> vehicles</span><span><strong>{unmatched.length}</strong> unmatched</span><span><strong>{job?.running ? `${job.done}/${job.attempted}` : lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</strong> {job?.running ? 'finished' : 'last sync'}</span></div>
      <div className="heading-actions" style={{ marginTop: 18 }}>
        <button className="button primary" onClick={onStop} disabled={!live && !job?.running}><Square size={15} /> Stop</button>
        <button className="button secondary" onClick={onScan} disabled={busy || !configured}><RefreshCw size={15} /> Scan folders</button>
        <button className="button secondary" onClick={onGmail} disabled={busy || !configured}><Mail size={15} /> Check Gmail</button>
        <button className="button secondary" onClick={onOcr} disabled={busy || !configured || !ocrConfigured}><ScanLine size={15} /> Read plates</button>
      </div>
    </section>
    <section className="panel table-panel standalone">
      <div className="panel-heading"><div><h2>{advancing ? `Starting batch ${(job?.batch || 1) + 1}` : job?.running ? `Now processing · batch ${batch}` : 'Processing queue'} {(job?.items.length || waiting.length) ? <span className="count-pill">{(job?.items.length || 0) + waiting.length}</span> : null}</h2><p>{advancing ? 'This batch is complete. The next files are being opened, read, and matched.' : job?.running ? 'Each card updates as the file is opened, read, renamed, and matched. The next batch starts when this one finishes.' : 'Drop files in the photos or insurance folders, then watch them here until they match a Registration Number.'}</p></div>{job?.running ? <span className="live-pill"><LoaderCircle size={14} className="spin-icon" /> Live</span> : advancing ? <span className="live-pill"><LoaderCircle size={14} className="spin-icon" /> Next batch</span> : ingest?.more ? <span className="live-pill">Next batch</span> : null}</div>
      <div className="process-board">
        {(!job?.items.length && waiting.length === 0) ? <div className="empty-row">No files in the live queue. New photos and certificates appear here as they are processed.</div> : null}
        {(job?.items || []).map((item) => {
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
            <span className={`process-flag stage-${item.stage}`}>{item.stage === 'opening' || item.stage === 'reading' || item.stage === 'renaming' || item.stage === 'matching' ? <LoaderCircle size={14} className="spin-icon" /> : null}{processStageLabel(item.stage, item.plate)}</span>
          </article>
        })}
        {waiting.map((file) => <article className="process-card stage-unmatched" key={file.id}>
          <div className="process-thumb"><ProcessThumb item={{ fileId: file.id, name: file.name, preview: /\.(jpe?g|png|gif|webp)$/i.test(file.name), type: file.type }} /></div>
          <div className="process-card-copy"><strong>{file.name}</strong><span>{labelFor(file.type)}{file.plate ? ` · ${file.plate}` : ''}</span><p>Waiting to match a Registration Number. Use Read plates, or assign the plate under Unmatched.</p></div>
          <span className="process-flag stage-unmatched">Waiting</span>
        </article>)}
      </div>
    </section>
  </div>
}

function UnmatchedView({ files, busy, ocrConfigured, onAssign, onOcr }: { files: TypedFile[]; busy: boolean; ocrConfigured: boolean; onAssign: (input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) => Promise<void> | void; onOcr: (fileId?: string) => Promise<void> | void }) {
  const [drafts, setDrafts] = useState<Record<string, { plate: string; type: DocType }>>({})
  const [rowError, setRowError] = useState('')
  const [busyId, setBusyId] = useState('')
  const readableCount = files.filter((file) => isPhotoFile(file) || file.type === 'certificate').length
  return <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>Unmatched documents <span className="count-pill">{files.length}</span></h2><p>Assign a plate, or OCR photos and insurance files. They are renamed in their type folder as Photos KMHE520A or Insurance - KMHE520A; they are not copied elsewhere.</p></div>{readableCount > 0 && <button className="button secondary" disabled={busy || !ocrConfigured} onClick={() => onOcr()}><ScanLine size={15} /> Read plates</button>}</div>{!ocrConfigured && readableCount > 0 && <div className="auth-error" style={{ margin: '0 21px 12px' }}>OCR is not ready. Restart the app.</div>}{rowError && <div className="auth-error" style={{ margin: '0 21px 12px' }}>{rowError}</div>}<div className="unmatched-list">{files.length === 0 ? <div className="empty-row">No unmatched files.</div> : files.map((item) => { const draft = drafts[item.id] || { plate: '', type: item.type }; return <div className="unmatched-row" key={item.id}><div className="file-icon"><FileText size={18} /></div><div className="file-info"><strong>{item.name}</strong><span>{labelFor(item.type)}</span></div><label className="field-label">Plate<input className="assign-input" placeholder="KDA 482M" value={draft.plate} onChange={(e) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, plate: e.target.value } }))} /></label><label className="field-label">Type<select className="assign-input" value={draft.type} onChange={(e) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, type: e.target.value as DocType } }))}><option value="logbook">Logbook</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>{(isPhotoFile(item) || item.type === 'certificate') && <button className="button secondary" disabled={busy || busyId === item.id || !ocrConfigured} onClick={async () => { setRowError(''); setBusyId(item.id); try { await onOcr(item.id) } finally { setBusyId('') } }}>{busyId === item.id ? 'Reading…' : 'Read plate'}</button>}<button className="button primary" disabled={busy || busyId === item.id} onClick={async () => { if (!draft.plate.trim()) { setRowError('Enter a registration plate.'); return } setRowError(''); setBusyId(item.id); try { await onAssign({ fileId: item.id, plate: draft.plate, type: draft.type, currentType: item.type, name: item.name }) } finally { setBusyId('') } }}>{busyId === item.id ? 'Assigning…' : 'Assign'}</button></div> })}</div></section>
}

function AuditView({ events, onExport }: { events: FleetSnapshot['audit']; onExport: () => void }) {
  return <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>Audit log</h2><p>Written to fleetwise-audit.jsonl in the certificates folder.</p></div><button className="button secondary" onClick={onExport} disabled={!events.length}><ArrowDownToLine size={16} /> Export log</button></div><div className="audit-list">{events.length === 0 ? <div className="empty-row">No audit events yet.</div> : events.map((event) => <div className="audit-row" key={`${event.time}-${event.action}`}><div className="audit-avatar">{event.user === 'System' ? <Database size={15} /> : <UserRound size={15} />}</div><div><strong>{event.user}</strong><span>{event.action}</span></div><time>{event.time}</time></div>)}</div></section>
}

function SettingsView({ fleet, firstRun, busy, onSave, onBrowse, onBrowseSheets }: { fleet: FleetSnapshot | null; firstRun: boolean; busy: boolean; onSave: (input: { logbooksId: string; certificatesId: string; photosId: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold: number }) => void; onBrowse: (parentId?: string, query?: string) => Promise<DriveItem[]>; onBrowseSheets: () => Promise<DriveItem[]> }) {
  const [logbooks, setLogbooks] = useState({ id: fleet?.config?.logbooksId || '', name: fleet?.config?.logbooksName || '' })
  const [certificates, setCertificates] = useState({ id: fleet?.config?.certificatesId || '', name: fleet?.config?.certificatesName || '' })
  const [photos, setPhotos] = useState({ id: fleet?.config?.photosId || '', name: fleet?.config?.photosName || '' })
  const [collateral, setCollateral] = useState({ id: fleet?.config?.collateralId || DEFAULT_COLLATERAL_PARENT_ID, name: fleet?.config?.collateralName || 'Collateral parent folder' })
  const [spreadsheet, setSpreadsheet] = useState({ id: fleet?.config?.spreadsheetId || '', name: fleet?.config?.spreadsheetName || '' })
  const [threshold, setThreshold] = useState(fleet?.config?.autoUploadThreshold ?? 85)
  const [picker, setPicker] = useState<'logbook' | 'certificate' | 'photo' | 'collateral' | null>(null)
  const [sheetPicker, setSheetPicker] = useState(false)
  const savedFolders = [
    fleet?.config?.logbooksId || '',
    fleet?.config?.certificatesId || '',
    fleet?.config?.photosId || '',
    fleet?.config?.collateralId || '',
    fleet?.config?.spreadsheetId || '',
  ].join('|')
  useEffect(() => {
    setLogbooks({ id: fleet?.config?.logbooksId || '', name: fleet?.config?.logbooksName || '' })
    setCertificates({ id: fleet?.config?.certificatesId || '', name: fleet?.config?.certificatesName || '' })
    setPhotos({ id: fleet?.config?.photosId || '', name: fleet?.config?.photosName || '' })
    setCollateral({ id: fleet?.config?.collateralId || DEFAULT_COLLATERAL_PARENT_ID, name: fleet?.config?.collateralName || 'Collateral parent folder' })
    setSpreadsheet({ id: fleet?.config?.spreadsheetId || '', name: fleet?.config?.spreadsheetName || '' })
    setThreshold(fleet?.config?.autoUploadThreshold ?? 85)
  }, [savedFolders])
  return <div className="settings-grid">
    {firstRun && <section className="panel settings-card setup-hero"><div className="panel-heading"><div><h2>Set up Drive folders and Sheets</h2><p>Choose the three document folders. Fleetwise updates the STOCK DOCUMENTS tab on Fleet Assets or Fleet Assets - KE: Logbook / Agreement, PSV Insurance, and Asset Photo.</p></div></div></section>}
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Drive folders</h2><p>Includes My Drive, folders shared with you, and Shared drives you can access.</p></div></div>
      <FolderRow label="Logbooks" name={logbooks.name} id={logbooks.id} onChoose={() => setPicker('logbook')} />
      <FolderRow label="Certificates" name={certificates.name} id={certificates.id} onChoose={() => setPicker('certificate')} />
      <FolderRow label="Photos" name={photos.name} id={photos.id} onChoose={() => setPicker('photo')} />
      <FolderRow label="Collateral parent" name={collateral.name} id={collateral.id} onChoose={() => setPicker('collateral')} />
      <div className="setting-toggle"><div><strong>Auto-upload threshold</strong><span>Gmail certificates at or above this confidence go into the certificates folder with a plate filename.</span></div><label className="field-label">Percent<input className="assign-input" type="number" min={50} max={99} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label></div>
      <div style={{ padding: '0 21px 18px' }}><button className="button primary" onClick={() => onSave({ logbooksId: logbooks.id, certificatesId: certificates.id, photosId: photos.id, collateralId: collateral.id, spreadsheetId: spreadsheet.id, autoUploadThreshold: threshold })} disabled={busy || !logbooks.id || !certificates.id || !photos.id}>{busy ? 'Saving…' : 'Save folders'}</button></div>
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Registration sheets</h2><p>Defaults to Fleet Assets or Fleet Assets - KE, tab STOCK DOCUMENTS. Links go on the matching Registration Number row.</p></div></div>
      <FolderRow label="Workbook" name={spreadsheet.name} id={spreadsheet.id} onChoose={() => setSheetPicker(true)} />
    </section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Connections</h2><p>Google sign-in is identity. Drive folders and Sheets are the workspace.</p></div></div>
      <div className="connection-row"><div className="connection-icon"><Database size={17} /></div><div><strong>Google Drive</strong><span>{fleet?.driveConnected ? 'Signed in' : 'Sign in required'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><FileSpreadsheet size={17} /></div><div><strong>Google Sheets</strong><span>{fleet?.sheetsConnected ? fleet.config?.spreadsheetName || 'Workbook connected' : 'Pick a workbook — then sign out and in if Sheets access was not granted'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><Mail size={17} /></div><div><strong>Gmail</strong><span>{fleet?.gmailConnected ? 'Inbox has been checked' : 'Not checked yet — use Check inbox'}</span></div></div>
      <div className="connection-row"><div className="connection-icon"><ScanLine size={17} /></div><div><strong>On-device OCR</strong><span>{fleet?.ocrConfigured ? 'Tesseract — reads plates locally, no Google billing' : 'OCR is not ready'}</span></div></div>
    </section>
    {picker && <FolderPicker title={`Choose ${picker} folder`} onClose={() => setPicker(null)} onBrowse={onBrowse} onSelect={(folder) => { if (picker === 'logbook') setLogbooks({ id: folder.id, name: folder.name }); if (picker === 'certificate') setCertificates({ id: folder.id, name: folder.name }); if (picker === 'photo') setPhotos({ id: folder.id, name: folder.name }); if (picker === 'collateral') setCollateral({ id: folder.id, name: folder.name }); setPicker(null) }} />}
    {sheetPicker && <SpreadsheetPicker onClose={() => setSheetPicker(false)} onBrowse={onBrowseSheets} onSelect={(file) => { setSpreadsheet({ id: file.id, name: file.name }); setSheetPicker(false) }} />}
  </div>
}

function FolderRow({ label, name, id, onChoose }: { label: string; name?: string; id: string; onChoose: () => void }) {
  return <div className="connection-row"><div className="connection-icon"><FileText size={17} /></div><div><strong>{label}</strong><span>{name || (id ? 'Selected folder' : 'Not selected')}</span></div><button className="button secondary" type="button" onClick={onChoose}>{id ? 'Change' : 'Choose folder'}</button></div>
}

function SpreadsheetPicker({ onClose, onBrowse, onSelect }: { onClose: () => void; onBrowse: () => Promise<DriveItem[]>; onSelect: (file: DriveItem) => void }) {
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

function FolderPicker({ title, onClose, onBrowse, onSelect }: { title: string; onClose: () => void; onBrowse: (parentId?: string, query?: string) => Promise<DriveItem[]>; onSelect: (folder: DriveItem) => void }) {
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

function UploadDialog({ defaultType, onClose, onUpload }: { defaultType: DocType; onClose: () => void; onUpload: (form: FormData) => Promise<void> }) {
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
      <label className="field-label">Document type<select value={type} onChange={(e) => setType(e.target.value as DocType)}><option value="logbook">Logbook</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>
      <label className="field-label">File<input name="file" type="file" required /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload to Drive'}</button>
    </form>
  </Drawer>
}

function HelpDrawer({ onClose }: { onClose: () => void }) {
  return <Drawer title="How Fleetwise files" eyebrow="HELP" onClose={onClose}>
    <div className="help-body">
      <p>Drop files into the logbooks, certificates, or photos Drive folders, including files inside nested folders. Keep Fleetwise open and it scans those folders on its own — including JPEG, PNG, and PDF documents — then renames them as Photos KMHE520A, Insurance - KMHE520A, or KMHE520A - Logbook, with no file extension. Already-renamed files are only written to the sheet if that cell is still empty. Insurance PDFs use REGISTRATION No; logbook PDFs use the REGISTRATION field on the document.</p>
      <p>It then finds that Registration Number on the STOCK DOCUMENTS tab of Fleet Assets / Fleet Assets - KE and writes a Drive file chip into Logbook / Agreement, PSV Insurance, or Asset Photo — not an underlined hyperlink. Photos whose name includes Branded go to Asset Photo(Branded). Every scan re-reads Collateral Files: empty cells get a folder named after the registration number under the collateral parent, then a Drive chip. Cells that already have a Drive chip are left as they are.</p>
      <p>Plates that cannot be read, or that are not on the matching sheet, stay in Unmatched. Sign out and in again after this update so Sheets access is granted. Enable the Google Sheets API on the Cloud project.</p>
    </div>
  </Drawer>
}

async function exportCsv(input: { query: string; status: StatusFilter; brand: string; missing: MissingFilter[] }) {
  const csv = await exportVehicleRegister({ query: input.query, status: input.status, brand: input.brand, missing: input.missing })
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'fleetwise-register.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function exportAudit(events: FleetSnapshot['audit']) {
  downloadCsv('fleetwise-audit.csv', [['User', 'Action', 'Time'], ...events.map((event) => [event.user, event.action, event.time])])
}

function downloadCsv(name: string, rows: string[][]) {
  const blob = new Blob([rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export default function Page() {
  return (
    <Suspense fallback={<ConsoleShell />}>
      <FleetApp />
    </Suspense>
  )
}
