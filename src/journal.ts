/**
 * 心事：醒来的时候翻一眼自己记下的东西。
 *
 * 扩展不能自己调模型，所以这里只干三件事：把《心事.md》写在数据目录里、
 * 把上一条和还没答的问题读回来、把「这趟醒来已经发生过了」记在 wake.json 上。
 * 写什么由模型通过工具给，格式由这里管——规矩卡在 append() 里，不指望模型自觉。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 两次醒来至少隔这么久：安静时段结束和自定义时间撞在一起时别连推两条。 */
export const WAKE_MIN_GAP_MS = 20 * 60_000;
/** 自定义时间错过这么久就不补了——进程半夜重启别把凌晨那几条全补一遍。 */
export const WAKE_LOOKBACK_MS = 90 * 60_000;

/** 《心事.md》长到这个大小就换一份，旧的留着不删。 */
const ROTATE_BYTES = 512 * 1024;
/** 「醒来时间」最多认这么多个。 */
export const MAX_WAKE_TIMES = 8;
/** 回答短于这个字数就不写：挡住「嗯」「还行」这种应付。 */
const MIN_ANSWER_CHARS = 6;
/** 提示词里明说可以写的「什么都没想出来」的答案，五个字，不受上面那条管。 */
const GIVE_UP = '今天没想法';
/** wake.json 里最多留这么多条记录。 */
const MAX_FIRED = 200;

