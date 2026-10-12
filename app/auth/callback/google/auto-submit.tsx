'use client'

import { useEffect, useRef } from 'react'

export function AutoSubmit() {
  const submitted = useRef(false)
  useEffect(() => {
    if (submitted.current) return
    submitted.current = true
    const form = document.getElementById('google-callback-form') as HTMLFormElement | null
    form?.requestSubmit()
  }, [])
  return null
}
