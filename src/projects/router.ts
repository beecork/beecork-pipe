import { getDb } from '../db/index.js';
import { listProjects, getProject, ensureCategory, touchProject } from './manager.js';
import type { Project, RouteDecision, RoutingContext } from './types.js';

// Category keywords for non-project routing
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  research: ['research', 'find out', 'look into', 'compare', 'investigate', 'analyze', 'study'],
  planning: ['plan', 'schedule', 'organize', 'roadmap', 'strategy', 'outline', 'agenda'],
};

// Per-user current context tracking (in-memory, resets on daemon restart)
const userContext = new Map<string, { projectName: string; tabName: string; updatedAt: number }>();

interface CachedProject extends Project {
  nameLower: string;
}

// Project list cache. listProjects() ran on every inbound message and re-did a
// full SELECT + ORDER BY across the projects table; with N projects each call
// then re-lowercased every name. The cache is invalidated explicitly via
// invalidateProjectCache() at the few sites that mutate the table.
let projectsCache: { user: CachedProject[]; expiresAt: number } | null = null;
const PROJECTS_CACHE_TTL_MS = 30_000;

function getUserProjectsCached(): CachedProject[] {
  const now = Date.now();
  if (projectsCache && projectsCache.expiresAt > now) return projectsCache.user;
  const user = listProjects()
    .filter((p) => p.type === 'user-project')
    .map((p) => ({ ...p, nameLower: p.name.toLowerCase() }));
  projectsCache = { user, expiresAt: now + PROJECTS_CACHE_TTL_MS };
  return user;
}

/** Invalidate the project cache. Call after createProject/discoverProjects/etc. */
export function invalidateProjectCache(): void {
  projectsCache = null;
}

/** Route a message to the right project and tab */
export function routeMessage(message: string, context?: RoutingContext): RouteDecision {
  const projects = getUserProjectsCached();
  const userId = context?.userId || 'default';
  const messageLower = message.toLowerCase();

  // 1. Check for explicit project mention by name
  const mentionedProject = findMentionedProject(messageLower, projects);
  if (mentionedProject) {
    const { tabName, exists } = resolveTabInProject(mentionedProject);
    touchProject(mentionedProject.name);
    recordRouting(message, mentionedProject.name);
    return {
      project: mentionedProject,
      tabName,
      isNewTab: !exists,
      confidence: 0.95,
      needsConfirmation: false,
      reason: `Message mentions project "${mentionedProject.name}"`,
    };
  }

  // 2. Check if continuing current context
  const currentCtx = userContext.get(userId);
  if (currentCtx && Date.now() - currentCtx.updatedAt < 10 * 60 * 1000) {
    // 10 min window
    const project = getProject(currentCtx.projectName);
    if (project) {
      touchProject(project.name);
      return {
        project,
        tabName: currentCtx.tabName,
        isNewTab: false,
        confidence: 0.7,
        needsConfirmation: false,
        reason: `Continuing in "${project.name}" (recent context)`,
      };
    }
  }

  // 3. Check routing preferences (learned patterns)
  const learned = checkLearnedRouting(messageLower);
  if (learned) {
    const project = getProject(learned.projectName);
    if (project && learned.confidence >= 0.9) {
      const { tabName, exists } = resolveTabInProject(project);
      touchProject(project.name);
      return {
        project,
        tabName,
        isNewTab: !exists,
        confidence: learned.confidence,
        needsConfirmation: false,
        reason: `Learned pattern → "${project.name}"`,
      };
    }
  }

  // 4. Multiple projects could match — ask user
  const possibleMatches = findPossibleMatches(messageLower, projects);
  if (possibleMatches.length > 1) {
    return {
      project: possibleMatches[0],
      tabName: possibleMatches[0].name,
      isNewTab: false,
      confidence: 0.5,
      needsConfirmation: true,
      reason: `Multiple projects could match: ${possibleMatches.map((p) => p.name).join(', ')}`,
    };
  }

  // 5. Check for category keywords (non-project)
  const category = detectCategory(messageLower);
  if (category) {
    const project = ensureCategory(category);
    const tabName = category;
    return {
      project,
      tabName,
      isNewTab: !tabExists(tabName),
      confidence: 0.8,
      needsConfirmation: false,
      reason: `Detected category: ${category}`,
    };
  }

  // 6. Default to general
  const general = ensureCategory('general');
  return {
    project: general,
    tabName: 'general',
    isNewTab: !tabExists('general'),
    confidence: 0.6,
    needsConfirmation: false,
    reason: 'Default routing to general',
  };
}

