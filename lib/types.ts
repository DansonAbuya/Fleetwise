export const DOC_TYPES = ['logbook', 'certificate', 'photo', 'agreement'] as const
export type DocType = (typeof DOC_TYPES)[number]
export const DEFAULT_COLLATERAL_PARENT_ID = '1adoj_LXvsAXcke0mzgLENQdqusDLT08-'

export type DriveItem = {
  id: string
  name: string
  mimeType?: string
  modifiedTime?: string
  webViewLink?: string
  iconLink?: string
  parents?: string[]
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
}

export type TypedFile = DriveItem & {
  type: DocType
  plate: string | null
}

/** A folder file left over after this plate and document type were already uploaded to STOCK DOCUMENTS. */
export type DuplicateFile = TypedFile & {
  sheetLabel: string
  uploadedId: string
  uploadedName: string
  uploadedLink?: string
}

export type InsuranceCoverView = {
  commencement: string | null
  expiry: string | null
  daysLeft: number | null
  alert: 'week' | 'two-days' | 'expired' | null
}

export type InsuranceAlert = InsuranceCoverView & {
  plate: string
  kind: 'week' | 'two-days' | 'expired'
}

export type VehicleRecord = {
  plate: string
  brand?: string
  files: Record<DocType, TypedFile[]>
  collateral?: { id: string; name: string; webViewLink?: string }
  agreement?: { id: string; name: string; webViewLink?: string }
  insurance?: InsuranceCoverView
  present: number
  total: 5
  status: 'Complete' | 'Needs attention'
  updated: string
}

export type FleetConfig = {
  logbooksId: string
  certificatesId: string
  photosId: string
  agreementsId?: string
  collateralId?: string
  logbooksName?: string
  certificatesName?: string
  photosName?: string
  agreementsName?: string
  collateralName?: string
  spreadsheetId?: string
  spreadsheetName?: string
  logbooksSheet?: string
  certificatesSheet?: string
  photosSheet?: string
  autoUploadThreshold: number
  insuranceInboxEmail?: string
  logbooksInboxEmail?: string
  lastSync?: string
  configFileId?: string
}

export type InboxItem = {
  id: string
  sender: string
  subject: string
  attachment: string
  received: string
  vehicle: string
  confidence: number
  status: 'Auto-uploaded' | 'Needs review'
  fileId?: string
  folder: string
  type?: DocType
}

export type AuditEvent = {
  user: string
  action: string
  time: string
}

export type GmailState = {
  lastSync?: string
  processedIds: string[]
  items: InboxItem[]
}

export type FleetStats = {
  total: number
  complete: number
  attention: number
  logbook: number
  certificate: number
  photo: number
  collateral: number
  agreement: number
  brands: string[]
  unbranded: number
  newPlates: string[]
  insuranceWeek: number
  insuranceTwoDays: number
  insuranceExpired: number
}

export type FleetSnapshot = {
  user: { name: string; email: string; image?: string }
  config: FleetConfig | null
  vehicles: VehicleRecord[]
  unmatched: TypedFile[]
  duplicates: DuplicateFile[]
  insuranceAlerts?: InsuranceAlert[]
  inbox: InboxItem[]
  audit: AuditEvent[]
  stats?: FleetStats
  lastSync?: string
  gmailConnected: boolean
  driveConnected: boolean
  ocrConfigured: boolean
  sheetsConnected: boolean
  databaseConnected?: boolean
  databaseVehicles?: number
  sheetsError?: string
  ingest?: {
    watching: string
    attempted: number
    renamed: number
    remaining?: number
    more?: boolean
    collateralMore?: boolean
    collateralStamp?: string
    focus?: 'all' | 'photos' | 'certificates' | 'logbooks' | 'agreements' | 'repair' | 'repair-photos' | 'repair-certificates' | 'repair-logbooks' | 'repair-agreements'
    error?: string
    notice?: string
    follow?: 'gmail' | 'files'
    preserve?: boolean
    lastAction?: {
      focus?: 'all' | 'photos' | 'certificates' | 'logbooks' | 'agreements' | 'repair' | 'repair-photos' | 'repair-certificates' | 'repair-logbooks' | 'repair-agreements'
      status?: string
      fileName?: string
      plate?: string
      detail?: string
      at?: string
      remaining?: number
      done?: number
    }
  }
}
