import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

let tmpDir: string | undefined;

export function setup() {
  tmpDir = resolve(repoRoot, '.tmp', `run-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.TMPDIR = tmpDir;
  return () => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

export function teardown() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export default setup;
