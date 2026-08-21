import { test, expect, describe } from 'vitest'
import { T_SENDER_MS, T_ACCEPT_MS, T_IDLE_MS, T_SWEEP_MS, T_UPLOAD_IDLE_MS, DEFAULT_PORT } from './protocol'

// 超时契约护栏(DESIGN §5.1/§11.2.3):挂起模型的正确性押在这条序关系上。
// 生产代码的确认窗口是 T_ACCEPT_MS(聊天流内确认;旧的弹框超时常量已随弹框模型一并删除)。
// 有人若把 T_SENDER_MS 调到 < T_ACCEPT_MS,接收方还在确认窗口内,发送方已先超时断开 —— 这里锁死。
describe('超时契约不变量(DESIGN §5.1)', () => {
  test('发送方超时必须 ≥ 聊天流确认窗口 + 余量', () => {
    expect(T_SENDER_MS).toBeGreaterThan(T_ACCEPT_MS)
    // 余量至少 10s,给网络往返 + resolve 200 的时间(当前 6min - 5min = 60s)
    expect(T_SENDER_MS - T_ACCEPT_MS).toBeGreaterThanOrEqual(10_000)
  })

  test('各超时常量为正', () => {
    expect(T_IDLE_MS).toBeGreaterThan(0)
    expect(T_SWEEP_MS).toBeGreaterThan(0)
    expect(T_UPLOAD_IDLE_MS).toBeGreaterThan(0)
  })

  /**
   * 两端的空闲阈值都是"多久没动静算断",谁先到点谁先放弃。**必须让接收方先**——
   * 会话是它的,它清干净了发送方才会拿到一个明确的连接错误;反过来发送方先走,
   * 接收方留着一个孤儿会话占住单会话锁,直到自己也超时为止。
   *
   * 接收方判空闲的上界不是 T_IDLE_MS 而是 T_IDLE_MS + T_SWEEP_MS:超时靠定期扫描推进,
   * 最坏情况刚好错过一次扫描。拿 T_IDLE_MS 直接比会得出一个偏松的结论。
   */
  test('发送方空闲阈值 > 接收方判空闲的上界 + 余量', () => {
    const receiverUpperBound = T_IDLE_MS + T_SWEEP_MS
    expect(T_UPLOAD_IDLE_MS).toBeGreaterThan(receiverUpperBound)
    expect(T_UPLOAD_IDLE_MS - receiverUpperBound).toBeGreaterThanOrEqual(5_000)
  })

  test('默认端口为 LocalSend 约定的 53317', () => {
    expect(DEFAULT_PORT).toBe(53317)
  })
})
