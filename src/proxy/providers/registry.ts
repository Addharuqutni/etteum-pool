import type { BaseProvider, ModelInfo } from "./base";
import { config } from "../../config";
import { CodeBuddyProvider } from "./codebuddy";
import { CodeBuddyChinaProvider } from "./codebuddy-china";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { GrokCliProvider } from "./grok-cli";
import { ByokProvider } from "./byok";
import { ClaudeProvider } from "./claude";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first.
 * Unknown models resolve to null (no fallback provider anymore).
 */
const codebuddy = new CodeBuddyProvider();
const codebuddyChina = new CodeBuddyChinaProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const grokCli = new GrokCliProvider();
const byok = new ByokProvider();
const claude = new ClaudeProvider();

// Priority order. canva/codex/grok-cli/claude have unique prefixes; codex is
// listed before codebuddy so the literal "gpt-5-codex" resolves to codex while
// codebuddy keeps its own "gpt-5*"/"gpt-5.x-codex" models. byok checks dynamic
// prefixes from DB accounts. claude owns `cc-*` (the assistant OAuth); grok-cli
// owns exact `grok-4.5*` ids from Grok Build catalog.
const PROVIDER_ORDER = [canva, codex, grokCli, claude, byok, codebuddyChina, codebuddy];

/** Canonical provider name union (mirrors config.providers). */
export type ProviderName = (typeof config.providers)[number];

/** Resolve which provider owns a model id, or null when none does. */
export function getProviderForModel(model: string): ProviderName | null {
  return PROVIDER_ORDER.find((p) => p.ownsModel(model))?.name ?? null;
}

/** Provider instances keyed by name. */
export const providers: Record<ProviderName, BaseProvider> = Object.fromEntries(
  PROVIDER_ORDER.map((p) => [p.name, p]),
) as Record<ProviderName, BaseProvider>;

/** All models across every registered provider. */
export function getAllModels(): ModelInfo[] {
  return PROVIDER_ORDER.flatMap((provider) => provider.getModels());
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}