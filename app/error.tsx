'use client'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <span className="eyebrow">FLEETWISE</span>
        <h1>Something went wrong</h1>
        <p>{error.message || 'The workspace could not be loaded.'}</p>
        <button className="button primary full" type="button" onClick={reset}>Try again</button>
      </div>
    </main>
  )
}
