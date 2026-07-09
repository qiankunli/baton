// 行分隔 JSON-RPC 2.0 peer（codex app-server 走 stdio）。
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

  constructor(private write: (line: string) => void) {}

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** 处理 server→client 请求；handler 的返回值作为 result 回包，抛错则回 error */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequestMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    } catch {
      return; // 非 JSON 行（stderr 混入等）直接忽略
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.handleServerRequest(msg);
    } else if (msg.method !== undefined) {
      this.notificationHandler?.(msg.method, msg.params);
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
