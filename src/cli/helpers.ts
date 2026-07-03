export { timeAgo } from '../util/text.js';
// Re-exported for back-compat; the implementation lives in util/pid.ts so
// non-CLI callers (e.g. the dashboard) don't import from the cli/ layer.
export { getDaemonPid } from '../util/pid.js';
