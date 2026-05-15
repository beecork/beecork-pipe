import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { logger } from '../util/logger.js';
import type { Project } from './types.js';

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  type: Project['type'];
  last_used_at: string;
  created_at: string;
}

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, path: r.path, type: r.type, lastUsedAt: r.last_used_at, createdAt: r.created_at };
}

/** Get the workspace root from config */
export function getWorkspaceRoot(): string {
  const config = getConfig();
  // Use the default tab's workingDir as workspace root
  const root = config.tabs?.default?.workingDir || process.env.HOME || '';
  return root.startsWith('~') ? root.replace('~', process.env.HOME || '') : root;
}

/** Get the managed workspace path (.beecork/ under workspace root) */
export function getManagedWorkspace(): string {
  return path.join(getWorkspaceRoot(), '.beecork');
}

/** Discover projects in scan paths (look for git repos, package.json, etc.) */
export function discoverProjects(scanPaths?: string[]): Project[] {
  const paths = scanPaths || [getWorkspaceRoot()];
  const projects: Project[] = [];
  const db = getDb();

  for (let scanPath of paths) {
    scanPath = scanPath.startsWith('~') ? scanPath.replace('~', process.env.HOME || '') : scanPath;
    if (!fs.existsSync(scanPath)) continue;

    try {
      const entries = fs.readdirSync(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // Skip hidden dirs
        if (entry.name === 'node_modules') continue;

        const dirPath = path.join(scanPath, entry.name);

        // Check if it looks like a project (has .git, package.json, or similar)
        const isProject = fs.existsSync(path.join(dirPath, '.git'))
          || fs.existsSync(path.join(dirPath, 'package.json'))
          || fs.existsSync(path.join(dirPath, 'Cargo.toml'))
          || fs.existsSync(path.join(dirPath, 'go.mod'))
          || fs.existsSync(path.join(dirPath, 'requirements.txt'))
          || fs.existsSync(path.join(dirPath, 'pyproject.toml'))
          || fs.existsSync(path.join(dirPath, 'CLAUDE.md'));

        if (isProject) {
          projects.push({
            id: uuidv4(),
            name: entry.name,
            path: dirPath,
            type: 'user-project',
            lastUsedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn(`Failed to scan ${scanPath}:`, err);
    }
  }

  // Upsert into database
  for (const project of projects) {
    db.prepare(`
      INSERT INTO projects (id, name, path, type) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET path = excluded.path, last_used_at = datetime('now')
    `).run(project.id, project.name, project.path, project.type);
  }

  return projects;
}

/** Create a new project. parentDir must resolve under an allowed root. */
export function createProject(name: string, parentDir?: string): Project {
  const requestedParent = parentDir || getWorkspaceRoot();
  const resolvedParent = path.resolve(requestedParent.startsWith('~')
    ? requestedParent.replace('~', process.env.HOME || '')
    : requestedParent);

  // Allowlist: parent must resolve under workspace root or one of the configured scan paths.
  const config = getConfig();
  const allowedRoots = [
    getWorkspaceRoot(),
    ...(config.projectScanPaths ?? []),
  ].map(r => path.resolve(r.startsWith('~') ? r.replace('~', process.env.HOME || '') : r));
  const isAllowed = allowedRoots.some(root => resolvedParent === root || resolvedParent.startsWith(root + path.sep));
  if (!isAllowed) {
    throw new Error(`Project parent directory must be under workspace root or a configured scan path. Allowed: ${allowedRoots.join(', ')}`);
  }

  // Sanitize name to prevent path traversal
  const safeName = path.basename(name.replace(/\.\./g, ''));
  if (!safeName) throw new Error('Invalid project name');
  const projectPath = path.resolve(resolvedParent, safeName);
  // Ensure resolved path is within the parent directory
  if (!projectPath.startsWith(resolvedParent)) {
    throw new Error('Project path must be within the parent directory');
  }

  if (fs.existsSync(projectPath)) {
    // Folder already exists — just register it
    logger.info(`Project folder already exists: ${projectPath}`);
  } else {
    fs.mkdirSync(projectPath, { recursive: true });
    logger.info(`Created project folder: ${projectPath}`);
  }

  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO projects (id, name, path, type) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET path = excluded.path
  `).run(id, name, projectPath, 'user-project');

  return { id, name, path: projectPath, type: 'user-project', lastUsedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
}

/** Ensure a managed category exists (lazy creation) */
export function ensureCategory(name: string): Project {
  const categoryPath = path.join(getManagedWorkspace(), name);
  fs.mkdirSync(categoryPath, { recursive: true });

  const db = getDb();
  const existing = db.prepare('SELECT * FROM projects WHERE name = ? AND type = ?').get(name, 'category') as ProjectRow | undefined;
  if (existing) return rowToProject(existing);

  const id = uuidv4();
  db.prepare('INSERT INTO projects (id, name, path, type) VALUES (?, ?, ?, ?)').run(id, name, categoryPath, 'category');
  return { id, name, path: categoryPath, type: 'category', lastUsedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
}

/** List all projects */
export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY type, last_used_at DESC').all() as ProjectRow[];
  return rows.map(rowToProject);
}

/** Get a project by name */
export function getProject(name: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

/** Update last used timestamp */
export function touchProject(name: string): void {
  getDb().prepare("UPDATE projects SET last_used_at = datetime('now') WHERE name = ?").run(name);
}

// closeTab moved to TabManager.closeTab — see src/session/manager.ts. It now kills
// the subprocess and deletes the rows in one place rather than the caller doing both.
