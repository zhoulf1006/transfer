import { useEffect, useState, useRef, useCallback } from 'react'
import type { RemoteDevice } from '@shared/types'
import type { IdentityInfo, UiMessage, AutoAcceptSettings, ProgressPayload } from '@shared/ipc'

/** 传输进度快照:messageId → 已传/总字节(不落库,仅内存) */
type ProgressMap = Record<string, { sent: number; total: number }>

export function App(): JSX.Element {
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

  // 选中对端的消息(按对端 fingerprint 过滤)
  const peerMessages = peer ? messages.filter((m) => m.peerFp === peer) : []

  return (
    <div style={S.app}>
      <Sidebar
        identity={identity}
        devices={devices}
        peer={peer}
        view={view}
        onPick={(fp) => {
          setPeer(fp)
          setView('chat')
        }}
        onShowDownloads={() => setView('downloads')}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div style={S.main}>
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
  onPick: (fp: string) => void
  onShowDownloads: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const { identity, devices, peer, view, onPick, onShowDownloads, onOpenSettings } = props
  const online = devices.filter((d) => d.status !== 'offline')
  const offline = devices.filter((d) => d.status === 'offline')

  const DeviceRow = (d: RemoteDevice): JSX.Element => {
    const off = d.status === 'offline'
    const active = view === 'chat' && peer === d.info.fingerprint
    return (
      <div
        key={d.info.fingerprint}
        onClick={() => onPick(d.info.fingerprint)}
        style={{ ...S.devItem, ...(active ? S.devItemActive : {}), ...(off ? S.devItemOffline : {}) }}
      >
        <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...S.dot, background: off ? '#bbb' : '#22c55e' }} />
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
        <strong>Transfer</strong>
        <button onClick={onOpenSettings} title="设置" style={S.iconBtn}>
          ⚙
        </button>
      </div>
      {identity && <div style={S.self}>本机:{identity.alias}</div>}

      <div
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendText()
            }
          }}
          placeholder="输入消息,Enter 发送,Shift+Enter 换行"
          rows={1}
          style={S.textarea}
        />
        <button onClick={sendText} disabled={!text.trim()} style={S.sendBtn}>
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
          <div key={f.id} style={S.dlRow}>
            <span style={{ fontSize: 22 }}>📄</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.dlName} title={f.fileName ?? ''}>
                {f.fileName}
              </div>
              <div style={S.dlMeta}>
                {f.fileSize != null ? fmtSize(f.fileSize) : ''} · 来自 {f.peerAlias} ·{' '}
                {fmtDateTime(f.createdAt)}
              </div>
            </div>
            <button style={S.openBtn} onClick={() => window.transfer.openFile(f.id)}>
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
          <FileBubble msg={msg} prog={prog} />
        )}
        <div style={S.meta}>
          {statusLabel(msg)} · {fmtTime(msg.createdAt)}
        </div>
      </div>
    </div>
  )
}

