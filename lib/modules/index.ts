import { stockDocumentsModule } from '@/lib/modules/stock-documents'
import type { ModuleSyncResult, SheetModule, SheetSyncMode } from '@/lib/modules/types'
import type { FleetConfig, TypedFile } from '@/lib/types'

/**
 * Register another workbook tab by adding a module next to stock-documents
 * and appending it here. Each module owns its tab headers, chip writes, and
 * register grouping. Fleetwise runs them in order during a scan.
 */
export const SHEET_MODULES: SheetModule[] = [
  stockDocumentsModule,
]

export function sheetModuleById(id: string) {
  return SHEET_MODULES.find((module) => module.id === id)
}

export async function syncSheetModules(config: FleetConfig, files: TypedFile[], mode: SheetSyncMode) {
  const results: ModuleSyncResult[] = []
  for (const module of SHEET_MODULES) {
    try {
      results.push(await module.sync(config, files, mode))
    } catch (err) {
      results.push({
        moduleId: module.id,
        keys: new Set(),
        written: 0,
        missing: [],
        matched: [],
        hint: '',
        cells: new Map(),
        error: err instanceof Error ? err.message : 'Sheet module failed',
      })
    }
  }
  return results
}

export { stockDocumentsModule }
export type { ModuleSyncResult, SheetCell, SheetCells, SheetModule } from '@/lib/modules/types'
