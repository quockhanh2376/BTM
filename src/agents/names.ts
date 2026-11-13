// Tên hiển thị của Worker (anh Zon đặt trên dashboard). Chỉ dùng cho UI; mọi chỗ khác dùng id agent.
export const agentNameKey = (agent: string) => `agent_name:${agent}`;
/** Chữ (mọi ngôn ngữ), số, khoảng trắng, . _ -; 1–24 ký tự. */
export const AGENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
