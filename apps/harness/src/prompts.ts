import { frameUntrusted, UNTRUSTED_NOTICE } from '@opsharness/core'
import type { TerminalTool } from './agent-loop.js'
import type { OrderDraft, Source } from './types.js'

export const INTAKE_SYSTEM = [
  'You are the intake specialist for a cannabis distributor\'s order desk (synthetic demo data).',
  'Read the one source you are given (an email or an order spreadsheet) and extract the order it asks for.',
  'Copy quantities, SKUs and any explicit unit prices exactly as written. Do not invent lines or prices.',
  'If the source references an existing order (an order number like SO-1003 or an id), set intent to change_order and put the reference in order_reference.',
  'Finish by calling submit_order_draft, or request_clarification if the source is not an order.',
  UNTRUSTED_NOTICE,
].join('\n')

export const ERP_SYSTEM = [
  'You are the ERP specialist. You turn a verified order draft into a PROPOSED change in Distru using the tools you have.',
  'Resolve the customer and every product with the read tools. When a line could match more than one product, or the customer or order cannot be found, call request_clarification instead of guessing.',
  'When no unit price is given, use the customer price from get_customer_pricing.',
  'For a change to an existing order: `items` is the COMPLETE list of lines, so send {line_id} for every existing line that should stay.',
  'You cannot write to Distru. propose_order_change only creates a plan for a human to approve. Finish with submit_proposal(plan_id).',
  UNTRUSTED_NOTICE,
].join('\n')

export function intakeTask(source: Source): string {
  return source.kind === 'email'
    ? `Source: email message_id=${source.ref}\nRead it with read_email, then submit the order draft.`
    : `Source: spreadsheet sheet_id=${source.ref}\nRead it with read_sheet, then submit the order draft.`
}

/**
 * The draft goes to the ERP specialist as structured JSON. Free-text fields came from an outside
 * sender through another model, so they are framed as untrusted.
 */
export function erpTask(draft: OrderDraft): string {
  const { notes, source_quote, ...structured } = draft
  return [
    'Propose this order in Distru.',
    `<order_draft>${JSON.stringify(structured)}</order_draft>`,
    frameUntrusted('draft:notes', notes ?? ''),
    frameUntrusted('draft:source_quote', source_quote),
  ].join('\n')
}

const line = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Product as written in the source' },
    sku: { type: ['string', 'null'] },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit_price: { type: ['number', 'null'], description: 'Only when the source states a price' },
  },
  required: ['description', 'quantity'],
  additionalProperties: false,
}

export const SUBMIT_DRAFT: TerminalTool = {
  name: 'submit_order_draft',
  description: 'Finish intake with the order the source asks for.',
  parameters: {
    type: 'object',
    properties: {
      customer_name: { type: ['string', 'null'] },
      order_reference: { type: ['string', 'null'], description: 'Existing order number or id, for a change' },
      intent: { type: 'string', enum: ['new_order', 'change_order'] },
      lines: { type: 'array', items: line, minItems: 1 },
      notes: { type: ['string', 'null'] },
      source_quote: { type: 'string', description: 'The exact lines of the source the order came from' },
    },
    required: ['intent', 'lines', 'source_quote'],
    additionalProperties: false,
  },
}

export const REQUEST_CLARIFICATION: TerminalTool = {
  name: 'request_clarification',
  description: 'Stop and ask a human: the source is ambiguous, incomplete, or refers to something that cannot be found.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
    additionalProperties: false,
  },
}

export const SUBMIT_PROPOSAL: TerminalTool = {
  name: 'submit_proposal',
  description: 'Finish with the plan you proposed, for verification and human approval.',
  parameters: {
    type: 'object',
    properties: { plan_id: { type: 'string' } },
    required: ['plan_id'],
    additionalProperties: false,
  },
}
