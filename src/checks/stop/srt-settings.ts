import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { stopDenyWritePaths } from '../protect.js';
import type { HarnessConfig } from '../../core/config.js';
import { CREDENTIAL_ENV, credentialFiles } from '../../core/credentials.js';
import { realish } from '../../core/paths.js';

export type Lit = { path: string; literal: true };
export interface SrtSettings {
  network: { allowedDomains: string[]; allowLocalBinding: boolean };
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

const lit = (path: string): Lit => ({ path: abs(path), literal: true });

export function renderSrtSettings(i: SrtInputs): SrtSettings {
  const extra = i.tokenBase ? [i.tokenBase] : [];
  return {
    network: { allowedDomains: [...new Set(i.stop.allowed_domains.map((d) => d.trim().toLowerCase().replace(/\.+$/, '')))], allowLocalBinding: i.stop.allow_local },
    filesystem: {
      allowWrite: writableRoots(i).map(lit),
      denyWrite: [...stopDenyWritePaths().map((p) => `${i.root}/${p.replace(/^\.\//, '')}`), ...extra, ...i.denyWrite].map(lit),
      denyRead: [...extra, ...i.denyRead].map(lit),
    },
    credentials: {
      files: credentialFiles(i.home).files.map((path) => ({ path, mode: 'deny' as const })),
      envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' as const })),
    },
  };
}
