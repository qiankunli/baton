// 带前缀的 ULID：ID 从第一天起稳定、可外部引用（@ 与将来委派的共同前提，见 docs/design.md §2）。
// 自实现以避免依赖；同毫秒内不保证单调，事件定序靠信封里的 seq，不靠 ID。

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(time: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[(bytes[i] as number) % 32];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

/** bs=BatonSession ps=ProviderSession t=Turn m=Message tc=ToolCall pl=Plan ar=ApprovalRequest arv=ApprovalReview qr=QuestionRequest htr=HookTrustRequest */
export type IdPrefix = "bs" | "ps" | "t" | "m" | "tc" | "pl" | "ar" | "arv" | "qr" | "htr";

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
