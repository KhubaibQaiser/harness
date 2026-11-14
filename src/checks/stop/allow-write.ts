import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { stopDenyWritePaths } from '../protect.js';
import { realish, within } from '../../core/paths.js';
import { expandHome } from './srt-settings.js';

export type AllowWriteSys = { root: string; home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; srtReal: string | null; tokenBase: string | null };

const LOGIN = ['.claude', 'Library/LaunchAgents', '.config/systemd/user', '.config/autostart'];

const pkgRoot = (file: string): string | null => {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) return null;
  }
};

/** Why `entry` can't be a Stop-writable root (§11.2 fragment), or null. Each class is checked on the expanded path and on its realpath. */
export function allowWriteProblem(entry: string, sys: AllowWriteSys): string | null {
  const e = expandHome(entry, sys.home);
  if (!isAbsolute(e)) throw new Error(`stop.allow_write entry is not absolute: ${entry}`);
  const w = (p: string, dir: string) => within(p, dir, sys.platform);
  const inside = (dir: string) => [e, realish(e)].some((p) => w(p, dir)); // equal or inside
  const above = (dir: string) => [e, realish(e)].some((p) => w(dir, p)); // equal or above
  const forms = (p: string) => [p, realish(p)];
  const sep = sys.platform === 'win32' ? ';' : ':';
  const pathDirs = (sys.env.PATH ?? '').split(sep).filter((s) => s && isAbsolute(s));
  const srtRoot = sys.srtReal ? pkgRoot(sys.srtReal) : null;
  const protectedDirs = forms(sys.root).flatMap((r) => stopDenyWritePaths().map((q) => join(r, q)));
  const login = [...forms(sys.home)].flatMap((h) => LOGIN.map((l) => join(h, l)));
  if (protectedDirs.some(inside)) return 'it is a protected path';
  if (forms(sys.home).some(above)) return 'it is your home folder';
  if (login.some((d) => inside(d) || above(d))) return 'programs there run at login';
  if (pathDirs.some(above)) return 'it is on PATH';
  if (srtRoot && (inside(srtRoot) || above(srtRoot))) return 'srt is installed there';
  if (sys.tokenBase && inside(sys.tokenBase)) return 'it holds the GitHub token folder';
  return null;
}

export const allowWriteMessage = (entry: string, why: string): string =>
  `stop.allow_write can't list ${entry}: ${why}. Choose a folder only your tests write, such as a cache folder.`;
