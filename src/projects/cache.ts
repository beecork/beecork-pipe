import type { Project } from './types.js';

export interface CachedProject extends Project {
  nameLower: string;
}

// Project-list cache state. Lives in its own leaf module (imports nothing from
// router/manager) so both the router (reader) and the manager (invalidator) can
// use it without a router↔manager import cycle.
let projectsCache: { user: CachedProject[]; expiresAt: number } | null = null;

export function getProjectsCache(): { user: CachedProject[]; expiresAt: number } | null {
  return projectsCache;
}

export function setProjectsCache(value: { user: CachedProject[]; expiresAt: number }): void {
  projectsCache = value;
}

/** Invalidate the project cache. Call after createProject/discoverProjects/etc. */
export function invalidateProjectCache(): void {
  projectsCache = null;
}
