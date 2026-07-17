# Transfer

> 跨平台(macOS / Windows)局域网工具:**文件/文本互传 + 聊天 + 截图标注**,三者打通。
> 局域网直连,**无服务器、无账号、无云**。基于 Electron + TypeScript,发现与传输兼容 [LocalSend 协议 v2](https://github.com/localsend/protocol)。

---

## 这是什么

同一个 Wi-Fi / 局域网下的两台电脑,打开 Transfer 就能**自动发现彼此**,像聊天一样把文件、文本、截图直接发过去——不经过任何中转服务器,数据只在局域网里走。

适合的场景:

- 手边两台电脑(自己的 Mac + Windows)之间倒文件,懒得插 U 盘 / 开网盘。
- 给同一网络下的同事快速发个文件或一段文本。
- 截个图、标注一下,一键发给正在聊天的对方。

## 核心特性

| 功能 | 说明 |
|------|------|
| **自动发现** | UDP 多播 + 子网广播双通道,免配置;同网设备自动出现在列表里。兼容官方 LocalSend 客户端的发现广播。 |
| **文件传送** | 选文件发送,接收方**弹框/气泡确认**后落盘;支持一次发多个文件(并行传输),自带 **SHA-256 完整性校验**。 |
| **文本消息** | 直接发文字,像 IM 一样即时显示。 |
| **聊天式界面** | 文本与文件统一为消息气泡流,本地 **SQLite 持久化历史**;未读角标 + 系统级新消息提醒(mac Dock 数字角标 / Windows 任务栏闪烁)。 |
| **截图标注** | 全局快捷键(默认 **F1**,可自定义)框选截图,内置全套标注(矩形/椭圆/箭头/画笔/文字/序号/马赛克/高斯模糊等)+ 取色放大镜,三个出口:**发到当前聊天 / 复制到剪贴板 / 保存为文件**;聊天输入区也有截图按钮,支持**粘贴图片直接发送**。 |
| **自动接收** | 可选开启:小于阈值的文件自动接收(文本消息始终自动接收,文件默认全部需确认)。 |

> **安全提醒**:传输走 **HTTPS**(自签名证书 + 指纹 TOFU pinning),可防被动窃听。但设备指纹经明文 UDP 广播,**同网段的主动攻击者可冒充对端**(与官方 LocalSend 同级局限)——**接收前的确认弹框是防冒充的人肉防线**。请在**可信局域网**使用;不建议在公共 Wi-Fi 传敏感内容。

> **已知限制 · VPN / 全隧道会阻断局域网直连**:Transfer 靠**直连对端局域网 IP**(HTTPS)收发消息。如果**任一方开启了 VPN 的全隧道模式**(如 F5 BIG-IP Edge Client 等企业 VPN 默认配置),操作系统会把发往局域网 IP 的流量也灌进 VPN 隧道,导致到对端的直连被"劫持"进隧道而无法送达——表现为**设备列表里能看到对方,但消息发不出去**(此时连接会在约 10 秒后提示"连接超时,对方可能开了 VPN")。解决办法:**临时关闭 VPN**,或在 VPN 客户端开启**分离隧道 / 允许本地子网访问(Split Tunnel / Local Subnet Access)**放行局域网网段。这属于对端网络环境限制,非 Transfer 可绕过。

## 工作原理

```
┌──────────── 设备 A ────────────┐          ┌──────────── 设备 B ────────────┐
│  Electron App                  │          │  Electron App                  │
│  ┌──────────┐                  │  UDP 多播 │                  ┌──────────┐  │
│  │ 发现(dgram)│◄─── 224.0.0.167:53317 ───►│ 发现(dgram)│  │
│  └──────────┘                  │  +子网广播 │                  └──────────┘  │
│  ┌──────────┐  HTTPS :53317    │◄─────────►│    HTTPS :53317  ┌──────────┐  │
│  │ Fastify  │  prepare-upload / upload / cancel                │ Fastify  │  │
│  └──────────┘                  │          │                  └──────────┘  │
└────────────────────────────────┘          └────────────────────────────────┘
```

- **发现**:每台设备定期发出 announce 报文(UDP 多播 `224.0.0.167:53317` + 各网卡子网广播),收到后用 HTTP 定向 register 回应对方。用 `fingerprint` 过滤掉自己。
- **传输**:走 LocalSend v2 握手,基于 **HTTPS**(自签名证书 + 指纹 TOFU pinning)——`prepare-upload`(协商 + 确认)→ `upload`(裸二进制流式落盘,可并行)→ 完成校验 SHA-256。文本走 `prepare-upload` 里的 `preview` 字段,不走 `upload`。
- **进程分工**:主进程负责所有网络/文件/系统能力;渲染进程只做 UI,经 `contextBridge` 受限 IPC 通信。

详细设计见 [`docs/DESIGN.md`](docs/DESIGN.md);截图功能见 [`docs/screenshot-feature.md`](docs/screenshot-feature.md)。

## 技术栈

- **Electron 35** + **TypeScript** + **React 18**
- **electron-vite** 构建(主窗 + 截图 overlay 多入口)
- 发现层:Node 内置 **`dgram`**(原生 UDP 多播,非 mDNS)
- 传输层:**Fastify(HTTPS)** + **`node:https` client**(自签名证书 + 指纹 pinning;`upload` 用 `addContentTypeParser` 直接 pipe `request.raw` 流式落盘,不入内存)
- 证书:**`selfsigned`**(纯 JS,EC P-256 自签名)
- 历史存储:**`node:sqlite`**(Electron 35 内置,零原生依赖)
- 包管理:**pnpm**

## 开发

前置:Node 22.16+(需内置 `node:sqlite`)、pnpm 9。

```bash
pnpm install

pnpm dev          # 开发模式(HMR)
pnpm typecheck    # 类型检查
pnpm test         # 运行测试(vitest)
pnpm build        # 构建
```

> 本机测试"两台设备"互传:用不同 `userData` 目录 / 不同 fingerprint 启两个实例(避免同 fingerprint 互判为"自己")。见 DESIGN §9。

## 打包

```bash
pnpm dist:mac         # macOS(universal:arm64 + x64 单个 dmg)
pnpm dist:mac:sign    # macOS 签名 + 公证(本地,需 Developer ID)
pnpm dist:win         # Windows(NSIS 安装版 + portable 免安装版)
```

CI(GitHub Actions,`.github/workflows/build.yml`)在打 tag(或手动触发)时构建 macOS / Windows 产物。macOS 干净 tag 会公证成正式版。

> 未签名的构建在对方机器上首次打开会有一次性系统安全提示,属正常。

## 项目状态

- ✅ 局域网发现、文件/文本互传、SHA-256 校验、并行传输
- ✅ 聊天式 UI、SQLite 历史、未读提醒、自动接收
- ✅ 截图 + 全套标注 + 三出口、自定义快捷键、粘贴发图
- ✅ HTTPS 加密传输(自签名证书 + 指纹 TOFU pinning)
- 🚧 规划中:PIN 保护 / 带外指纹验证、与第三方 LocalSend App 完整互通、传输历史清理、断点续传、笔记(Markdown)

## 目录结构

```
src/
  main/          # 主进程:发现 / 传输 / 截图 / 聊天服务 / SQLite / IPC
    discovery/   # UDP 多播 + 广播、设备表
    transfer/    # Fastify server/client、会话状态机、落盘
    db/          # node:sqlite 消息表
    screenshot-service.ts
  preload/       # contextBridge 受限 API
  renderer/      # React UI(主聊天窗 + 截图 overlay)
  shared/        # 三端共用:协议常量 / 类型 / IPC 定义 / 纯逻辑
docs/            # 设计文档与各专题记录
```

## License

[MIT](LICENSE) © loong_zhou
