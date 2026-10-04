import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { gql } from '@/lib/server'
import { VIEWER } from '@/lib/queries'
import './globals.css'

export const metadata: Metadata = {
  title: 'opsharness console',
  description: 'Runs, traces and approvals for the opsharness work sample. SYNTHETIC data; unofficial; not affiliated with or endorsed by Distru.',
}

export const dynamic = 'force-dynamic'

async function viewer() {
  try {
    return await gql<{ viewer: { displayName: string; tenantName: string }; approvals: { id: string }[] }>(VIEWER)
  } catch {
    return null
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const v = await viewer()
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <span className="brand">opsharness</span>
            <nav className="nav">
              <Link href="/">Runs</Link>
              <Link href="/approvals">Approvals{v && v.approvals.length > 0 ? ` (${v.approvals.length})` : ''}</Link>
            </nav>
            <span className="who">{v ? `${v.viewer.displayName} · ${v.viewer.tenantName}` : 'database unavailable'}</span>
          </header>
          <p className="banner">
            Work sample. SYNTHETIC data against a mock of Distru&apos;s published API contract. Unofficial; not affiliated with or endorsed by Distru.
          </p>
          {children}
        </div>
      </body>
    </html>
  )
}
