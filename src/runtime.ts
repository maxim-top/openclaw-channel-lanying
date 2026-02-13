import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setLanyingRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getLanyingRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Lanying runtime not initialized");
  }
  return runtime;
}