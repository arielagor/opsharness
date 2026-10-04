import type { LineV, PlanV } from '@/lib/queries'

const money = (n: number) => n.toFixed(2)

function Row({ l, kind, note }: { l: LineV; kind: 'added' | 'deleted' | 'changed' | 'kept'; note?: string }) {
  return (
    <tr className={kind === 'deleted' ? 'row-deleted' : kind === 'added' ? 'row-added' : undefined}>
      <td>{kind === 'deleted' ? 'DELETED' : kind === 'added' ? 'added' : kind}</td>
      <td className="mono">{l.sku}</td>
      <td>{l.name}</td>
      <td className="num">{l.quantity}</td>
      <td className="num">{money(l.price)}</td>
      <td className="muted">{note ?? ''}</td>
    </tr>
  )
}

/** The semantic diff a human approves. Deleted lines are red and named; nothing is hidden behind a toggle. */
export function PlanDiff({ plan }: { plan: PlanV }) {
  const { added, changed, kept, deleted } = plan.lines
  return (
    <div>
      {plan.destructive && (
        <ul className="del-reasons">
          {plan.destructiveReasons.map((r) => (
            <li key={r}>This plan {r}</li>
          ))}
        </ul>
      )}
      {plan.header.length > 0 && (
        <p className="muted">
          Header: {plan.header.map((h) => `${h.field}: ${h.from ?? 'none'} → ${h.to ?? 'none'}`).join('; ')}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Change</th>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">Qty</th>
              <th className="num">Price</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {deleted.map((l) => (
              <Row key={`d${l.lineId}`} l={l} kind="deleted" note="removed from the order" />
            ))}
            {changed.map((l) => (
              <Row key={`c${l.lineId}`} l={l} kind="changed" note={l.changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join(', ')} />
            ))}
            {added.map((l, i) => (
              <Row key={`a${i}`} l={l} kind="added" />
            ))}
            {kept.map((l) => (
              <Row key={`k${l.lineId}`} l={l} kind="kept" />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
