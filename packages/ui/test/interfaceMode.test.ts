// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { IBroadcastService } from "@zcode/services";
import { INTERFACE_MODE_STORAGE_KEY, normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { createZCodeStore } from "@/store/index.js";

// 修复原因：vitest 对 jsdom window 的全局投影会丢掉 storage 属性（localStorage 为
// undefined，opaque-origin 行为），挂一个带真实 origin 的 JSDOM Storage 保持完整语义。
const storage = new JSDOM("", { url: "http://localhost/" }).window.localStorage;
beforeAll(() => {
  vi.stubGlobal("localStorage", storage);
});

describe("界面模式偏好", () => {
  beforeEach(() => storage.clear());

  it.each([
    [null, "coding"],
    [undefined, "coding"],
    ["invalid", "coding"],
    ["office", "office"],
    ["coding", "coding"],
    // CR-02：改名 office 前的旧名，存量 localStorage 值必须映射到 office 而不是重置成 coding。
    ["general", "office"],
    ["concise", "office"],
    ["professional", "coding"],
  ])("归一化 %s 为 %s", (value, expected) => {
    expect(normalizeInterfaceMode(value)).toBe(expected);
  });

  it("保存模式、跨窗口同步且不回播，不改写代码换行偏好", () => {
    let receive: Parameters<IBroadcastService["onMessage"]>[0] | undefined;
    const send = vi.fn(async () => {});
    const service: IBroadcastService = {
      send,
      acquireClaim: async () => ({ status: "unavailable" }),
      commitClaim: async () => {},
      releaseClaim: async () => {},
      tryClaim: async () => false,
      onMessage: (listener) => {
        receive = listener;
        return { dispose: () => {} };
      },
    };
    localStorage.setItem(INTERFACE_MODE_STORAGE_KEY, "office");
    const store = createZCodeStore(service);
    expect(store.getState().interfaceMode).toBe("office");
    store.getState().setCodePreviewSettings({ wrapLongLines: false });
    store.getState().setInterfaceMode("coding");
    expect(localStorage.getItem(INTERFACE_MODE_STORAGE_KEY)).toBe("coding");
    expect(send).toHaveBeenCalledWith({ channel: "state:interfaceMode", payload: "coding" });
    send.mockClear();
    receive?.({ channel: "state:interfaceMode", payload: "office" });
    expect(store.getState().interfaceMode).toBe("office");
    expect(localStorage.getItem(INTERFACE_MODE_STORAGE_KEY)).toBe("office");
    expect(store.getState().codePreviewSettings.wrapLongLines).toBe(false);
    expect(send).not.toHaveBeenCalled();
    receive?.({ channel: "state:interfaceMode", payload: "unexpected" });
    expect(store.getState().interfaceMode).toBe("office");
  });
});
