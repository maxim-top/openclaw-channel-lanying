export const CLAWCHAT_CHANNEL_ID = "clawchat";
export const CLAWCHAT_LEGACY_CHANNEL_ID = "lanying";
export const CLAWCHAT_DEFAULT_ACCOUNT_ID = "default";

export type OpenClawConfig = Record<string, any>;

export type ClawchatGroupPolicy = "open" | "disabled" | "allowlist";

export type ClawchatGroupConfig = {
  requireMention?: boolean;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
};

export type ClawchatChannelConfig = {
  enabled?: boolean;
  enable?: boolean;
  appId?: string;
  app_id?: string;
  username?: string;
  password?: string;
  allowManage?: boolean;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  groupPolicy?: ClawchatGroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, ClawchatGroupConfig | undefined>;
  defaultTo?: string;
  sessionMapSync?: boolean;
  session_map_sync?: boolean;
  mergeSubSessions?: boolean;
  merge_sub_sessions?: boolean;
};

export type ResolvedClawchatAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  configKey: string;
  usesLegacyConfig: boolean;
  appId: string;
  username: string;
  password: string;
  allowManage: boolean;
  dmPolicy: string;
  allowFrom: string[];
  groupPolicy: ClawchatGroupPolicy;
  groupAllowFrom: string[];
  groups: Record<
    string,
    {
      requireMention?: boolean;
      enabled?: boolean;
      allowFrom: string[];
    }
  >;
  defaultTo?: string;
  sessionMapSync: boolean;
  mergeSubSessions: boolean;
};

export type ClawchatMessageTarget = {
  kind: "user" | "group";
  id: string;
};

export type ClawchatInboundEvent = {
  from?: { uid?: string | number; id?: string | number } | string | number;
  to?: { uid?: string | number; id?: string | number } | string | number;
  gid?: string | number;
  group_id?: string | number;
  conversation_id?: string | number;
  type?: string;
  msg?: unknown;
  text?: unknown;
  content?: unknown;
  payload?: Record<string, unknown>;
  sender_id?: string | number;
  [key: string]: unknown;
};
