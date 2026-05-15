/**
 * Minimal MCP tool-input validator. Walks the declared `inputSchema` from
 * `tool-definitions.ts` and rejects calls that violate `required`, `type`, or
 * `enum`. Handlers previously had ad-hoc checks for some fields and silently
 * accepted invalid inputs for others — this single validator converts the
 * inconsistency into a uniform "Invalid input: ..." failure.
 *
 * Deliberately handwritten (no Ajv/zod dep) to avoid pulling a runtime dep
 * for one validation pass.
 */

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

interface PropertySchema {
  type?: string | string[];
  enum?: readonly unknown[];
  items?: PropertySchema;
  description?: string;
}

export interface InputSchema {
  type?: string;
  properties?: Record<string, PropertySchema>;
  required?: readonly string[];
}

export function validateToolArgs(
  schema: unknown,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as InputSchema;
  const a = args || {};

  // Required fields
  for (const field of s.required ?? []) {
    const value = a[field];
    if (value === undefined || value === null || value === '') {
      return `Invalid input: "${field}" is required`;
    }
  }

  // Per-property type/enum checks
  for (const [field, propSchema] of Object.entries(s.properties ?? {})) {
    const value = a[field];
    if (value === undefined || value === null) continue;
    const typeError = checkType(value, propSchema, field);
    if (typeError) return typeError;
    if (propSchema.enum && !propSchema.enum.includes(value)) {
      return `Invalid input: "${field}" must be one of ${JSON.stringify(propSchema.enum)} (got ${JSON.stringify(value)})`;
    }
  }

  return null;
}

function checkType(value: unknown, schema: PropertySchema, field: string): string | null {
  if (!schema.type) return null;
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as JsonType[];
  for (const t of types) {
    if (matchesType(value, t)) return null;
  }
  return `Invalid input: "${field}" must be ${types.join(' | ')} (got ${typeof value})`;
}

function matchesType(value: unknown, t: JsonType): boolean {
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      // Unknown types fall through to accept (lenient).
      return true;
  }
}
