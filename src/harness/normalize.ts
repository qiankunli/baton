// Adapter 边界的归一原语。见 docs/kernel.md §2 不变量 #2。

/**
 * 封闭词表归一（kernel.md §2 不变量 #2 的单一结构保证）：把 harness 的开放 / UNSTABLE
 * 终态字符串映射到内部**闭合**词汇；名单外的值一律回落到**保守**成员（fail-closed），
 * 绝不乐观放行——乐观兜底曾把 codex 的 declined 渲染成绿勾。
 *
 * 所有 adapter 的终态翻译都应走这里，让"未知终态 → 保守态"从每处各自手写白名单，收成一处
 * 结构保证；新 harness 接入时免再重新发明这条纪律。归一发生在 adapter 边界：闭合值进入
 * 事件流后，reduce / 投影都面对闭集，不必再兜未知；harness 原始值仍在信封 `raw` 里保真。
 *
 * @param raw harness wire 上的原始终态值（容忍 unknown 类型）
 * @param table 明确认得的值 → 内部闭合词汇
 * @param fallback 名单外（含空 / 缺失，除非给了 emptyAs）的保守回落成员
 * @param emptyAs 空 / 缺失的特判——如 codex `item/completed` 缺 status 即 completed（方法名本身即完成语义），不是词汇漂移
 */
export function closedTerminal<T extends string>(
  raw: unknown,
  table: Record<string, T>,
  fallback: T,
  emptyAs?: T,
): T {
  if (raw === undefined || raw === null || raw === "") return emptyAs ?? fallback;
  return table[String(raw)] ?? fallback;
}
