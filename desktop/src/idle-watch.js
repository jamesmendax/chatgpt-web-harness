"use strict";
// 工具调用空档提醒：某个 ChatGPT 对话开始调用工具后，静默满设定时间就提醒一次。
// 只读 MCP 的 tools/call 行（进程 stdout 与 Admin 活动源两种格式）。对话由服务端写入的
// conv= 区分（来自 ChatGPT 的 openai/session）；没有 conv= 的调用按整个账户计时。
// 账户之间、对话之间各自计时：别的账户或别的对话还在调用，不会重置这一个的空档。
// 运行超过 1 分钟的调用每分钟报告一次 [running]，同样算作活动，长命令不会被误报。

const IDLE_REMINDER_CHOICES = Object.freeze([0, 5, 10, 15]);
const DEFAULT_MINUTES = 5;
// 启动或端口变化后活动源会回放最近的历史；更早的行不能开启一个新的空档。
const REPLAY_GRACE_MS = 2 * 60 * 1000;
const FORGET_AFTER_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERY_RETRY_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

const LINE = /^(\d{2}):(\d{2}):(\d{2}) [! ] +(\S.*)$/;
// stdout:  [MCP] [ok] tools/call read_text_file — a.txt 12ms session=… conv=…   (conv 永远在行尾)
//          [MCP ERROR] HTTP 400 tools/call write_file — denied 3ms session=… conv=…
const STDOUT_CALL = /^\[MCP(?: ERROR)?\](?: HTTP \d+)?(?: \[[\w-]+\])? tools\/call ([\w.-]+)(.*)$/;
// Admin 活动源: [mcp] tools/call read_text_file ok 12ms client=chatgpt session=… conv=… — a.txt
const FEED_CALL = /^\[(?:mcp|tool)\] tools\/call ([\w.-]+)(.*)$/;

function reminderMinutes(cfg) {
  const minutes = Number(cfg && cfg.idleReminderMinutes);
  return IDLE_REMINDER_CHOICES.includes(minutes) ? minutes : DEFAULT_MINUTES;
}

function clockTime(hours, minutes, seconds, now) {
  const date = new Date(now);
  date.setHours(hours % 24, minutes, seconds, 0);
  const at = date.getTime();
  return at > now + 60_000 ? at - DAY_MS : at; // a line stamped just before midnight
}

function parseCall(line, now) {
  const stamped = LINE.exec(line);
  if (!stamped) return null;
  const text = stamped[4];
  let tool, conversation, summary;
  const out = STDOUT_CALL.exec(text) || /^\[TOOL\] \[(?:running|ok|error|blocked|failed|failure)\] ([\w.-]+)(?=.* \d+ms call=\S+)(.*)$/.exec(text);
  if (out) {
    tool = out[1];
    conversation = (/ conv=([0-9a-f]{8})$/.exec(out[2]) || [])[1];
    const rest = out[2].replace(/(?: \d+ms)?(?: call=\S+)?(?: session=\S+)?(?: conv=[0-9a-f]{8})?$/, "");
    summary = rest.startsWith(" — ") ? rest.slice(3) : "";
  } else {
    const feed = FEED_CALL.exec(text);
    if (!feed) return null;
    tool = feed[1];
    const cut = feed[2].indexOf(" — ");
    const head = cut < 0 ? feed[2] : feed[2].slice(0, cut);
    conversation = (/(?:^| )conv=([0-9a-f]{8})(?= |$)/.exec(head) || [])[1];
    summary = cut < 0 ? "" : feed[2].slice(cut + 3);
  }
  return {
    at: clockTime(Number(stamped[1]), Number(stamped[2]), Number(stamped[3]), now),
    tool,
    conversation: conversation || null,
    summary: summary.length > 60 ? `${summary.slice(0, 59)}…` : summary,
  };
}

class IdleWatch {
  /**
   * @param {{ minutesFor: (accountId: string) => number, onRemind?: (reminder: object) => void, now?: () => number }} options
   *   minutesFor 返回该账户的提醒间隔（0 = 关闭）；抛错表示账户已不存在。
   */
  constructor({ minutesFor, onRemind, now = Date.now }) {
    this.minutesFor = minutesFor;
    this.onRemind = onRemind;
    this.now = now;
    this.accounts = new Map(); // accountId -> Map(conversation | "" -> bucket)
    this.identities = new Map(); // accountId -> (8hex => { id: full anonymous ID | null, lastAt })
    this.stoppedAt = new Map(); // accountId -> time of the last deliberate stop
  }

