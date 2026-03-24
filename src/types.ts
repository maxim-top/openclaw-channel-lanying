export const LANYING_CHANNEL_ID = "lanying";
export const LANYING_DEFAULT_ACCOUNT_ID = "default";

export type LanyingGroupPolicy = "open" | "disabled" | "allowlist";

export type LanyingGroupConfig = {
  requireMention?: boolean;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
};

export type LanyingChannelConfig = {
  enabled?: boolean;
  enable?: boolean;
  appId?: string;
  app_id?: string;
  username?: string;
  password?: string;
  allowManage?: boolean;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  groupPolicy?: LanyingGroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, LanyingGroupConfig | undefined>;
  defaultTo?: string;
};

export type ResolvedLanyingAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  appId: string;
  username: string;
  password: string;
  allowManage: boolean;
  dmPolicy: string;
  allowFrom: string[];
  groupPolicy: LanyingGroupPolicy;
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
};

export type LanyingMessageTarget = {
  kind: "user" | "group";
  id: string;
};

export type LanyingInboundEvent = {
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
