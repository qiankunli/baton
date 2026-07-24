import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_ASYNC_LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 10;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleLock(lockPath: string): void {
  let observed: string;
  try {
    observed = readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  const holder = Number(observed.split(":", 1)[0]);
  if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) return;
  try {
    // 只删仍是刚才所见内容的 stale lock，避免释放与新持有者创建之间的竞态。
    if (readFileSync(lockPath, "utf8") === observed) rmSync(lockPath);
  } catch {
    // 持有者恰好释放或另一写者已接管，下一轮重试即可。
  }
}

function tryAcquire(path: string, token: string): boolean {
  const lockPath = `${path}.lock`;
  let created = false;
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    created = true;
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (created) {
      try {
        rmSync(lockPath);
      } catch {
        // 原始写锁错误更有诊断价值；残锁会按 pid 规则回收。
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    removeStaleLock(lockPath);
    return false;
  }
}

function release(path: string, token: string): void {
  const lockPath = `${path}.lock`;
  try {
    if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath);
  } catch {
    // 写结果已经原子落盘；锁清理失败由下一位写者按 pid 回收。
  }
}

/**
 * 以 `<path>.lock` 串行化同一文件的跨进程 read-modify-write。
 * callback 必须是同步短操作；长任务不应占用持久化锁。
 */
export function withFileLock<T>(
  path: string,
  update: () => T,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): T {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  while (!tryAcquire(path, token)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock ${path}`);
    Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, LOCK_RETRY_MS);
  }
  try {
    return update();
  } finally {
    release(path, token);
  }
}

/**
 * 长异步操作使用的跨进程锁。等待期间让出 event loop；callback 完成前锁保持有效。
 */
export async function withAsyncFileLock<T>(
  path: string,
  update: () => Promise<T>,
  timeoutMs: number = DEFAULT_ASYNC_LOCK_TIMEOUT_MS,
): Promise<T> {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  while (!tryAcquire(path, token)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock ${path}`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await update();
  } finally {
    release(path, token);
  }
}
