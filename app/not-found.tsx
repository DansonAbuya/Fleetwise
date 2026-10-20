import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <span className="eyebrow">FLEETWISE</span>
        <h1>Page not found</h1>
        <p>That route does not exist. Return to the module home.</p>
        <Link className="button primary full google-sign-in" href="/">Back to modules</Link>
      </div>
    </main>
  )
}
