import { execFileSync } from 'node:child_process';

/**
 * Single source of truth for validating an npm package name before we shell out
 * to `npm install -g`. Security-relevant: keeping one copy prevents the regex
 * from drifting between the CLI, the store, and the capability packs.
 */
export const SAFE_NPM_PACKAGE = /^[@a-zA-Z0-9_/.-]+$/;

export function isSafeNpmPackage(name: string): boolean {
  return SAFE_NPM_PACKAGE.test(name);
}

/**
 * Install a package globally via execFile (argv array — no shell interpolation).
 * Throws if the name fails validation, so callers can never pass an unvalidated
 * name to the shell.
 */
export function installGlobalNpmPackage(name: string, stdio: 'inherit' | 'pipe' = 'inherit'): void {
  if (!isSafeNpmPackage(name)) {
    throw new Error(`Unsafe npm package name: ${name}`);
  }
  execFileSync('npm', ['install', '-g', name], { stdio });
}
