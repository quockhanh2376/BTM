import { readdirSync, readFileSync, lstatSync, existsSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export type TicketType = 'feat' | 'fix' | 'chore' | 'security';
export type TicketSize = 'S' | 'M' | 'L';
export type TicketState =
  | 'pending'
  | 'in_dev'
  | 'awaiting_qc'
  | 'passed'
  | 'returned'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface Ticket {
  id: string;
  goal: string; /* "G1" */
  number: number;
  of: number;
  title: string;
  type: TicketType;
  size: TicketSize;
  scope: string[];
  acceptance: string[];
  done_when: string;
  depends_on: string[];
  from_audit: boolean;
  note?: string;
  openspec_change?: string;
}

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketError';
  }
}

export const ScopePathSchema = z
  .string()
  .min(1, 'Scope path cannot be empty')
  .refine(
    (p) => !p.startsWith('/') && !p.includes('..'),
    { message: 'Scope item must be a relative path and cannot contain ".." or start with "/"' }
  )
  .refine(
    (p) => !/\s|\(/.test(p),
    { message: 'Scope item cannot contain whitespace or "("' }
  );

export const TicketSchema = z
  .object({
    id: z.string().regex(/^[A-Z]{2,5}-\d{4}$/, 'Ticket id must match /^[A-Z]{2,5}-\\d{4}$/'),
    goal: z.string().regex(/^G\d+$/, 'Goal must match /^G\\d+$/'),
    number: z.number().int().positive('Ticket number must be a positive integer'),
    of: z.number().int().positive('Ticket of must be a positive integer'),
    title: z.string().min(1, 'Title cannot be empty'),
    type: z.enum(['feat', 'fix', 'chore', 'security']),
    size: z.enum(['S', 'M', 'L']),
    scope: z.array(ScopePathSchema).min(1, 'Scope cannot be empty'),
    acceptance: z
      .array(z.string().min(1, 'Acceptance item cannot be empty'))
      .min(1, 'Acceptance cannot be empty')
      .max(5, 'Acceptance can have at most 5 items'),
    done_when: z.string().min(1, 'done_when cannot be empty'),
    depends_on: z.array(z.string()).nullish().transform((v) => v ?? []),
    from_audit: z.boolean().nullish().transform((v) => v ?? false),
    note: z
      .union([z.string(), z.number()])
      .nullish()
      .transform((v) => (v != null ? String(v) : undefined)),
    openspec_change: z.string().nullish().transform((v) => v ?? undefined),
  })
  .refine((data) => data.number <= data.of, {
    message: 'Ticket number cannot exceed total count (of)',
    path: ['number'],
  });

function extractFrontMatter(markdown: string): string {
  if (typeof markdown !== 'string') {
    throw new TicketError('Expected markdown string');
  }
  const trimmed = markdown.replace(/^\uFEFF/, '');
  const match = trimmed.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*(?:[\r\n]|$)/);
  if (!match) {
    throw new TicketError('Missing front matter');
  }
  return match[1];
}

export function parseTicket(markdown: string, key: string): Ticket {
  const yamlContent = extractFrontMatter(markdown);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (err) {
    throw new TicketError(`Invalid YAML in ticket: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TicketError('Ticket front matter must be an object');
  }

  const result = TicketSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const p = issue.path.join('.');
        return p ? `${p}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new TicketError(`Ticket validation error: ${details}`);
  }

  const expectedPrefixRegex = new RegExp(`^${key}-\\d{4}$`);
  if (!expectedPrefixRegex.test(result.data.id)) {
    throw new TicketError(
      `Ticket id "${result.data.id}" does not match project key "${key}" (expected ${key}-nnnn)`
    );
  }

  const ticket: Ticket = {
    id: result.data.id,
    goal: result.data.goal,
    number: result.data.number,
    of: result.data.of,
    title: result.data.title,
    type: result.data.type,
    size: result.data.size,
    scope: result.data.scope,
    acceptance: result.data.acceptance,
    done_when: result.data.done_when,
    depends_on: result.data.depends_on,
    from_audit: result.data.from_audit,
  };

  if (result.data.note !== undefined) {
    ticket.note = result.data.note;
  }
  if (result.data.openspec_change !== undefined) {
    ticket.openspec_change = result.data.openspec_change;
  }

  return ticket;
}

export function loadTickets(repo: string, key: string, goal?: string): Ticket[] {
  const ticketsDir = join(repo, 'team', 'tickets');
  if (!existsSync(ticketsDir)) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(ticketsDir, { withFileTypes: true });
  } catch (err) {
    throw new TicketError(`Cannot read directory "${ticketsDir}": ${(err as Error).message}`);
  }

  const tickets: Ticket[] = [];
  const seenIds = new Set<string>();
  const seenGoalNumbers = new Map<string, Set<number>>();

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const filePath = join(ticketsDir, entry.name);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch (err) {
      throw new TicketError(`Cannot read ticket file "${filePath}": ${(err as Error).message}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new TicketError(`Cannot read ticket file "${filePath}": ${(err as Error).message}`);
    }

    const ticket = parseTicket(content, key);
    const expectedId = entry.name.replace(/\.md$/, '');
    if (ticket.id !== expectedId) {
      throw new TicketError(`Ticket id "${ticket.id}" does not match filename "${entry.name}"`);
    }

    if (seenIds.has(ticket.id)) {
      throw new TicketError(`Duplicate ticket id "${ticket.id}"`);
    }
    seenIds.add(ticket.id);

    const goalNumbers = seenGoalNumbers.get(ticket.goal) ?? new Set<number>();
    if (goalNumbers.has(ticket.number)) {
      throw new TicketError(`Duplicate ticket number ${ticket.number} in goal ${ticket.goal}`);
    }
    goalNumbers.add(ticket.number);
    seenGoalNumbers.set(ticket.goal, goalNumbers);

    tickets.push(ticket);
  }

  tickets.sort((a, b) => {
    const numGoalA = parseInt(a.goal.replace(/^G/, ''), 10) || 0;
    const numGoalB = parseInt(b.goal.replace(/^G/, ''), 10) || 0;
    if (numGoalA !== numGoalB) {
      return numGoalA - numGoalB;
    }
    return a.number - b.number;
  });

  if (goal !== undefined) {
    return tickets.filter((t) => t.goal === goal);
  }

  return tickets;
}

export function checkReady(
  t: Ticket,
  stateOf: (id: string) => TicketState | null
): string[] {
  const reasons: string[] = [];

  if (t.size === 'L') {
    reasons.push('size_L');
  }

  for (const dep of t.depends_on) {
    const state = stateOf(dep);
    if (state !== 'passed') {
      reasons.push(`depends_on:${dep}`);
    }
  }

  return reasons;
}

export function reportHeader(
  t: Ticket,
  agentName: string,
  seatLabel: 'Dev' | 'QC' | 'Audit'
): string {
  return `${t.id} · ${t.goal}#${t.number}/${t.of} · ${agentName}-${seatLabel}`;
}
