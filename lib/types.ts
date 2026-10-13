export const DOC_TYPES = ['logbook', 'certificate', 'photo'] as const
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

export type VehicleRecord = {
  plate: string
  brand?: string
  files: Record<DocType, TypedFile[]>
  collateral?: { id: string; name: string; webViewLink?: string }
  present: number
  total: 4
  status: 'Complete' | 'Needs attention'
  updated: string
}

export type FleetConfig = {
  logbooksId: string
  certificatesId: string
  photosId: string
  collateralId?: string
  logbooksName?: string
  certificatesName?: string
  photosName?: string
  collateralName?: string
  spreadsheetId?: string
  spreadsheetName?: string
  logbooksSheet?: string
  certificatesSheet?: string
  photosSheet?: string
  autoUploadThreshold: number
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
  brands: string[]
  unbranded: number
  newPlates: string[]
}

export type FleetSnapshot = {
  user: { name: string; email: string; image?: string }
  config: FleetConfig | null
  vehicles: VehicleRecord[]
  unmatched: TypedFile[]
  inbox: InboxItem[]
  audit: AuditEvent[]
  stats?: FleetStats
  lastSync?: string
  gmailConnected: boolean
  driveConnected: boolean
  ocrConfigured: boolean
  sheetsConnected: boolean
  sheetsError?: string
  ingest?: {
    watching: string
    attempted: number
    renamed: number
    remaining?: number
    more?: boolean
    focus?: 'all' | 'photos' | 'certificates' | 'repair'
    error?: string
    notice?: string
    lastAction?: {
      focus?: 'all' | 'photos' | 'certificates' | 'repair'
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
