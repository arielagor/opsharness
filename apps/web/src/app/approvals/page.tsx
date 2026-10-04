import Link from 'next/link'
import { PlanDiff } from '@/components/plan-diff'
import { when } from '@/components/status'
import { gql } from '@/lib/server'
import { APPROVALS, type PlanV } from '@/lib/queries'
import { decide } from './actions'

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ done?: string; err?: string }> }) {
  const { done, err } = await searchParams
  const { viewer, approvals } = await gql<{ viewer: { canApprove: boolean }; approvals: PlanV[] }>(APPROVALS)
  return (
    <main>
      <h1>Approvals</h1>
      {done && <p className="flash">Recorded: {done}. The worker applies approved plans and closes rejected runs.</p>}
      {err && <p className="flash err">Not recorded: {err}</p>}
      {approvals.length === 0 ? (
        <div className="empty">Nothing is waiting for approval.</div>
      ) : (
        approvals.map((p) => (
          <section key={p.id} className={`card${p.destructive ? ' destructive' : ''}`}>
            <div className="card-head">
              <h2>
                {p.kind === 'create' ? 'New order' : `Edit ${p.orderNumber}`} for {p.customer}
              </h2>
              {p.destructive && <span className="badge s-BLOCKED">destructive</span>}
              <span className="muted">
                proposed {when(p.createdAt)} · {p.runId ? <Link href={`/runs/${p.runId}`}>run trace</Link> : 'no run'}
              </span>
            </div>
            <PlanDiff plan={p} />
            {viewer.canApprove ? (
              <form action={decide} className="actions">
                <input type="hidden" name="planId" value={p.id} />
                <input type="hidden" name="planHash" value={p.hash} />
                {p.destructive && (
                  <label className="ack">
                    <input type="checkbox" name="acknowledgeDestructive" /> I have read the deletions above
                  </label>
                )}
                <button type="submit" name="decision" value="APPROVED" className="primary">
                  Approve
                </button>
                <button type="submit" name="decision" value="REJECTED" className="danger">
                  Reject
                </button>
              </form>
            ) : (
              <p className="muted">You can view this plan but not decide it.</p>
            )}
          </section>
        ))
      )}
    </main>
  )
}
