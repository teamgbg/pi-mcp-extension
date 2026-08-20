/**
 * @system pi-mcp-extension
 * @status handwritten
 * @edit edit directly
 *
 * JSON Schema → TypeBox conversion for MCP tool input schemas.
 * Handles the common subset used by real-world MCP servers:
 *   - Primitives (string, number, integer, boolean, null)
 *   - Arrays, objects (with required/optional/additionalProperties)
 *   - Enums (string enums → Union of Literals)
 *   - Nullable types ("type": ["string", "null"])
 *   - $ref (local #/$defs/ and #/definitions/ references)
 *   - oneOf / anyOf → TypeBox Union
 *   - allOf → TypeBox Intersect
 * Falls back to Type.Any() for unresolvable $ref or missing type.
 */

import * as Type from "typebox";
import type { TSchema } from "typebox";

export function convertJsonSchemaToTypebox(
  schema: unknown,
  depth = 0,
  defs?: Record<string, unknown>,
): TSchema {
  // Guard against infinite recursion and malformed schemas
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 10) {
    return Type.Any();
  }

  const s = schema as Record<string, unknown>;
  const description = typeof s["description"] === "string" ? s["description"] : undefined;
  const opts = description ? { description } : {};

  // Extract $defs / definitions for $ref resolution (carried through recursive calls)
  const resolvedDefs: Record<string, unknown> = {
    ...((s["$defs"] ?? s["definitions"]) as Record<string, unknown> | undefined),
    ...defs,
  };

  // ── Handle $ref ──────────────────────────────────────────────────────────
  if (typeof s["$ref"] === "string") {
    const ref = s["$ref"] as string;
    let resolved: unknown;

    // Local references: #/$defs/Foo, #/definitions/Foo
    if (ref.startsWith("#/")) {
      const parts = ref.slice(2).split("/");
      if (parts[0] === "$defs" || parts[0] === "definitions") {
        const key = parts.slice(1).join("/");
        resolved = resolvedDefs[key];
      } else {
        // Fallback: try walking the defs map by the last part
        const key = parts[parts.length - 1]!;
        resolved = resolvedDefs[key];
      }
    } else {
      // External $ref — cannot resolve, fall back
      console.warn(
        `[pi-mcp] Cannot resolve external $ref "${ref}", using Type.Any()`,
      );
      return Type.Any(opts);
    }

    if (!resolved) {
      console.warn(
        `[pi-mcp] Could not resolve $ref "${ref}", using Type.Any()`,
      );
      return Type.Any(opts);
    }

    // Merge description from referencing schema into resolved schema
    const merged = { ...(resolved as Record<string, unknown>) };
    if (description && !merged["description"]) {
      merged["description"] = description;
    }
    return convertJsonSchemaToTypebox(merged, depth + 1, resolvedDefs);
  }

  // ── Handle oneOf / anyOf → TypeBox Union ─────────────────────────────────
  if (Array.isArray(s["oneOf"])) {
    const members = (s["oneOf"] as unknown[])
      .map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
    return members.length === 1 ? members[0]! : Type.Union(members, opts);
  }

  if (Array.isArray(s["anyOf"])) {
    const members = (s["anyOf"] as unknown[])
      .map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
    return members.length === 1 ? members[0]! : Type.Union(members, opts);
  }

  // ── Handle allOf → TypeBox Intersect ─────────────────────────────────────
  if (Array.isArray(s["allOf"])) {
    const members = (s["allOf"] as unknown[])
      .map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
    return members.length === 1 ? members[0]! : Type.Intersect(members, opts);
  }

  // Handle nullable types: { "type": ["string", "null"] }
  const rawType = s["type"];
  const type = Array.isArray(rawType)
    ? rawType.find((t) => t !== "null") as string | undefined
    : typeof rawType === "string" ? rawType : undefined;

  const isNullable = Array.isArray(rawType) && rawType.includes("null");

  let base: TSchema;

  switch (type) {
    case "string": {
      const enumVals = s["enum"];
      if (Array.isArray(enumVals) && enumVals.every((v) => typeof v === "string")) {
        // TypeBox doesn't have a built-in StringEnum — use Union of Literals
        base = Type.Union(
          (enumVals as string[]).map((v) => Type.Literal(v)),
          opts,
        );
      } else {
        base = Type.String(opts);
      }
      break;
    }
    case "number":
    case "integer":
      base = Type.Number(opts);
      break;
    case "boolean":
      base = Type.Boolean(opts);
      break;
    case "null":
      base = Type.Null(opts);
      break;
    case "array": {
      const items = s["items"];
      base = Type.Array(
        items ? convertJsonSchemaToTypebox(items, depth + 1, resolvedDefs) : Type.Unknown(),
        opts,
      );
      break;
    }
    case "object": {
      const properties = s["properties"] as Record<string, unknown> | undefined;
      const required = new Set<string>(
        Array.isArray(s["required"]) ? (s["required"] as string[]) : [],
      );
      const additionalProperties = s["additionalProperties"];

      if (!properties) {
        // Open object — passthrough as Any to avoid over-constraining
        base = Type.Record(Type.String(), Type.Unknown(), opts);
        break;
      }

      const props: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(properties)) {
        const converted = convertJsonSchemaToTypebox(value, depth + 1, resolvedDefs);
        props[key] = required.has(key) ? converted : Type.Optional(converted);
      }

      const objOpts: Record<string, unknown> = { ...opts };
      if (additionalProperties === false) {
        objOpts["additionalProperties"] = false;
      }

      base = Type.Object(props, objOpts as any);
      break;
    }
    default: {
      // Truly unsupported or missing type field
      base = Type.Any(opts);
      break;
    }
  }

  return isNullable ? Type.Union([base, Type.Null()]) : base;
}
