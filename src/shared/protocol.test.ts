import { test, expect, describe } from 'vitest'
import { T_SENDER_MS, T_DIALOG_MS, T_IDLE_MS, T_UPLOAD_MS, DEFAULT_PORT } from './protocol'

// 超时契约护栏(DESIGN §5.1,B1):挂起模型的正确性押在这条序关系上。
// 有人若把 T_SENDER_MS 调到 < T_DIALOG_MS,真实传输会在用户点弹框前断开 —— 这里锁死。
describe('超时契约不变量(DESIGN §5.1)', () => {
  test('发送方超时必须 ≥ 接收方弹框超时 + 余量', () => {
    expect(T_SENDER_MS).toBeGreaterThan(T_DIALOG_MS)
    // 余量至少 10s,给网络往返 + resolve 200 的时间
    expect(T_SENDER_MS - T_DIALOG_MS).toBeGreaterThanOrEqual(10_000)
  })

  test('各超时常量为正且量级合理', () => {
    expect(T_DIALOG_MS).toBeGreaterThan(0)
    expect(T_IDLE_MS).toBeGreaterThan(0)
    // upload 超时应远大于弹框/空闲(大文件传输留足)
    expect(T_UPLOAD_MS).toBeGreaterThan(T_IDLE_MS)
  })

  test('默认端口为 LocalSend 约定的 53317', () => {
    expect(DEFAULT_PORT).toBe(53317)
  })
})
