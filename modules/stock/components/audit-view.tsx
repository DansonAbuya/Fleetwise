'use client'

import { ArrowDownToLine, Database, UserRound } from 'lucide-react'
import type { FleetSnapshot } from '@/lib/types'

export function AuditView({ events, onExport }: { events: FleetSnapshot['audit']; onExport: () => void }) {
  return <section className="panel table-panel standalone"><div className="panel-heading"><div><h2>Audit log</h2><p>Written to fleetwise-audit.jsonl in the certificates folder.</p></div><button className="button secondary" onClick={onExport} disabled={!events.length}><ArrowDownToLine size={16} /> Export log</button></div><div className="audit-list">{events.length === 0 ? <div className="empty-row">No audit events yet.</div> : events.map((event) => <div className="audit-row" key={`${event.time}-${event.action}`}><div className="audit-avatar">{event.user === 'System' ? <Database size={15} /> : <UserRound size={15} />}</div><div><strong>{event.user}</strong><span>{event.action}</span></div><time>{event.time}</time></div>)}</div></section>
}
