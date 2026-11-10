import { describe, it, expect } from 'vitest';
import { parseTicketQcResult, type QcResult } from '../src/qc/result.ts';

describe('QC Result parser', () => {
  const expectSpec = {
    ticket: 'GTM-0012',
    goal: 'G1',
    number: 3,
  };

  describe('Clean JSON', () => {
    it('parses valid pass result', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('parses valid fail result with bugs, fix, and confirm', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'fail',
        bugs: ['Logic error in auth check', 'Missing test case'],
        fix: ['Add null check before accessing token'],
        confirm: ['Should we support legacy tokens?'],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: ['Logic error in auth check', 'Missing test case'],
        fix: ['Add null check before accessing token'],
        confirm: ['Should we support legacy tokens?'],
      });
    });
  });

  describe('Markdown fenced JSON and surrounding prose', () => {
    it('parses JSON inside ```json fence with prose before and after', () => {
      const input = `
Tôi đã kiểm tra mã nguồn và chạy các bài kiểm tra tự động.
Kết quả như sau:
\`\`\`json
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
\`\`\`
Mọi thứ đều đạt yêu cầu, sẵn sàng nghiệm thu.
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for plain ``` fence without language specifier', () => {
      const input = `
\`\`\`
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "fail",
  "bugs": ["Component does not render"],
  "fix": ["Export component properly"],
  "confirm": []
}
\`\`\`
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for raw JSON embedded in prose without code fence', () => {
      const input = `
Kết quả kiểm tra:
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
Cảm ơn bạn.
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });
  });

  describe('Invalid output fallback to qc_output_invalid', () => {
    it('returns qc_output_invalid for pure prose without JSON', () => {
      const input = 'Tôi thấy code ổn rồi, duyệt nhé!';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for empty string or whitespace', () => {
      expect(parseTicketQcResult('', expectSpec)).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
      expect(parseTicketQcResult('   \n\t  ', expectSpec)).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for malformed JSON syntax', () => {
      const input = '{ verdict: "pass", bugs: [ }';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for unclosed braces', () => {
      const input = 'Here is the result: { "verdict": "pass"';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid when JSON does not conform to schema', () => {
      const input = JSON.stringify({
        somethingElse: 'not a qc result',
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for invalid verdict value', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'in_progress',
        bugs: [],
        fix: [],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid if bugs or fix is not a string array', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'fail',
        bugs: 'not an array',
        fix: [],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('never throws for null or undefined input', () => {
      expect(parseTicketQcResult(null as unknown as string, expectSpec)).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
      expect(parseTicketQcResult(undefined as unknown as string, expectSpec)).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });
  });

  describe('Verdict pass coercion', () => {
    it('coerces pass to fail when bugs is not empty', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: ['Found a minor bug'],
        fix: [],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('fail');
      expect(result.bugs).toEqual(['Found a minor bug']);
      expect(result.fix).toEqual([]);
      expect(result.confirm).toEqual([]);
    });

    it('coerces pass to fail when fix is not empty', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: [],
        fix: ['Need to refactor variable name'],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('fail');
      expect(result.bugs).toEqual([]);
      expect(result.fix).toEqual(['Need to refactor variable name']);
      expect(result.confirm).toEqual([]);
    });

    it('coerces pass to fail when both bugs and fix are not empty', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: ['Bug 1'],
        fix: ['Fix 1'],
        confirm: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('fail');
      expect(result.bugs).toEqual(['Bug 1']);
      expect(result.fix).toEqual(['Fix 1']);
    });

    it('does not coerce pass to fail when only confirm is not empty', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: ['Please double check staging environment'],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('pass');
      expect(result.bugs).toEqual([]);
      expect(result.fix).toEqual([]);
      expect(result.confirm).toEqual(['Please double check staging environment']);
    });
  });

  describe('Defaulting missing fields', () => {
    it('defaults missing confirm to empty array', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: [],
        fix: [],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('defaults missing bugs and fix to empty arrays', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('transforms null values to empty arrays', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'pass',
        bugs: null,
        fix: null,
        confirm: null,
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });
  });

  describe('Extracting the last JSON block and handling edge cases', () => {
    it('extracts the last JSON block when multiple blocks exist', () => {
      const input = `
Previous evaluation:
\`\`\`json
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "fail",
  "bugs": ["Old bug"],
  "fix": ["Old fix"],
  "confirm": []
}
\`\`\`

Updated final evaluation:
\`\`\`json
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
\`\`\`
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('handles curly braces inside strings without getting confused', () => {
      const input = JSON.stringify({
        ticket: 'GTM-0012',
        goal: 'G1',
        number: 3,
        verdict: 'fail',
        bugs: ['Template string `${name}` causes error', 'Object { foo: 1 } unexpected'],
        fix: ['Escape { and } correctly'],
        confirm: ['Confirm { scope } is ok'],
      });
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: ['Template string `${name}` causes error', 'Object { foo: 1 } unexpected'],
        fix: ['Escape { and } correctly'],
        confirm: ['Confirm { scope } is ok'],
      });
    });

    it('handles prose containing braces before the JSON block', () => {
      const input = `
I reviewed {src/a.ts, src/b.ts} and found everything good.
\`\`\`json
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
\`\`\`
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'pass',
        bugs: [],
        fix: [],
        confirm: [],
      });
    });

    it('extracts last ```json block ignoring trailing raw text outside fence', () => {
      const input = `
\`\`\`json
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
\`\`\`
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "fail",
  "bugs": ["Raw fail bug"],
  "fix": ["Raw fail fix"],
  "confirm": []
}
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('pass');
      expect(result.bugs).toEqual([]);
      expect(result.fix).toEqual([]);
    });

    it('returns qc_output_invalid without backtracking when last JSON block fails schema validation', () => {
      const input = '{"ticket":"GTM-0012","goal":"G1","number":3,"verdict":"pass"} {"verdict":"invalid"}';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid for cut-off JSON with nested valid JSON', () => {
      const input = '{"verdict":"fail","nested":{"verdict":"pass"}';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid when trailing JSON block is incomplete / cut off', () => {
      const input = '{"ticket":"GTM-0012","goal":"G1","number":3,"verdict":"pass","bugs":[],"fix":[],"confirm":[]} {"verdict":"fail"';
      const result = parseTicketQcResult(input, expectSpec);
      expect(result.verdict).toBe('fail');
      expect(result.fix).toContain('qc_output_invalid');
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns qc_output_invalid when prose has raw JSON without code fence', () => {
      const input = `Unclosed " quote in prose before JSON
{
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "verdict": "pass",
  "bugs": [],
  "fix": [],
  "confirm": []
}
`;
      const result = parseTicketQcResult(input, expectSpec);
      expect(result).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('does not affect subsequent invalid results when mutating returned invalid arrays', () => {
      const first = parseTicketQcResult('invalid output 1', expectSpec);
      expect(first).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });

      first.bugs.push('mutated_bug');
      first.fix.push('mutated_fix');
      first.confirm.push('mutated_confirm');

      const second = parseTicketQcResult('invalid output 2', expectSpec);
      expect(second).toEqual<QcResult>({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });
  });

  describe('parseTicketQcResult (Ticket-aware QC Result parser)', () => {
    it('parses valid ticket qc result with matching ticket, goal, number', () => {
      const text = `
Here is my review:
\`\`\`json
{
  "verdict": "pass",
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 3,
  "bugs": [],
  "fix": [],
  "confirm": []
}
\`\`\`
All good.
`;
      const res = parseTicketQcResult(text, expectSpec);
      expect(res.verdict).toBe('pass');
      expect(res.bugs).toEqual([]);
      expect(res.fix).toEqual([]);
      expect(res.confirm).toEqual([]);
    });

    it('returns fail + qc_output_invalid khi thiếu ticket hoặc ticket sai', () => {
      const missingTicket = `
\`\`\`json
{
  "verdict": "pass",
  "goal": "G1",
  "number": 3,
  "bugs": [],
  "fix": []
}
\`\`\`
`;
      expect(parseTicketQcResult(missingTicket, expectSpec)).toEqual({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });

      const wrongTicket = `
\`\`\`json
{
  "verdict": "pass",
  "ticket": "GTM-0099",
  "goal": "G1",
  "number": 3,
  "bugs": [],
  "fix": []
}
\`\`\`
`;
      expect(parseTicketQcResult(wrongTicket, expectSpec)).toEqual({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });

    it('returns fail + qc_output_invalid khi number lệch hoặc goal lệch', () => {
      const wrongNum = `
\`\`\`json
{
  "verdict": "pass",
  "ticket": "GTM-0012",
  "goal": "G1",
  "number": 4,
  "bugs": [],
  "fix": []
}
\`\`\`
`;
      expect(parseTicketQcResult(wrongNum, expectSpec)).toEqual({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });

      const wrongGoal = `
\`\`\`json
{
  "verdict": "pass",
  "ticket": "GTM-0012",
  "goal": "G2",
  "number": 3,
  "bugs": [],
  "fix": []
}
\`\`\`
`;
      expect(parseTicketQcResult(wrongGoal, expectSpec)).toEqual({
        verdict: 'fail',
        bugs: [],
        fix: ['qc_output_invalid'],
        confirm: [],
      });
    });
  });
});
