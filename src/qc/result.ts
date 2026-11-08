import { z } from 'zod';

export interface QcResult {
  verdict: 'pass' | 'fail';
  bugs: string[];
  fix: string[];
  confirm: string[];
}

function createInvalidResult(): QcResult {
  return {
    verdict: 'fail',
    bugs: [],
    fix: ['qc_output_invalid'],
    confirm: [],
  };
}

const ArrayOfStringsSchema = z
  .array(z.string())
  .nullish()
  .transform((v) => v ?? []);

export const QcResultSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  bugs: ArrayOfStringsSchema,
  fix: ArrayOfStringsSchema,
  confirm: ArrayOfStringsSchema,
});

function parseAndValidate(jsonStr: string): QcResult {
  try {
    const raw = JSON.parse(jsonStr);
    const parsed = QcResultSchema.safeParse(raw);
    if (!parsed.success) {
      return createInvalidResult();
    }

    const data = parsed.data;
    const verdict: 'pass' | 'fail' =
      data.verdict === 'pass' && (data.bugs.length > 0 || data.fix.length > 0)
        ? 'fail'
        : data.verdict;

    return {
      verdict,
      bugs: data.bugs,
      fix: data.fix,
      confirm: data.confirm,
    };
  } catch {
    return createInvalidResult();
  }
}

export function parseQcResult(text: string): QcResult {
  if (typeof text !== 'string') {
    return createInvalidResult();
  }

  const jsonFenceRegex = /```json\s*([\s\S]*?)```/gi;
  const matches = [...text.matchAll(jsonFenceRegex)];

  if (matches.length > 0) {
    const lastContent = matches[matches.length - 1][1].trim();
    return parseAndValidate(lastContent);
  }

  if (text.includes('```')) {
    return createInvalidResult();
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return createInvalidResult();
  }

  return parseAndValidate(trimmed);
}
