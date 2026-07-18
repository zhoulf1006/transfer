// 翻译字典(单一数据源,main + 两个 renderer 共享 import)。
// 命名空间见 docs/i18n-follow-system.md §4。
//
// 完整性由类型保证:TKey 取自 zh 的键集合,en 必须实现同一组键(Record<TKey,string>),
// 缺键编译报错——自研相比 i18next 的优势(引擎多为运行时键、漏译静默回退)。

import type { Lang } from './t'

const zh = {
  // common:跨处复用的通用词
  'common.cancel': '取消',
  'common.save': '保存',
  'common.openFolder': '打开所在文件夹',
  'common.settings': '设置',
  'common.accept': '接收',
  'common.reject': '拒绝',

  // sidebar:设备列表侧栏
  'sidebar.boundaryDevices': '设备列表',
  'sidebar.boundaryChat': '聊天',
  'sidebar.self': '本机 · {alias}',
  'sidebar.received': '已接收文件',
  'sidebar.online': '在线 · {count}',
  'sidebar.searching': '正在搜索…',
  'sidebar.offlineGroup': '离线 · {count}',
  'sidebar.deviceOffline': '离线',
  'sidebar.ctxRenameAlias': '修改备注',
  'sidebar.ctxClearAlias': '清除备注',
  'sidebar.aliasSaveFail': '保存失败,请重试',
  'sidebar.aliasClearFail': '清除失败,请重试',

  // chat:聊天区
  'chat.emptyPickDevice': '选择左侧设备开始聊天',
  'chat.emptySearching': '正在搜索局域网设备…',
  'chat.offlineTag': '离线',
  'chat.noMessages': '还没有消息。发一条,或把文件拖进来 👇',
  'chat.dropHint': '松开发送文件',
  'chat.captureTitle': '截图',
  'chat.sendFileTitle': '发送文件',
  'chat.inputPlaceholder': '输入消息,Enter 发送,Shift+Enter 换行',

  // chat.status:statusLabel 参数化(status × direction 拆独立键)
  'chat.status.pendingSent': '发送中',
  'chat.status.pendingRecv': '待接收',
  'chat.status.accepting': '接收中',
  'chat.status.sent': '已发送',
  'chat.status.delivered': '已送达',
  'chat.status.received': '已接收',
  'chat.status.rejected': '被拒绝',
  'chat.status.expired': '已过期',

  // chat.failed:failedLabel 参数化(errorReason 枚举)
  'chat.failed.busy': '对方正忙',
  'chat.failed.timeout': '连接超时(对方可能开了 VPN)',
  'chat.failed.refused': '对方未在监听',
  'chat.failed.certMismatch': '证书不匹配',
  'chat.failed.default': '失败',

  // downloads:已接收文件页
  'downloads.title': '已接收文件',
  'downloads.empty': '还没有接收到文件。',
  'downloads.from': '来自 {alias}',

  // image:图片消息 / 预览
  'image.thumbTitle': '点击查看原图 · 右键保存',
  'image.saveImage': '保存图片',
  'image.openWithSystem': '用系统程序打开',

  // settings:设置弹窗
  'settings.title': '设置',
  'settings.sectionReceive': '接收',
  'settings.autoAcceptLabel': '启用自动接收(文本消息始终自动接收)',
  'settings.maxSizeLabel': '自动接收文件大小上限:',
  'settings.sectionStorage': '存储',
  'settings.fileLabel': '文件:',
  'settings.openFolderTitle': '打开文件夹',
  'settings.sectionShortcut': '快捷键',
  'settings.sectionLanguage': '语言',

  // settings.lang:语言选择器
  'settings.lang.system': '跟随系统',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.lang.systemHint': '改系统语言后需重启应用生效',

  // shortcut:截图快捷键录制
  'shortcut.captureLabel': '截图:',
  'shortcut.recordGuideEsc': '按下快捷键…(Esc 取消)',
  'shortcut.recordGuide': '按下快捷键…',
  'shortcut.saving': '保存中…',
  'shortcut.hintNeedModifier': '普通键需配合 Cmd/Ctrl/Alt/Shift',
  'shortcut.hintUnsupported': '不支持该按键,请换一个',
  'shortcut.hintContinue': '继续按下组合键…',
  'shortcut.errConflict': '该快捷键可能被其他程序占用,请换一个',
  'shortcut.errInvalid': '快捷键格式非法,请换一个',

  // theme:主题按钮(仅文案,交互位置不变)
  'theme.system': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.tooltip': '主题:{label}(点击切换)',

  // overlay:截图标注全屏窗
  'overlay.loading': '正在截图…',
  'overlay.magnifierHint': 'C 复制 · Shift 切格式 · 滚轮缩放',
  'overlay.opHint': '拖拽框选 · 右键取消 · Esc 退出',
  'overlay.strokeWidth': '粗细',
  'overlay.undo': '撤销',
  'overlay.redo': '重做',
  'overlay.copyClipboard': '复制到剪贴板',
  'overlay.saveFile': '保存为文件',
  'overlay.sendToPeer': '发到当前聊天',
  'overlay.sendNoPeer': '先在主窗选择一个聊天对象',

  // overlay.tool:标注工具名(按钮 title)
  'overlay.tool.rect': '矩形',
  'overlay.tool.ellipse': '椭圆',
  'overlay.tool.arrow': '箭头',
  'overlay.tool.line': '直线',
  'overlay.tool.pen': '画笔',
  'overlay.tool.mosaic': '马赛克',
  'overlay.tool.blur': '模糊',
  'overlay.tool.text': '文字',
  'overlay.tool.badge': '序号',

  // error:ErrorBoundary 兜底
  'error.boundarySuffix': '{label}出错了',
  'error.boundaryFallback': '这里',
  'error.boundaryApp': '应用',
  'error.retry': '重试',

  // main.dialog:主进程原生对话框
  'main.dialog.initFailTitle': '初始化失败',
  'main.dialog.initFailBody': '无法生成本机证书(HTTPS 前提):{err}',
  'main.dialog.startFailTitle': '启动失败',
  'main.dialog.screenPermTitle': '需要屏幕录制权限',
  'main.dialog.screenPermDetail':
    '请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 Transfer,然后重启应用。',
  'main.dialog.screenPermOpen': '打开系统设置',
  'main.dialog.screenPermCancel': '取消',

  // main.file:文件名前缀 / dialog filter
  'main.file.imagePrefix': '图片',
  'main.file.screenshotPrefix': '截图',
  'main.file.pngFilterName': 'PNG 图片'
} as const

