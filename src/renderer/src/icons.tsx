import React from 'react'

/**
 * 内联 SVG 图标。**一律内联,不引运行时图标库**——overlay 有严格 CSP
 * (default-src 'self'),CDN 图标字体加载不进来;内联同时让 size 由 width/height
 * 显式控制,不受字体度量影响(字符当图标会"同一 font-size 下实际字面大小不一")。
 *
 * **三个来源,按此优先级取,每个图标注明出处**:
 *   1. Lucide(https://lucide.dev,ISC)—— 主库,绝大多数图标在此。
 *   2. Tabler(https://tabler.io/icons,MIT)—— **仅当 Lucide 无对应语义时**。
 *      它与 Lucide 规格逐字相同(24 viewBox / fill none / stroke currentColor /
 *      stroke-width 2 / 圆角线帽),故可共用下面的 Icon 包装,混排无视觉差异。
 *   3. Material Symbols(Apache-2.0)—— 最后手段,**规格不同**:填充式、
 *      viewBox `0 -960 960 960`,套 Icon 会渲染成空白,必须用 FilledIcon。
 *
 * 加图标时照抄官方文件的**内部元素**,不贴完整 <svg> 标签、不在路径上写死颜色。
 */
function Icon({ size = 16, children }: { size?: number; children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

/**
 * Material Symbols 专用包装:**填充式**(fill=currentColor、无 stroke),且 viewBox 是
 * `0 -960 960 960` 而非 24。两处都与上面的 Icon 不同,混用会静默出错——把 Material 的
 * 路径塞进 Icon 会因 `fill="none"` 且路径本身无描边而**渲染成空白**(不报错)。
 * 只在 Lucide 与 Tabler 都没有对应语义时使用(当前仅 blur_on 一例)。
 */
function FilledIcon({ size = 16, children }: { size?: number; children: React.ReactNode }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor">
      {children}
    </svg>
  )
}

/** Lucide copy */
export function CopyIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  )
}

/** Lucide save */
export function SaveIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </Icon>
  )
}

/** Lucide send */
export function SendIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </Icon>
  )
}

/** Lucide sun-moon(主题:跟随系统 —— 半太阳半月亮,表达随系统自动切换明暗) */
export function SunMoonIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.3 17.7-1.4 1.4" />
      <path d="m19.1 4.9-1.4 1.4" />
      <path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4" />
    </Icon>
  )
}

/** Lucide sun(主题:浅色) */
export function SunIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Icon>
  )
}

/** Lucide moon(主题:深色) */
export function MoonIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Icon>
  )
}

/** Lucide settings(设置:齿轮) */
export function SettingsIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

/** Lucide paperclip(发送文件) */
export function PaperclipIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M13.234 20.252 21 12.3" />
      <path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486l7.766-7.952" />
    </Icon>
  )
}

/** Lucide camera(截图) */
export function CameraIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </Icon>
  )
}

/** Lucide inbox(已接收文件) */
export function InboxIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Icon>
  )
}

/** Lucide folder-open(设置页"在文件管理器中打开接收目录") */
export function FolderOpenIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Icon>
  )
}

/** Lucide chevron-down(聊天流"跳到最新"按钮) */
export function ChevronDownIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

/** Lucide rectangle-horizontal —— 标注:矩形 */
export function RectIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <rect width="20" height="12" x="2" y="6" rx="2" />
    </Icon>
  )
}

/** Lucide circle —— 标注:椭圆 */
export function EllipseIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <circle cx="12" cy="12" r="10" />
    </Icon>
  )
}

/** Lucide arrow-up-right —— 标注:箭头 */
export function ArrowIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M7 7h10v10" /> <path d="M7 17 17 7" />
    </Icon>
  )
}

/** Lucide slash —— 标注:直线 */
export function LineIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M22 2 2 22" />
    </Icon>
  )
}

/** Lucide pencil —— 标注:画笔 */
export function PenIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /> <path d="m15 5 4 4" />
    </Icon>
  )
}

/** Tabler texture —— 标注:马赛克 —— Lucide 无马赛克语义(mosaic/pixelate 标签全空),取 Tabler 斜纹 */
export function MosaicIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M6 3l-3 3" /> <path d="M21 18l-3 3" /> <path d="M11 3l-8 8" /> <path d="M16 3l-13 13" /> <path d="M21 3l-18 18" /> <path d="M21 8l-13 13" /> <path d="M21 13l-8 8" />
    </Icon>
  )
}

