// Plan 6 Task 4: câu hỏi "Cần xác nhận" trong báo cáo Dev (dòng `Cần xác nhận: …` hoặc gạch đầu dòng dưới
// heading `## Cần xác nhận`). Chữ của agent – không tin cậy: tối đa 5 câu, mỗi câu 500 ký tự, hiển thị bằng textContent.
export function parseReportQuestions(md: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,6}\s*(.+)$/.exec(line);
    if (h) {
      inSection = /^Cần xác nhận/i.test(h[1]!.trim());
      continue;
    }
    const m = /^[-*]?\s*Cần xác nhận\s*[:：]\s*(.+)$/i.exec(line);
    if (m) {
      out.push(m[1]!);
      continue;
    }
    if (inSection) {
      const b = /^[-*]\s+(.+)$/.exec(line);
      if (b) out.push(b[1]!);
    }
  }
  return cleanQuestions(out);
}

// "Cần xác nhận: OK / không / none" nghĩa là không có câu hỏi.
const NONE_RE = /^(ok|okay|không|không có|không cần|none|no|n\/a|na|-|—|chưa có)\.?$/i;

export function cleanQuestions(items: string[]): string[] {
  return items
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500))
    .filter((s) => s && !NONE_RE.test(s))
    .slice(0, 5);
}
