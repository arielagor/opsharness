import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'

/** The SYNTHETIC fixtures shipped with this package: fixtures/<tenant>/{mail,sheets}. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

const ID = /^[a-z0-9][a-z0-9.-]*$/

export interface EmailSummary { message_id: string; from: string; subject: string; date: string | null }
export interface Email extends EmailSummary { to: string; body: string }
export interface Sheet { sheet_id: string; columns: string[]; rows: Record<string, string>[] }

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some((f) => f !== '')) rows.push(row)
  }
  return rows
}

/**
 * Read-only access to ONE tenant's workspace. The tenant directory is fixed at construction;
 * ids are matched against the directory listing, never joined into a path unchecked.
 */
export class TenantWorkspace {
  constructor(
    readonly tenantId: string,
    private readonly root: string = DEFAULT_FIXTURES_DIR,
  ) {
    if (!ID.test(tenantId)) throw new Error(`Invalid tenant id ${tenantId}`)
  }

  private dir(kind: 'mail' | 'sheets') {
    return join(this.root, this.tenantId, kind)
  }

  private async ids(kind: 'mail' | 'sheets', ext: string): Promise<string[]> {
    try {
      return (await readdir(this.dir(kind)))
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length))
        .filter((id) => ID.test(id))
        .sort()
    } catch {
      return []
    }
  }

  private async resolve(kind: 'mail' | 'sheets', ext: string, id: string): Promise<string | undefined> {
    return (await this.ids(kind, ext)).includes(id) ? join(this.dir(kind), `${id}${ext}`) : undefined
  }

  async listEmails(): Promise<EmailSummary[]> {
    const out: EmailSummary[] = []
    for (const id of await this.ids('mail', '.eml')) {
      const e = (await this.readEmail(id))!
      out.push({ message_id: e.message_id, from: e.from, subject: e.subject, date: e.date })
    }
    return out
  }

  async readEmail(id: string): Promise<Email | undefined> {
    const file = await this.resolve('mail', '.eml', id)
    if (!file) return undefined
    const parsed = await simpleParser(await readFile(file))
    const addr = (a: unknown) => (a && typeof a === 'object' && 'text' in a ? String((a as { text: string }).text) : '')
    return {
      message_id: id,
      from: addr(parsed.from),
      to: addr(parsed.to),
      subject: parsed.subject ?? '',
      date: parsed.date ? parsed.date.toISOString() : null,
      body: (parsed.text ?? '').replace(/\r\n/g, '\n').trim(),
    }
  }

  async listSheets(): Promise<{ sheet_id: string }[]> {
    return (await this.ids('sheets', '.csv')).map((sheet_id) => ({ sheet_id }))
  }

  async readSheet(id: string): Promise<Sheet | undefined> {
    const file = await this.resolve('sheets', '.csv', id)
    if (!file) return undefined
    const [header, ...body] = parseCsv(await readFile(file, 'utf8'))
    const columns = (header ?? []).map((c) => c.trim())
    return { sheet_id: id, columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))) }
  }
}
