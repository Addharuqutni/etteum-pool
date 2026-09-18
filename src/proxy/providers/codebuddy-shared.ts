/**
 * Helpers shared by the two CodeBuddy providers (global and China).
 *
 * The two providers target different hosts but speak the same API shape, so
 * their schema handling, tool normalisation, and failover classification are
 * deliberately identical. Anything that genuinely differs between regions
 * belongs in the provider file, not here.
 */

/**
 * Host-scoped upstream failures only: the peer host may still serve this
 * account fine. 401/403 deliberately excluded — auth state is account-wide and
 * those statuses drive the refresh-then-retry path. 400 (our malformed body)
 * and 429 (per-account quota) are equally not host problems.
 */
export function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 404 || status === 405;
}

/** Check if a schema object contains any `$ref` anywhere (deep check). */
function hasRefs(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some((item) => hasRefs(item));
  if ("$ref" in obj) return true;
  return Object.values(obj).some((value) => hasRefs(value));
}

/**
 * Resolve every `$ref` in a JSON Schema inline, dropping `$defs`/`definitions`.
 * Cycles are broken with a placeholder object rather than recursing forever.
 */
function resolveSchemaRefs(
  schema: unknown,
  defs: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => resolveSchemaRefs(item, defs, seen));
  }

  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    const refPath = node.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
    // Circular reference — return a generic object to avoid infinite loop.
    if (seen.has(refPath)) return { type: "object", description: `(circular ref: ${refPath})` };
    const resolved = defs[refPath];
    if (resolved) {
      seen.add(refPath);
      const result = resolveSchemaRefs({ ...(resolved as object) }, defs, seen);
      seen.delete(refPath);
      return result;
    }
    // Unresolvable ref — return generic.
    return { type: "object" };
  }

  // Recursively resolve all nested objects.
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "definitions") continue; // skip defs themselves
    clone[key] = resolveSchemaRefs(value, defs, seen);
  }
  return clone;
}

/**
 * Strip JSON-Schema features the CodeBuddy API rejects and inline every `$ref`.
 * Results are memoised per provider instance via the supplied cache.
 *
 * `dropMeta` lists the meta fields this region's API rejects — the global and
 * China hosts disagree on this set, so it is a parameter rather than a constant.
 */
export function sanitizeToolSchema(
  schema: unknown,
  cache: Map<string, unknown>,
  cacheMax: number,
  dropMeta: string[]
): unknown {
  if (!schema || typeof schema !== "object") return schema;

  const cacheKey = JSON.stringify(schema);
  // Cache lookup — the assistant sends identical tool schemas every request,
  // so we avoid re-resolving $ref on every call.
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const source = schema as Record<string, unknown>;
  const defs: Record<string, unknown> = {};
  // Extract $defs/definitions before removing them, so we can resolve $ref inline.
  for (const key of ["$defs", "definitions"]) {
    const value = source[key];
    if (value && typeof value === "object") Object.assign(defs, value);
  }

  // Resolve all $ref references inline.
  const working = (
    Object.keys(defs).length > 0 || hasRefs(schema)
      ? resolveSchemaRefs(schema, defs)
      : { ...source }
  ) as Record<string, unknown>;

  // Remove the meta fields this region's API rejects.
  for (const key of dropMeta) delete working[key];

  // Ensure type is set.
  if (!working.type) working.type = "object";

  // Ensure properties exists for object types.
  if (working.type === "object" && !working.properties) working.properties = {};

  // Ensure required is an array if present.
  if (working.required && !Array.isArray(working.required)) delete working.required;

  // Store in cache (evict all if cache grows too large).
  if (cache.size >= cacheMax) cache.clear();
  cache.set(cacheKey, working);
  return working;
}

/** Normalise Anthropic- or OpenAI-shaped tools into CodeBuddy's expected form. */
export function normalizeCodebuddyTools(
  tools: unknown[] | undefined,
  sanitize: (schema: unknown) => unknown
): unknown[] {
  if (!tools || tools.length === 0) return [];

  return tools
    .map((tool) => {
      const entry = tool as Record<string, any>;
      // If already in OpenAI format, extract and re-normalize.
      // Note: tool descriptions are already filtered by router.sanitizeRequest().
      if (entry.type === "function" && entry.function) {
        return {
          type: "function",
          function: {
            name: entry.function.name,
            description: entry.function.description || "",
            parameters: sanitize(entry.function.parameters),
          },
        };
      }

      // Convert Anthropic/Claude format to OpenAI format.
      const fn = entry.function || entry;
      return {
        type: "function",
        function: {
          name: fn?.name || entry?.name,
          description: fn?.description || entry?.description || "",
          parameters: sanitize(
            fn?.parameters || fn?.input_schema || { type: "object", properties: {} }
          ),
        },
      };
    })
    .filter((t) => t.function?.name);
}
