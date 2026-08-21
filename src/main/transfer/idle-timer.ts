/**
 * 空闲计时器:**距上一次 touch 超过 idleMs 就判定为断**,不限制总时长。
 *
 * 与"总时长硬超时"的区别是这次改动的要点:后者把"传完要多久"当成失败判据,于是文件一大就
 * 必然超时——而慢不等于断。空闲语义只问"还有没有动静",大文件传多久都行,真断线照样很快失败。
 *
 * 代价明知:对端若以低于 idleMs 的间隔一直挤牙膏,传输可以无限期挂着。这是选空闲语义换来的,
 * 见 ADR-0020;局域网点对点场景里没有对抗性对端,按可接受处理。
 *
 * 建好即开始计时——不能等第一次 touch:一个字节都没发出去的挂起正是要防的形态之一。
 */
export interface IdleTimer {
  /** 有动静(收到/发出字节)→ 重新开始计时 */
  touch: () => void
  /** 彻底停掉。响应已到达后必须调用,否则会去 destroy 一个已经完成的请求 */
  clear: () => void
}

export function createIdleTimer(idleMs: number, onIdle: () => void): IdleTimer {
  let timer: NodeJS.Timeout | null = null
  let fired = false

  const arm = (): void => {
    if (fired) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      // 只触发一次:重复触发会对同一个请求 destroy 多次
      fired = true
      timer = null
      onIdle()
    }, idleMs)
  }

  arm()

  return {
    touch: arm,
    clear: () => {
      fired = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
