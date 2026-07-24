import { ChatShell, type Theme } from "chat-tui";
import {
  forwardRef,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";

import { PluginScreen } from "./plugins/screen.tsx";
import { BatonChatProtocol, CHAT_COMMANDS } from "./protocol.ts";

export interface BatonTuiHandle {
  openPlugins(): void;
}

interface BatonTuiProps {
  protocol: BatonChatProtocol;
  theme: Theme;
}

/**
 * Keep screen changes inside one React tree. Imperative root.render() calls from
 * a key handler can leave OpenTUI pointing at the input that was just removed.
 */
export const BatonTui = forwardRef<BatonTuiHandle, BatonTuiProps>(
  function BatonTui(props, ref): ReactNode {
    const [screen, setScreen] = useState<"chat" | "plugins">("chat");

    useImperativeHandle(ref, () => ({
      openPlugins() {
        setScreen("plugins");
      },
    }));

    if (screen === "plugins") {
      return (
        <PluginScreen
          protocol={props.protocol}
          registry={props.protocol.marketplace}
          manager={props.protocol.pluginManager}
          theme={props.theme}
          onBack={() => setScreen("chat")}
        />
      );
    }

    return (
      <ChatShell
        protocol={props.protocol}
        commands={CHAT_COMMANDS}
        mentions={props.protocol.mentionCandidates}
        theme={props.theme}
      />
    );
  },
);
