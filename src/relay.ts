import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import type { CheckinConfigSection } from './config.ts';

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 桌宠自己记对话用的类型；`meta.kind === 'say'` 的就是冒出去的气泡 */
const SELF_TYPE = 'desktop-pet.self';
/** QQ 那边的消息事件；只用来认「最近跟谁私聊」，不转发它 */
const CHAT_TYPE = 'qq.message';
/** QQ world 的 source id；先按它查，查不到再全库翻 */
const QQ_SOURCE = 'qqbot';
/** 老配置里没有这个键时的兜底：SnowLuma / NapCat 的默认 HTTP 口 */
const DEFAULT_API = 'http://127.0.0.1:3000';
/** 一次最多读多少条事件（30 秒一跳，正常远少于这个数） */
const MAX_PER_PUMP = 200;
/** 攒着还没发出去的最多几条，超了丢最老的，免得网断了攒成山 */
const MAX_PENDING = 40;
const SEND_TIMEOUT_MS = 5_000;
/** 同一句话这么久之内不重复发（防止游标回退时补发一遍） */
const DEDUPE_MS = 10 * 60_000;
/** 攒了这么久还没发出去的就丢了，人也早回来了 */
const STALE_PENDING_MS = 6 * 3_600_000;
/** 「没找到发给谁」这类没法做事的原因，最多这么频繁地念一次 */
const WARN_EVERY_MS = 10 * 60_000;
/** 最近发过的几句话，只在内存与状态文件里，不落正文以外的内容 */
const RECENT_MAX = 12;

/** `【动作】` / `<表情>` 这类标记不进正文，抄过去也没意义 */
const MARK_RE = /【[^】]{0,40}】|<[^<>]{0,40}>/g;

interface Pending {
  text: string;
  at: number;
}

interface RelayState {
  /** 读到哪个游标了；null = 还没初始化（从「现在」开始，不补历史） */
  cursor: number | null;
  pending: Pending[];
  recent: Pending[];
  /** 上一次认到的私聊号；事件库里暂时翻不到时拿它顶上 */
  target?: string;
}

function emptyState(): RelayState {
  return { cursor: null, pending: [], recent: [] };
}

function loadState(file: string): RelayState {
  if (!existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RelayState>;
    return {
      cursor: typeof raw.cursor === 'number' ? raw.cursor : null,
      pending: Array.isArray(raw.pending) ? raw.pending.filter(isPending) : [],
      recent: Array.isArray(raw.recent) ? raw.recent.filter(isPending) : [],
      target: typeof raw.target === 'string' && raw.target ? raw.target : undefined,
    };
  } catch {
    // 状态文件坏了就当第一次跑：宁可漏掉几句，也不要一直发重复的
    return emptyState();
  }
}

function isPending(x: unknown): x is Pending {
  const p = x as Pending | null;
  return !!p && typeof p.text === 'string' && typeof p.at === 'number';
}

