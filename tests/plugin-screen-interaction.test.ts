import { afterEach, describe, expect, test } from "bun:test";
import {
  InputRenderable,
  TextareaRenderable,
} from "@opentui/core";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { createRoot, type Root } from "@opentui/react";
import { defaultTheme, type ChatViewState } from "chat-tui";
import { createElement, createRef } from "react";

import type { Manager } from "../src/plugin/manager.ts";
import type { MarketplaceRegistry } from "../src/plugin/marketplace/index.ts";
import {
  BatonTui,
  type BatonTuiHandle,
} from "../src/tui/app.tsx";
import type { BatonChatProtocol } from "../src/tui/protocol.ts";

let mounted: { root: Root; setup: TestRendererSetup } | null = null;

afterEach(() => {
  mounted?.root.unmount();
  mounted?.setup.renderer.destroy();
  mounted = null;
});

const view: ChatViewState = {
  transcript: [],
  header: "Baton chat",
  composerPlaceholder: "Chat input",
  footer: "ready",
};

function protocol(): BatonChatProtocol {
  const marketplace = {
    available: () => [],
    installed: () => [],
    list: () => [],
  } as unknown as MarketplaceRegistry;
  const pluginManager = {
    listInstances: () => [],
    isInstanceActive: () => false,
  } as unknown as Manager;

  return {
    marketplace,
    pluginManager,
    mentionCandidates: () => [],
    getView: () => view,
    subscribe: () => () => {},
    submit: () => {},
    command: () => {},
    cancel: () => {},
    exit: () => {},
    resolvePicker: () => {},
    resolveApproval: () => {},
    resolveQuestion: () => {},
  } as unknown as BatonChatProtocol;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.flush();
}

describe("Plugin screen interaction", () => {
  test("switches sections with arrows and restores the chat composer after Esc", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      screenMode: "main-screen",
    });
    const root = createRoot(setup.renderer);
    mounted = { root, setup };
    const tui = createRef<BatonTuiHandle>();

    root.render(
      createElement(BatonTui, {
        ref: tui,
        protocol: protocol(),
        theme: defaultTheme,
      }),
    );
    await settle(setup);

    tui.current?.openPlugins();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search discover");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable);

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search installed");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Chat input");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(TextareaRenderable);
    expect(setup.renderer.currentFocusedRenderable).not.toBeInstanceOf(InputRenderable);

    await setup.mockInput.typeText("focus restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("focus restored");
  });
});
