// Settings (anh Zon 2026-11-14): chuẩn mặc định áp dụng cho MỌI project BTM làm + mặc định của dashboard.
// Lưu trong DB (settings), không theo project. PM đưa vào tiêu chí ticket, Dev làm theo, QC kiểm.
import { z } from 'zod';
import type { Store } from './store/db.ts';

export const STANDARDS_KEY = 'project_standards';
export const UI_DEFAULTS_KEY = 'ui_defaults';
export const CUSTOM_MAX = 10;
export const CUSTOM_CHARS = 200;

/** Múi giờ chọn được: tên IANA + nhãn UTC. */
export const TIMEZONES: Record<string, string> = {
  'Asia/Ho_Chi_Minh': 'UTC+7',
  'Asia/Bangkok': 'UTC+7',
  'Asia/Singapore': 'UTC+8',
  'Asia/Tokyo': 'UTC+9',
  UTC: 'UTC+0',
  'Europe/London': 'UTC+0/+1',
  'America/New_York': 'UTC-5/-4',
  'America/Los_Angeles': 'UTC-8/-7',
};

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CHARS);

export const StandardsSchema = z.object({
  timezone: z.object({ on: z.boolean(), value: z.string().refine((v) => Object.hasOwn(TIMEZONES, v), { message: 'Unknown timezone' }) }),
  utf8: z.boolean(),
  theme: z.boolean(),
  bilingual: z.boolean(),
  custom: z.array(z.string().max(1000)).max(50).transform((a) => a.map(clean).filter(Boolean).slice(0, CUSTOM_MAX)),
});
export type Standards = z.infer<typeof StandardsSchema>;

// Chat lúc rảnh (anh Zon 2026-11-14): tối đa mấy agent cùng nói một lượt, khoảng nghỉ ngẫu nhiên giữa hai lượt.
export const CHAT_KEY = 'chat_settings';
const range = (min: number, max: number) => z.tuple([z.number().min(min).max(max), z.number().min(min).max(max)]).transform(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]);
export const ChatSettingsSchema = z.object({
  /** Tối đa số agent cùng nói trong một lượt tán gẫu (1–3). */
  speakers: z.number().int().min(1).max(3),
  /** Vui vẻ: nghỉ ngẫu nhiên giữa hai lượt, tính bằng giây (10–600). */
  livelySec: range(10, 600),
  /** Bình thường: nghỉ ngẫu nhiên giữa hai lượt, tính bằng phút (1–60). */
  normalMin: range(1, 60),
});
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;
export const DEFAULT_CHAT: ChatSettings = { speakers: 3, livelySec: [30, 60], normalMin: [5, 8] };

export const UiDefaultsSchema = z.object({ lang: z.enum(['en', 'vi']), theme: z.enum(['light', 'dark', 'system']) });
export type UiDefaults = z.infer<typeof UiDefaultsSchema>;

// Mặc định theo anh Zon: giờ +7, Unicode, sáng/tối, song ngữ Anh/Việt – bật sẵn.
export const DEFAULT_STANDARDS: Standards = { timezone: { on: true, value: 'Asia/Ho_Chi_Minh' }, utf8: true, theme: true, bilingual: true, custom: [] };
export const DEFAULT_UI: UiDefaults = { lang: 'en', theme: 'system' };

function read<T>(store: Pick<Store, 'getSetting'>, key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(store.getSetting(key) || 'null'));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
export const readStandards = (store: Pick<Store, 'getSetting'>) => read(store, STANDARDS_KEY, StandardsSchema, DEFAULT_STANDARDS);
export const readChatSettings = (store: Pick<Store, 'getSetting'>) => read(store, CHAT_KEY, ChatSettingsSchema as unknown as z.ZodType<ChatSettings>, DEFAULT_CHAT);
export const readUiDefaults = (store: Pick<Store, 'getSetting'>) => read(store, UI_DEFAULTS_KEY, UiDefaultsSchema, DEFAULT_UI);

/** Các chuẩn đang bật, mỗi chuẩn một dòng (đưa vào prompt). */
export function standardsLines(st: Standards): string[] {
  const out: string[] = [];
  if (st.timezone.on) out.push(`Múi giờ mặc định ${TIMEZONES[st.timezone.value] ?? ''} (${st.timezone.value}): mọi giờ hiển thị, giờ mặc định và mốc "hôm nay" theo múi này; lưu trữ nội bộ có thể là UTC.`);
  if (st.utf8) out.push('Unicode: mọi file nguồn, trang web (meta charset), cơ sở dữ liệu, file xuất và dữ liệu vào/ra dùng UTF-8; tiếng Việt có dấu phải hiển thị và lưu đúng.');
  if (st.theme) out.push('Nếu sản phẩm có giao diện: có chế độ Light và Dark, đổi được và nhớ lựa chọn của người dùng.');
  if (st.bilingual) out.push('Nếu sản phẩm có giao diện: song ngữ tiếng Anh và tiếng Việt, đổi được, không viết cứng chữ hiển thị trong code (để ở bảng chuỗi).');
  for (const c of st.custom) out.push(c);
  return out;
}

export const standardsFor = (store: Pick<Store, 'getSetting'>) => standardsLines(readStandards(store));
