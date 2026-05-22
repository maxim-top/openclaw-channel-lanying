import { createHash } from "node:crypto";

import { type OpenClawConfig } from "../types.js";

export const PROBE_MANAGED_AGENTS_RELATIVE_PATH = "clawchat/AGENTS.md";

type ProbeComparable =
  | null
  | boolean
  | number
  | string
  | ProbeComparable[]
  | { [key: string]: ProbeComparable };

function compareStableStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function toProbeComparable(value: unknown): ProbeComparable {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toProbeComparable(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item !== "undefined")
      .sort(([left], [right]) => compareStableStrings(left, right));
    const normalized: Record<string, ProbeComparable> = {};
    for (const [key, item] of entries) {
      normalized[key] = toProbeComparable(item);
    }
    return normalized;
  }
  return value === undefined ? null : String(value);
}

export function stableStringifyProbeValue(value: unknown): string {
  return JSON.stringify(toProbeComparable(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isProviderModelsProbePath(path: string): boolean {
  const normalized = path.trim();
  return normalized.startsWith("models.providers.") && normalized.endsWith(".models");
}

export function normalizeProbeValueForPath(path: string, value: unknown): unknown {
  if (!isProviderModelsProbePath(path) || !Array.isArray(value)) {
    return value;
  }
  const ids = value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const candidate = (item as Record<string, unknown>).id;
        return typeof candidate === "string" ? candidate.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
  return Array.from(new Set(ids)).sort(compareStableStrings);
}

export function summarizeProbeValueForLog(path: string, value: unknown): unknown {
  const normalized = normalizeProbeValueForPath(path, value);
  if (isProviderModelsProbePath(path)) {
    return {
      modelIds: Array.isArray(normalized) ? normalized : [],
      count: Array.isArray(normalized) ? normalized.length : 0,
    };
  }
  return normalized;
}

export function buildProbeValueDigest(value: unknown, present: boolean, path = ""): string {
  const normalizedValue = normalizeProbeValueForPath(path, value);
  const payload = present ? { present: true, value: normalizedValue } : { present: false };
  return sha256Hex(stableStringifyProbeValue(payload));
}

function parsePathSegments(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) {
    return [];
  }
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === ".") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      continue;
    }
    if (char === "[") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      const quote = trimmed[index + 1];
      if (quote !== '"' && quote !== "'") {
        return [];
      }
      const closingQuoteIndex = trimmed.indexOf(quote, index + 2);
      if (closingQuoteIndex < 0 || trimmed[closingQuoteIndex + 1] !== "]") {
        return [];
      }
      segments.push(trimmed.slice(index + 2, closingQuoteIndex));
      index = closingQuoteIndex + 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

export function getConfigValueAtPath(
  root: Record<string, unknown>,
  path: string,
): { found: boolean; value?: unknown } {
  const segments = parsePathSegments(path);
  if (segments.length === 0) {
    return { found: false };
  }
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

export function buildManagedAgentsContentForProbe(params: {
  chatbotId: string;
  chatbotName: string;
  prompt: string;
}): string {
  const title = params.chatbotName || params.chatbotId || "unknown-chatbot";
  const body =
    params.prompt.trim().length > 0
      ? params.prompt
      : "No synced system preset prompt. Previous synced content has been cleared.";
  return [
    "# AGENTS.md",
    "",
    "This file is managed by the ClawChat plugin for OpenClaw prompt injection.",
    "",
    `Chatbot ID: ${params.chatbotId || "unknown"}`,
    `Chatbot Name: ${title}`,
    "",
    "## Synced System Preset Prompt",
    "",
    body,
    "",
  ].join("\n");
}

export function evaluatePresetPromptHookConfig(
  cfg: OpenClawConfig,
  requiredPath = PROBE_MANAGED_AGENTS_RELATIVE_PATH,
): {
  match: boolean;
  missingRequirements: string[];
} {
  const missingRequirements: string[] = [];
  const hooks =
    cfg.hooks && typeof cfg.hooks === "object" && !Array.isArray(cfg.hooks)
      ? (cfg.hooks as Record<string, unknown>)
      : {};
  const internal =
    hooks.internal && typeof hooks.internal === "object" && !Array.isArray(hooks.internal)
      ? (hooks.internal as Record<string, unknown>)
      : {};
  const entries =
    internal.entries && typeof internal.entries === "object" && !Array.isArray(internal.entries)
      ? (internal.entries as Record<string, unknown>)
      : {};
  const bootstrapEntry =
    entries["bootstrap-extra-files"] &&
    typeof entries["bootstrap-extra-files"] === "object" &&
    !Array.isArray(entries["bootstrap-extra-files"])
      ? (entries["bootstrap-extra-files"] as Record<string, unknown>)
      : null;

  if (internal.enabled !== true) {
    missingRequirements.push("internal_hooks_disabled");
  }
  if (!bootstrapEntry) {
    missingRequirements.push("bootstrap_extra_files_missing");
    return {
      match: missingRequirements.length === 0,
      missingRequirements,
    };
  }
  if (bootstrapEntry.enabled !== true) {
    missingRequirements.push("bootstrap_extra_files_disabled");
  }
  const rawPaths = Array.isArray(bootstrapEntry.paths)
    ? bootstrapEntry.paths
    : Array.isArray(bootstrapEntry.patterns)
      ? bootstrapEntry.patterns
      : Array.isArray(bootstrapEntry.files)
        ? bootstrapEntry.files
        : [];
  const normalizedPaths = rawPaths
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  if (!normalizedPaths.includes(requiredPath)) {
    missingRequirements.push("injection_path_missing");
  }
  return {
    match: missingRequirements.length === 0,
    missingRequirements,
  };
}
