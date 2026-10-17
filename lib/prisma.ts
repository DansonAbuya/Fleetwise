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

export async function databaseStatus() {
  if (!databaseConfigured()) {
    return { configured: false, connected: false, vehicles: 0 }
  }
  try {
    const vehicles = await prisma().vehicle.count()
    return { configured: true, connected: true, vehicles }
  } catch {
    return { configured: true, connected: false, vehicles: 0 }
  }
}
