/** Where a run's order came from. The content itself is untrusted data. */
export interface Source {
  kind: 'email' | 'sheet'
  /** message_id or sheet_id in the tenant's workspace. */
  ref: string
}

export interface DraftLine {
  description: string
  sku?: string | null
  quantity: number
  unit_price?: number | null
}

/** What the intake specialist extracted. Every field is a claim to be verified, not a fact. */
export interface OrderDraft {
  customer_name?: string | null
  order_reference?: string | null
  intent: 'new_order' | 'change_order'
  lines: DraftLine[]
  notes?: string | null
  source_quote: string
}

export interface Proposal {
  planId: string
  planHash: string
  destructive: boolean
  destructiveReasons: string[]
  summary: string
}

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export interface Verdict {
  /** True when nothing blocks sending the plan to a human. */
  ok: boolean
  /** The source cannot be matched to one product per line: ask, don't guess. */
  needsClarification: boolean
  blockers: string[]
  warnings: string[]
  checks: Check[]
}

export interface ApplyView {
  ok: boolean
  orderId?: string
  orderNumber?: string
  total?: string
  replayed?: boolean
  error?: string
}

export type Outcome = 'APPLIED' | 'REJECTED' | 'BLOCKED' | 'NEEDS_CLARIFICATION' | 'FAILED'
