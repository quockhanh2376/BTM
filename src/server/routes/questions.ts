// Route nhóm "questions" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { answerImagePath, detectImage } from '../inbox.ts';

export async function handleQuestionsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // "Để Finn trả lời": PM trả lời câu hỏi đang mở (một lượt chỉ đọc), trả lời hết thì tự Resume.
  if (pathname === '/api/questions/delegate') {
    if (!o.host.delegateAnswers) {
      sendJson(res, 501, { error: 'Not implemented' });
      return true;
    }
    const result = await o.host.delegateAnswers();
    sendJson(res, result.ok ? 200 : (result.status || 400), result);
    return true;
  }
  // Plan 6 Task 4: anh trả lời câu hỏi chặn ticket
  const answerMatch = pathname.match(/^\/api\/questions\/(\d{1,9})\/answer$/);
  if (answerMatch) {
    const parsed = z.object({
      text: z.string().trim().min(1).max(2000),
      image: z.object({ base64: z.string().min(1).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().optional(),
    }).strict().safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid answer' });
      return true;
    }
    const q = o.store.getQuestion(parseInt(answerMatch[1]!, 10));
    const activeProject = o.store.getActiveProject();
    if (!q || q.project !== activeProject) {
      sendJson(res, 404, { error: 'Unknown question' });
      return true;
    }
    if (q.state !== 'open') {
      sendJson(res, 409, { error: 'Already answered' });
      return true;
    }
    // Ảnh kèm câu trả lời: cùng luật với ảnh Team note (≤ 5 MB, png/jpg/webp theo nội dung file).
    let imageName: string | null = null;
    if (parsed.data.image) {
      const imgBuf = Buffer.from(parsed.data.image.base64, 'base64');
      if (imgBuf.length > 5 * 1024 * 1024) {
        sendJson(res, 413, { error: 'Image exceeds 5 MB limit' });
        return true;
      }
      const detected = detectImage(imgBuf);
      if (!detected) {
        sendJson(res, 415, { error: 'Unsupported image format' });
        return true;
      }
      imageName = `Q-${q.id}.${detected.ext}`;
      try {
        writeFileSync(answerImagePath(activeProject, imageName), imgBuf);
      } catch (err: any) {
        sendJson(res, 400, { error: err?.message || 'Cannot save image' });
        return true;
      }
    }
    o.store.answerQuestion(q.id, parsed.data.text, imageName);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
