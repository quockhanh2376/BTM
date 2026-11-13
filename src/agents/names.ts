// Tên hiển thị của Worker (anh Zon đặt trên dashboard). Chỉ dùng cho UI; mọi chỗ khác dùng id agent.
export const agentNameKey = (agent: string) => `agent_name:${agent}`;
/** Chữ (mọi ngôn ngữ), số, khoảng trắng, . _ -; 1–24 ký tự. */
export const agentAvatarKey = (agent: string) => `agent_avatar:${agent}`;
export const agentAvatarVerKey = (agent: string) => `agent_avatar_v:${agent}`;
/** Avatar đã thu nhỏ ở trình duyệt (96px); chặn ảnh lớn hơn mức này. */
export const AVATAR_MAX_BYTES = 48 * 1024;
export const AGENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
