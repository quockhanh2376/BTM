import { z } from 'zod';
import type { AuditFinding } from '../ticket/ticket.ts';

export interface AuditResult {
  verdict: 'pass' | 'fail';
  findings: AuditFinding[];
}

function createInvalidResult(): AuditResult {
  return {
    verdict: 'fail',
    findings: [{ ticket: '', severity: 'high', text: 'audit_output_invalid' }],
  };
}

const AuditFindingSchema = z.object({
  ticket: z.string().default(''),
  severity: z.enum(['high', 'medium', 'low']),
  text: z.string(),
});

const AuditResultSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  findings: z.array(AuditFindingSchema).nullish().transform((v) => v ?? []),
});

function parseAndValidateAudit(jsonStr: string): AuditResult {
  try {
    const raw = JSON.parse(jsonStr);
    const parsed = AuditResultSchema.safeParse(raw);
    if (!parsed.success) {
      return createInvalidResult();
    }
    const data = parsed.data;
    const hasHighOrMedium = data.findings.some(
      (f) => f.severity === 'high' || f.severity === 'medium'
    );
    const verdict: 'pass' | 'fail' = hasHighOrMedium ? 'fail' : data.verdict;

    return {
      verdict,
      findings: data.findings,
    };
  } catch {
    return createInvalidResult();
  }
}

export function parseAuditResult(text: string): AuditResult {
  if (typeof text !== 'string') {
    return createInvalidResult();
  }

  const jsonFenceRegex = /```json\s*([\s\S]*?)```/gi;
  const matches = [...text.matchAll(jsonFenceRegex)];

  if (matches.length > 0) {
    const lastContent = matches[matches.length - 1][1].trim();
    return parseAndValidateAudit(lastContent);
  }

  if (text.includes('```')) {
    return createInvalidResult();
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return createInvalidResult();
  }

  return parseAndValidateAudit(trimmed);
}
