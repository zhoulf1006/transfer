/**
 * 落地页多语言文案。文案提炼自 README.md / README.en.md。
 * key 用点号命名空间;组件按当前 locale 取字符串。
 */

export const languages = { zh: '中文', en: 'English' } as const
export type Locale = keyof typeof languages
export const defaultLocale: Locale = 'zh'

type Dict = Record<string, string>

export const ui: Record<Locale, Dict> = {
  zh: {
    'site.name': 'Transfer',
    'nav.features': '功能',
    'nav.how': '工作原理',
    'nav.download': '下载',
    'nav.github': 'GitHub',

    'hero.tagline': '局域网互传，简单到像聊天',
    'hero.title': '文件 · 文本 · 截图，一键发给同网络的另一台电脑',
    'hero.subtitle':
      '同一个 Wi-Fi 下的两台电脑，打开就自动发现彼此。无服务器、无账号、无云——数据只在局域网里走。',
    'hero.cta.download': '免费下载',
    'hero.cta.github': '在 GitHub 查看',
    'hero.platforms': '支持 macOS(Apple 芯片 / Intel)与 Windows',
    'hero.shotAlt': 'Transfer 应用主界面:聊天式收发文件与文本',

    'features.title': '核心功能',
    'features.autodiscovery.title': '自动发现',
    'features.autodiscovery.desc':
      'UDP 多播 + 子网广播双通道，免配置。同网设备自动出现在列表里，兼容官方 LocalSend 客户端。',
    'features.filetransfer.title': '文件传送',
    'features.filetransfer.desc':
      '选文件发送，接收方确认后落盘。支持一次发多个文件并行传输，自带 SHA-256 完整性校验。',
    'features.text.title': '文本消息',
    'features.text.desc': '直接发文字，像 IM 一样即时显示。',
    'features.chat.title': '聊天式界面',
    'features.chat.desc':
      '文本与文件统一为消息气泡流，本地 SQLite 持久化历史。未读角标 + 系统级新消息提醒。',
    'features.screenshot.title': '截图标注',
    'features.screenshot.desc':
      '全局快捷键框选截图，内置全套标注(矩形/箭头/画笔/文字/马赛克/高斯模糊等)。三个出口:发到聊天 / 复制剪贴板 / 保存文件。',
    'features.multilang.title': '多语言(跟随系统)',
    'features.multilang.desc':
      '界面支持中文 / 英文，默认跟随系统语言，也可手动切换，即时生效无需重启。',

    'how.title': '工作原理',
    'how.step1.title': '自动发现',
    'how.step1.desc':
      '每台设备定期发出 announce 报文(UDP 多播 224.0.0.167 + 子网广播),收到后定向回应对方。',
    'how.step2.title': 'HTTPS 直传',
    'how.step2.desc':
      '走 LocalSend v2 握手,基于 HTTPS(自签名证书 + 指纹 TOFU pinning)流式落盘,完成校验 SHA-256。',
    'how.step3.title': '数据不出局域网',
    'how.step3.desc':
      '不经过任何中转服务器,消息只在两台设备之间直连传输,数据只在局域网里走。',

    'download.title': '下载 Transfer',
    'download.version': '当前版本',
    'download.mac.heading': 'macOS',
    'download.win.heading': 'Windows',
    'download.mac.arm64': 'Apple 芯片 (Apple Silicon)',
    'download.mac.x64': 'Intel 芯片',
    'download.mac.universal': '通用版 (不确定就选这个)',
    'download.win.setup': '安装版 (Setup)',
    'download.win.portable': '免安装版 (Portable)',
    'download.source.primary': '下载',
    'download.source.cloudflare': 'Cloudflare',
    'download.stats.prefix': '当前已有',
    'download.stats.suffix': '次下载',

    'security.title': '安全说明',
    'security.transport':
      '传输走 HTTPS(自签名证书 + 指纹 TOFU pinning),可防被动窃听。请在可信局域网使用,不建议在公共 Wi-Fi 传敏感内容。',
    'security.vpn':
      '注意:任一方开启 VPN 全隧道模式会阻断局域网直连(能看到对方但发不出)。解决办法是临时关闭 VPN,或在 VPN 客户端开启分离隧道 / 允许本地子网访问。',

    'footer.opensource': '开源项目',
    'footer.license': 'MIT 协议',
    'footer.madeby': '由 loong_zhou 开发',
  },

  en: {
    'site.name': 'Transfer',
    'nav.features': 'Features',
    'nav.how': 'How it works',
    'nav.download': 'Download',
    'nav.github': 'GitHub',

    'hero.tagline': 'LAN transfer, as simple as chatting',
    'hero.title': 'Send files, text & screenshots to another computer on your network in one click',
    'hero.subtitle':
      'Two computers on the same Wi-Fi discover each other automatically. No server, no account, no cloud — data stays within the local network.',
    'hero.cta.download': 'Download free',
    'hero.cta.github': 'View on GitHub',
    'hero.platforms': 'Supports macOS (Apple Silicon / Intel) and Windows',
    'hero.shotAlt': 'Transfer main window: chat-style file and text transfer',

    'features.title': 'Key features',
    'features.autodiscovery.title': 'Auto discovery',
    'features.autodiscovery.desc':
      'UDP multicast + subnet broadcast dual channels, zero config. Devices on the same network appear automatically; compatible with the official LocalSend client.',
    'features.filetransfer.title': 'File transfer',
    'features.filetransfer.desc':
      'Pick files to send; the receiver confirms before they land on disk. Send multiple files in parallel, with built-in SHA-256 integrity check.',
    'features.text.title': 'Text messages',
    'features.text.desc': 'Send text directly, shown instantly like an IM.',
    'features.chat.title': 'Chat-style UI',
    'features.chat.desc':
      'Text and files unified into a message-bubble stream with local SQLite history. Unread badges + system-level new-message alerts.',
    'features.screenshot.title': 'Screenshot annotation',
    'features.screenshot.desc':
      'Global shortcut to select a region, with a full annotation toolkit (rectangle/arrow/pen/text/mosaic/blur, etc.). Three outputs: send to chat / copy to clipboard / save to file.',
    'features.multilang.title': 'Multi-language (follows system)',
    'features.multilang.desc':
      'The UI supports Chinese / English, following the system language by default, switchable manually with instant effect — no restart.',

    'how.title': 'How it works',
    'how.step1.title': 'Auto discovery',
    'how.step1.desc':
      'Each device periodically sends announce packets (UDP multicast 224.0.0.167 + subnet broadcast) and responds with a directed register on receipt.',
    'how.step2.title': 'Direct HTTPS transfer',
    'how.step2.desc':
      'Follows the LocalSend v2 handshake over HTTPS (self-signed cert + fingerprint TOFU pinning), streamed to disk with SHA-256 verification.',
    'how.step3.title': 'Data never leaves the LAN',
    'how.step3.desc':
      'No relay server involved; messages travel directly between the two devices, staying within the local network.',

    'download.title': 'Download Transfer',
    'download.version': 'Current version',
    'download.mac.heading': 'macOS',
    'download.win.heading': 'Windows',
    'download.mac.arm64': 'Apple Silicon',
    'download.mac.x64': 'Intel',
    'download.mac.universal': 'Universal (pick this if unsure)',
    'download.win.setup': 'Installer (Setup)',
    'download.win.portable': 'Portable',
    'download.source.primary': 'Download',
    'download.source.cloudflare': 'Cloudflare',
    'download.stats.prefix': 'Downloads so far:',
    'download.stats.suffix': '',

    'security.title': 'Security notes',
    'security.transport':
      'Transfers run over HTTPS (self-signed cert + fingerprint TOFU pinning), preventing passive eavesdropping. Use it on a trusted LAN; avoid sending sensitive content over public Wi-Fi.',
    'security.vpn':
      'Note: a VPN full-tunnel on either side blocks the direct LAN connection (you see the peer but can\'t send). Fix: temporarily turn off the VPN, or enable Split Tunnel / Local Subnet Access in the VPN client.',

    'footer.opensource': 'Open source',
    'footer.license': 'MIT License',
    'footer.madeby': 'Made by loong_zhou',
  },
}

/** 取当前 locale 的翻译函数 */
export function useTranslations(locale: Locale) {
  return function t(key: string): string {
    return ui[locale][key] ?? ui[defaultLocale][key] ?? key
  }
}

/** 生成带 locale 前缀的路径:zh -> /path, en -> /en/path */
export function localizedPath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  return locale === defaultLocale ? clean : `/en${clean === '/' ? '' : clean}`
}