function FileBubble({
  msg,
  prog
}: {
  msg: UiMessage
  prog?: { sent: number; total: number }
}): JSX.Element {
  const canRespond = msg.direction === 'recv' && msg.status === 'pending'
  const canOpen = msg.status === 'done' && msg.filePath
  // 传输中(pending/accepted)且有进度 → 百分比进度条(§12.3)
  const transferring = msg.status === 'pending' || msg.status === 'accepted'
  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.sent / prog.total) * 100)) : null
  return (
    <div>
      <div style={S.fileLine}>
        <span style={{ fontSize: 20 }}>📄</span>
        <div>
          <div style={{ fontWeight: 500 }}>{msg.fileName}</div>
          {msg.fileSize != null && <div style={S.fileSize}>{fmtSize(msg.fileSize)}</div>}
        </div>
      </div>
      {transferring && pct !== null && (
        <div style={S.progWrap}>
          <div style={{ ...S.progBar, width: `${pct}%` }} />
          <span style={S.progPct}>{pct}%</span>
        </div>
      )}
      {canRespond && (
        <div style={S.actions}>
          <button
            style={S.acceptBtn}
            onClick={() =>
              msg.transferId &&
              window.transfer.respond({ transferId: msg.transferId, accept: true })
            }
          >
            接收
          </button>
          <button
            style={S.rejectBtn}
            onClick={() =>
              msg.transferId &&
              window.transfer.respond({ transferId: msg.transferId, accept: false })
            }
          >
            拒绝
          </button>
        </div>
      )}
      {canOpen && (
        <button style={S.openBtn} onClick={() => window.transfer.openFile(msg.id)}>
          打开
        </button>
      )}
    </div>
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

const purple = '#673ab7'
const S: Record<string, React.CSSProperties> = {
  app: { display: 'flex', height: '100vh', fontFamily: 'system-ui', color: '#222' },
  sidebar: { width: 240, borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box', overflowY: 'auto' },
  brand: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 18 },
  iconBtn: { border: 'none', background: 'none', fontSize: 18, cursor: 'pointer' },
  self: { fontSize: 12, color: '#888', margin: '6px 0 12px' },
  devHeader: { fontSize: 12, color: '#999', margin: '8px 0 4px' },
  hint: { color: '#aaa', fontSize: 13, padding: 8 },
  devItem: { padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4 },
  devItemActive: { background: 'rgba(103,58,183,0.12)' },
  devItemOffline: { opacity: 0.55 },
  devSub: { fontSize: 11, color: '#999' },
  dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  downloadsEntry: { padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 8, fontSize: 13, fontWeight: 500 },
  main: { flex: 1, display: 'flex', minWidth: 0 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#aaa' },
  chat: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  chatHeader: { padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
  offlineTag: { fontSize: 11, fontWeight: 400, color: '#999', border: '1px solid #ddd', borderRadius: 4, padding: '1px 6px' },
  stream: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' },
  streamDragging: { outline: `2px dashed ${purple}`, outlineOffset: -8, background: 'rgba(103,58,183,0.04)' },
  dropHint: { position: 'sticky', bottom: 8, alignSelf: 'center', background: purple, color: '#fff', padding: '6px 16px', borderRadius: 16, fontSize: 13, pointerEvents: 'none' },
  bubbleRow: { display: 'flex' },
  bubble: { maxWidth: '72%', padding: '8px 12px', borderRadius: 14 },
  bubbleOwn: { background: 'rgba(103,58,183,0.15)', borderBottomRightRadius: 4 },
  bubbleOther: { background: '#f1f3f5', borderBottomLeftRadius: 4 },
  text: { fontSize: 14, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  meta: { fontSize: 10, color: '#999', marginTop: 4 },
  fileLine: { display: 'flex', alignItems: 'center', gap: 8 },
  fileSize: { fontSize: 11, color: '#999' },
  progWrap: { position: 'relative', height: 14, background: 'rgba(0,0,0,0.08)', borderRadius: 7, marginTop: 8, overflow: 'hidden' },
  progBar: { position: 'absolute', left: 0, top: 0, bottom: 0, background: purple, borderRadius: 7, transition: 'width 0.1s linear' },
  progPct: { position: 'absolute', right: 6, top: 0, lineHeight: '14px', fontSize: 9, color: '#333' },
  dlRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderBottom: '1px solid #f0f0f0' },
  dlName: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dlMeta: { fontSize: 11, color: '#999', marginTop: 2 },
  actions: { display: 'flex', gap: 8, marginTop: 8 },
  acceptBtn: { padding: '4px 12px', border: 'none', borderRadius: 6, background: purple, color: '#fff', cursor: 'pointer' },
  rejectBtn: { padding: '4px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer' },
  openBtn: { marginTop: 8, padding: '4px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer' },
  inputBar: { display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #eee', alignItems: 'flex-end' },
  attachBtn: { border: 'none', background: 'none', fontSize: 20, cursor: 'pointer' },
  textarea: { flex: 1, border: '1px solid #ddd', borderRadius: 10, padding: '8px 12px', fontSize: 14, resize: 'none', fontFamily: 'inherit', maxHeight: 120 },
  sendBtn: { width: 38, height: 38, border: 'none', borderRadius: '50%', background: purple, color: '#fff', cursor: 'pointer', fontSize: 16 },
  modalMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: 12, padding: 24, width: 360 },
  settingRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 14 },
  numInput: { width: 80, padding: '4px 8px', border: '1px solid #ccc', borderRadius: 6 },
  btn: { padding: '6px 16px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer' },
  btnPrimary: { border: 'none', background: purple, color: '#fff' }
}
