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

export function parseQcResult(text: string): QcResult {
  if (typeof text !== 'string') {
    return createInvalidResult();
  }

  if (text.lastIndexOf('{') > text.lastIndexOf('}')) {
    return createInvalidResult();
  }

  const last = text.lastIndexOf('}');
  if (last === -1) {
    return createInvalidResult();
  }

  for (let i = text.indexOf('{'); i !== -1 && i < last; i = text.indexOf('{', i + 1)) {
    try {
      const raw = JSON.parse(text.slice(i, last + 1));
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
      // JSON.parse error, continue searching candidates
    }
  }

  return createInvalidResult();
}
