'use client'

import { FormEvent, ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut, useSession } from '@/lib/auth-client'
import { assignUnmatched, assignUnmatchedBatch, continueProcessing, exportVehicleRegister, getProcessingJob, linkPerceivedMatches, listDriveFolders, listSpreadsheets, loadFleet, loadVehiclePage, loadWorkspace, loadWorkspacePanels, ocrUnmatchedPhotos, runProcessing, saveFolderConfig, stopProcessing, syncGmail, syncRegisterToDatabase, uploadDocument } from '@/app/actions/fleet'
import { coverAlertLabel, formatCoverDate } from '@/lib/insurance'
import { listRegistrationNumbers, parseKenyanPlate } from '@/lib/plates'
import { processFocusLabel, type ProcessFocus } from '@/lib/process-focus'
import type { ProcessJob } from '@/lib/processing'
import { EMPTY_STATS } from '@/lib/vehicles'
import { DEFAULT_COLLATERAL_PARENT_ID, type DocType, type DriveItem, type DuplicateFile, type FleetSnapshot, type InboxItem, type TypedFile, type VehicleRecord } from '@/lib/types'
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
  Clock,
  Copy,
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

type NavKey = 'Overview' | 'Vehicles' | 'Insurance inbox' | 'Logbook inbox' | 'Processing' | 'Unmatched' | 'Duplicates' | 'Audit log' | 'Settings'
type ViewSlug = 'overview' | 'vehicles' | 'inbox' | 'logbook-inbox' | 'processing' | 'unmatched' | 'duplicates' | 'audit' | 'settings'
type StatusFilter = 'all' | 'Complete' | 'Needs attention'
type MissingFilter = 'logbook' | 'certificate' | 'photo' | 'collateral' | 'agreement'

const MISSING_FILTERS: { id: MissingFilter; label: string }[] = [
  { id: 'logbook', label: 'Without logbook' },
  { id: 'certificate', label: 'Without certificate' },
  { id: 'photo', label: 'Without photo' },
  { id: 'collateral', label: 'Without collateral' },
  { id: 'agreement', label: 'Without agreement' },
]

const PROCESS_TASKS: { id: ProcessFocus; label: string; detail: string }[] = [
  { id: 'photos', label: 'Photos only', detail: 'Read bike plates with Tesseract.js and rename Photos {plate}.' },
  { id: 'certificates', label: 'Insurance only', detail: 'Rename new insurance PDFs from REGISTRATION No, save commencement and expiry on the vehicle register, then write the insurance chip on the sheet.' },
  { id: 'logbooks', label: 'Logbooks only', detail: 'Rename new logbook PDFs from REGISTRATION No to {plate} - Logbook, then write chips on the sheet.' },
  { id: 'agreements', label: 'Agreements only', detail: 'Rename files in the agreements folder to {plate} - Agreement, then write chips on Agreement Link.' },
  { id: 'all', label: 'All waiting files', detail: 'Photos, insurance, logbooks, agreements, and other waiting documents.' },
  { id: 'repair-photos', label: 'Fix wrong photos', detail: 'Reopen unmatched photos only and rename them from the plate. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-certificates', label: 'Fix wrong insurance', detail: 'Reopen unmatched insurance only and rename from REGISTRATION No. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-logbooks', label: 'Fix wrong logbooks', detail: 'Reopen unmatched logbooks only and rename from REGISTRATION No. Files already on STOCK DOCUMENTS are left alone.' },
  { id: 'repair-agreements', label: 'Fix wrong agreements', detail: 'Reopen unmatched agreements only and rename to {plate} - Agreement. Files already on STOCK DOCUMENTS are left alone.' },
]

const SLUGS: Record<ViewSlug, NavKey> = {
  overview: 'Overview',
  vehicles: 'Vehicles',
  inbox: 'Insurance inbox',
  'logbook-inbox': 'Logbook inbox',
  processing: 'Processing',
  unmatched: 'Unmatched',
  duplicates: 'Duplicates',
  audit: 'Audit log',
  settings: 'Settings',
}

const TO_SLUG: Record<NavKey, ViewSlug> = {
  Overview: 'overview',
  Vehicles: 'vehicles',
  'Insurance inbox': 'inbox',
  'Logbook inbox': 'logbook-inbox',
  Processing: 'processing',
  Unmatched: 'unmatched',
  Duplicates: 'duplicates',
  'Audit log': 'audit',
  Settings: 'settings',
}

