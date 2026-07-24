// 行分隔 JSON-RPC 2.0 peer（codex app-server 走 stdio）。

import type { DiagnosticSink } from "../../diagnostics.ts";
import { diagnosticError } from "../../diagnostics.ts";
// 三类入站消息：响应（id 无 method）、服务端请求（id + method，需要回包）、通知（仅 method）。

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buffer = "";
  private notificationHandler: NotificationHandler | undefined;
  private serverRequestHandler: ServerRequestHandler | undefined;
  private closed = false;

  constructor(
    private write: (line: string) => void,
    private diagnostic: DiagnosticSink = () => {},
  ) {}

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** 处理 server→client 请求；handler 的返回值作为 result 回包，抛错则回 error */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * timeoutMs：显式请求超时（超时后 reject 并丢弃迟到响应）。默认不超时——
   * turn/start 在老版本 app-server 上会合法地阻塞到 turn 结束，不能一刀切；
   * 调用方按请求语义决定（启动期请求必须设，否则冷启动卡死会永久占住 turn 队列）。
   */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequestMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`${method} timed out after ${opts.timeoutMs}ms`));
          }
        }, opts.timeoutMs);
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      });
      this.write(`${JSON.stringify(msg)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** 喂入 stdout 原始数据；内部按行切分，容忍半行残留 */
  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  /** 连接断开：所有挂起请求以错误结清，避免调用方悬挂 */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`jsonrpc peer closed: ${reason}`));
    this.pending.clear();
  }

  private dispatch(line: string): void {
    let msg: JsonRpcRequestMessage & JsonRpcResponseMessage;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      this.diagnostic({
        level: "warn",
        component: "codex.jsonrpc",
        harness: "codex",
        message: "ignored non-JSON app-server output",
        error: diagnosticError(error),
        details: { line: line.slice(0, 4096) },
      });
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.handleServerRequest(msg);
    } else if (msg.method !== undefined) {
      try {
        this.notificationHandler?.(msg.method, msg.params);
      } catch (error) {
        this.diagnostic({
          level: "error",
          component: "codex.notification",
          harness: "codex",
          message: `notification handler failed: ${msg.method}`,
          error: diagnosticError(error),
          details: { method: msg.method },
        });
      }
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.method ?? "rpc"} error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  private async handleServerRequest(msg: JsonRpcRequestMessage): Promise<void> {
    try {
      if (!this.serverRequestHandler) throw new Error(`no handler for server request ${msg.method}`);
      const result = await this.serverRequestHandler(msg.method, msg.params);
      this.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
    } catch (err) {
      this.diagnostic({
        level: "error",
        component: "codex.server-request",
        harness: "codex",
        message: `server request handler failed: ${msg.method}`,
        error: diagnosticError(err),
        details: { method: msg.method },
      });
      this.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        })}\n`,
      );
    }
  }
}
