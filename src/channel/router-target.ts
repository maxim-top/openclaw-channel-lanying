export type RouterDeliveryTargetKind = "group" | "direct";

export type RouterDeliveryTarget = {
  kind: RouterDeliveryTargetKind;
  id: string;
};

const CLAWCHAT_PROVIDER_PREFIX = /^(?:clawchat|lanying):/i;

export function buildRouterDeliveryTarget(target: RouterDeliveryTarget): string {
  const id = target.id.trim();
  if (!id) {
    return "";
  }
  return `router:${target.kind}:${id}`;
}

export function parseRouterDeliveryTarget(raw?: string | null): RouterDeliveryTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(CLAWCHAT_PROVIDER_PREFIX, "");
  const match = /^router:(group|direct):(.+)$/i.exec(normalized);
  if (!match) {
    return null;
  }
  const id = match[2]?.trim() || "";
  if (!id) {
    return null;
  }
  return {
    kind: match[1]?.toLowerCase() === "group" ? "group" : "direct",
    id,
  };
}

export function buildRouterReplyMessage(params: {
  id: string;
  from: string;
  target: RouterDeliveryTarget;
  text: string;
  timestamp?: number;
}): Record<string, unknown> {
  const timestamp = Number.isFinite(params.timestamp) ? Number(params.timestamp) : Date.now();
  return {
    id: params.id,
    from: params.from,
    to: params.target.id,
    content: params.text,
    type: "text",
    ext: "",
    config: "",
    attach: "",
    status: 1,
    timestamp: String(timestamp),
    toType: params.target.kind === "group" ? "group" : "roster",
  };
}
