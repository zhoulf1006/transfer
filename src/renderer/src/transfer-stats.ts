// 传输的两个数字:实时速度与总耗时。都是纯函数,与 React 无关,单测在 transfer-stats.test.ts。
//
// 这两个数字都**可能算不出来**(第一帧还没有可比的前帧、老消息没有时长),
// 一律用 `null` 表达"没有",由调用方整个不渲染 —— 退化成 `0s` / `0 MB/s` 会让用户
// 以为传输卡住了,那比不显示更糟。

/**
 * 时长 → `1h23m45s` / `4m5s` / `18s`。
 *
 * **统一 h/m/s,不随语言变**(2026-08-22 用户裁定):单位符号是国际通用记法,
 * 中英共用一套省掉一组要维护的文案,也让宽度在两种语言下完全一致。不加空格。
 * 不足 1 时不写 h、不足 1 分不写 m;不足 1 秒向上取整成 `1s`。
 */
export function fmtDuration(ms: number | null): string | null {
  // 负数来自时钟回拨,非有限值来自除零 —— 两者都不是"很短的时长",而是"算错了"
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const t = Math.max(1, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  if (h > 0) return `${h}h${m}m${s}s`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

const KB = 1024
const MB = 1024 * 1024

/**
 * 速度 → `118 MB/s` / `12.3 MB/s` / `340 KB/s` / `500 B/s`。
 *
 * MB/s 档 100 以下留一位小数、100 以上取整:让这个数字的宽度稳定在三四个字符,
 * 否则它在气泡右端会随速度抖动而左右伸缩。
 */
export function fmtSpeed(bps: number | null): string | null {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return null
  if (bps >= MB) {
    const v = bps / MB
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} MB/s`
  }
  if (bps >= KB) return `${Math.round(bps / KB)} KB/s`
  return `${Math.round(bps)} B/s`
}

/** 上一帧的进度采样。bps 为 null 表示当时还算不出速度。 */
export interface SpeedSample {
  sent: number
  at: number
  bps: number | null
}

/** 平滑系数:新采样占三成。太大读数抖、太小跟不上真实变化。 */
const ALPHA = 0.3

/**
 * 由两帧进度算速度,并做指数平滑。
 *
 * 为什么必须平滑:进度事件是节流推送的,而字节到达本身就不均匀 ——
 * 直接用瞬时增量做读数会在几十到几百 MB/s 之间乱跳,没法看。
 *
 * 三种异常帧一律**保持上次读数**而不是算出一个假数:
 * 时间差为 0(同一毫秒两帧,除零得 Infinity)、时间倒流(时钟回拨)、字节倒退。
 */
export function nextSpeed(prev: SpeedSample | undefined, cur: { sent: number; at: number }): number | null {
  if (!prev) return null // 第一帧没有可比的前帧
  const dt = cur.at - prev.at
  const db = cur.sent - prev.sent
  if (dt <= 0 || db < 0) return prev.bps
  const instant = (db / dt) * 1000
  return prev.bps === null ? instant : prev.bps + ALPHA * (instant - prev.bps)
}
