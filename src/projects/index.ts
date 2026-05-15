export type { Project, RouteDecision, RoutingContext } from './types.js';
export { discoverProjects, createProject, listProjects, getProject, ensureCategory, touchProject } from './manager.js';
export { routeMessage, setUserContext, resolveProjectRoute } from './router.js';
export type { RouteResult } from './router.js';
