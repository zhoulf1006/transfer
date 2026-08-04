import { describe, expect, it } from 'vitest'
import { resolveIcpBeian } from './beian'

describe('resolveIcpBeian', () => {
  // 未配置 = 这不是国内那份构建(Cloudflare Pages 就不设这个变量),不渲染备案号
  it('未设置时返回 null,不报错', () => {
    expect(resolveIcpBeian(undefined)).toBeNull()
  })

  // CI 与托管平台常把「没填」的变量传成空串。当成非法值会让 .com 那侧莫名构建失败,
  // 所以空串与纯空白一律视同未设置。
  it('空串与纯空白视同未设置', () => {
    expect(resolveIcpBeian('')).toBeNull()
    expect(resolveIcpBeian('   ')).toBeNull()
    expect(resolveIcpBeian('\n\t')).toBeNull()
  })

  it('合法备案号原样返回', () => {
    expect(resolveIcpBeian('苏ICP备2025154241号-2')).toBe('苏ICP备2025154241号-2')
    expect(resolveIcpBeian('京ICP备12345678号')).toBe('京ICP备12345678号')
    expect(resolveIcpBeian('黑ICP备87654321号-11')).toBe('黑ICP备87654321号-11')
  })

  it('两端有空白的合法值会被去掉空白', () => {
    expect(resolveIcpBeian('  苏ICP备2025154241号-2  ')).toBe('苏ICP备2025154241号-2')
  })

  // 「可选」与「随便写什么都行」是两回事:写错的备案号是违规展示,
  // 静默放行等于把违规藏到线上,而线上没人会去看页脚。所以设了就必须合法,否则构建失败。
  it('设置了但格式非法时抛错,让构建失败', () => {
    expect(() => resolveIcpBeian('ICP备2025154241号')).toThrow(/备案号/) // 缺省份简称
    expect(() => resolveIcpBeian('苏ICP备号-2')).toThrow(/备案号/) // 缺数字
    expect(() => resolveIcpBeian('苏ICP2025154241号')).toThrow(/备案号/) // 缺“备”
    expect(() => resolveIcpBeian('苏ICP备2025154241')).toThrow(/备案号/) // 缺“号”
    expect(() => resolveIcpBeian('随便写点什么')).toThrow(/备案号/)
    expect(() => resolveIcpBeian('https://beian.miit.gov.cn/')).toThrow(/备案号/)
  })

  it('抛错信息里带上拿到的原值,便于定位是哪个环境配错了', () => {
    expect(() => resolveIcpBeian('写错了')).toThrow(/写错了/)
  })
})
