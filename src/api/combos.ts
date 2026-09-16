import { Hono } from "hono";
import { listCombos, createCombo, updateCombo, deleteCombo, parseTargets } from "../proxy/combos";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export const combosRouter = new Hono();

const KNOWN_FIELDS = new Set(["name", "targets", "enabled"]);

/** Reject any field outside the contract; unknown fields -> 400 {error}. */
function rejectUnknownFields(body: Record<string, unknown>) {
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) {
      return { error: `unknown field "${key}"` };
    }
  }
  return null;
}

/**
 * Warn about targets no provider currently owns. A combo target whose BYOK
 * prefix is absent/disabled, or whose model id is misspelled, can never be
 * attempted — the runtime combo loop skips it. We do NOT reject the save:
 * a prefix may legitimately be temporarily offline, and the admin should still
 * be able to persist the intended chain. Surfacing it here makes the mistake
 * visible at configuration time instead of only in the proxy logs.
 */
function unresolvableTargets(targets: string[]): string[] {
  return targets.filter((t) => !pool.getProviderForModel(t));
}

combosRouter.get("/", async (c) => {
  const data = await listCombos();
  return c.json({ data });
});

combosRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const bad = rejectUnknownFields(body);
  if (bad) return c.json(bad, 400);

  try {
    // Validate BEFORE warning: unresolvableTargets() assumes a parsed
    // string[], so raw input made it leak a TypeError instead of the
    // documented contract message.
    const targets = parseTargets(body.targets);
    const unknown = unresolvableTargets(targets);
    if (unknown.length > 0) {
      console.warn(`[Combos] "${body.name as string}" has targets no provider owns: ${unknown.join(", ")}`);
    }
    // `enabled` is an accepted POST field (KNOWN_FIELDS) but was dropped here,
    // so {"enabled": false} created an ENABLED combo that then ran in the
    // proxy despite the caller asking for it off.
    const combo = await createCombo({
      name: body.name as string,
      targets,
      enabled: body.enabled as boolean | undefined,
    });
    broadcast({ type: "combos_updated", data: {} });
    return c.json({ data: combo });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "failed to create combo" }, 400);
  }
});

combosRouter.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid combo id" }, 400);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const bad = rejectUnknownFields(body);
  if (bad) return c.json(bad, 400);

  try {
    // Same ordering as POST: parse first so malformed input yields the
    // contract message rather than a leaked TypeError.
    const targets = body.targets === undefined ? undefined : parseTargets(body.targets);
    if (targets) {
      const unknown = unresolvableTargets(targets);
      if (unknown.length > 0) {
        console.warn(`[Combos] update has targets no provider owns: ${unknown.join(", ")}`);
      }
    }
    const combo = await updateCombo(id, {
      name: body.name as string | undefined,
      targets,
      enabled: body.enabled as boolean | undefined,
    });
    if (!combo) return c.json({ error: "combo not found" }, 404);
    broadcast({ type: "combos_updated", data: {} });
    return c.json({ data: combo });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "failed to update combo" }, 400);
  }
});

combosRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid combo id" }, 400);

  const ok = await deleteCombo(id);
  if (!ok) return c.json({ error: "combo not found" }, 404);

  broadcast({ type: "combos_updated", data: {} });
  return c.json({ data: { ok: true } });
});
