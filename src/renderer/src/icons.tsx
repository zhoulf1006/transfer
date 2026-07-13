import React from 'react'

/**
 * 内联 Lucide 图标(https://lucide.dev,ISC 许可)。
 *
 * overlay 有严格 CSP(default-src 'self'),不能走 CDN 图标字体,故内联 SVG。
 * 统一 Lucide 规范:24 viewBox、stroke=currentColor、stroke-width 2、圆角线帽。
 * color 跟随按钮 currentColor,size 默认 16。
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
