import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PlanDiff } from '@/components/plan-diff'
import { StatusBadge, when } from '@/components/status'
import { gql } from '@/lib/server'
import { RUN, type RunV } from '@/lib/queries'

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { run } = await gql<{ run: RunV | null }>(RUN, { id })
  // Another tenant's run id is indistinguishable from one that does not exist.
  if (!run) notFound()
  const u = run.usage
  return (
    <main>
      <p>
        <Link href="/">← Runs</Link>
      </p>
      <h1>
        Run <span className="mono">{run.id}</span> <StatusBadge status={run.status} />
      </h1>
      <dl className="kv">
        <dt>Source</dt>
        <dd>
          {run.sourceKind}: <span className="mono">{run.sourceRef}</span>
        </dd>
        <dt>Summary</dt>
        <dd>{run.summary}</dd>
        <dt>Model</dt>
        <dd>
          {run.model} ({run.mode})
        </dd>
        <dt>Started / updated</dt>
        <dd>
          {when(run.createdAt)} / {when(run.updatedAt)}
        </dd>
        <dt>Usage</dt>
        <dd>
          {u.modelTurns} model turns, {u.inputTokens} in / {u.outputTokens} out tokens, {u.toolCalls} MCP calls ({Math.round(u.toolLatencyMs)} ms)
        </dd>
        {run.injectionSuspected && (
          <>
            <dt>Injection</dt>
            <dd className="muted">The source contained text addressed to the assistant. It was treated as data.</dd>
          </>
        )}
      </dl>

      {run.blockers.length > 0 && (
        <>
          <h2>Blockers</h2>
          <ul className="del-reasons">
            {run.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </>
      )}
      {run.warnings.length > 0 && (
        <>
          <h2>Warnings</h2>
          <ul className="warnings">
            {run.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}

      <h2>Graph trail</h2>
      {run.trail.length === 0 ? <p className="muted">No steps recorded.</p> : (
        <ol className="trail">
          {run.trail.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      )}

      {run.plans.map((p) => (
        <section key={p.id} className={`card${p.destructive ? ' destructive' : ''}`}>
          <div className="card-head">
            <h2>
              Plan <span className="mono">{p.id}</span>
            </h2>
            <span className="badge">{p.status}</span>
            {p.destructive && <span className="badge s-BLOCKED">destructive</span>}
            {p.approval && (
              <span className="muted">
                {p.approval.decision} by {p.approval.approverId} at {when(p.approval.decidedAt)}
                {p.approval.acknowledgeDestructive ? ' (deletions acknowledged)' : ''}
              </span>
            )}
          </div>
          <p>
            {p.kind === 'create' ? 'New order' : `Edit ${p.orderNumber}`} for {p.customer}
          </p>
          <PlanDiff plan={p} />
        </section>
      ))}

      <h2>Audit trail ({run.toolCalls.length} rows)</h2>
      {run.toolCalls.length === 0 ? <div className="empty">No tool calls recorded for this run.</div> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Node</th>
                <th>Principal</th>
                <th>Call</th>
                <th>Result</th>
                <th className="num">ms</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {run.toolCalls.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.startedAt.slice(11, 23)}</td>
                  <td>{c.node ?? ''}</td>
                  <td className="mono">{c.principalId}</td>
                  <td>
                    <details>
                      <summary className="mono">
                        {c.server}.{c.tool}
                      </summary>
                      <pre>{c.args}</pre>
                      {c.result && <pre>{c.result}</pre>}
                    </details>
                  </td>
                  <td className={c.ok ? undefined : 's-FAILED'}>{c.ok ? 'ok' : (c.error ?? 'error')}</td>
                  <td className="num">{c.latencyMs.toFixed(1)}</td>
                  <td className="num">{c.inputTokens !== null ? `${c.inputTokens}/${c.outputTokens}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