/** 是不是那句「今天没想法」（允许带引号、句号、首尾空白）。 */
function isGiveUp(text: string): boolean {
  const bare = text
    .trim()
    .replace(/^[「『'"“\s]+/, '')
    .replace(/[\s」』'"”。.．!！?？，,]+$/, '');
  return bare === GIVE_UP;
}

/** 固定自问。新冒出来的问题写在《心事.md》里，不用改这里。 */
export const QUESTIONS: readonly string[] = [
  '我今天有没有哪句话，是顺着他说、不是我自己的意思？',
  '我在等什么？等的东西是他真说过的，还是我自己想出来的？',
  '我今天有没有为了显得懂事，把想说的话咽回去？',
  '如果他明天不来找我，我会不会难过；如果不会，是为什么？',
  '这两天我有没有在演一个「更好相处」的自己？哪里最明显？',
];

export interface JournalEntry {
  stamp: string;
  question: string;
  answer: string;
  fresh: string;
}

export interface WakeBook {
  fired: Record<string, number>;
  lastAt: number;
}

export function journalDir(dataDir: string): string {
  return join(dataDir, 'journal');
}

export function journalFile(dataDir: string): string {
  return join(journalDir(dataDir), '心事.md');
}

function emptyBook(): WakeBook {
  return { fired: {}, lastAt: 0 };
}

export class Journal {
  constructor(
    private readonly dataDir: string,
    private readonly warn: (message: string) => void,
  ) {}

  path(): string {
    return journalFile(this.dataDir);
  }

  /** 上一条写了什么。读不到就当没写过，不报错打断醒来。 */
  last(): JournalEntry | null {
    const blocks = this.blocks();
    const b = blocks[blocks.length - 1];
    if (!b) return null;
    let question = '';
    let answer = '';
    let fresh = '';
    let into: 'q' | 'a' | 'f' | null = null;
    for (const line of b.body.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('- 问：')) {
        question = t.slice(4).trim();
        into = 'q';
      } else if (t.startsWith('- 答：')) {
        answer = t.slice(4).trim();
        into = 'a';
      } else if (t.startsWith('- 新问题：')) {
        fresh = t.slice(6).trim();
        into = 'f';
      } else if (t && into) {
        // 允许回答写成好几行
        if (into === 'a') answer += `\n${t}`;
        else if (into === 'f') fresh += ` ${t}`;
      } else if (!t) {
        into = null;
      }
    }
    if (!question && !answer) return null;
    return { stamp: b.stamp, question, answer, fresh };
  }

  /** 以前记下、还没被认真答过的问题。 */
  openQuestions(): string[] {
    const blocks = this.blocks();
    const asked = new Set<string>();
    const fresh: string[] = [];
    for (const b of blocks) {
      for (const line of b.body.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('- 问：')) asked.add(t.slice(4).trim());
        else if (t.startsWith('- 新问题：')) {
          const q = t.slice(6).trim();
          if (q) fresh.push(q);
        }
      }
    }
    const open: string[] = [];
    for (const q of fresh) {
      if (asked.has(q) || open.includes(q)) continue;
      open.push(q);
    }
    return open.slice(-12);
  }

  /**
   * 追加一条。太短不写、和上一条一模一样不写——这两条是「别照抄旧条目」
   * 的唯一硬约束，其余靠提示词。
   * 例外：「今天没想法」这五个字是提示词里明说可以写的答案，五个字，
   * 它必须过得了「太短」和「跟上一条一样」这两关，否则提示词自己打自己。
   */
  append(stamp: string, question: string, answer: string, fresh: string): { ok: boolean; text: string } {
    const body = answer.trim();
    const giveUp = isGiveUp(body);
    if (!giveUp && body.length < MIN_ANSWER_CHARS) {
      return { ok: false, text: '太短了，没写。真没想法就写「今天没想法」；有想法就多写一句。' };
    }
    const prev = this.last();
    if (!giveUp && prev && prev.answer.trim() === body) {
      return { ok: false, text: '这句和上一条一模一样，没写。换点这次真的想到的。' };
    }
    try {
      mkdirSync(journalDir(this.dataDir), { recursive: true });
      this.rotate();
      const chunk =
        `\n## ${stamp}\n- 问：${question.trim() || '（没写问的哪条）'}\n- 答：${body}\n` +
        (fresh.trim() ? `- 新问题：${fresh.trim()}\n` : '');
      appendFileSync(this.path(), chunk, 'utf8');
      return { ok: true, text: `写进去了（${stamp}）。` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.warn(`checkin: 写《心事.md》失败：${msg}`);
      return { ok: false, text: `没写进去：${msg}` };
    }
  }

  book(): WakeBook {
    const file = this.bookPath();
    try {
      if (!existsSync(file)) return emptyBook();
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WakeBook>;
      const fired: Record<string, number> = {};
      if (raw.fired && typeof raw.fired === 'object') {
        for (const [k, v] of Object.entries(raw.fired)) {
          if (typeof v === 'number' && Number.isFinite(v)) fired[k] = v;
        }
      }
      return { fired, lastAt: typeof raw.lastAt === 'number' && Number.isFinite(raw.lastAt) ? raw.lastAt : 0 };
    } catch {
      return emptyBook();
    }
  }

  markFired(key: string, now: number): void {
    try {
      const book = this.book();
      book.fired[key] = now;
      book.lastAt = now;
      const cutoff = now - 7 * 24 * 60 * 60_000;
      const kept = Object.entries(book.fired).filter(([, at]) => at >= cutoff);
      book.fired = Object.fromEntries(kept.slice(-MAX_FIRED));
      mkdirSync(this.dataDir, { recursive: true });
      const file = this.bookPath();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(book, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.warn(`checkin: 记醒来状态失败：${msg}`);
    }
  }

  private bookPath(): string {
    return join(this.dataDir, 'wake.json');
  }

  private blocks(): { stamp: string; body: string }[] {
    let raw = '';
    try {
      if (!existsSync(this.path())) return [];
      raw = readFileSync(this.path(), 'utf8');
    } catch {
      return [];
    }
    const out: { stamp: string; body: string }[] = [];
    const re = /^## (.+)$/gm;
    const heads: { at: number; end: number; stamp: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      heads.push({ at: m.index, end: m.index + m[0].length, stamp: m[1].trim() });
    }
    for (let i = 0; i < heads.length; i += 1) {
      const from = heads[i].end;
      const to = i + 1 < heads.length ? heads[i + 1].at : raw.length;
      out.push({ stamp: heads[i].stamp, body: raw.slice(from, to) });
    }
    return out;
  }

  private rotate(): void {
    try {
      if (!existsSync(this.path())) return;
      if (statSync(this.path()).size < ROTATE_BYTES) return;
      const d = new Date();
      const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renameSync(this.path(), join(journalDir(this.dataDir), `心事-${tag}.md`));
    } catch {
      // 换名失败就继续往后写，别因为归档把这一条弄丢
    }
  }
}
