import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const darwinTemp = (): string => execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5000 });

/** Where the gh token file lives, per platform; null when there is no per-user runtime dir. Throws if macOS can't say. */
export function tokenBase(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, getconf: () => string = darwinTemp): string | null {
  if (platform === 'darwin') {
    let dir: string;
    try { dir = getconf().trim(); } catch (e) { throw new Error(`getconf DARWIN_USER_TEMP_DIR failed: ${String((e as Error).message).split('\n')[0]}`); }
    if (!dir) throw new Error('getconf DARWIN_USER_TEMP_DIR returned nothing');
    if (!posix.isAbsolute(dir)) throw new Error(`getconf DARWIN_USER_TEMP_DIR is not an absolute path: ${dir}`);
    return posix.join(dir, 'harness', 'gh');
  }
  if (platform === 'linux') return env.XDG_RUNTIME_DIR && posix.isAbsolute(env.XDG_RUNTIME_DIR) ? posix.join(env.XDG_RUNTIME_DIR, 'harness', 'gh') : null;
  return null;
}
