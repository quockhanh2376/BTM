import { readdirSync, readFileSync, lstatSync, realpathSync, Dirent } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface TaskCard {
  id: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  done_when: string;
  out_of_scope?: string[];
  context?: string[];
  openspec_change?: string;
  note?: string;
}

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardError';
  }
}

const ScopePathSchema = z
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

export const TaskCardSchema = z.object({
  id: z.string().regex(/^T-\d{3}$/, 'Task id must match /^T-\\d{3}$/'),
  goal: z.string().min(1, 'Goal cannot be empty'),
  scope: z.array(ScopePathSchema).min(1, 'Scope cannot be empty'),
  acceptance: z
    .array(z.string().min(1, 'Acceptance item cannot be empty'))
    .min(1, 'Acceptance cannot be empty')
    .max(5, 'Acceptance can have at most 5 items'),
  done_when: z.string().min(1, 'done_when cannot be empty'),
  out_of_scope: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  context: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  openspec_change: z.string().nullish().transform((v) => v ?? undefined),
  note: z.string().nullish().transform((v) => v ?? undefined),
});

function extractFrontMatter(markdown: string): string {
  if (typeof markdown !== 'string') {
    throw new CardError('Expected markdown string');
  }
  const trimmed = markdown.replace(/^\uFEFF/, '');
  const match = trimmed.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*(?:[\r\n]|$)/);
  if (!match) {
    throw new CardError('Missing front matter');
  }
  return match[1];
}

export function parseTaskCard(markdown: string): TaskCard {
  const yamlContent = extractFrontMatter(markdown);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (err) {
    throw new CardError(`Invalid YAML in task card: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CardError('Task card front matter must be an object');
  }

  const result = TaskCardSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const p = issue.path.join('.');
        return p ? `${p}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new CardError(`Card validation error: ${details}`);
  }

  const card: TaskCard = {
    id: result.data.id,
    goal: result.data.goal,
    scope: result.data.scope,
    acceptance: result.data.acceptance,
    done_when: result.data.done_when,
  };

  if (result.data.out_of_scope !== undefined) {
    card.out_of_scope = result.data.out_of_scope;
  }
  if (result.data.context !== undefined) {
    card.context = result.data.context;
  }
  if (result.data.openspec_change !== undefined) {
    card.openspec_change = result.data.openspec_change;
  }
  if (result.data.note !== undefined) {
    card.note = result.data.note;
  }

  return card;
}

export function loadTaskCards(dir: string, repo?: string): TaskCard[] {
  if (repo !== undefined) {
    let realDir: string;
    let realRepo: string;
    try {
      realDir = realpathSync(dir);
      realRepo = realpathSync(repo);
    } catch (err) {
      throw new CardError(`Cannot resolve path: ${(err as Error).message}`);
    }
    const rel = relative(realRepo, realDir);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new CardError(`Tasks directory "${dir}" is outside repository "${repo}"`);
    }
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new CardError(`Cannot read directory "${dir}": ${(err as Error).message}`);
  }

  const cards: TaskCard[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!/^T-.*\.md$/.test(entry.name)) {
      continue;
    }
    const filePath = join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch (err) {
      throw new CardError(`Cannot read task card file "${filePath}": ${(err as Error).message}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new CardError(`Cannot read task card file "${filePath}": ${(err as Error).message}`);
    }
    try {
      const card = parseTaskCard(content);
      const expectedId = entry.name.replace(/\.md$/, '');
      if (card.id !== expectedId) {
        throw new CardError(`Task card id "${card.id}" does not match filename "${entry.name}"`);
      }
      if (seenIds.has(card.id)) {
        throw new CardError(`Duplicate task card id "${card.id}"`);
      }
      seenIds.add(card.id);
      cards.push(card);
    } catch (err) {
      if (err instanceof CardError) {
        throw new CardError(`Error loading "${filePath}": ${err.message}`);
      }
      throw err;
    }
  }

  cards.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return cards;
}