/** Update current context for a user */
export function setUserContext(userId: string, projectName: string, tabName: string): void {
  userContext.set(userId, { projectName, tabName, updatedAt: Date.now() });
  // Evict oldest entry when map grows too large
  if (userContext.size > 1000) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, val] of userContext) {
      if (val.updatedAt < oldestTime) {
        oldestTime = val.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) userContext.delete(oldestKey);
  }
}

/** Find a project explicitly mentioned by name in the message (messageLower already lower-cased) */
function findMentionedProject(
  messageLower: string,
  projects: CachedProject[],
): CachedProject | null {
  for (const project of projects) {
    if (messageLower.includes(project.nameLower)) return project;
  }
  return null;
}

/** Find possible project matches (for ambiguity) */
function findPossibleMatches(messageLower: string, projects: CachedProject[]): CachedProject[] {
  const words = messageLower.split(/\s+/);
  return projects.filter((p) => {
    const nameParts = p.nameLower.split(/[-_]/);
    return nameParts.some((part) => words.includes(part));
  });
}

/**
 * Resolve which tab to use within a project. Coalesces the previous
 * "find tabs + tabExists" into one query — the caller used to fire both
 * back-to-back, and the working_dir scan had no covering index.
 * (Index added by migration v28; see src/db/migrations.ts.)
 */
function resolveTabInProject(project: Project): { tabName: string; exists: boolean } {
  const db = getDb();
  const row = db
    .prepare('SELECT name FROM tabs WHERE working_dir = ? ORDER BY last_activity_at DESC LIMIT 1')
    .get(project.path) as { name: string } | undefined;
  return row ? { tabName: row.name, exists: true } : { tabName: project.name, exists: false };
}

/** Check if a tab exists in the database */
function tabExists(tabName: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM tabs WHERE name = ?').get(tabName);
  return !!row;
}

/** Detect a category from keywords (messageLower already lower-cased) */
function detectCategory(messageLower: string): string | null {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => messageLower.includes(kw))) return category;
  }
  return null;
}

/** Record a successful routing for learning */
function recordRouting(message: string, projectName: string): void {
  const db = getDb();
  // Extract key words from message for pattern matching
  const words = message
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);
  const pattern = words.join(' ');
  if (!pattern) return;

  db.prepare(
    `
    INSERT INTO routing_preferences (pattern, project_name)
    VALUES (?, ?)
    ON CONFLICT(pattern, project_name) DO UPDATE SET hit_count = hit_count + 1
  `,
  ).run(pattern, projectName);
}

/** Check learned routing preferences (messageLower already lower-cased) */
function checkLearnedRouting(
  messageLower: string,
): { projectName: string; confidence: number } | null {
  const db = getDb();
  const words = messageLower.split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return null;

  // Fetch all preferences in a single query and match in JS
  const allPrefs = db
    .prepare(
      'SELECT pattern, project_name, confidence, hit_count FROM routing_preferences WHERE hit_count >= 3 ORDER BY hit_count DESC LIMIT 200',
    )
    .all() as Array<{
    pattern: string;
    project_name: string;
    confidence: number;
    hit_count: number;
  }>;

  for (const pref of allPrefs) {
    // pref.pattern was written via .toLowerCase() in recordRouting(), so no
    // re-lowercase here (saves N allocations per inbound message).
    const patternLower = pref.pattern;
    if (words.some((word) => patternLower.includes(word) || word.includes(patternLower))) {
      return { projectName: pref.project_name, confidence: Math.min(pref.confidence, 0.9) };
    }
  }

  return null;
}

export interface RouteResult {
  effectiveTabName: string;
  projectPath?: string;
  confirmationMessage?: string;
}

/**
 * Shared project routing logic — resolves which tab/project to use for a message.
 * Pulled out of channels/ so all routing decisions live in one place.
 */
export async function resolveProjectRoute(
  rawPrompt: string,
  tabName: string,
  text: string,
  userId: string,
): Promise<RouteResult> {
  if (tabName !== 'default' || text.startsWith('/tab ')) {
    return { effectiveTabName: tabName };
  }

  try {
    const decision = routeMessage(rawPrompt, { userId });

    if (decision.needsConfirmation) {
      const projects = listProjects().filter((p): p is Project => p.type === 'user-project');
      const options = projects.map((p, i: number) => `${i + 1}) ${p.name}`).join('\n');
      return {
        effectiveTabName: tabName,
        confirmationMessage: `Which project?\n${options}\n\nReply with the number, or just send your message with /project <name> first.`,
      };
    }

    setUserContext(userId, decision.project.name, decision.tabName);
    return {
      effectiveTabName: decision.tabName,
      projectPath: decision.project.path,
    };
  } catch {
    return { effectiveTabName: tabName };
  }
}