/** Material Symbols blur_on —— 标注:模糊 —— 填充式,必须走 FilledIcon;Lucide 连 blur 标签都没有 */
export function BlurIcon(props: { size?: number }): JSX.Element {
  return (
    <FilledIcon size={props.size}>
      <path d="M120-380q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm0-160q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm120 340q-17 0-28.5-11.5T200-240q0-17 11.5-28.5T240-280q17 0 28.5 11.5T280-240q0 17-11.5 28.5T240-200Zm0-160q-17 0-28.5-11.5T200-400q0-17 11.5-28.5T240-440q17 0 28.5 11.5T280-400q0 17-11.5 28.5T240-360Zm0-160q-17 0-28.5-11.5T200-560q0-17 11.5-28.5T240-600q17 0 28.5 11.5T280-560q0 17-11.5 28.5T240-520Zm0-160q-17 0-28.5-11.5T200-720q0-17 11.5-28.5T240-760q17 0 28.5 11.5T280-720q0 17-11.5 28.5T240-680Zm160 340q-25 0-42.5-17.5T340-400q0-25 17.5-42.5T400-460q25 0 42.5 17.5T460-400q0 25-17.5 42.5T400-340Zm0-160q-25 0-42.5-17.5T340-560q0-25 17.5-42.5T400-620q25 0 42.5 17.5T460-560q0 25-17.5 42.5T400-500Zm0 300q-17 0-28.5-11.5T360-240q0-17 11.5-28.5T400-280q17 0 28.5 11.5T440-240q0 17-11.5 28.5T400-200Zm0-480q-17 0-28.5-11.5T360-720q0-17 11.5-28.5T400-760q17 0 28.5 11.5T440-720q0 17-11.5 28.5T400-680Zm0 580q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm0-720q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm160 480q-25 0-42.5-17.5T500-400q0-25 17.5-42.5T560-460q25 0 42.5 17.5T620-400q0 25-17.5 42.5T560-340Zm0-160q-25 0-42.5-17.5T500-560q0-25 17.5-42.5T560-620q25 0 42.5 17.5T620-560q0 25-17.5 42.5T560-500Zm0 300q-17 0-28.5-11.5T520-240q0-17 11.5-28.5T560-280q17 0 28.5 11.5T600-240q0 17-11.5 28.5T560-200Zm0-480q-17 0-28.5-11.5T520-720q0-17 11.5-28.5T560-760q17 0 28.5 11.5T600-720q0 17-11.5 28.5T560-680Zm0 580q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm0-720q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm160 620q-17 0-28.5-11.5T680-240q0-17 11.5-28.5T720-280q17 0 28.5 11.5T760-240q0 17-11.5 28.5T720-200Zm0-160q-17 0-28.5-11.5T680-400q0-17 11.5-28.5T720-440q17 0 28.5 11.5T760-400q0 17-11.5 28.5T720-360Zm0-160q-17 0-28.5-11.5T680-560q0-17 11.5-28.5T720-600q17 0 28.5 11.5T760-560q0 17-11.5 28.5T720-520Zm0-160q-17 0-28.5-11.5T680-720q0-17 11.5-28.5T720-760q17 0 28.5 11.5T760-720q0 17-11.5 28.5T720-680Zm120 300q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Zm0-160q-8 0-14-6t-6-14q0-8 6-14t14-6q8 0 14 6t6 14q0 8-6 14t-14 6Z" />
    </FilledIcon>
  )
}

/** Tabler circle-number-1 —— 标注:序号 —— Lucide 全库无带圈数字(1768 个已穷举) */
export function BadgeNumberIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /> <path d="M10 10l2 -2v8" />
    </Icon>
  )
}

/** Lucide undo-2 —— 标注工具条:撤销 */
export function UndoIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M9 14 4 9l5-5" /> <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Icon>
  )
}

/** Lucide redo-2 —— 标注工具条:重做 */
export function RedoIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="m15 14 5-5-5-5" /> <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
    </Icon>
  )
}

/** Lucide file-image —— 文件类型:图片 */
export function FileImageIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <circle cx="10" cy="12" r="2" /> <path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" />
    </Icon>
  )
}

/** Lucide file-video-camera —— 文件类型:视频 */
export function FileVideoIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M4 12V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="m10 17.843 3.033-1.755a.64.64 0 0 1 .967.56v4.704a.65.65 0 0 1-.967.56L10 20.157" /> <rect width="7" height="6" x="3" y="16" rx="1" />
    </Icon>
  )
}

/** Lucide file-music —— 文件类型:音频 */
export function FileAudioIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="M8 20v-7l3 1.474" /> <circle cx="6" cy="20" r="2" />
    </Icon>
  )
}

/** Lucide file-text —— 文件类型:文档与 PDF —— Lucide 无 PDF 专用字形(1776 个已穷举),A 案统一家族下二者共用 */
export function FileTextIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="M10 9H8" /> <path d="M16 13H8" /> <path d="M16 17H8" />
    </Icon>
  )
}

/** Lucide file-archive —— 文件类型:压缩包 */
export function FileArchiveIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="M8 12v-1" /> <path d="M8 18v-2" /> <path d="M8 7V6" /> <circle cx="8" cy="20" r="2" />
    </Icon>
  )
}

/** Lucide file-spreadsheet —— 文件类型:表格 */
export function FileSheetIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="M8 13h2" /> <path d="M14 13h2" /> <path d="M8 17h2" /> <path d="M14 17h2" />
    </Icon>
  )
}

/** Lucide file —— 文件类型:兜底(未匹配任何扩展名) */
export function FileIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    </Icon>
  )
}
