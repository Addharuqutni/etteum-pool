import { Hono } from "hono";
import { listCombos, createCombo, updateCombo, deleteCombo } from "../proxy/combos";
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
    const combo = await createCombo({
      name: body.name as string,
      targets: body.targets as string[],
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
    const combo = await updateCombo(id, {
      name: body.name as string | undefined,
      targets: body.targets as string[] | undefined,
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
