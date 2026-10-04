const LABEL: Record<string, string> = {
  RUNNING: 'Running',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPLIED: 'Applied',
  REJECTED: 'Rejected',
  BLOCKED: 'Blocked',
  NEEDS_CLARIFICATION: 'Needs clarification',
  FAILED: 'Failed',
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{LABEL[status] ?? status}</span>
}

export function when(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
