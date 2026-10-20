'use client'

import { Suspense } from 'react'
import { ConsoleShell } from '@/modules/stock/components/chrome'
import { StockApp } from '@/modules/stock/stock-app'

export default function Page() {
  return (
    <Suspense fallback={<ConsoleShell />}>
      <StockApp />
    </Suspense>
  )
}
