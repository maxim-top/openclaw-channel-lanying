import { asPlainObject } from "../shared/utils.js";

export function extractSessionSyncText(value: unknown): string {
  if (typeof value === "string") {
    return value;
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
  return "";
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
