// Kho key của Boss (MB) – decision 0003. Key Z.ai mã hoá AES-256-GCM trong setting `mb_key`;
// khoá giải mã là file 32 byte <data_dir>/keys/master.key (0600, dir 0700 – user agent của Linux worker không đọc được).
// Giới hạn (anh Zon chấp nhận): root trên VM vẫn đọc được. Không bao giờ trả key thật qua API/log.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string): void };

export const MB_KEY = 'mb_key';
export const MB_ENABLED = 'mb_enabled';

export interface SealedKey { iv: string; tag: string; data: string; last4: string }
export interface MbStatus { set: boolean; last4: string; enabled: boolean }

export function encryptKey(plain: string, master: Buffer): SealedKey {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), last4: plain.slice(-4) };
}

/** Sai khoá / dữ liệu hỏng → null (không ném). */
export function decryptKey(rec: SealedKey, master: Buffer): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', master, Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function loadMasterKey(dataDir: string): Buffer {
  const dir = join(dataDir, 'keys');
  const file = join(dir, 'master.key');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const buf = readFileSync(file);
  if (buf.length !== 32) throw new Error('master.key must be 32 bytes');
  return buf;
}

/** Cắt khoảng trắng; key hợp lệ: 20–300 ký tự in được, không khoảng trắng. */
export function cleanKey(s: unknown): string | null {
  const k = String(s ?? '').trim();
  return /^[\x21-\x7e]{20,300}$/.test(k) ? k : null;
}

function sealed(store: Settings): SealedKey | null {
  try {
    const v = JSON.parse(store.getSetting(MB_KEY) || 'null') as SealedKey | null;
    return v && v.iv && v.tag && v.data ? v : null;
  } catch {
    return null;
  }
}

export function saveMbKey(store: Settings, dataDir: string, plain: string): void {
  store.setSetting(MB_KEY, JSON.stringify(encryptKey(plain, loadMasterKey(dataDir))));
  store.setSetting(MB_ENABLED, '1');
}

export function readMbKey(store: Settings, dataDir: string): string | null {
  const rec = sealed(store);
  if (!rec) return null;
  try {
    return decryptKey(rec, loadMasterKey(dataDir));
  } catch {
    return null;
  }
}

export function mbStatus(store: Settings): MbStatus {
  const rec = sealed(store);
  return { set: Boolean(rec), last4: rec?.last4 ?? '', enabled: store.getSetting(MB_ENABLED) !== '0' };
}

export function setMbEnabled(store: Settings, on: boolean): void {
  store.setSetting(MB_ENABLED, on ? '1' : '0');
}

export function removeMbKey(store: Settings): void {
  store.setSetting(MB_KEY, '');
}
