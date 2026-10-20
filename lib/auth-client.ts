'use client'

import { useEffect, useState } from 'react'
import { getCurrentUser } from '@/app/actions/auth'

export type ClientUser = { name: string; email: string; image?: string }

export function useSession() {
  const [user, setUser] = useState<ClientUser | null>(null)
  const [isPending, setPending] = useState(true)

  useEffect(() => {
    getCurrentUser()
      .then((next) => setUser(next))
      .catch(() => setUser(null))
      .finally(() => setPending(false))
  }, [])

  return { user, isPending }
}

export function signOut() {
  window.location.assign('/auth/logout')
}
