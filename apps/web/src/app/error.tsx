'use client'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p className="flash err">
        The console could not load this page{error.digest ? ` (reference ${error.digest})` : ''}. If Postgres is not running, start it with <code>pnpm db:up</code>.
      </p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  )
}
