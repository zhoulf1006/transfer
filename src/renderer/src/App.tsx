import { useEffect, useState, useRef, useCallback } from 'react'
import type { RemoteDevice } from '@shared/types'
import { isImageFile } from '@shared/ipc'
import type { IdentityInfo, UiMessage, AutoAcceptSettings, ProgressPayload } from '@shared/ipc'
import { ErrorBoundary } from './ErrorBoundary'

/** 传输进度快照:messageId → 已传/总字节(不落库,仅内存) */
type ProgressMap = Record<string, { sent: number; total: number }>

type ThemePref = 'system' | 'light' | 'dark'

/**
 * 主题:跟随系统 / 手动浅 / 手动深。持久化走 **main 侧**(settings.json + IPC),
 * 不用 localStorage —— 打包版 file:// 下 localStorage 首次访问会卡数秒(阻塞首屏)。
 * 手动时在 <html> 上打 data-theme(CSS 里 :root[data-theme] 覆盖 @media)。
 */
function useTheme(): { pref: ThemePref; cycle: () => void } {
  // 初值 system(默认):不阻塞首屏;真实偏好由 IPC 异步拉回后应用。
  const [pref, setPref] = useState<ThemePref>('system')

  // 首次:从 main 拉持久化的主题偏好
  useEffect(() => {
    window.transfer.getTheme().then((t) => setPref(t))
  }, [])

  // pref 变化 → 应用到 DOM + 写回 main 持久化
  useEffect(() => {
    const root = document.documentElement
    if (pref === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', pref)
    void window.transfer.setTheme(pref)
  }, [pref])

  // 循环:system → light → dark → system
  const cycle = (): void =>
    setPref((p) => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'))
  return { pref, cycle }
}

export function App(): JSX.Element {
  const { pref: themePref, cycle: cycleTheme } = useTheme()
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [peer, setPeer] = useState<string | null>(null) // 选中对端 fingerprint
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [progress, setProgress] = useState<ProgressMap>({})
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<'chat' | 'downloads'>('chat')
  const [auto, setAuto] = useState<AutoAcceptSettings>({ enabled: false, maxBytes: 100 * 1024 * 1024 })

  // 初始化
  useEffect(() => {
    window.transfer.getIdentity().then(setIdentity)
    window.transfer.listDevices().then(setDevices)
    window.transfer.listMessages().then(setMessages)
    window.transfer.getAutoAccept().then(setAuto)

    const unsubs = [
      window.transfer.onDevicesUpdated((d) => setDevices(d)),
      window.transfer.onMessageUpserted((m) => {
        setMessages((prev) => {
          const i = prev.findIndex((x) => x.id === m.id)
          if (i >= 0) {
            const next = prev.slice()
            next[i] = m
            return next
          }
          return [...prev, m].sort((a, b) => a.createdAt - b.createdAt)
        })
        // 消息进入终态 → 清理残留进度条(失败/拒绝/超时不会有 done 进度帧)
        if (['done', 'failed', 'rejected', 'expired'].includes(m.status)) {
          setProgress((prev) => {
            if (!(m.id in prev)) return prev
            const { [m.id]: _drop, ...rest } = prev
            return rest
          })
        }
      }),
      window.transfer.onProgress((p: ProgressPayload) =>
        setProgress((prev) => {
          // 完成即清理该条进度(气泡改由 status 显示"已送达/已接收")
          if (p.total > 0 && p.sent >= p.total) {
            const { [p.messageId]: _drop, ...rest } = prev
            return rest
          }
          return { ...prev, [p.messageId]: { sent: p.sent, total: p.total } }
        })
      )
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // 同步"当前聊天对象"给 main(决定截图"发聊天"可用性,§4.3)。
  // 仅聊天视图下的选中 peer 才算活跃对象;下载页/未选设备时为 null。
  useEffect(() => {
    window.transfer.setShotActivePeer(view === 'chat' ? peer : null)
  }, [peer, view])

  // 选中对端的消息(按对端 fingerprint 过滤)
  const peerMessages = peer ? messages.filter((m) => m.peerFp === peer) : []

  return (
    <div style={S.app}>
      {/* 侧栏与主区各自包错误边界:一块崩溃不影响另一块(用户诉求) */}
      <ErrorBoundary label="设备列表">
        <Sidebar
          identity={identity}
          devices={devices}
          peer={peer}
          view={view}
          themePref={themePref}
          onCycleTheme={cycleTheme}
          onPick={(fp) => {
            setPeer(fp)
            setView('chat')
          }}
          onShowDownloads={() => setView('downloads')}
          onOpenSettings={() => setShowSettings(true)}
        />
      </ErrorBoundary>
      <div style={S.main}>
        <ErrorBoundary label="聊天" key={view + (peer ?? '')}>
          {view === 'downloads' ? (
            <Downloads />
          ) : peer ? (
            <Chat
              peer={peer}
              peerAlias={peerAliasOf(devices, peer)}
              online={devices.find((d) => d.info.fingerprint === peer)?.status !== 'offline'}
              messages={peerMessages}
              progress={progress}
            />
          ) : (
            <Empty devices={devices} />
          )}
        </ErrorBoundary>
      </div>
      {showSettings && (
        <SettingsModal
          value={auto}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            const next = await window.transfer.setAutoAccept(s)
            setAuto(next)
            setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}

function peerAliasOf(devices: RemoteDevice[], fp: string): string {
  return devices.find((d) => d.info.fingerprint === fp)?.info.alias ?? fp.slice(0, 8)
}

function Sidebar(props: {
  identity: IdentityInfo | null
  devices: RemoteDevice[]
  peer: string | null
  view: 'chat' | 'downloads'
  themePref: ThemePref
  onCycleTheme: () => void
  onPick: (fp: string) => void
  onShowDownloads: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const { identity, devices, peer, view, themePref, onCycleTheme, onPick, onShowDownloads, onOpenSettings } = props
  const online = devices.filter((d) => d.status !== 'offline')
  const offline = devices.filter((d) => d.status === 'offline')
  const themeIcon = themePref === 'system' ? '◐' : themePref === 'light' ? '☀' : '☾'
  const themeLabel = themePref === 'system' ? '跟随系统' : themePref === 'light' ? '浅色' : '深色'

  const DeviceRow = (d: RemoteDevice): JSX.Element => {
    const off = d.status === 'offline'
    const active = view === 'chat' && peer === d.info.fingerprint
    return (
      <div
        key={d.info.fingerprint}
        className="tf-row"
        onClick={() => onPick(d.info.fingerprint)}
        style={{ ...S.devItem, ...(active ? S.devItemActive : {}), ...(off ? S.devItemOffline : {}) }}
      >
        <div style={{ fontWeight: 550, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ ...S.dot, background: off ? 'var(--offline)' : 'var(--online)' }} />
          {d.info.alias}
        </div>
        <div style={S.devSub}>
          {d.info.deviceModel} · {off ? '离线' : d.address}
        </div>
      </div>
    )
  }

  return (
    <div style={S.sidebar}>
      <div style={S.brand}>
        <strong style={S.brandName}>Transfer</strong>
        <div style={{ display: 'flex', gap: 2 }}>
          <button
            className="tf-icon-btn"
            onClick={onCycleTheme}
            title={`主题:${themeLabel}(点击切换)`}
            style={S.iconBtn}
          >
            {themeIcon}
          </button>
          <button className="tf-icon-btn" onClick={onOpenSettings} title="设置" style={S.iconBtn}>
            ⚙
          </button>
        </div>
      </div>
      {identity && <div style={S.self}>本机 · {identity.alias}</div>}

      <div
        className="tf-row"
        onClick={onShowDownloads}
        style={{ ...S.downloadsEntry, ...(view === 'downloads' ? S.devItemActive : {}) }}
      >
        📥 已接收文件
      </div>

      <div style={S.devHeader}>在线 · {online.length}</div>
      {online.length === 0 && <div style={S.hint}>正在搜索…</div>}
      {online.map(DeviceRow)}

      {offline.length > 0 && (
        <>
          <div style={S.devHeader}>离线 · {offline.length}</div>
          {offline.map(DeviceRow)}
        </>
      )}
    </div>
  )
}

function Empty({ devices }: { devices: RemoteDevice[] }): JSX.Element {
  return (
    <div style={S.empty}>
      <div style={{ fontSize: 40 }}>💬</div>
      <p>{devices.length ? '选择左侧设备开始聊天' : '正在搜索局域网设备…'}</p>
    </div>
  )
}

function Chat(props: {
  peer: string
  peerAlias: string
  online: boolean
  messages: UiMessage[]
  progress: ProgressMap
}): JSX.Element {
  const { peer, peerAlias, online, messages, progress } = props
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages.length])

  const sendText = useCallback(async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    await window.transfer.sendText({ peerFp: peer, text: t })
  }, [text, peer])

  const sendPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length) await window.transfer.sendFiles({ peerFp: peer, filePaths: paths })
    },
    [peer]
  )

  const pickAndSend = useCallback(async () => {
    sendPaths(await window.transfer.pickFiles())
  }, [sendPaths])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      // §12.4:必须传原始 File 给 preload 的 getDroppedPaths(不能克隆/过 IPC)
      const files = Array.from(e.dataTransfer.files)
      if (files.length) sendPaths(window.transfer.getDroppedPaths(files))
    },
    [sendPaths]
  )

  return (
    <div style={S.chat}>
      <div style={S.chatHeader}>
        {peerAlias}
        {!online && <span style={S.offlineTag}>离线</span>}
      </div>
      <div
        ref={scrollRef}
        style={{ ...S.stream, ...(dragging ? S.streamDragging : {}) }}
        onDragOver={(e) => {
          e.preventDefault() // 必须,否则不触发 drop
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => {
          // 仅当离开整个区域(而非子元素间移动)才取消高亮
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {messages.length === 0 && <div style={S.hint}>还没有消息。发一条,或把文件拖进来 👇</div>}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} prog={progress[m.id]} />
        ))}
        {dragging && <div style={S.dropHint}>松开发送文件</div>}
      </div>
      <div style={S.inputBar}>
        <button onClick={pickAndSend} style={S.attachBtn} title="发送文件">
          📎
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法组字中按 Enter 是"确认选词",不是发送。
            // e.nativeEvent.isComposing 在 IME 组字期间为 true,此时不发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              sendText()
            }
          }}
          placeholder="输入消息,Enter 发送,Shift+Enter 换行"
          rows={1}
          style={S.textarea}
        />
        <button className="tf-btn" onClick={sendText} disabled={!text.trim()} style={S.sendBtn}>
          ➤
        </button>
      </div>
    </div>
  )
}

