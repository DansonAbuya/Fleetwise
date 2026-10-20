import { Bike, ClipboardList, FileText, LayoutGrid, type LucideIcon } from 'lucide-react'

export type FleetView = 'Overview' | 'Bikes' | 'Activity' | 'Daily report'

export const FLEET_NAV: { label: FleetView; icon: LucideIcon; detail: string }[] = [
  { label: 'Overview', icon: LayoutGrid, detail: 'Yesterday’s fleet department report.' },
  { label: 'Bikes', icon: Bike, detail: 'Bikes on loan, branded units, activations, and repossessions.' },
  { label: 'Activity', icon: ClipboardList, detail: 'Rides, mileage, and net earnings for each bike.' },
  { label: 'Daily report', icon: FileText, detail: 'Generate the fleet department daily report.' },
]
