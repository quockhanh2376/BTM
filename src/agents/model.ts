import { EffortSchema, ModelSchema, type Config, type Effort, type Tool } from '../config.ts';

type Settings = { getSetting(key: string): string | null } | null | undefined;

export const agentModelKey = (id: string) => `agent_model:${id}`;
export const agentEffortKey = (id: string) => `agent_effort:${id}`;

/** Mỗi thẻ chọn model riêng cho từng công cụ (anh Zon 2026-11-15): công cụ chính của thẻ dùng khoá cũ, công cụ khác thêm ":<công cụ>". */
export const toolScope = (cfg: Config, id: string, tool?: Tool | null) => (tool && cfg.agents[id] && tool !== cfg.agents[id]!.tool ? `${id}:${tool}` : id);

// Dashboard (setting) ghi đè config; giá trị setting không hợp lệ → bỏ qua. Chuỗi rỗng ở setting = dùng mặc định CLI.
// tool: công cụ của tài khoản chạy lượt; khác công cụ chính của thẻ thì không lấy model/effort trong config của thẻ.
export function agentModel(cfg: Config, settings: Settings, id: string, tool?: Tool | null): string | undefined {
  const scope = toolScope(cfg, id, tool);
  const v = settings?.getSetting(agentModelKey(scope));
  if (v !== null && v !== undefined) {
    if (v === '') return undefined;
    if (ModelSchema.safeParse(v).success) return v;
  }
  return scope === id ? cfg.agents[id]?.model : undefined;
}

// Công cụ khác công cụ chính của thẻ: chưa chọn effort → undefined (dùng mặc định của CLI; agy từ chối --effort lệch với model).
export function agentEffort(cfg: Config, settings: Settings, id: string): Effort;
export function agentEffort(cfg: Config, settings: Settings, id: string, tool: Tool | null | undefined): Effort | undefined;
export function agentEffort(cfg: Config, settings: Settings, id: string, tool?: Tool | null): Effort | undefined {
  const scope = toolScope(cfg, id, tool);
  const v = settings?.getSetting(agentEffortKey(scope));
  const parsed = EffortSchema.safeParse(v);
  if (parsed.success) return parsed.data;
  return scope === id ? cfg.agents[id]?.effort ?? 'medium' : undefined;
}
