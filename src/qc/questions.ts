// Plan 6 Task 4: câu hỏi "Cần xác nhận" trong báo cáo Dev (dòng `Cần xác nhận: …` hoặc gạch đầu dòng dưới
// heading `## Cần xác nhận`). Chữ của agent – không tin cậy: tối đa 5 câu, mỗi câu 500 ký tự, hiển thị bằng textContent.
export function parseReportQuestions(md: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim().replace(/\*\*/g, '');
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

// Chỉ là câu hỏi khi có dấu "?" (bỏ qua "?" trong URL). "Cần xác nhận: OK / Không có câu hỏi" không phải câu hỏi.
export function cleanQuestions(items: string[]): string[] {
  return items
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500))
    .filter((s) => s.replace(/https?:\/\/\S+/g, '').includes('?'))
    .slice(0, 5);
}