const nav = [
  { label: 'Overview' as const, icon: LayoutDashboard },
  { label: 'Vehicles' as const, icon: Truck },
  { label: 'Insurance inbox' as const, icon: Mail },
  { label: 'Logbook inbox' as const, icon: FileText },
  { label: 'Processing' as const, icon: RefreshCw },
  { label: 'Unmatched' as const, icon: AlertCircle },
  { label: 'Duplicates' as const, icon: Copy },
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

function writeSavedFolders(input: { logbooksId: string; certificatesId: string; photosId: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }) {
  try {
    localStorage.setItem(FOLDER_STORE, JSON.stringify({
      logbooksId: input.logbooksId,
      certificatesId: input.certificatesId,
      photosId: input.photosId,
      agreementsId: input.agreementsId,
      collateralId: input.collateralId,
      spreadsheetId: input.spreadsheetId,
      autoUploadThreshold: input.autoUploadThreshold ?? 85,
      insuranceInboxEmail: input.insuranceInboxEmail || '',
      logbooksInboxEmail: input.logbooksInboxEmail || '',
    }))
  } catch { /* ignore quota */ }
}

function readSavedFolders() {
  try {
    const raw = localStorage.getItem(FOLDER_STORE)
    if (!raw) return null
    const stored = JSON.parse(raw) as { logbooksId?: string; certificatesId?: string; photosId?: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold?: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }
    if (!stored.logbooksId || !stored.certificatesId || !stored.photosId) return null
    return {
      logbooksId: stored.logbooksId,
      certificatesId: stored.certificatesId,
      photosId: stored.photosId,
      agreementsId: stored.agreementsId,
      collateralId: stored.collateralId,
      spreadsheetId: stored.spreadsheetId,
      autoUploadThreshold: stored.autoUploadThreshold ?? 85,
      insuranceInboxEmail: stored.insuranceInboxEmail || '',
      logbooksInboxEmail: stored.logbooksInboxEmail || '',
    }
  } catch {
    return null
  }
}

function keepVehicles(current: FleetSnapshot | null, next: FleetSnapshot) {
  if (next.ingest?.preserve && current) {
    return {
      ...current,
      config: next.config || current.config,
      inbox: next.inbox.length ? next.inbox : current.inbox,
      gmailConnected: next.gmailConnected || current.gmailConnected,
      lastSync: next.lastSync || current.lastSync,
      ingest: next.ingest,
      sheetsError: next.sheetsError || current.sheetsError,
    }
  }
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

function RecordsSkeleton() {
  return <div className="records-skeleton" role="status" aria-live="polite" aria-label="Loading records">
    <div className="skeleton-kpis">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><span className="skeleton-bone bone-icon" /><div><span className="skeleton-bone bone-label" /><span className="skeleton-bone bone-value" /></div></div>)}</div>
    <section className="panel table-panel">
      <div className="panel-heading"><div><span className="skeleton-bone bone-title" /><span className="skeleton-bone bone-copy" /></div></div>
      <div className="skeleton-rows">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-row" key={index}><span className="skeleton-bone bone-plate" /><span className="skeleton-bone bone-cell" /><span className="skeleton-bone bone-cell short" /><span className="skeleton-bone bone-cell short" /><span className="skeleton-bone bone-status" /></div>)}</div>
    </section>
  </div>
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
      {children || <div className="page-wrap"><RecordsSkeleton /></div>}
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
      agreementsId: folders.agreementsId,
      collateralId: folders.collateralId,
      spreadsheetId: folders.spreadsheetId,
      autoUploadThreshold: folders.autoUploadThreshold ?? 85,
      insuranceInboxEmail: folders.insuranceInboxEmail,
      logbooksInboxEmail: folders.logbooksInboxEmail,
    } : null,
    vehicles: [],
    unmatched: [],
    duplicates: [],
    inbox: [],
    audit: [],
    stats: EMPTY_STATS,
    gmailConnected: false,
    driveConnected: true,
    ocrConfigured: true,
    sheetsConnected: Boolean(folders?.spreadsheetId),
  }
}

function viewFromSearch(search = typeof window === 'undefined' ? '' : window.location.search): NavKey {
  const slug = new URLSearchParams(search).get('view') as ViewSlug
  return SLUGS[slug] || 'Overview'
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
  if (type === 'agreement') return 'Agreement'
  return 'Vehicle photo'
}

