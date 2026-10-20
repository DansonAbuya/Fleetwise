import type { DocType, DuplicateFile, FleetConfig, TypedFile, VehicleRecord } from '@/lib/types'

export type SheetSyncMode = 'auto' | 'full' | 'match'

export type SheetCell = { label: string; uri?: string }
export type SheetDocKey = DocType | 'collateral' | 'agreement'
export type SheetRowMeta = Partial<Record<SheetDocKey, SheetCell>> & {
  brand?: string
  commencement?: string
  expiry?: string
}
export type SheetCells = Map<string, SheetRowMeta>

export type ModuleSyncResult = {
  moduleId: string
  keys: Set<string>
  written: number
  missing: string[]
  matched: string[]
  hint: string
  cells: SheetCells
  error?: string
  more?: boolean
}

export type ModuleRegister = {
  vehicles: VehicleRecord[]
  unmatched: TypedFile[]
  duplicates: DuplicateFile[]
}

export type SheetModule = {
  id: string
  label: string
  description: string
  matchHint: string
  sync(config: FleetConfig, files: TypedFile[], mode: SheetSyncMode): Promise<ModuleSyncResult>
  buildRegister(files: TypedFile[], sync: Pick<ModuleSyncResult, 'keys' | 'cells'>): ModuleRegister
}
