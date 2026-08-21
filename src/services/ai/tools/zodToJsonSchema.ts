import type { z } from 'zod';

/**
 * Minimal Zod → JSON Schema converter for provider tool `inputSchema`.
 * Covers the shapes used by the assistant tool registry (objects, enums,
 * numbers, optionals, defaults, unknown/any, arrays, passthrough).
 * Unwraps ZodEffects (preprocess/refine) so per-tool mutation schemas export
 * their real object shapes to native tool calling.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertZod(schema);
}

function convertZod(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName || '';

  switch (typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = convertZod(field);
        if (!isOptionalLike(field)) {
          required.push(key);
        }
      }
      const out: Record<string, unknown> = {
        type: 'object',
        properties,
        additionalProperties: (def as { unknownKeys?: string }).unknownKeys === 'passthrough',
      };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber': {
      const checks = ((def as { checks?: Array<{ kind: string }> }).checks || []);
      const out: Record<string, unknown> = { type: 'number' };
      if (checks.some(c => c.kind === 'int')) out.type = 'integer';
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum': {
      const values = (def as { values?: string[] }).values || [];
      return { type: 'string', enum: values };
    }
    case 'ZodLiteral': {
      const value = (def as { value?: unknown }).value;
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        return { type: t, const: value };
      }
      return {};
    }
    case 'ZodArray': {
      const type = (def as { type?: z.ZodTypeAny }).type;
      return {
        type: 'array',
        items: type ? convertZod(type) : {},
      };
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = (def as { innerType?: z.ZodTypeAny }).innerType;
      return inner ? convertZod(inner) : {};
    }
    case 'ZodDefault': {
      const inner = (def as { innerType?: z.ZodTypeAny }).innerType;
      const base = inner ? convertZod(inner) : {};
      try {
        const defaultValue = (schema as z.ZodDefault<z.ZodTypeAny>)._def.defaultValue();
        return { ...base, default: defaultValue };
      } catch {
        return base;
      }
    }
    case 'ZodUnknown':
    case 'ZodAny':
      return {};
    case 'ZodRecord':
      return { type: 'object', additionalProperties: true };
    case 'ZodUnion': {
      const options = (def as { options?: z.ZodTypeAny[] }).options || [];
      return { anyOf: options.map(convertZod) };
    }
    case 'ZodEffects': {
      // preprocess / refine / transform — export the underlying object schema.
      // Preserve .describe() / refinement notes so the model sees constraints
      // that JSON Schema cannot express strictly (e.g. "at least one of …").
      const inner = (def as { schema?: z.ZodTypeAny }).schema;
      const json = inner ? convertZod(inner) : { type: 'object', additionalProperties: true };
      const description = getZodDescription(schema) || getZodDescription(inner);
      if (description) {
        const existing = typeof json.description === 'string' ? json.description : '';
        return {
          ...json,
          description: existing && existing !== description
            ? `${existing} ${description}`
            : description,
        };
      }
      return json;
    }
    case 'ZodPipeline': {
      const out = (def as { out?: z.ZodTypeAny }).out;
      return out ? convertZod(out) : { type: 'object', additionalProperties: true };
    }
    default:
      // Safe fallback so unknown Zod wrappers still produce a usable object schema.
      return { type: 'object', additionalProperties: true };
  }
}

function isOptionalLike(schema: z.ZodTypeAny): boolean {
  const typeName = (schema as { _def?: { typeName?: string } })._def?.typeName || '';
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
  if (typeName === 'ZodNullable') {
    const inner = (schema as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
    return inner ? isOptionalLike(inner) : false;
  }
  return false;
}

function getZodDescription(schema: z.ZodTypeAny | undefined): string | undefined {
  if (!schema) return undefined;
  const direct = (schema as { description?: string }).description;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const fromDef = (schema as { _def?: { description?: string } })._def?.description;
  if (typeof fromDef === 'string' && fromDef.trim()) return fromDef.trim();
  return undefined;
}
