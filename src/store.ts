import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ThreadStatus = 'pending' | 'done' | 'dropped';

/** 一条「以后要问的事」。 */
export interface Thread {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** 已经提醒过这一次的时刻；有值就不再重复提醒 */
  askedAt?: number;
  status: ThreadStatus;
}

/** 搭话（副通道）的账本：今天说了几条、上次是什么时候、被无视过几次。 */
export interface SoftStats {
  day: string;
  count: number;
  lastAt: number;
  ignored: number;
  /** 今天每次搭话的时刻，用来算「每小时最多几条」 */
  at: number[];
}

interface State {
  version: 1;
  threads: Thread[];
  soft: SoftStats;
}

const EMPTY: State = {
  version: 1,
  threads: [],
  soft: { day: '', count: 0, lastAt: 0, ignored: 0, at: [] },
};

/** 太久以前结掉的事留个短尾巴就够了，别让文件一直长。 */
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_THREADS = 200;
/** 「每小时几条」只需要最近几小时的记录 */
const MAX_SOFT_AT = 64;

export class ThreadStore {
  private readonly file: string;
  private state: State;

  constructor(file: string) {
    this.file = file;
    this.state = load(file);
  }

  pending(): Thread[] {
    return this.state.threads
      .filter((t) => t.status === 'pending')
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 到点、还没提醒过的。 */
  due(now: number): Thread[] {
    return this.pending().filter((t) => !t.askedAt && t.dueAt <= now);
  }

  add(text: string, dueAt: number): Thread {
    const th: Thread = {
      id: randomUUID(),
      text,
      dueAt,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.state.threads.push(th);
    this.prune();
    this.save();
    return th;
  }

  markAsked(id: string, at: number): boolean {
    const th = this.state.threads.find((t) => t.id === id);
    if (!th || th.status !== 'pending' || th.askedAt) return false;
    th.askedAt = at;
    this.save();
    return true;
  }

  /** 按 id（支持写前几位）或按原文找一条还挂着的。 */
  find(sel: { id?: string; text?: string }): Thread | null {
    const open = this.pending();
    const id = typeof sel.id === 'string' ? sel.id.trim().replace(/^#/, '') : '';
    if (id) {
      const hit = open.find((t) => t.id === id) ?? open.find((t) => t.id.startsWith(id));
      if (hit) return hit;
    }
    const needle = typeof sel.text === 'string' ? sel.text.trim() : '';
    if (needle) {
      const hit = open.find((t) => t.text.includes(needle));
      if (hit) return hit;
    }
    return null;
  }

  close(id: string, status: 'done' | 'dropped'): Thread | null {
    const th = this.state.threads.find((t) => t.id === id);
    if (!th) return null;
    th.status = status;
    this.prune();
    this.save();
    return th;
  }

  /**
   * 自动回收过期的跟进：已经提醒过一次、却一直没结果的最多再留 `askedMs`；
   * 从来没轮到问的（比如安静时段一直跨过去）留 `unaskedMs`，免得一直挂在列表里。
   * 回收的记为 `dropped`，不是 `done`——它没被处理，只是没意义了。
   */
  sweep(now: number, askedMs: number, unaskedMs: number): Thread[] {
    const gone: Thread[] = [];
    for (const t of this.state.threads) {
      if (t.status !== 'pending') continue;
      const base = t.askedAt ?? t.dueAt;
      const ttl = t.askedAt ? askedMs : unaskedMs;
      if (now - base > ttl) {
        t.status = 'dropped';
        gone.push(t);
      }
    }
    if (gone.length) {
      this.prune();
      this.save();
    }
    return gone;
  }

  soft(): SoftStats {
    return this.state.soft;
  }

  /** 换日就把今天说的条数清零（上次时刻和退避要留着）。 */
  rollDay(day: string): void {
    if (this.state.soft.day === day) return;
    this.state.soft = { day, count: 0, lastAt: this.state.soft.lastAt, ignored: this.state.soft.ignored, at: [] };
    this.save();
  }

  /** 最近 windowMs 里搭过几条（今天的账）。 */
  countSince(now: number, windowMs: number): number {
    const from = now - windowMs;
    return this.state.soft.at.filter((t) => t > from).length;
  }

  markSoft(day: string, at: number, ignored: number): void {
    const s = this.state.soft;
    const today = s.day === day;
    s.count = today ? s.count + 1 : 1;
    s.day = day;
    s.lastAt = at;
    s.ignored = Math.max(0, ignored);
    const keep = today ? s.at : [];
    s.at = [...keep, at].slice(-MAX_SOFT_AT);
    this.save();
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // 落盘失败不该把 World 带崩；内存里的记录继续用
    }
  }

  private prune(): void {
    const now = Date.now();
    this.state.threads = this.state.threads
      .filter((t) => t.status === 'pending' || t.createdAt > now - KEEP_MS)
      .slice(-MAX_THREADS);
  }
}

function load(file: string): State {
  try {
    if (!existsSync(file)) return structuredClone(EMPTY);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
    const threads = Array.isArray(raw.threads)
      ? raw.threads
          .filter((t): t is Thread => !!t && typeof t === 'object' && typeof (t as Thread).id === 'string')
          .map((t) => ({
            id: t.id,
            text: typeof t.text === 'string' ? t.text : '',
            dueAt: Number.isFinite(t.dueAt) ? t.dueAt : Date.now(),
            createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
            askedAt: Number.isFinite(t.askedAt) ? t.askedAt : undefined,
            status: t.status === 'done' || t.status === 'dropped' ? t.status : 'pending',
          }))
      : [];
    const soft = raw.soft && typeof raw.soft === 'object' ? raw.soft : EMPTY.soft;
    return {
      version: 1,
      threads,
      soft: {
        day: typeof soft.day === 'string' ? soft.day : '',
        count: Number.isFinite(soft.count) ? soft.count : 0,
        lastAt: Number.isFinite(soft.lastAt) ? soft.lastAt : 0,
        ignored: Number.isFinite(soft.ignored) ? soft.ignored : 0,
        at: Array.isArray(soft.at)
          ? soft.at.filter((t): t is number => Number.isFinite(t)).slice(-MAX_SOFT_AT)
          : [],
      },
    };
  } catch {
    return structuredClone(EMPTY);
  }
}