/** 已接收文件下载列表(§12.5) */
function Downloads(): JSX.Element {
  const [files, setFiles] = useState<UiMessage[]>([])
  useEffect(() => {
    window.transfer.listReceivedFiles().then(setFiles)
    // 仅当"接收文件落盘完成"(recv+file+done)才重拉,避免任意 upsert 刷爆 IPC/查询(3-B)
    return window.transfer.onMessageUpserted((m) => {
      if (m.direction === 'recv' && m.type === 'file' && m.status === 'done') {
        window.transfer.listReceivedFiles().then(setFiles)
      }
    })
  }, [])
  return (
    <div style={S.chat}>
      <div style={S.chatHeader}>已接收文件</div>
      <div style={{ ...S.stream, gap: 0 }}>
        {files.length === 0 && <div style={S.hint}>还没有接收到文件。</div>}
        {files.map((f) => (
          <div key={f.id} className="tf-row" style={S.dlRow}>
            <div style={S.fileIcon}>{fileEmoji(f.fileName)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.dlName} title={f.fileName ?? ''}>
                {f.fileName}
              </div>
              <div style={S.dlMeta}>
                {f.fileSize != null ? fmtSize(f.fileSize) : ''} · 来自 {f.peerAlias} ·{' '}
                {fmtDateTime(f.createdAt)}
              </div>
            </div>
            <button className="tf-btn" style={S.openBtn} onClick={() => window.transfer.openFile(f.id)}>
              打开
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Bubble({ msg, prog }: { msg: UiMessage; prog?: { sent: number; total: number } }): JSX.Element {
  const own = msg.direction === 'sent'
  return (
    <div style={{ ...S.bubbleRow, justifyContent: own ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubble, ...(own ? S.bubbleOwn : S.bubbleOther) }}>
        {msg.type === 'text' ? (
          <div style={S.text}>{msg.content}</div>
        ) : (
          <FileBubble msg={msg} prog={prog} own={own} />
        )}
        <div style={S.meta}>
          {statusLabel(msg)} · {fmtTime(msg.createdAt)}
        </div>
      </div>
    </div>
  )
}

/** 按文件扩展名给个贴切的图标(纯装饰,识别不了就用通用文件图标) */
function fileEmoji(name: string | null): string {
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (/^(png|jpg|jpeg|gif|webp|heic|bmp|svg)$/.test(ext)) return '🖼️'
  if (/^(mp4|mov|avi|mkv|webm)$/.test(ext)) return '🎬'
  if (/^(mp3|wav|flac|aac|m4a)$/.test(ext)) return '🎵'
  if (/^(pdf)$/.test(ext)) return '📕'
  if (/^(zip|rar|7z|tar|gz|dmg|pkg|exe|msi)$/.test(ext)) return '📦'
  if (/^(doc|docx|txt|md|rtf)$/.test(ext)) return '📝'
  if (/^(xls|xlsx|csv)$/.test(ext)) return '📊'
  return '📄'
}

function FileBubble({
  msg,
  prog,
  own
}: {
  msg: UiMessage
  prog?: { sent: number; total: number }
  own: boolean
}): JSX.Element {
  const canRespond = msg.direction === 'recv' && msg.status === 'pending'
  const canOpen = msg.status === 'done' && msg.filePath
  // 传输中(pending/accepted)且有进度 → 百分比进度条(§12.3)
  const transferring = msg.status === 'pending' || msg.status === 'accepted'
  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.sent / prog.total) * 100)) : null
  // 图片消息(已完成落盘)尝试缩略图;拿不到(GIF/WEBP/失败)由 ImageThumb 回退文件行
  const showThumb = canOpen && isImageFile(msg.fileName)
  return (
    <div>
      {showThumb ? (
        <ImageThumb msg={msg} />
      ) : (
        <div style={S.fileLine}>
          <div style={own ? S.fileIconOwn : S.fileIcon}>{fileEmoji(msg.fileName)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={S.fileName}>{msg.fileName}</div>
            {msg.fileSize != null && <div style={S.fileSize}>{fmtSize(msg.fileSize)}</div>}
          </div>
        </div>
      )}
      {transferring && pct !== null && (
        <>
          <div style={own ? S.progWrapOwn : S.progWrap}>
            <div style={{ ...(own ? S.progBarOwn : S.progBar), width: `${pct}%` }} />
          </div>
          <div style={S.progPct}>{pct}%</div>
        </>
      )}
      {/* 接收确认按钮只出现在 recv(对方=灰底气泡),用中性描边按钮 */}
      {canRespond && (
        <div style={S.actions}>
          <button
            className="tf-btn"
            style={S.acceptBtn}
            onClick={() =>
              msg.transferId && window.transfer.respond({ transferId: msg.transferId, accept: true })
            }
          >
            接收
          </button>
          <button
            className="tf-btn"
            style={S.rejectBtn}
            onClick={() =>
              msg.transferId && window.transfer.respond({ transferId: msg.transferId, accept: false })
            }
          >
            拒绝
          </button>
        </div>
      )}
      {canOpen && !showThumb && (
        <button className="tf-btn" style={S.openBtn} onClick={() => window.transfer.openFile(msg.id)}>
          打开
        </button>
      )}
    </div>
  )
}

/**
 * 图片缩略图气泡:向 main 拉缩略图 dataURL(nativeImage 生成)。
 * 拿到 → 显示缩略图,点击调 openFile 用系统查看器看原图;
 * 拿不到(GIF/WEBP/读失败)→ 回退文件图标行(与非图片一致)。
 */
function ImageThumb({ msg }: { msg: UiMessage }): JSX.Element {
  const [thumb, setThumb] = useState<string | null | undefined>(undefined) // undefined=加载中
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null) // 右键菜单位置
  const [viewer, setViewer] = useState<string | null>(null) // 原图 dataURL(居中弹层打开中)

  // 点击缩略图 → 拉原图 dataURL,打开居中弹层看大图
  const openViewer = (): void => {
    window.transfer.getImageDataUrl(msg.id).then((d) => {
      if (d) setViewer(d)
    })
  }

  // 弹层打开时 Esc 关闭
  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewer(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  useEffect(() => {
    let alive = true
    window.transfer.getThumbnail(msg.id).then((d) => {
      if (alive) setThumb(d)
    })
    return () => {
      alive = false
    }
  }, [msg.id])

  // 右键菜单打开时,点别处/滚动关闭
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // 拿不到缩略图 → 回退文件行
  if (thumb === null) {
    return (
      <div style={S.fileLine}>
        <div style={S.fileIcon}>{fileEmoji(msg.fileName)}</div>
        <div style={{ minWidth: 0 }}>
          <div style={S.fileName}>{msg.fileName}</div>
          {msg.fileSize != null && <div style={S.fileSize}>{fmtSize(msg.fileSize)}</div>}
        </div>
      </div>
    )
  }
  // 加载中:占位(保持文件名,避免闪)
  if (thumb === undefined) {
    return <div style={S.thumbLoading}>{msg.fileName}</div>
  }
  return (
    <>
      <img
        src={thumb}
        style={S.thumb}
        onClick={openViewer}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        title="点击查看原图 · 右键保存"
        alt={msg.fileName ?? ''}
      />
      {viewer && (
        <div style={S.lightbox} onClick={() => setViewer(null)}>
          <img src={viewer} style={S.lightboxImg} alt={msg.fileName ?? ''} />
        </div>
      )}
      {menu && (
        <div style={{ ...S.imgMenu, left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div
            className="tf-row"
            style={S.imgMenuItem}
            onClick={() => {
              setMenu(null)
              void window.transfer.saveImageAs(msg.id)
            }}
          >
            保存图片
          </div>
          <div
            className="tf-row"
            style={S.imgMenuItem}
            onClick={() => {
              setMenu(null)
              void window.transfer.openFile(msg.id)
            }}
          >
            用系统程序打开
          </div>
        </div>
      )}
    </>
  )
}

function SettingsModal(props: {
  value: AutoAcceptSettings
  onClose: () => void
  onSave: (s: Partial<AutoAcceptSettings>) => void
}): JSX.Element {
  const [enabled, setEnabled] = useState(props.value.enabled)
  const [mb, setMb] = useState(Math.round(props.value.maxBytes / (1024 * 1024)))
  return (
    <div style={S.modalMask} onClick={props.onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>接收设置</h3>
        <label style={S.settingRow}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用自动接收(文本消息始终自动接收)
        </label>
        <label style={{ ...S.settingRow, opacity: enabled ? 1 : 0.5 }}>
          自动接收文件大小上限:
          <input
            type="number"
            value={mb}
            disabled={!enabled}
            onChange={(e) => setMb(Math.max(0, Number(e.target.value)))}
            style={S.numInput}
          />
          MB
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={props.onClose} style={S.btn}>
            取消
          </button>
          <button
            onClick={() => props.onSave({ enabled, maxBytes: mb * 1024 * 1024 })}
            style={{ ...S.btn, ...S.btnPrimary }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ── helpers ──
function statusLabel(m: UiMessage): string {
  switch (m.status) {
    case 'pending':
      return m.direction === 'sent' ? '发送中' : '待接收'
    case 'accepted':
      return '接收中'
    case 'sent':
      return '已发送'
    case 'done':
      return m.direction === 'sent' ? '已送达' : '已接收'
    case 'rejected':
      return '被拒绝'
    case 'expired':
      return '已过期'
    case 'failed':
      return m.errorReason === 'busy' ? '对方正忙' : '失败'
    default:
      return m.status
  }
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 静谧石墨中性 + Notion 紫:所有颜色走 CSS 变量(见 theme.css),字号小一档、边框细、留白从容。
const S: Record<string, React.CSSProperties> = {
  app: { display: 'flex', height: '100vh', color: 'var(--ink)', fontSize: 13 },
  sidebar: { width: 224, borderRight: '1px solid var(--line)', background: 'var(--side)', display: 'flex', flexDirection: 'column', padding: '14px 12px', boxSizing: 'border-box', overflowY: 'auto' },
  brand: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  brandName: { fontSize: 15, fontWeight: 640, letterSpacing: '-0.01em' },
  iconBtn: { border: 'none', background: 'none', fontSize: 14, cursor: 'pointer', color: 'var(--muted)', width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center' },
  self: { fontSize: 11, color: 'var(--muted)', margin: '3px 0 14px' },
  devHeader: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', margin: '12px 4px 5px' },
  hint: { color: 'var(--muted)', fontSize: 12.5, padding: 8, lineHeight: 1.5 },
  devItem: { padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 1 },
  devItemActive: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  devItemOffline: { opacity: 0.5 },
  devSub: { fontSize: 10.5, color: 'var(--muted)', marginTop: 1, paddingLeft: 14 },
  dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  downloadsEntry: { padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 8, fontSize: 12.5, fontWeight: 550, display: 'flex', alignItems: 'center', gap: 7 },
  main: { flex: 1, display: 'flex', minWidth: 0, background: 'var(--card)' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', gap: 8 },
  chat: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  chatHeader: { padding: '13px 18px', borderBottom: '1px solid var(--line)', fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 },
  offlineTag: { fontSize: 10.5, fontWeight: 450, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 5, padding: '1px 7px' },
  stream: { flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 9, position: 'relative' },
  streamDragging: { outline: '2px dashed var(--accent)', outlineOffset: -8, background: 'var(--accent-soft)' },
  dropHint: { position: 'sticky', bottom: 8, alignSelf: 'center', background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '6px 16px', borderRadius: 18, fontSize: 12.5, pointerEvents: 'none', boxShadow: 'var(--shadow-md)' },
  bubbleRow: { display: 'flex' },
  bubble: { maxWidth: '74%', padding: '8px 12px', borderRadius: 14 },
  bubbleOwn: { background: 'var(--bubble-me)', color: 'var(--bubble-me-ink)', borderBottomRightRadius: 5 },
  bubbleOther: { background: 'var(--bubble-you)', color: 'var(--bubble-you-ink)', borderBottomLeftRadius: 5 },
  text: { fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  meta: { fontSize: 9.5, opacity: 0.7, marginTop: 4 },
  fileLine: { display: 'flex', alignItems: 'center', gap: 9 },
  fileIcon: { width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0, background: 'var(--accent-soft)' },
  // me 气泡是柔紫底,图标底不能再用同支柔紫(会糊),改用紫墨半透明:比气泡深一档、浅深底都可见
  fileIconOwn: { width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0, background: 'var(--own-wash)' },
  fileName: { fontWeight: 560, fontSize: 12.5 },
  fileSize: { fontSize: 10.5, opacity: 0.65, marginTop: 1 },
  thumb: {
    display: 'block',
    maxWidth: 180,
    maxHeight: 240,
    borderRadius: 8,
    cursor: 'pointer',
    objectFit: 'cover'
  },
  thumbLoading: {
    minWidth: 100,
    padding: '18px 12px',
    fontSize: 11.5,
    color: 'var(--muted)',
    background: 'var(--track)',
    borderRadius: 8,
    textAlign: 'center'
  },
  imgMenu: {
    position: 'fixed',
    zIndex: 1000,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    padding: 4,
    boxShadow: 'var(--shadow-md)',
    minWidth: 132
  },
  imgMenuItem: {
    padding: '7px 10px',
    fontSize: 12.5,
    borderRadius: 5,
    cursor: 'pointer',
    color: 'var(--ink)'
  },
  lightbox: {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'zoom-out',
    padding: 32,
    boxSizing: 'border-box'
  },
  lightboxImg: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 4,
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)'
  },
  progWrap: { position: 'relative', height: 5, background: 'var(--track)', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  progWrapOwn: { position: 'relative', height: 5, background: 'var(--own-wash)', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  progBar: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.12s linear' },
  // 全柔紫方案:me 气泡里的填充条也用中等紫(和非 own 一致),柔底上够清楚
  progBarOwn: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.12s linear' },
  progPct: { fontSize: 9.5, marginTop: 3, opacity: 0.85, fontVariantNumeric: 'tabular-nums' },
  dlRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: '1px solid var(--line)' },
  dlName: { fontWeight: 550, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dlMeta: { fontSize: 10.5, color: 'var(--muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', gap: 7, marginTop: 8 },
  acceptBtn: { padding: '4px 13px', border: '1px solid var(--accent-soft)', borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 },
  rejectBtn: { padding: '4px 13px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 11.5 },
  openBtn: { marginTop: 8, padding: '4px 13px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 11.5 },
  inputBar: { display: 'flex', gap: 8, padding: '11px 14px', borderTop: '1px solid var(--line)', alignItems: 'flex-end' },
  attachBtn: { border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', opacity: 0.6 },
  textarea: { flex: 1, border: '1px solid var(--line-strong)', borderRadius: 10, padding: '8px 12px', fontSize: 13, resize: 'none', fontFamily: 'inherit', maxHeight: 120, background: 'var(--bg)', color: 'var(--ink)', outline: 'none' },
  sendBtn: { width: 34, height: 34, border: 'none', borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, display: 'grid', placeItems: 'center', flexShrink: 0 },
  modalMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' },
  modal: { background: 'var(--card)', color: 'var(--ink)', borderRadius: 14, padding: 24, width: 380, border: '1px solid var(--line)', boxShadow: 'var(--shadow-md)' },
  settingRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13 },
  numInput: { width: 80, padding: '4px 8px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)' },
  btn: { padding: '6px 16px', border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 13 },
  btnPrimary: { border: '1px solid var(--accent-soft)', background: 'var(--accent-soft)', color: 'var(--accent)' }
}