function isPhotoFile(file: TypedFile) {
  const mime = (file.mimeType || '').toLowerCase()
  if (mime.includes('svg') || mime.includes('heic') || mime.includes('heif')) return false
  if (mime.startsWith('image/') || mime.includes('pdf')) return true
  return /\.(png|jpe?g|webp|gif|bmp|tif?f|pdf)$/i.test(file.name)
}

function splitUnmatched<T extends TypedFile>(files: T[]) {
  return {
    photos: files.filter((file) => file.type === 'photo'),
    insurance: files.filter((file) => file.type === 'certificate'),
    logbooks: files.filter((file) => file.type === 'logbook'),
    agreements: files.filter((file) => file.type === 'agreement'),
  }
}

function unmatchedSplitLabel(files: TypedFile[]) {
  const { photos, insurance, logbooks, agreements } = splitUnmatched(files)
  return [
    `${photos.length} photo${photos.length === 1 ? '' : 's'}`,
    `${insurance.length} insurance`,
    `${logbooks.length} logbook${logbooks.length === 1 ? '' : 's'}`,
    `${agreements.length} agreement${agreements.length === 1 ? '' : 's'}`,
  ].join(' · ')
}

type UnmatchedKind = 'all' | 'photo' | 'certificate' | 'logbook' | 'agreement'

function inboxKind(item: InboxItem): 'certificate' | 'logbook' {
  return item.type === 'logbook' ? 'logbook' : 'certificate'
}

