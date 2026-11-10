import { describe, it, expect } from 'vitest';
import { parseAuditResult } from '../src/audit/result.ts';
import { auditPrompt } from '../src/core/prompts.ts';

describe('Audit Result Parser', () => {
  it('parses valid pass result with no findings', () => {
    const raw = JSON.stringify({
      verdict: 'pass',
      findings: [],
    });
    const res = parseAuditResult(raw);
    expect(res.verdict).toBe('pass');
    expect(res.findings).toEqual([]);
  });

  it('parses valid pass result from markdown fenced json', () => {
    const text = 'Audit completed.\n```json\n{"verdict": "pass", "findings": []}\n```\nAll clear.';
    const res = parseAuditResult(text);
    expect(res.verdict).toBe('pass');
    expect(res.findings).toEqual([]);
  });

  it('picks the last json fence block when multiple exist', () => {
    const text = `
Earlier check:
\`\`\`json
{"verdict": "fail", "findings": [{"ticket": "GTM-0001", "severity": "high", "text": "bad"}]}
\`\`\`
Final check:
\`\`\`json
{"verdict": "pass", "findings": []}
\`\`\`
`;
    const res = parseAuditResult(text);
    expect(res.verdict).toBe('pass');
    expect(res.findings).toEqual([]);
  });

  it('coerces pass to fail when high severity finding exists', () => {
    const raw = JSON.stringify({
      verdict: 'pass',
      findings: [
        { ticket: 'GTM-0001', severity: 'high', text: 'SQL injection detected' },
      ],
    });
    const res = parseAuditResult(raw);
    expect(res.verdict).toBe('fail');
    expect(res.findings.length).toBe(1);
    expect(res.findings[0].severity).toBe('high');
    expect(res.findings[0].text).toBe('SQL injection detected');
  });

  it('coerces pass to fail when medium severity finding exists', () => {
    const raw = JSON.stringify({
      verdict: 'pass',
      findings: [
        { ticket: 'GTM-0002', severity: 'medium', text: 'Sensitive log exposed' },
      ],
    });
    const res = parseAuditResult(raw);
    expect(res.verdict).toBe('fail');
    expect(res.findings.length).toBe(1);
    expect(res.findings[0].severity).toBe('medium');
  });

  it('retains pass verdict when only low severity findings exist', () => {
    const raw = JSON.stringify({
      verdict: 'pass',
      findings: [
        { ticket: 'GTM-0001', severity: 'low', text: 'Minor header check' },
      ],
    });
    const res = parseAuditResult(raw);
    expect(res.verdict).toBe('pass');
    expect(res.findings.length).toBe(1);
    expect(res.findings[0].severity).toBe('low');
  });

  it('returns fail with audit_output_invalid for corrupt JSON', () => {
    const text = 'Not a json output';
    const res = parseAuditResult(text);
    expect(res.verdict).toBe('fail');
    expect(res.findings[0].text).toBe('audit_output_invalid');
  });

  it('returns fail with audit_output_invalid for broken json code fence', () => {
    const text = '```json\n{ broken json\n```';
    const res = parseAuditResult(text);
    expect(res.verdict).toBe('fail');
    expect(res.findings[0].text).toBe('audit_output_invalid');
  });

  it('returns fail when non-json code fence is present without json block', () => {
    const text = '```typescript\nconst a = 1;\n```';
    const res = parseAuditResult(text);
    expect(res.verdict).toBe('fail');
    expect(res.findings[0].text).toBe('audit_output_invalid');
  });

  it('handles empty input cleanly', () => {
    expect(parseAuditResult('')).toEqual({
      verdict: 'fail',
      findings: [{ ticket: '', severity: 'high', text: 'audit_output_invalid' }],
    });
  });

  it('defaults missing ticket field to empty string', () => {
    const raw = JSON.stringify({
      verdict: 'fail',
      findings: [{ severity: 'low', text: 'General security notice' }],
    });
    const res = parseAuditResult(raw);
    expect(res.verdict).toBe('fail');
    expect(res.findings[0].ticket).toBe('');
    expect(res.findings[0].text).toBe('General security notice');
  });
});

describe('Audit Prompt', () => {
  it('auditPrompt contains goal, base, ticket list, checklist items, and read-only instructions', () => {
    const prompt = auditPrompt({ n: 1, title: 'Bảo mật auth' }, 'main', ['GTM-0001', 'GTM-0002'], 'Kai');
    expect(prompt).toContain('G1');
    expect(prompt).toContain('Bảo mật auth');
    expect(prompt).toContain('main');
    expect(prompt).toContain('GTM-0001, GTM-0002');
    expect(prompt).toContain('Kai');
    expect(prompt).toMatch(/secret.*injection.*xác thực.*upload.*dependency.*nhạy cảm/i);
    expect(prompt).toMatch(/CHỈ ĐỌC/i);
    expect(prompt).toMatch(/cấm.*commit.*push/i);
    expect(prompt).toContain('team/reports/G1-audit.md');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"findings"');
  });
});

