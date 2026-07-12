import { useEffect, useState, useRef, useCallback } from 'react'
import type { RemoteDevice } from '@shared/types'
import type { IdentityInfo, UiMessage, AutoAcceptSettings } from '@shared/ipc'

export function App(): JSX.Element {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [peer, setPeer] = useState<string | null>(null) // 选中对端 fingerprint
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [auto, setAuto] = useState<AutoAcceptSettings>({ enabled: false, maxBytes: 100 * 1024 * 1024 })

  // 初始化
  useEffect(() => {
    window.transfer.getIdentity().then(setIdentity)
    window.transfer.listDevices().then(setDevices)
    window.transfer.listMessages().then(setMessages)
    window.transfer.getAutoAccept().then(setAuto)

    const unsubs = [
      window.transfer.onDevicesUpdated((d) => setDevices(d)),
      window.transfer.onMessageUpserted((m) =>
        setMessages((prev) => {
          const i = prev.findIndex((x) => x.id === m.id)
          if (i >= 0) {
            const next = prev.slice()
            next[i] = m
            return next
          }
          return [...prev, m].sort((a, b) => a.createdAt - b.createdAt)
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
        onPick={setPeer}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div style={S.main}>
        {peer ? (
          <Chat peer={peer} peerAlias={peerAliasOf(devices, peer)} messages={peerMessages} />
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
  onPick: (fp: string) => void
  onOpenSettings: () => void
}): JSX.Element {
  const { identity, devices, peer, onPick, onOpenSettings } = props
  return (
    <div style={S.sidebar}>
      <div style={S.brand}>
        <strong>Transfer</strong>
        <button onClick={onOpenSettings} title="设置" style={S.iconBtn}>
          ⚙
        </button>
      </div>
      {identity && <div style={S.self}>本机:{identity.alias}</div>}
      <div style={S.devHeader}>附近设备</div>
      {devices.length === 0 && <div style={S.hint}>正在搜索…</div>}
      {devices.map((d) => (
        <div
          key={d.info.fingerprint}
          onClick={() => onPick(d.info.fingerprint)}
          style={{
            ...S.devItem,
            ...(peer === d.info.fingerprint ? S.devItemActive : {})
          }}
        >
          <div style={{ fontWeight: 500 }}>{d.info.alias}</div>
          <div style={S.devSub}>
            {d.info.deviceModel} · {d.address}
          </div>
        </div>
      ))}
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
  messages: UiMessage[]
}): JSX.Element {
  const { peer, peerAlias, messages } = props
  const [text, setText] = useState('')
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

  const pickAndSend = useCallback(async () => {
    const files = await window.transfer.pickFiles()
    if (files.length) await window.transfer.sendFiles({ peerFp: peer, filePaths: files })
  }, [peer])

  return (
    <div style={S.chat}>
      <div style={S.chatHeader}>{peerAlias}</div>
      <div ref={scrollRef} style={S.stream}>
        {messages.length === 0 && <div style={S.hint}>还没有消息。发一条试试 👇</div>}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
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

function Bubble({ msg }: { msg: UiMessage }): JSX.Element {
  const own = msg.direction === 'sent'
  return (
    <div style={{ ...S.bubbleRow, justifyContent: own ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubble, ...(own ? S.bubbleOwn : S.bubbleOther) }}>
        {msg.type === 'text' ? (
          <div style={S.text}>{msg.content}</div>
        ) : (
          <FileBubble msg={msg} />
        )}
        <div style={S.meta}>
          {statusLabel(msg)} · {fmtTime(msg.createdAt)}
        </div>
      </div>
    </div>
  )
}

function FileBubble({ msg }: { msg: UiMessage }): JSX.Element {
  const canRespond = msg.direction === 'recv' && msg.status === 'pending'
  const canOpen = msg.status === 'done' && msg.filePath
  return (
    <div>
      <div style={S.fileLine}>
        <span style={{ fontSize: 20 }}>📄</span>
        <div>
          <div style={{ fontWeight: 500 }}>{msg.fileName}</div>
          {msg.fileSize != null && <div style={S.fileSize}>{fmtSize(msg.fileSize)}</div>}
        </div>
      </div>
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
  devSub: { fontSize: 11, color: '#999' },
  main: { flex: 1, display: 'flex', minWidth: 0 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#aaa' },
  chat: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  chatHeader: { padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600 },
  stream: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  bubbleRow: { display: 'flex' },
  bubble: { maxWidth: '72%', padding: '8px 12px', borderRadius: 14 },
  bubbleOwn: { background: 'rgba(103,58,183,0.15)', borderBottomRightRadius: 4 },
  bubbleOther: { background: '#f1f3f5', borderBottomLeftRadius: 4 },
  text: { fontSize: 14, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  meta: { fontSize: 10, color: '#999', marginTop: 4 },
  fileLine: { display: 'flex', alignItems: 'center', gap: 8 },
  fileSize: { fontSize: 11, color: '#999' },
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
