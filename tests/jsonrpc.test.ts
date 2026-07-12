import { describe, expect, test } from "bun:test";

import { JsonRpcPeer } from "../src/adapters/codex/jsonrpc.ts";

function pair(): { peer: JsonRpcPeer; sent: string[] } {
  const sent: string[] = [];
  const peer = new JsonRpcPeer((line) => sent.push(line));
  return { peer, sent };
}

describe("JsonRpcPeer", () => {
  test("request resolves on matching response", async () => {
    const { peer, sent } = pair();
    const p = peer.request("thread/start", { cwd: "/tmp" });
    const req = JSON.parse(sent[0]!) as { id: number; method: string };
    expect(req.method).toBe("thread/start");
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "th_1" } } })}\n`);
    expect(await p).toEqual({ thread: { id: "th_1" } });
  });

  test("request rejects on error response", async () => {
    const { peer, sent } = pair();
    const p = peer.request("turn/start", {});
    const req = JSON.parse(sent[0]!) as { id: number };
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "boom" } })}\n`);
    await expect(p).rejects.toThrow(/boom/);
  });

  test("notifications and chunked lines dispatch correctly", () => {
    const { peer } = pair();
    const got: Array<[string, unknown]> = [];
    peer.onNotification((m, params) => got.push([m, params]));
    const line = `${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "hi" } })}\n`;
    // 按任意字节边界切开喂入
    peer.feed(line.slice(0, 17));
    peer.feed(line.slice(17));
    expect(got).toEqual([["item/agentMessage/delta", { delta: "hi" }]]);
  });

  test("server request gets response written back", async () => {
    const { peer, sent } = pair();
    peer.onServerRequest(async (method) => {
      expect(method).toBe("execCommandApproval");
      return { decision: "accept" };
    });
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval", params: {} })}\n`);
    await Bun.sleep(0); // 让异步 handler 完成
    const resp = JSON.parse(sent[0]!) as { id: string; result: unknown };
    expect(resp.id).toBe("srv-1");
    expect(resp.result).toEqual({ decision: "accept" });
  });

  test("non-JSON lines are ignored", () => {
    const { peer } = pair();
    expect(() => peer.feed("warning: something\n")).not.toThrow();
  });

  test("close rejects all pending requests", async () => {
    const { peer } = pair();
    const p = peer.request("model/list");
    peer.close("process exited");
    await expect(p).rejects.toThrow(/closed/);
  });

  // 启动期请求（initialize / thread resume/start / inject_items）卡死不能永久占住
  // turn 队列：preparing 的退出路径依赖显式超时兜底
  test("request with timeoutMs rejects when no response arrives", async () => {
    const { peer } = pair();
    await expect(peer.request("initialize", {}, { timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });

  test("timeout is disarmed by a response; late timer stays inert", async () => {
    const { peer, sent } = pair();
    const p = peer.request("thread/start", {}, { timeoutMs: 20 });
    const req = JSON.parse(sent[0]!) as { id: number };
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "th_1" } } })}\n`);
    expect(await p).toEqual({ thread: { id: "th_1" } });
    await Bun.sleep(30); // 超时点已过：不得出现迟到 reject / unhandled rejection
  });

  test("late response after a timeout is ignored", async () => {
    const { peer, sent } = pair();
    const p = peer.request("thread/resume", {}, { timeoutMs: 5 });
    await expect(p).rejects.toThrow(/timed out/);
    const req = JSON.parse(sent[0]!) as { id: number };
    expect(() =>
      peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} })}\n`),
    ).not.toThrow();
  });
});
