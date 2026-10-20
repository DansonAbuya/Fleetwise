export type ProcessFocus = 'all' | 'photos' | 'certificates' | 'logbooks' | 'agreements' | 'repair' | 'repair-photos' | 'repair-certificates' | 'repair-logbooks' | 'repair-agreements'

export function processFocusLabel(focus?: ProcessFocus) {
  if (focus === 'photos') return 'Photos'
  if (focus === 'certificates') return 'Insurance'
  if (focus === 'logbooks') return 'Logbooks'
  if (focus === 'agreements') return 'Agreements'
  if (focus === 'repair-photos') return 'Wrong photos'
  if (focus === 'repair-certificates') return 'Wrong insurance'
  if (focus === 'repair-logbooks') return 'Wrong logbooks'
  if (focus === 'repair-agreements') return 'Wrong agreements'
  if (focus === 'repair') return 'Wrong matches'
  if (focus === 'all') return 'All files'
  return 'Processing'
}
