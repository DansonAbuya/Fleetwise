import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL)
}

export function prisma() {
  if (!databaseConfigured()) {
    throw new Error('Add DATABASE_URL from your Neon project to .env, run npx prisma db push, then restart the app.')
  }
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient()
  }
  return globalForPrisma.prisma
}

const statusStore = globalThis as typeof globalThis & { __fleetwiseDbStatus?: { at: number; status: { configured: boolean; connected: boolean; vehicles: number } } }

export function clearDatabaseStatusCache() {
  statusStore.__fleetwiseDbStatus = undefined
}

export async function databaseStatus() {
  if (!databaseConfigured()) {
    return { configured: false, connected: false, vehicles: 0 }
  }
  const cached = statusStore.__fleetwiseDbStatus
  if (cached && Date.now() - cached.at < 30_000) return cached.status
  try {
    const vehicles = await prisma().vehicle.count()
    const status = { configured: true, connected: true, vehicles }
    statusStore.__fleetwiseDbStatus = { at: Date.now(), status }
    return status
  } catch {
    return { configured: true, connected: false, vehicles: 0 }
  }
}
