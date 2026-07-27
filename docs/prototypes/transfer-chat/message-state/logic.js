// 纯逻辑模块:接收文件消息状态机(逆向自 chat-service 现行为)。
// 零 I/O、零 DOM;驾驶面板单向依赖本模块。验证通过后可整体提升进真代码(此处为逆向示范,真身已在产线)。
// JSDoc 保留类型(可被 TS 检查);file:// 下 ES module import 受 CORS 限制,故挂 window。

/** @typedef {'pending'|'accepted'|'done'|'failed'|'rejected'|'expired'} Status */
/** @typedef {'enospc'|'network'} FailReason */
/**
 * @typedef {Object} MsgState
 * @property {Status} status
 * @property {boolean} autoAccepted
 * @property {number} received
 * @property {number} total
 * @property {string|null} filePath
 * @property {FailReason|null} errorReason
 * @property {string|null} illegal 上一个被拒绝的非法事件(现实中静默忽略;原型里外显,供驾驶者看见"歪路被挡")
 */
/**
 * @typedef {{type:'userAccept'}|{type:'userReject'}|{type:'acceptTimeout'}|{type:'restartRecover'}
 *   |{type:'progress',bytes:number}|{type:'fileDone'}|{type:'fileFail',reason:FailReason}} Action
 */

/** @type {ReadonlySet<Status>} */
const TERMINAL = new Set(['done', 'failed', 'rejected', 'expired']);

/**
 * @param {boolean} auto 自动接收是否命中
 * @param {number} total 文件总字节
 * @returns {MsgState}
 */
function initial(auto, total) {
  return {
    status: auto ? 'accepted' : 'pending',
    autoAccepted: auto,
    received: 0,
    total,
    filePath: null,
    errorReason: null,
    illegal: null
  };
}

/**
 * @param {MsgState} s
 * @param {Action} a
 * @returns {MsgState}
 */
function reduce(s, a) {
  /** @param {string} why @returns {MsgState} */
  const deny = (why) => ({ ...s, illegal: `${a.type} 被忽略:${why}` });
  /** @param {Partial<MsgState>} patch @returns {MsgState} */
  const ok = (patch) => ({ ...s, illegal: null, ...patch });

  if (TERMINAL.has(s.status)) return deny('已是终态,现实中该事件被静默忽略');

  switch (a.type) {
    case 'userAccept':
      return s.status === 'pending' ? ok({ status: 'accepted' }) : deny('仅 pending 可接收(重复点击被忽略)');
    case 'userReject':
      return s.status === 'pending' ? ok({ status: 'rejected' }) : deny('仅 pending 可拒绝');
    case 'acceptTimeout':
      return s.status === 'pending' ? ok({ status: 'expired' }) : deny('确认定时器只存在于 pending 期');
    case 'restartRecover':
      return s.status === 'pending' ? ok({ status: 'expired' }) : deny('重启恢复只清 pending');
    case 'progress':
      return s.status === 'accepted'
        ? ok({ received: Math.min(s.total, s.received + a.bytes) })
        : deny('仅 accepted 期间存在传输进度');
    case 'fileDone':
      return s.status === 'accepted'
        ? ok({ status: 'done', received: s.total, filePath: '~/Downloads/示例文件.bin' })
        : deny('仅 accepted 可落盘完成');
    case 'fileFail':
      return s.status === 'accepted'
        ? ok({ status: 'failed', errorReason: a.reason })
        : deny('仅 accepted 期间会落盘失败');
    default:
      return deny('未知事件');
  }
}

/**
 * 每种事件的代表样例(仅用于可达性查询;参数不影响合法性判断)。
 * @type {Action[]}
 */
const ALL_ACTIONS = [
  { type: 'userAccept' },
  { type: 'userReject' },
  { type: 'acceptTimeout' },
  { type: 'restartRecover' },
  { type: 'progress', bytes: 0 },
  { type: 'fileDone' },
  { type: 'fileFail', reason: 'enospc' }
];

/**
 * 准入条件查询:当前状态下哪些事件合法,非法者附原因。
 * **不重写规则**——对每个事件试跑 reduce,被 deny(illegal 非空)即非法。
 * 规则永远只有 reduce 一处,本函数是它的派生查询,两者不可能不一致。
 * @param {MsgState|null} s null = 空态(无消息在驾驶):一切事件非法,唯一出路是新消息
 * @returns {Record<string,{legal:boolean, why:string|null}>} 以 action.type 为键
 */
function legal(s) {
  /** @type {Record<string,{legal:boolean, why:string|null}>} */
  const out = {};
  for (const a of ALL_ACTIONS) {
    if (s === null) {
      out[a.type] = { legal: false, why: '空态:还没有消息,先「新消息」入场' };
      continue;
    }
    const next = reduce(s, a);
    out[a.type] = next.illegal
      ? { legal: false, why: next.illegal.replace(/^\S+ 被忽略:/, '') }
      : { legal: true, why: null };
  }
  return out;
}

window.StateMachine = { initial, reduce, legal, ALL_ACTIONS, TERMINAL };
