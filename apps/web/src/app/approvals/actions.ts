'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { gql } from '@/lib/server'
import { DECIDE } from '@/lib/queries'

/**
 * Records the human decision through the GraphQL mutation. The plan store writes the approval and
 * its audit row in one transaction; the harness worker then resumes the run. Nothing here writes
 * to Distru.
 */
export async function decide(form: FormData): Promise<void> {
  const decision = form.get('decision') === 'REJECTED' ? 'REJECTED' : 'APPROVED'
  const planId = String(form.get('planId') ?? '')
  const r = await gql<{ decide: { ok: boolean; error: string | null } }>(DECIDE, {
    planId,
    planHash: String(form.get('planHash') ?? ''),
    decision,
    acknowledgeDestructive: form.get('acknowledgeDestructive') === 'on',
    note: String(form.get('note') ?? '') || null,
  })
  revalidatePath('/approvals')
  revalidatePath('/')
  const q = r.decide.ok ? `done=${encodeURIComponent(`${decision.toLowerCase()} ${planId}`)}` : `err=${encodeURIComponent(r.decide.error ?? 'failed')}`
  redirect(`/approvals?${q}`)
}
