import { asPlainObject, maybeParseJson } from "../shared/utils.js";

function extractYieldResultMessage(value: unknown): string {
  const obj = asPlainObject(value);
  if (!obj) {
    return "";
  }
  if (obj.type !== "toolCall") {
    return "";
  }
  if (typeof obj.name !== "string" || obj.name.trim() !== "sessions_yield") {
    return "";
  }
  const rawArguments =
    typeof obj.arguments === "string" ? maybeParseJson(obj.arguments) : obj.arguments;
  const argumentsObj = asPlainObject(rawArguments);
  if (!argumentsObj) {
    return "";
  }
  return typeof argumentsObj.message === "string" ? argumentsObj.message : "";
}

function stripOpenClawRuntimeContextFromVisibleText(text: string): string {
  const marker = "[Current message]";
  const index = text.lastIndexOf(marker);
  if (index < 0) {
    return text;
  }
  return text.slice(index + marker.length).trim();
}

export function extractSessionSyncText(value: unknown): string {
  if (typeof value === "string") {
    return stripOpenClawRuntimeContextFromVisibleText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractSessionSyncText(item)).filter(Boolean).join("\n\n");
  }
  const obj = asPlainObject(value);
  if (!obj) {
    return "";
  }
  if (typeof obj.text === "string") {
    return obj.text;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "content")) {
    return extractSessionSyncText(obj.content);
  }
  return extractYieldResultMessage(obj);
}

export function normalizeSessionSyncText(value: unknown): string {
  return extractSessionSyncText(value)
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：“”"'`~!?,.;:]/g, "")
    .trim();
}

export function isSilentSessionSyncReply(value: unknown): boolean {
  const text = extractSessionSyncText(value).trim();
  if (!text) {
    return false;
  }
  return text.toUpperCase() === "NO_REPLY";
}

export function sessionSyncTextsLookDuplicated(left: unknown, right: unknown): boolean {
  const a = normalizeSessionSyncText(left);
  const b = normalizeSessionSyncText(right);
  if (!a || !b) {
    return false;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 12) {
    return shorter === longer;
  }
  return longer.includes(shorter);
}
