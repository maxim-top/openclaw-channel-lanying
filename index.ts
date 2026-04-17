import { clawchatPlugin, emitSessionMessageSyncToSelf } from "./src/channel.js";
import {
  formatGlobalOpenClawSessionLoggerStatus,
  installGlobalOpenClawSessionLogger,
  resetGlobalOpenClawSessionLoggerStatus,
} from "./src/openclaw/session-logger.js";
import { setClawchatRuntime } from "./src/runtime.js";

type OpenClawPluginApi = {
  runtime: unknown;
  registerCommand?: (params: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: () => Promise<{ text: string }> | { text: string };
  }) => void;
  registerChannel: (params: { plugin: unknown }) => void;
};

const plugin = {
  id: "clawchat",
  name: "ClawChat",
  description: "ClawChat IM channel plugin for OpenClaw",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    setClawchatRuntime(api.runtime);
    const disposeSessionLogger = installGlobalOpenClawSessionLogger(api.runtime, {
      onSessionTranscriptUpdate: async (update) => {
        try {
          await emitSessionMessageSyncToSelf(update);
        } catch {
          // sendSessionMessageSyncToSelf already logs failures; never surface
          // transcript sync forwarding as an unhandled plugin rejection.
        }
      },
    });
    api.registerCommand?.({
      name: "clawchat-session-log-status",
      description: "Show ClawChat runtime session logger counters and recent events.",
      acceptsArgs: false,
      handler: async () => ({ text: formatGlobalOpenClawSessionLoggerStatus() }),
    });
    api.registerCommand?.({
      name: "clawchat-session-log-reset",
      description: "Reset ClawChat runtime session logger counters and recent events.",
      acceptsArgs: false,
      handler: async () => ({ text: resetGlobalOpenClawSessionLoggerStatus() }),
    });
    api.registerChannel({ plugin: clawchatPlugin });
    return {
      dispose() {
        disposeSessionLogger();
      },
    };
  },
};

export default plugin;
