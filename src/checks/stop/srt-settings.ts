import { tmpdir } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import { stopDenyWritePaths } from '../protect.js';
import type { HarnessConfig } from '../../core/config.js';
import { CREDENTIAL_ENV, credentialFiles } from '../../core/credentials.js';
import { normHost } from '../../core/hosts.js';
import { realish } from '../../core/paths.js';

export type Lit = { path: string; literal: true };
export interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: boolean };
  filesystem: { allowWrite: Lit[]; denyWrite: Lit[]; denyRead: Lit[] };
  credentials: { files: { path: string; mode: 'deny' }[]; envVars: { name: string; mode: 'deny' }[] };
}
export interface SrtInputs { root: string; stop: HarnessConfig['stop']; home: string; tmp: string[]; tokenBase: string | null; denyWrite: string[]; denyRead: string[] }

export const tempRoots = (): string[] => [...new Set([realish(tmpdir()), realish('/tmp')])];
export const expandHome = (p: string, home: string): string => (p.startsWith('~/') ? `${home}/${p.slice(2)}` : p);

const abs = (path: string): string => {
  if (!isAbsolute(path)) throw new Error(`srt settings: path is not absolute: ${path}`);
  return path;
};

export const writableRoots = (i: Pick<SrtInputs, 'root' | 'stop' | 'home' | 'tmp'>): string[] =>
  [...new Set([i.root, ...i.tmp, ...i.stop.allow_write.map((p) => realish(abs(expandHome(p, i.home))))])];

// Both spellings, so a deny binds whether srt matches given or resolved paths.
const both = (p: string): string[] => [...new Set([normalize(abs(p)), realish(abs(p))])];
const GLOB = /[*?[\]{}]/;

const lit = (path: string): Lit => ({ path: abs(path), literal: true });

export function renderSrtSettings(i: SrtInputs, platform: NodeJS.Platform = process.platform): SrtSettings {
  if (platform === 'win32') throw new Error('srt is not supported on native Windows');
  const extra = i.tokenBase ? [i.tokenBase] : [];
  return {
    // srt 0.0.83 requires deniedDomains; an empty list adds no denies (anything not allowed is already blocked).
    network: { allowedDomains: [...new Set(i.stop.allowed_domains.map(normHost))], deniedDomains: [], allowLocalBinding: i.stop.allow_local },
    filesystem: {
      allowWrite: writableRoots(i).map(lit),
      denyWrite: [...new Set([...stopDenyWritePaths().map((p) => `${i.root}/${p.replace(/^\.\//, '')}`), ...extra, ...i.denyWrite].flatMap(both))].map(lit),
      denyRead: [...new Set([...extra, ...i.denyRead].flatMap(both))].map(lit),
    },
    credentials: {
      files: [...new Set(credentialFiles(i.home).files.flatMap(both).filter((p) => !GLOB.test(p)))].map((path) => ({ path, mode: 'deny' as const })),
      envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' as const })),
    },
  };
}
