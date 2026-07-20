// @ts-check
// ============================================================
// 终端渲染协议字节清洗（terminal-clean）
//
// 把「headless Agent / CLI」在 TTY 里输出的终端控制字节（而非纯文本）
// 彻底剥离，避免把 TUI 协议噪声（opencode / codex / aider 的 OSC 1337
// 能力协商、OSC 99 通知、OSC 8 超链接、ANSI 颜色 / 光标 / 清屏 CSI 等）
// 喂给 AI 模型或泄漏到聊天气泡里。
//
// 暴露两个能力：
//   1. stripTerminalCodes(s)        —— 纯函数，清洗「完整」字符串（单 chunk 已确定完整）。
//   2. createStreamCleaner(opts)    —— 有状态流式清洗器，跨 chunk 边界缓存「未完成的
//                                      转义序列」前缀，直到收到终止符再吐出，解决
//                                      PTY onData / poll delta 把序列切成两片导致的残留。
// ============================================================
'use strict';

// 完整可移除序列（全局、贪婪匹配已终止的序列）：
//   - OSC：以 \x1b] 开头，到 BEL(\x07) 或 ST(\x1b\\) 结束
//   - CSI 及 C1 短序列：\x1b[@-Z\-_] 或 \x1b[...最终字节]
//   - 残余裸 ESC
function stripTerminalCodes(s) {
  if (!s) return s;
  return s
    .replace(/\x1B\][^\x07\x1B]*?(?:\x07|\x1B\\)/g, '') // OSC（超链接 / 1337 能力协商 / 通知）
    .replace(/\x1B(?:[@-Z\\^_]|\[[0-?]*[ -/]*[@-~])/g, '') // CSI 及 C1 短序列（排除 [ ] 这两个引入符）
    .replace(/\x1B/g, ''); // 残余裸 ESC
}

// 判断以 `rest` 开头的转义序列「是否已经完整」（即全局正则能在此处匹配到一个
// 已终止的完整序列）。用于流式清洗器判断尾部是否需要缓存。
function isCompleteEscapePrefix(rest) {
  if (!rest || rest[0] !== '\x1b') return false;
  return (
    /^\x1B\][^\x07\x1B]*?(?:\x07|\x1B\\)/.test(rest) || // 已终止的 OSC
    /^\x1B(?:[@-Z\\^_]|\[[0-?]*[ -/]*[@-~])/.test(rest) // 已终止的 CSI / C1 短序列
  );
}

/**
 * 创建有状态流式清洗器。
 *
 * 终端转义序列可能恰好被 chunk 边界切开（例如 PTY 一次 onData 只给了一半的
 * OSC 1337，下一半在下一回调里）。若对每个 chunk 单独用 stripTerminalCodes，
 * 前半片因缺少终止符而无法匹配，会作为「裸 ESC + 参数」残留在输出里 —— 这正是
 * 之前 opencode 污染泄漏的根因之一。
 *
 * 本清洗器在遇到「末尾是不完整的转义前缀」时，把该前缀缓存到下一次 feed，
 * 直至序列真正补全（收到终止符）再一次性清洗吐出；已完整的部分则立即吐出。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxCarry=1024] 缓存上限（字节）。超过则视为损坏输出，
 *                                       强制丢弃缓存（安全阀，防止孤 ESC 永久挂起）。
 * @returns {(chunk: string) => string}
 */
function createStreamCleaner(opts = {}) {
  const maxCarry = typeof opts.maxCarry === 'number' ? opts.maxCarry : 1024;
  let carry = ''; // 上一 chunk 残留的、尚未补全的转义前缀

  return function feed(chunk) {
    if (!chunk) return '';
    let s = carry + chunk;
    carry = '';
    if (!s) return '';

    // 找到最后一个 ESC：若它开启的序列在本字符串内仍未终止，则把从该 ESC
    // 起到末尾的整段缓存，只清洗它之前已确定的片段。
    // （已终止的序列会被 stripTerminalCodes 在下面正常清掉；若最后一个 ESC
    //  本身就是完整序列，则整串一起清洗。这覆盖了「单序列跨 chunk 切分」的
    //  现实场景 —— 终端总是原子式发出完整序列，跨边界的只有末尾那一个。）
    const lastEsc = s.lastIndexOf('\x1b');
    if (lastEsc !== -1 && !isCompleteEscapePrefix(s.slice(lastEsc))) {
      carry = s.slice(lastEsc);
      if (carry.length > maxCarry) {
        // 安全阀：缓存过长（极可能是乱码孤 ESC），丢弃并强制吐出前面的内容
        const flushed = stripTerminalCodes(s.slice(0, lastEsc));
        carry = '';
        return flushed;
      }
      return stripTerminalCodes(s.slice(0, lastEsc));
    }

    return stripTerminalCodes(s);
  };
}

module.exports = { stripTerminalCodes, isCompleteEscapePrefix, createStreamCleaner };
