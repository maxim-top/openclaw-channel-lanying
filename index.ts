import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { lanyingPlugin } from "./src/channel.js";
import { setLanyingRuntime } from "./src/runtime.js";

const plugin = {
  id: "lanying",
  name: "Lanying",
  description: "Lanying IM channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setLanyingRuntime(api.runtime);
    api.registerChannel({ plugin: lanyingPlugin });
  },
};

export default plugin;