/** 所有翻译键(取自 zh) */
export type TKey = keyof typeof zh

// en 必须实现同一组键(缺键编译报错)
const en: Record<TKey, string> = {
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.openFolder': 'Show in Folder',
  'common.settings': 'Settings',
  'common.accept': 'Accept',
  'common.reject': 'Decline',

  'sidebar.boundaryDevices': 'Device List',
  'sidebar.boundaryChat': 'Chat',
  'sidebar.self': 'This device · {alias}',
  'sidebar.received': 'Received Files',
  'sidebar.online': 'Online · {count}',
  'sidebar.searching': 'Searching…',
  'sidebar.offlineGroup': 'Offline · {count}',
  'sidebar.deviceOffline': 'Offline',
  'sidebar.ctxRenameAlias': 'Edit Note',
  'sidebar.ctxClearAlias': 'Clear Note',
  'sidebar.aliasSaveFail': 'Save failed, please retry',
  'sidebar.aliasClearFail': 'Clear failed, please retry',

  'chat.emptyPickDevice': 'Select a device on the left to start chatting',
  'chat.emptySearching': 'Searching for devices on the LAN…',
  'chat.offlineTag': 'Offline',
  'chat.noMessages': 'No messages yet. Send one, or drag files in 👇',
  'chat.dropHint': 'Release to send files',
  'chat.captureTitle': 'Screenshot',
  'chat.sendFileTitle': 'Send Files',
  'chat.inputPlaceholder': 'Type a message. Enter to send, Shift+Enter for newline',

  'chat.status.pendingSent': 'Sending',
  'chat.status.pendingRecv': 'Awaiting',
  'chat.status.accepting': 'Receiving',
  'chat.status.sent': 'Sent',
  'chat.status.delivered': 'Delivered',
  'chat.status.received': 'Received',
  'chat.status.rejected': 'Declined',
  'chat.status.expired': 'Expired',

  'chat.failed.busy': 'Recipient is busy',
  'chat.failed.timeout': 'Connection timed out (recipient may be on a VPN)',
  'chat.failed.refused': 'Recipient is not listening',
  'chat.failed.certMismatch': 'Certificate mismatch',
  'chat.failed.default': 'Failed',

  'downloads.title': 'Received Files',
  'downloads.empty': 'No files received yet.',
  'downloads.from': 'From {alias}',

  'image.thumbTitle': 'Click to view · Right-click to save',
  'image.saveImage': 'Save Image',
  'image.openWithSystem': 'Open with System App',

  'settings.title': 'Settings',
  'settings.sectionReceive': 'Receiving',
  'settings.autoAcceptLabel': 'Enable auto-accept (text messages always auto-accepted)',
  'settings.maxSizeLabel': 'Auto-accept file size limit:',
  'settings.sectionStorage': 'Storage',
  'settings.fileLabel': 'Files:',
  'settings.openFolderTitle': 'Open Folder',
  'settings.sectionShortcut': 'Shortcut',
  'settings.sectionLanguage': 'Language',

  'settings.lang.system': 'Follow System',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.lang.systemHint': 'Changing the system language takes effect after restarting the app',

  'shortcut.captureLabel': 'Screenshot:',
  'shortcut.recordGuideEsc': 'Press a shortcut… (Esc to cancel)',
  'shortcut.recordGuide': 'Press a shortcut…',
  'shortcut.saving': 'Saving…',
  'shortcut.hintNeedModifier': 'Regular keys need Cmd/Ctrl/Alt/Shift',
  'shortcut.hintUnsupported': 'This key is not supported, try another',
  'shortcut.hintContinue': 'Keep pressing the key combination…',
  'shortcut.errConflict': 'This shortcut may be taken by another app, try another',
  'shortcut.errInvalid': 'Invalid shortcut format, try another',

  'theme.system': 'Follow System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.tooltip': 'Theme: {label} (click to switch)',

  'overlay.loading': 'Capturing…',
  'overlay.magnifierHint': 'C copy · Shift switch format · scroll to zoom',
  'overlay.opHint': 'Drag to select · Right-click to cancel · Esc to exit',
  'overlay.strokeWidth': 'Stroke Width',
  'overlay.undo': 'Undo',
  'overlay.redo': 'Redo',
  'overlay.copyClipboard': 'Copy to Clipboard',
  'overlay.saveFile': 'Save as File',
  'overlay.sendToPeer': 'Send to current chat',
  'overlay.sendNoPeer': 'Pick a chat target in the main window first',

  'overlay.tool.rect': 'Rectangle',
  'overlay.tool.ellipse': 'Ellipse',
  'overlay.tool.arrow': 'Arrow',
  'overlay.tool.line': 'Line',
  'overlay.tool.pen': 'Pen',
  'overlay.tool.mosaic': 'Mosaic',
  'overlay.tool.blur': 'Blur',
  'overlay.tool.text': 'Text',
  'overlay.tool.badge': 'Number',

  'error.boundarySuffix': '{label} crashed',
  'error.boundaryFallback': 'This part',
  'error.boundaryApp': 'The app',
  'error.retry': 'Retry',

  'main.dialog.initFailTitle': 'Initialization Failed',
  'main.dialog.initFailBody': 'Failed to generate local certificate (required for HTTPS): {err}',
  'main.dialog.startFailTitle': 'Startup Failed',
  'main.dialog.screenPermTitle': 'Screen Recording Permission Required',
  'main.dialog.screenPermDetail':
    'Please allow Transfer under System Settings → Privacy & Security → Screen Recording, then restart the app.',
  'main.dialog.screenPermOpen': 'Open System Settings',
  'main.dialog.screenPermCancel': 'Cancel',

  'main.file.imagePrefix': 'image',
  'main.file.screenshotPrefix': 'screenshot',
  'main.file.pngFilterName': 'PNG Image'
}

export const DICT: Record<Lang, Record<TKey, string>> = { zh, en }