/** 只留下能当一句话发出去的东西。 */
function cleanText(raw: string): string {
  return raw
    .replace(MARK_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把桌宠冒出来的话抄一份到 QQ。
 *
 * 走的是本机 OneBot 的 HTTP 接口（SnowLuma / NapCat 都是这个形状），不开 WS：
 * 宿主那边的 qqbot 已经占着 WS，这里只借一条短连接 `send_private_msg`，两边互不影响。
 *
 * 读的是事件库而不是工具调用：`pet_say` 说完会往 `desktop-pet.self` 里记一条
 * `meta.kind === 'say'`，正文就是气泡里那句话。所以模型用别的写法绕开也照样抄得到。
 */
export class QqRelay {
  private state: RelayState;
  private lastWarnAt = 0;
  private lastWarn = '';

  constructor(
    private readonly file: string,
    private readonly warn: (message: string) => void,
  ) {
    this.state = loadState(file);
  }

  /** 两个开关任意一个开着才算「要抄」。 */
  static enabled(cfg: CheckinConfigSection): boolean {
    return cfg.relayAlways === true || cfg.relayAway === true;
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`checkin: 转 QQ 的游标没存下来：${msg(err)}`);
    }
  }

  /**
   * 一跳干完：读新事件 → 排队 → 逐条发。
   * `active` 是「这一跳该不该抄」（离开才转 / 全都转），关着的时候只把游标推到现在，
   * 这样下一趟打开不会把人在的时候说的话补发出去。
   */
  async pump(host: WorldHost, cfg: CheckinConfigSection, active: boolean, now: number): Promise<void> {
    const latest = host.store.latestCursor();

    if (!QqRelay.enabled(cfg)) {
      if (this.state.cursor !== null) {
        this.state.cursor = latest;
        this.state.pending = [];
        this.save();
      }
      return;
    }

    if (this.state.cursor === null) {
      // 第一次跑：从现在开始，不补历史
      this.state.cursor = latest;
      this.save();
      return;
    }

    if (!active) {
      // 不抄的时段：游标跟上，攒着的丢掉——人都回来了，气泡他也看见了
      if (this.state.cursor !== latest || this.state.pending.length) {
        this.state.cursor = latest;
        this.state.pending = [];
        this.save();
      }
      return;
    }

    const target = this.target(host, cfg);
    const api = String(cfg.relayApi || DEFAULT_API).trim();
    if (!api || !target) {
      this.note(!api ? '没有配 OneBot 地址' : '不知道发给谁（填个号，或者先跟我私聊一句）', now);
      return;
    }

    if (latest > this.state.cursor) {
      let events: EventEnvelope[];
      try {
        events = host.store.range({ fromCursor: this.state.cursor + 1, toCursor: latest, limit: MAX_PER_PUMP });
      } catch (err) {
        this.warn(`checkin: 读事件库失败，这一跳没抄：${msg(err)}`);
        return;
      }
      if (events.length >= MAX_PER_PUMP) {
        this.warn(`checkin: 攒了 ${events.length} 条事件（上限 ${MAX_PER_PUMP}），只抄了最后一段`);
      }
      for (const e of events) this.collect(e, now);
      this.state.cursor = latest;
      this.save();
    }

    await this.flush(api, String(cfg.relayToken ?? '').trim(), target, now);
  }

  /** 把一条事件里该抄的话收进队列。 */
  private collect(e: EventEnvelope, now: number): void {
    if (e.type !== SELF_TYPE) return;
    const meta = e.meta as { kind?: unknown } | undefined;
    if (meta?.kind !== 'say') return;
    const text = cleanText(typeof e.text === 'string' ? e.text : '');
    if (!text) return;
    // 同一句话刚发过、或者正排在队里，就不再收一遍（防游标回退 / 一次读完两条一样的）
    if (this.state.pending.some((p) => p.text === text)) return;
    if (this.state.recent.some((r) => r.text === text && now - r.at < DEDUPE_MS)) return;
    this.state.pending.push({ text, at: now });
    if (this.state.pending.length > MAX_PENDING) {
      const dropped = this.state.pending.splice(0, this.state.pending.length - MAX_PENDING);
      this.warn(`checkin: 转 QQ 的队列满了，丢了 ${dropped.length} 条旧的`);
    }
  }

  /** 逐条发；发不出去就留着下一跳再试（网断一会儿不至于把话吞了）。 */
  private async flush(api: string, token: string, target: string, now: number): Promise<void> {
    while (this.state.pending.length) {
      const head = this.state.pending[0]!;
      if (now - head.at > STALE_PENDING_MS) {
        this.state.pending.shift();
        this.warn('checkin: 转 QQ 的队列里有太旧的，丢了');
        this.save();
        continue;
      }
      try {
        await sendPrivate(api, token, target, head.text);
      } catch (err) {
        this.warn(`checkin: 转 QQ 没发出去，攒着下一跳再试：${msg(err)}`);
        break;
      }
      this.state.pending.shift();
      this.state.recent.push({ text: head.text, at: now });
      if (this.state.recent.length > RECENT_MAX) this.state.recent.splice(0, this.state.recent.length - RECENT_MAX);
      this.save();
    }
  }

  /** 配了号就用号；没配就用「最近一次跟我私聊」的那个号（认不到就拿上次认到的）。 */
  private target(host: WorldHost, cfg: CheckinConfigSection): string {
    const fixed = String(cfg.relayTarget ?? '').trim();
    if (fixed) return fixed;
    for (const query of [{ source: QQ_SOURCE, limit: 200 }, { limit: 200 }]) {
      try {
        const events = host.store.range(query);
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i]!;
          if (e.type !== CHAT_TYPE) continue;
          const conv = (e.meta as { conv?: unknown } | undefined)?.conv;
          if (typeof conv === 'string' && conv.startsWith('private:')) {
            const id = conv.slice('private:'.length);
            if (id !== this.state.target) {
              this.state.target = id;
              this.save();
            }
            return id;
          }
        }
      } catch {
        // 这个查法不行就换下一种
      }
    }
    return this.state.target ?? '';
  }

  /** 同样的原因不重复念：只在内容变了、或者过了十分钟再说一次。 */
  private note(reason: string, now: number): void {
    if (this.lastWarn === reason && now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarn = reason;
    this.lastWarnAt = now;
    this.warn(`checkin: 转 QQ 没做成，${reason}`);
  }
}

/** 一条 OneBot v11 `send_private_msg`。 */
async function sendPrivate(api: string, token: string, target: string, text: string): Promise<void> {
  const id = Number(target);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`「${target}」不像 QQ 号`);
  const url = `${api.replace(/\/+$/, '')}/send_private_msg`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: id, message: text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const raw = await res.text();
  let ok = res.ok;
  let detail = `HTTP ${res.status}`;
  try {
    const body = JSON.parse(raw) as { status?: unknown; retcode?: unknown };
    ok = ok && (body.status === 'ok' || body.retcode === 0);
    if (body.retcode !== undefined) detail += ` retcode=${String(body.retcode)}`;
  } catch {
    // 不是 JSON 就只报状态码
  }
  if (!ok) throw new Error(`${detail}: ${raw.slice(0, 120)}`);
}