  /** 记录一行日志；返回它是否被计入某个对话的计时。 */
  observe(accountId, source, line) {
    if (!accountId || source !== "mcp" || typeof line !== "string") return false;
    const now = this.now();
    const call = parseCall(line, now);
    if (!call || now - call.at > REPLAY_GRACE_MS) return false;
    // 停止之后，活动源还可能送来停止前那次调用的一行；它不能重新开启空档。
    if (call.at <= (this.stoppedAt.get(accountId) ?? -Infinity)) return false;
    let buckets = this.accounts.get(accountId);
    if (!buckets) this.accounts.set(accountId, (buckets = new Map()));
    let key = call.conversation || "";
    if (key) {
      const linked = this.identities.get(accountId)?.get(key);
      if (linked?.id === null) return false; // collision: wait for a full verified identity
      if (linked?.id) key = linked.id;
    }
    const known = buckets.get(key);
    // 托管 MCP 的同一次调用会从 stdout 和活动源各到一行；较早的那行不能把时间往回拨。
    if (known && known.lastAt >= call.at) return true;
    buckets.set(key, { conversation: key.startsWith("oai_conv_") ? key : call.conversation, lastAt: call.at, tool: call.tool, summary: call.summary, reminded: false });
    return true;
  }

  /** Structured authenticated activity from the local Admin API; never a short prefix. */
  observeIdentity(accountId, { conversationId, at, tool } = {}) {
    if (!accountId || !/^oai_conv_[a-f0-9]{32}$/.test(conversationId || "") ||
        !Number.isFinite(at) || typeof tool !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(tool)) return false;
    const now = this.now();
    if (now-at > REPLAY_GRACE_MS || at > now+60_000 || at <= (this.stoppedAt.get(accountId) ?? -Infinity)) return false;
    const short = conversationId.slice(9,17);
    let identities=this.identities.get(accountId);
    if (!identities) this.identities.set(accountId,(identities=new Map()));
    const old=identities.get(short);
    identities.set(short,{id:!old||old.id===conversationId?conversationId:null,lastAt:at});
    let buckets=this.accounts.get(accountId);
    if (!buckets) this.accounts.set(accountId,(buckets=new Map()));
    // A short log observation is only a temporary unverified bucket.
    // The full authenticated event supersedes it, never merging aliases.
    buckets.delete(short);
    const known=buckets.get(conversationId);
    if (known && known.lastAt >= at) return true;
    buckets.set(conversationId,{conversation:conversationId,lastAt:at,tool,summary:"",reminded:false});
    return true;
  }

  /** 到点的空档各提醒一次；返回本轮发出的提醒。 */
  tick(now = this.now()) {
    const fired = [];
    for (const [accountId, buckets] of this.accounts) {
      let minutes;
      try { minutes = this.minutesFor(accountId); }
      catch { this.accounts.delete(accountId); continue; }
      for (const [key, bucket] of buckets) {
        const idle = now - bucket.lastAt;
        if (idle > FORGET_AFTER_MS) { buckets.delete(key); continue; }
        if (!minutes || bucket.reminded || bucket.pending || idle < minutes * 60_000 ||
          (bucket.attempts || 0) >= MAX_DELIVERY_ATTEMPTS || now < (bucket.retryAt || 0)) continue;
        bucket.pending = true;
        bucket.attempts = (bucket.attempts || 0) + 1;
        const reminder = {
          accountId,
          conversation: bucket.conversation,
          tool: bucket.tool,
          summary: bucket.summary,
          lastAt: bucket.lastAt,
          idleMinutes: Math.floor(idle / 60_000),
        };
        fired.push(reminder);
        const settle = delivered => {
          // A newer call or deliberate stop owns its own state. An older
          // Windows callback must not consume or resurrect that later gap.
          if (this.accounts.get(accountId)?.get(key) !== bucket) return;
          bucket.pending = false;
          if (delivered !== false) bucket.reminded = true;
          else bucket.retryAt = this.now() + DELIVERY_RETRY_MS;
        };
        try {
          const result = this.onRemind?.(reminder, { attempt: bucket.attempts });
          if (result && typeof result.then === "function") Promise.resolve(result).then(settle, () => settle(false));
          else settle(result);
        } catch { settle(false); }
      }
      if (!buckets.size) this.accounts.delete(accountId);
    }
    for (const [id,mappings] of this.identities) {
      for (const [prefix,item] of mappings) if (now-item.lastAt>FORGET_AFTER_MS) mappings.delete(prefix);
      if (!mappings.size) this.identities.delete(id);
    }
    return fired;
  }

  /** 用户主动停止服务后，这个账户此前的空档不再提醒。 */
  forget(accountId) {
    this.accounts.delete(accountId);
    this.identities.delete(accountId);
    this.stoppedAt.set(accountId, this.now());
  }
}

module.exports = { IdleWatch, IDLE_REMINDER_CHOICES, reminderMinutes, parseCall };
