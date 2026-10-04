'use client'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
        <h1>The console failed to load</h1>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  )
}