function unmatchedTitle(file: TypedFile) {
  if (file.type === 'certificate') return 'Unmatched insurance'
  if (file.type === 'photo') return 'Unmatched photo'
  if (file.type === 'agreement') return 'Unmatched agreement'
  return 'Unmatched logbook'
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
    const url = `/?view=${TO_SLUG[view]}`
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
      <div className="brand"><div className="brand-mark"><Truck size={18} /></div><div><strong>Fleetwise</strong><span>Kenya fleet ops</span></div></div>
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
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Operations</span><span>/</span><strong>{active}</strong></div><div className="top-actions"><div className="notification-wrap"><button className="icon-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => { setProfileMenu(null); setNotificationsOpen(!notificationsOpen) }}><Bell size={19} />{notifications.length > 0 && <i />}</button>{notificationsOpen && <div className="notification-popover" role="menu"><div className="notification-head"><div><strong>Notifications</strong><span>{notifications.length} open</span></div></div><div className="notification-list">{notifications.length === 0 ? <div className="notification-item read"><span /><span><strong>All clear</strong><small>No unmatched files, insurance expiry alerts, or certificates waiting.</small></span></div> : notifications.map((notification) => <button className="notification-item" key={notification.id} onClick={() => { if ('query' in notification && notification.query) { setQuery(notification.query); setVehiclePage(1) } go(notification.view, false, 'kind' in notification ? notification.kind : undefined) }}><span className={`notification-icon ${'tone' in notification && notification.tone === 'urgent' ? 'urgent' : 'tone' in notification && notification.tone === 'week' ? 'week' : ''}`}>{('tone' in notification && notification.tone) ? <Clock size={15} /> : <ShieldCheck size={15} />}</span><span><strong>{notification.title}</strong><small>{notification.message}</small><time>{notification.time}</time></span><b /></button>)}</div></div>}</div><div className="profile-wrap profile-wrap-top"><button type="button" className="top-avatar" aria-label="Open account menu" aria-haspopup="menu" aria-expanded={profileMenu === 'top'} onClick={() => toggleProfileMenu('top')}>{initials}</button>{profileMenu === 'top' && <ProfileMenu name={sessionUser.name} email={sessionUser.email} onLogout={() => signOut()} />}</div></div></header>
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

function shareParts(have: number, total: number) {
  const complete = Math.max(0, have)
  const missing = Math.max(0, total - complete)
  const completePct = total ? Math.round((complete / total) * 100) : 0
  const missingPct = total ? Math.round((missing / total) * 100) : 0
  return { complete, missing, completePct, missingPct }
}

function shareLabel(have: number, total: number) {
  const { complete, completePct } = shareParts(have, total)
  if (!total) return '0 of 0 (0%)'
  return `${complete} of ${total} (${completePct}%)`
}

function Coverage({ stats, onSelect }: { stats?: FleetSnapshot['stats']; onSelect?: (item: MissingFilter) => void }) {
  const total = stats?.total || 0
  const rows: { key: MissingFilter; label: string; have: number }[] = [
    { key: 'logbook', label: labelFor('logbook'), have: stats?.logbook || 0 },
    { key: 'agreement', label: 'Agreements', have: stats?.agreement || 0 },
    { key: 'certificate', label: labelFor('certificate'), have: stats?.certificate || 0 },
    { key: 'photo', label: labelFor('photo'), have: stats?.photo || 0 },
    { key: 'collateral', label: 'Collateral files', have: stats?.collateral || 0 },
  ]
  return <div className="coverage-list">{rows.map((row) => {
    const { complete, missing, completePct, missingPct } = shareParts(row.have, total)
    return <button type="button" className="coverage-row" key={row.key} onClick={() => onSelect?.(row.key)}>
      <span>{row.label}</span>
      <div className="coverage-track">
        <div className="big-progress coverage-bar" aria-hidden="true"><span style={{ width: `${completePct}%` }} /></div>
        <div className="coverage-counts">
          <span className="coverage-have">{complete} complete ({completePct}%)</span>
          <span className="coverage-miss">{missing} missing ({missingPct}%)</span>
        </div>
      </div>
    </button>
  })}</div>
}

function VehicleTable({ vehicles, total, page, pageSize, pageSizes, loading, onPageChange, onPageSizeChange, onSelect }: { vehicles: VehicleRecord[]; total: number; page: number; pageSize: number; pageSizes?: number[]; loading?: boolean; onPageChange?: (page: number) => void; onPageSizeChange?: (size: number) => void; onSelect: (vehicle: VehicleRecord) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(page * pageSize, total)
  return <div>
    <div className="table-scroll"><table><thead><tr><th>Vehicle</th><th>Brand</th><th>Logbook</th><th>Agreement</th><th>Certificate</th><th>Commencement</th><th>Expiry</th><th>Photo</th><th>Collateral</th><th>Status</th><th>Last updated</th></tr></thead><tbody>{loading ? Array.from({ length: Math.min(pageSize, 8) }, (_, index) => <tr className="skeleton-table-row" key={index}><td colSpan={11}><span className="skeleton-bone bone-row" /></td></tr>) : !vehicles.length ? <tr className="empty-row-tr"><td colSpan={11}>No plates found in the configured folders yet.</td></tr> : vehicles.map((vehicle) => <tr key={vehicle.plate} onClick={() => onSelect(vehicle)}><td><strong className="plate-id">{vehicle.plate}</strong><span className="muted-cell">{vehicle.present} / {vehicle.total} documents</span></td><td>{vehicle.brand || '—'}</td><td className={vehicle.files.logbook.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.logbook.length ? 'Yes' : 'Missing'}</td><td className={vehicle.agreement ? 'cell-yes' : 'cell-no'}>{vehicle.agreement ? 'Yes' : 'Missing'}</td><td className={vehicle.files.certificate.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.certificate.length ? 'Yes' : 'Missing'}</td><td className="cell-cover">{formatCoverDate(vehicle.insurance?.commencement)}</td><td className={`cell-cover ${vehicle.insurance?.alert ? `cover-${vehicle.insurance.alert}` : ''}`}>{formatCoverDate(vehicle.insurance?.expiry)}{vehicle.insurance?.alert ? <span className={`cover-flag ${vehicle.insurance.alert}`}>{coverAlertLabel(vehicle.insurance)}</span> : null}</td><td className={vehicle.files.photo.length ? 'cell-yes' : 'cell-no'}>{vehicle.files.photo.length ? 'Yes' : 'Missing'}</td><td className={vehicle.collateral ? 'cell-yes' : 'cell-no'}>{vehicle.collateral ? 'Yes' : 'Missing'}</td><td><StatusBadge status={vehicle.status} /></td><td className="muted-cell">{vehicle.updated}</td></tr>)}</tbody></table></div>
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

function InboxView({ kind, inbox, config, gmailConnected, ocrConfigured, busy, onSync, onAssign }: { kind: 'certificate' | 'logbook'; inbox: InboxItem[]; config: FleetSnapshot['config']; gmailConnected: boolean; ocrConfigured: boolean; busy: boolean; onSync: () => void; onAssign: (input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) => Promise<void> | void }) {
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [plate, setPlate] = useState('')
  const [assignError, setAssignError] = useState('')
  const foldersSet = Boolean(config)
  const logbook = kind === 'logbook'
  const mailbox = logbook ? config?.logbooksInboxEmail : config?.insuranceInboxEmail
  const destination = logbook ? (config?.logbooksName || 'Logbooks') : (config?.certificatesName || 'Certificates')
  const title = logbook ? 'Logbooks' : 'Insurance certificates'
  const format = logbook ? '{plate} - Logbook' : 'Insurance - {plate}'
  return <div className="view-stack"><section className="panel inbox-summary"><div><span className="eyebrow">GMAIL INTAKE</span><h2>{title}</h2><p>Attachments from {mailbox || 'the configured mailbox'} are matched by plate in the filename, email, or PDF, renamed {format}, then stored in {destination}.{ocrConfigured ? '' : ' Photo OCR is off.'}</p></div><div className="inbox-summary-actions"><span className={`connected-pill ${gmailConnected ? '' : 'muted'}`}>{gmailConnected ? 'Gmail checked' : 'Not checked yet'}</span><span className={`connected-pill ${mailbox ? '' : 'muted'}`}>{mailbox || 'Set the mailbox in Settings'}</span></div></section><div className="inbox-kpis"><div><span>In queue</span><strong>{inbox.length}</strong></div><div><span>Auto-uploaded</span><strong className="green-text">{inbox.filter((item) => item.status === 'Auto-uploaded').length}</strong></div><div><span>Needs review</span><strong className="orange-text">{inbox.filter((item) => item.status === 'Needs review').length}</strong></div><div><span>Destination</span><strong>{destination}</strong></div></div><section className="panel table-panel standalone"><div className="panel-heading"><div><h2>{logbook ? 'Logbook inbox' : 'Insurance inbox'}</h2><p>Low-confidence files stay unmatched until you assign a plate. Check inboxes reads both mailboxes.</p></div><button className="button secondary" onClick={onSync} disabled={busy || !foldersSet}><RefreshCw size={15} /> Check inboxes</button></div><div className="inbox-list">{inbox.length === 0 ? <div className="empty-row">{mailbox ? 'No Gmail attachments processed yet.' : 'Add this mailbox address in Settings, then check inboxes.'}</div> : inbox.map((item) => <button className="inbox-row" key={item.id} onClick={() => { setSelected(item); setPlate(item.vehicle.includes(' ') || /^K[A-Z]{2}/i.test(item.vehicle) ? item.vehicle : ''); setAssignError('') }}><div className={`mail-icon ${item.status === 'Needs review' ? 'review' : 'uploaded'}`}><Mail size={18} /></div><div className="inbox-main"><strong>{item.subject}</strong><span>{item.sender} · {item.received}</span><small><FileText size={13} /> {item.attachment}</small></div><div className="inbox-match"><span>Registration number</span><strong>{item.vehicle}</strong><small>{item.confidence}% confidence</small></div><div className="inbox-destination"><span>Destination</span><strong>{item.folder}</strong></div><span className={`inbox-status ${item.status === 'Needs review' ? 'needs-review' : 'uploaded'}`}>{item.status}</span><ArrowUpRight size={16} className="inbox-open" /></button>)}</div></section>
    {selected && <Drawer title={selected.attachment} eyebrow="EMAIL INTAKE DETAIL" subtitle={selected.sender} wide onClose={() => setSelected(null)}>
      <div className="detail-summary"><span className={`inbox-status ${selected.status === 'Needs review' ? 'needs-review' : 'uploaded'}`}>{selected.status}</span><strong>{selected.confidence}% match confidence</strong></div>
      {selected.status === 'Needs review' && selected.fileId ? <form className="upload-form" onSubmit={async (event) => { event.preventDefault(); if (!plate.trim()) { setAssignError('Enter a registration plate.'); return } await onAssign({ fileId: selected.fileId!, plate, type: kind, currentType: kind, name: selected.attachment }); setSelected(null) }}><label className="field-label">Registration plate<input className="assign-input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="KDA 482M" /></label>{assignError && <div className="auth-error">{assignError}</div>}<div className="drawer-actions"><button className="button primary" type="submit" disabled={busy}>Assign to plate</button><button className="button secondary" type="button" onClick={() => setSelected(null)}>Close</button></div></form> : <><p className="drawer-copy">This file is already in {destination} with a plate filename.</p><button className="button secondary" onClick={() => setSelected(null)}>Close</button></>}
    </Drawer>}
  </div>
}

const PROCESS_STEPS = ['queued', 'opening', 'reading', 'renaming', 'matching', 'matched'] as const

function processStageLabel(stage: string, plate?: string | null, detail?: string) {
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

function ProcessThumb({ item }: { item: { fileId: string; name: string; preview: boolean; type: DocType; stage?: string } }) {
  const [broken, setBroken] = useState(false)
  const showPreview = item.preview && !broken && (item.stage === 'opening' || item.stage === 'reading' || item.stage === 'renaming' || item.stage === 'matching')
  if (showPreview) {
    return <img className="process-thumb-img" src={`/documents/${item.fileId}?preview=1`} alt={item.name} onError={() => setBroken(true)} />
  }
  return item.type === 'photo' ? <ImageIcon size={22} /> : <FileText size={22} />
}

function ProcessingView({ lastSync, vehicles, unmatched, busy, configured, ocrConfigured, ingest, job, photosFolder, certificatesFolder, logbooksFolder, agreementsFolder, onScan, onGmail, onOcr, onStart, onStop, onLinkSheet }: { lastSync?: string; vehicles: number; unmatched: TypedFile[]; busy: boolean; configured: boolean; ocrConfigured: boolean; ingest?: FleetSnapshot['ingest']; job: ProcessJob | null; photosFolder?: string; certificatesFolder?: string; logbooksFolder?: string; agreementsFolder?: string; onScan: () => void; onGmail: () => void; onOcr: () => void; onStart: (focus: ProcessFocus) => void | Promise<void>; onStop: () => void | Promise<void>; onLinkSheet: (type: 'photo' | 'certificate' | 'logbook') => void | Promise<void> }) {
  const percent = job?.attempted ? Math.round((job.done / job.attempted) * 100) : 0
  const liveItems: typeof job.items = []
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

function surplusGroups(files: DuplicateFile[]) {
  const groups = new Map<string, { key: string; plate: string; type: DocType; uploadedName: string; uploadedLink?: string; surplus: DuplicateFile[] }>()
  for (const file of files) {
    const plate = file.plate || ''
    const key = `${plate}:${file.type}:${file.uploadedId}`
    const current = groups.get(key)
    if (current) current.surplus.push(file)
    else groups.set(key, { key, plate, type: file.type, uploadedName: file.uploadedName, uploadedLink: file.uploadedLink, surplus: [file] })
  }
  return [...groups.values()].sort((a, b) => a.plate.localeCompare(b.plate) || a.type.localeCompare(b.type))
}

function DuplicatesView({ files }: { files: DuplicateFile[] }) {
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

function UnmatchedView({ files, category, onCategory, busy, ocrConfigured, onAssign, onAssignMany, onOcr }: {
  files: TypedFile[]
  category: UnmatchedKind
  onCategory: (kind: UnmatchedKind) => void
  busy: boolean
  ocrConfigured: boolean
  onAssign: (input: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }) => Promise<void> | void
  onAssignMany: (inputs: { fileId: string; plate: string; type: DocType; currentType: DocType; name: string }[]) => Promise<void> | void
  onOcr: (fileId?: string) => Promise<void> | void
}) {
  const [drafts, setDrafts] = useState<Record<string, { plate: string; type: DocType }>>({})
  const [rowError, setRowError] = useState('')
  const [busyId, setBusyId] = useState('')
  const split = splitUnmatched(files)
  const groups = [
    { id: 'photo' as const, title: 'Photos', empty: 'No unmatched photos.', items: split.photos },
    { id: 'certificate' as const, title: 'Insurance', empty: 'No unmatched insurance files.', items: split.insurance },
    { id: 'logbook' as const, title: 'Logbooks', empty: 'No unmatched logbooks.', items: split.logbooks },
    { id: 'agreement' as const, title: 'Agreements', empty: 'No unmatched agreements.', items: split.agreements },
  ]
  const visible = category === 'all' ? groups : groups.filter((group) => group.id === category)
  const readableCount = files.filter((file) => isPhotoFile(file) || file.type === 'certificate' || file.type === 'logbook' || file.type === 'agreement').length
  const queued = files.flatMap((item) => {
    const draft = drafts[item.id] || { plate: '', type: item.type }
    if (!draft.plate.trim()) return []
    return [{ fileId: item.id, plate: draft.plate, type: draft.type, currentType: item.type, name: item.name }]
  })

  function updateDraft(id: string, patch: Partial<{ plate: string; type: DocType }>, fallbackType: DocType) {
    setDrafts((current) => {
      const draft = current[id] || { plate: '', type: fallbackType }
      return { ...current, [id]: { ...draft, ...patch } }
    })
  }

  async function assignQueued() {
    if (!queued.length) {
      setRowError('Type registration numbers on the files you want, then assign them together.')
      return
    }
    const invalid = queued.filter((item) => !parseKenyanPlate(item.plate))
    if (invalid.length) {
      setRowError(`Not a Kenyan registration number: ${invalid.map((item) => item.name).join(', ')}. Example KMHE520A.`)
      return
    }
    setRowError('')
    setBusyId('batch')
    try {
      await onAssignMany(queued)
      const assigned = new Set(queued.map((item) => item.fileId))
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !assigned.has(id))))
    } finally {
      setBusyId('')
    }
  }

  return <section className="panel table-panel standalone">
    <div className="panel-heading">
      <div>
        <h2>Unmatched documents <span className="count-pill">{files.length}</span></h2>
        <p>{files.length ? unmatchedSplitLabel(files) : 'No unmatched files in the Drive folders.'} These are folder files not yet matched to a Registration Number on STOCK DOCUMENTS. Type plates, then assign them together. Files stay in their type folder as Photos KMHE520A, Insurance - KMHE520A, KMHE520A - Logbook, or KMHE520A - Agreement.</p>
      </div>
      <div className="heading-actions">
        {readableCount > 0 && <button className="button secondary" disabled={busy || busyId === 'batch' || !ocrConfigured} onClick={() => onOcr()}><ScanLine size={15} /> Read plates</button>}
        <button className="button primary" disabled={busy || Boolean(busyId) || !queued.length} onClick={() => void assignQueued()}>
          {busyId === 'batch' ? 'Assigning…' : queued.length ? `Assign ${queued.length}` : 'Assign all'}
        </button>
      </div>
    </div>
    <div className="unmatched-filters" role="tablist" aria-label="Unmatched file type">
      <button type="button" className={`filter-chip ${category === 'all' ? 'active' : ''}`} aria-pressed={category === 'all'} onClick={() => onCategory('all')}>All {files.length}</button>
      <button type="button" className={`filter-chip ${category === 'photo' ? 'active' : ''}`} aria-pressed={category === 'photo'} onClick={() => onCategory('photo')}>Photos {split.photos.length}</button>
      <button type="button" className={`filter-chip ${category === 'certificate' ? 'active' : ''}`} aria-pressed={category === 'certificate'} onClick={() => onCategory('certificate')}>Insurance {split.insurance.length}</button>
      <button type="button" className={`filter-chip ${category === 'logbook' ? 'active' : ''}`} aria-pressed={category === 'logbook'} onClick={() => onCategory('logbook')}>Logbooks {split.logbooks.length}</button>
      <button type="button" className={`filter-chip ${category === 'agreement' ? 'active' : ''}`} aria-pressed={category === 'agreement'} onClick={() => onCategory('agreement')}>Agreements {split.agreements.length}</button>
    </div>
    {!ocrConfigured && readableCount > 0 && <div className="auth-error" style={{ margin: '0 21px 12px' }}>OCR is not ready. Restart the app.</div>}
    {rowError && <div className="auth-error" style={{ margin: '0 21px 12px' }}>{rowError}</div>}
    {visible.map((group) => (
      <div className="unmatched-group" key={group.id}>
        <div className="unmatched-group-head">
          <h3>{group.title} <span className="count-pill">{group.items.length}</span></h3>
        </div>
        <div className="unmatched-list">
          {group.items.length === 0 ? <div className="empty-row">{group.empty}</div> : group.items.map((item) => {
            const draft = drafts[item.id] || { plate: '', type: item.type }
            return <div className="unmatched-row" key={item.id}>
              <div className="file-icon"><FileText size={18} /></div>
              <div className="file-info"><strong>{item.name}</strong><span>{labelFor(item.type)}</span></div>
              <label className="field-label">Plate<input className="assign-input" placeholder="KDA 482M" value={draft.plate} onChange={(e) => updateDraft(item.id, { plate: e.target.value }, item.type)} /></label>
              <label className="field-label">Type<select className="assign-input" value={draft.type} onChange={(e) => updateDraft(item.id, { type: e.target.value as DocType }, item.type)}><option value="logbook">Logbook</option><option value="agreement">Agreement</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>
              {(isPhotoFile(item) || item.type === 'certificate' || item.type === 'logbook' || item.type === 'agreement') && <button className="button secondary" disabled={busy || Boolean(busyId) || !ocrConfigured} onClick={async () => { setRowError(''); setBusyId(item.id); try { await onOcr(item.id) } finally { setBusyId('') } }}>{busyId === item.id ? 'Reading…' : 'Read plate'}</button>}
              <button className="button secondary" disabled={busy || Boolean(busyId)} onClick={async () => {
                if (!draft.plate.trim()) { setRowError('Enter a registration plate.'); return }
                if (!parseKenyanPlate(draft.plate)) { setRowError(`Not a Kenyan registration number for ${item.name}. Example KMHE520A.`); return }
                setRowError('')
                setBusyId(item.id)
                try {
                  await onAssign({ fileId: item.id, plate: draft.plate, type: draft.type, currentType: item.type, name: item.name })
                  setDrafts((current) => { const next = { ...current }; delete next[item.id]; return next })
                } finally {
                  setBusyId('')
                }
              }}>{busyId === item.id ? 'Assigning…' : 'Assign'}</button>
            </div>
          })}
        </div>
      </div>
    ))}
  </section>
}

function AuditView({ events, onExport }: { events: FleetSnapshot['audit']; onExport: () => void }) {
  return <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>Audit log</h2><p>Written to fleetwise-audit.jsonl in the certificates folder.</p></div><button className="button secondary" onClick={onExport} disabled={!events.length}><ArrowDownToLine size={16} /> Export log</button></div><div className="audit-list">{events.length === 0 ? <div className="empty-row">No audit events yet.</div> : events.map((event) => <div className="audit-row" key={`${event.time}-${event.action}`}><div className="audit-avatar">{event.user === 'System' ? <Database size={15} /> : <UserRound size={15} />}</div><div><strong>{event.user}</strong><span>{event.action}</span></div><time>{event.time}</time></div>)}</div></section>
}

function SettingsView({ fleet, firstRun, busy, onSave, onImportDatabase, onBrowse, onBrowseSheets }: { fleet: FleetSnapshot | null; firstRun: boolean; busy: boolean; onSave: (input: { logbooksId: string; certificatesId: string; photosId: string; agreementsId?: string; collateralId?: string; spreadsheetId?: string; autoUploadThreshold: number; insuranceInboxEmail?: string; logbooksInboxEmail?: string }) => void; onImportDatabase: () => void; onBrowse: (parentId?: string, query?: string) => Promise<DriveItem[]>; onBrowseSheets: () => Promise<DriveItem[]> }) {
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
      <label className="field-label">Document type<select value={type} onChange={(e) => setType(e.target.value as DocType)}><option value="logbook">Logbook</option><option value="agreement">Agreement</option><option value="certificate">Certificate</option><option value="photo">Photo</option></select></label>
      <label className="field-label">File<input name="file" type="file" required /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload to Drive'}</button>
    </form>
  </Drawer>
}

function HelpDrawer({ onClose }: { onClose: () => void }) {
  return <Drawer title="How Fleetwise files" eyebrow="HELP" onClose={onClose}>
    <div className="help-body">
      <p>Drop files into the logbooks, certificates, photos, or agreements Drive folders, including files inside nested folders. Keep Fleetwise open and it scans those folders on its own — including JPEG, PNG, and PDF documents — then renames them as Photos KMHE520A, Insurance - KMHE520A, KMHE520A - Logbook, or KMHE520A - Agreement, with no file extension. Already-renamed files are only written to the sheet if that cell is still empty. Insurance PDFs use REGISTRATION No; logbook PDFs use the REGISTRATION field on the document. Set an insurance inbox and a logbook inbox in Settings; Check inboxes downloads attachments from those addresses into the matching folders.</p>
      <p>It then finds that Registration Number on the STOCK DOCUMENTS tab of Fleet Assets / Fleet Assets - KE and writes a Drive file chip into Logbook / Agreement, Agreement Link, PSV Insurance, or Asset Photo — not an underlined hyperlink. Files named KMHE520A - Agreement in the agreements folder go to Agreement Link. Photos whose name includes Branded go to Asset Photo(Branded). Every scan re-reads Collateral Files: empty cells get a folder named after the registration number under the collateral parent, then a Drive chip. Cells that already have a Drive chip are left as they are.</p>
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
