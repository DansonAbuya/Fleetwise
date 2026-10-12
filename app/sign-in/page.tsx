'use client'

import { startGoogleSignIn } from '@/app/actions/auth'
import { Truck } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { useFormStatus } from 'react-dom'

function GoogleButton() {
  const { pending } = useFormStatus()
  return (
    <button className="button primary full google-sign-in" type="submit" disabled={pending} aria-busy={pending}>
      {pending ? 'Redirecting to Google…' : 'Continue with Google'}
    </button>
  )
}

function SignInForm() {
  const params = useSearchParams()
  const error = params.get('error')

  return (
    <main className="auth-page">
      <section className="auth-visual" aria-hidden="true">
        <div className="auth-visual-brand">
          <div className="brand-mark"><Truck size={20} /></div>
          <div><strong>Fleetwise</strong></div>
        </div>
        <div>
          <h2>Document control for the fleet that keeps Kenya moving.</h2>
          <p>Match Drive files to STOCK DOCUMENTS, chip logbooks, insurance, and photos onto the register, and keep completeness visible in one operations console.</p>
        </div>
        <div className="auth-visual-meta">
          <div><strong>Drive</strong>Source of files</div>
          <div><strong>Sheets</strong>Vehicle register</div>
          <div><strong>Gmail</strong>Certificate intake</div>
        </div>
      </section>
      <div className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark"><Truck size={18} /></div>
          <div><strong>Fleetwise</strong><span>Document control</span></div>
        </div>
        <span className="eyebrow">SECURE OPERATIONS ACCESS</span>
        <h1>Sign in with Google</h1>
        <p>Fleetwise asks for Drive, Sheets, and Gmail. Only accounts that can open the document folders and the workbook can operate.</p>
        {error && <div className="auth-error" role="alert">{error === 'oauth' ? 'Google sign-in failed. Add http://localhost:3000/auth/callback/google as an authorized redirect URI, then try again.' : error}</div>}
        <form action={startGoogleSignIn}>
          <GoogleButton />
        </form>
      </div>
    </main>
  )
}

export default function SignInPage() {
  return (
    <Suspense fallback={<main className="auth-page"><div className="auth-card"><span className="eyebrow">FLEETWISE</span><h1>Loading sign-in</h1><p>Preparing Google access.</p></div></main>}>
      <SignInForm />
    </Suspense>
  )
}
