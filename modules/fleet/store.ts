import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import path from 'path'
import type { FleetBikeRow, FleetDayRow } from '@/modules/fleet/report'

export type StoredBike = FleetBikeRow
export type StoredDay = FleetDayRow & { id: string }

type Store = { bikes: StoredBike[]; days: StoredDay[] }

const file = path.join(process.cwd(), 'data', 'fleet-operations.json')
let chain: Promise<unknown> = Promise.resolve()

function queue<T>(task: () => Promise<T>) {
  const run = chain.then(task, task)
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Store>
    return { bikes: parsed.bikes || [], days: parsed.days || [] }
  } catch {
    return { bikes: [], days: [] }
  }
}

async function writeStore(store: Store) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(store))
  await rename(temp, file)
}

export function readFleetStore() {
  return queue(readStore)
}

export function updateFleetStore(change: (store: Store) => void) {
  return queue(async () => {
    const store = await readStore()
    change(store)
    await writeStore(store)
    return store
  })
}

export function newFleetId() {
  return randomUUID()
}
