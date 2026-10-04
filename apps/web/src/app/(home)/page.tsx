import Link from 'next/link'
import { StatusBadge, when } from '@/components/status'
import { gql } from '@/lib/server'
import { RUNS, type RunListItem, type RunStatus } from '@/lib/queries'

const FILTERS: (RunStatus | 'ALL')[] = ['ALL', 'AWAITING_APPROVAL', 'APPLIED', 'BLOCKED', 'NEEDS_CLARIFICATION', 'REJECTED', 'FAILED']

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  const filter = FILTERS.includes(status as RunStatus) && status !== 'ALL' ? (status as RunStatus) : undefined
  const { runs } = await gql<{ runs: RunListItem[] }>(RUNS, filter ? { status: [filter] } : {})
  return (
    <main>
      <h1>Runs</h1>
      <div className="filters">
        {FILTERS.map((f) => (
          <Link key={f} href={f === 'ALL' ? '/' : `/?status=${f}`} className={(filter ?? 'ALL') === f ? 'on' : undefined}>
            {f === 'ALL' ? 'All' : f.replaceAll('_', ' ').toLowerCase()}
          </Link>
        ))}
      </div>
      {runs.length === 0 ? (
        <div className="empty">
          {filter ? 'No runs with this status.' : (
            <>
              No runs yet. Start one with <code>pnpm --filter @opsharness/harness exec opsharness demo</code>.
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Source</th>
                <th>Status</th>
                <th>Summary</th>
                <th className="num">Model turns</th>
                <th className="num">Tokens</th>
                <th className="num">Tool calls</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">
                    <Link href={`/runs/${r.id}`}>{when(r.createdAt)}</Link>
                  </td>
                  <td>
                    {r.sourceKind}: <span className="mono">{r.sourceRef}</span>
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.summary}</td>
                  <td className="num">{r.usage.modelTurns}</td>
                  <td className="num">{r.usage.inputTokens + r.usage.outputTokens}</td>
                  <td className="num">{r.usage.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
