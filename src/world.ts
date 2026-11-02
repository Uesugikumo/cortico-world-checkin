import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { BlobInput, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { briefTitle, isSelfApp, isWatchingVideo, sampleForeground, type Sample } from './activity.ts';
import { checkinConfigGroups, type CheckinConfigSection } from './config.ts';
import { capturePrint, captureScreen, changedRatio } from './shot.ts';
import { ThreadStore, type Thread } from './store.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 调度器多久醒一次 */
const TICK_MS = 30_000;
/** 采样最多留多少条（每分钟一条，240 条≈4 小时） */
const SAMPLES_MAX = 240;
/** 多久评估一次「要不要搭一句话」 */
const EVAL_MS = 15 * 60_000;
/** 挨无视后最多退避到几倍间隔 */
const IGNORED_MAX = 3;
/** 「两条之间至少隔多久」填 0 时，退避就没有基数了，用这个兜底 */
const GAP_FALLBACK_MIN = 5;
/** 「隔多久看一眼屏幕」的上限（分钟） */
const LOOK_MAX_MIN = 720;
/** 「隔多久看一眼屏幕」的默认值：老配置里没有这个键时用 */
const LOOK_DEFAULT_MIN = 30;
/** 键鼠停多久之后，开始拿画面来判断「他是不是还在看」 */
const FOCUS_IDLE_MS = 3 * 60_000;
/** 画面停住多久就算「人大概不在」——看书看画时画面总还在变（翻页、动画、光标） */
const STILL_WINDOW_MS = 10 * 60_000;
/** 两张画面指纹之间，单格亮度差多少才算变 */
const PRINT_CELL_DELTA = 24;
/** 变了的格子占比超过这个数才叫「画面在变」（挡住秒表、光标这种小面积抖动） */
const PRINT_CHANGE_RATIO = 0.05;
/** 两次取指纹之间至少隔这么久，别为了判断把截图当采样器用 */
const PRINT_MIN_INTERVAL_MS = 60_000;
/** 挂着的跟进最多几条 */
const MAX_PENDING = 20;
/** 用户真的说话了的标记 */
const SPEAK_RE = /\[(typed|voice|answer)\]/;
/** 桌宠被戳时它自己推的事件；我们只认「戳」这一种 */
const POKE_TYPE = 'desktop-pet.touch';
/** 多快看一眼有没有被戳 */
const POKE_POLL_MS = 1_000;
/** 连戳两下才算数：两下之间最多隔这么久（再慢就当两次各自的心血来潮） */
const POKE_DOUBLE_MS = 3_500;
/** 说了一句之后，这么久之内再戳也不再开口 */
const POKE_MIN_GAP_MS = 20_000;
/** 摸两下以上算「想让你陪着看一会儿」；两下之间最多隔这么久 */
const PET_WINDOW_MS = 3_500;
/** 摸几下才算数（一下是随手撸一把） */
const PET_MIN_TOUCHES = 2;
/** 这一趟陪着看多久（默认值；设置里能改） */
const COMPANION_MIN = 10;
/** 陪着看的时候，隔多久递一眼（默认值；设置里能改） */
const COMPANION_EVERY_MIN = 2;
/** 两次「回来啦」之间至少隔多久（防止出门倒垃圾来回三次都被招呼） */
const BACK_MIN_GAP_MS = 30 * 60_000;
/** 离开超过这么久就不细说了（多半是睡了一觉/合盖） */
const BACK_LONG_MS = 8 * 60 * 60_000;
/** 一条跟进提醒过一次之后，最多再留这么久（用户要的「问完就自己清掉」） */
const STALE_UNASKED_MS = 3 * 24 * 60 * 60_000;
/**
 * 递出「他走久了」之后过多久还没落账，就补一条「只记账、别开口」的收尾。
 * 这是「记账的时限」，跟「多久不动算离开」是两件事，所以固定 20 分钟、不进设置页。
 * 只补一次：不打扰用户是底线，逼模型给出结论只需要一次机会。
 */
const AWAY_VERDICT_MIN = 20;

/** 一次「看一眼」的结果：可能是刚采的，也可能是拿上一次的样本兜底。 */
interface Look {
  sample: Sample;
  /** 前台这会儿就是 Coo 自己（刚戳完桌宠、刚点面板按钮），样本是上一次的。 */
  selfNow: boolean;
  /** 样本不是刚采的。 */
  fromLast: boolean;
}

interface Deps {
  dataDir: string;
  cfg: CheckinConfigSection;
  timezone: string;
  /** 写回 config.json（框架的 ctx.persist）；面板上改的那一项要靠它落盘。 */
  persist?: (patch: Record<string, unknown>) => void;
  /** 取「画面指纹」的方式；只有测试会换掉它。 */
  print?: () => Promise<Uint8Array | null>;
}

export class CheckinWorld implements World {
  readonly id = 'checkin';

  private readonly deps: Deps;
  private readonly store: ThreadStore;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pokeTimer: ReturnType<typeof setInterval> | null = null;
  private pokeCursor: number | null = null;
  /** 这一小段时间里数到了几下戳：攒够两下才说话 */
  private pokeSeen = 0;
  private pokeSeenAt = 0;
  private lastPokeAt = 0;
  /** 这一小段时间里数到了几下「摸」：攒够两下就开始陪着看 */
  private petSeen = 0;
  private petSeenAt = 0;
  /** 持续陪伴到什么时候；0 = 没在陪 */
  private companionUntil = 0;
  /** 下一眼安排在什么时候 */
  private companionNextAt = 0;
  /** 这一趟已经递了几眼 */
  private companionCount = 0;
  private samples: Sample[] = [];
  private lastSampleAt = 0;
  private lastEvalAt = 0;
  /** 上一次按「看一眼屏幕」给由头是什么时候；0 = 还没给过 */
  private lastLookAt = 0;
  /** 上一次取到的画面指纹（32x18 灰度），只在本机内存里做比对 */
  private lastPrint: Uint8Array | null = null;
  /** 上一次取指纹的时刻 */
  private printAt = 0;
  /** 画面最后一次「明显变了」的时刻；0 = 还没观察到变化 */
  private lastChangeAt = 0;
  /** 这次「人不在」是从什么时候开始的；null 表示人在。 */
  private awaySince: number | null = null;
  /** 上次说「回来啦」的时刻。 */
  private lastBackAt = 0;
  /** 这一趟「人不在」有没有递过「他走久了」的由头（回来就复位）。 */
  private awayAsked = false;
  /** 这一趟离开的第一条推出去的时刻；null 表示没有待落账的由头。 */
  private awayAt: number | null = null;
  /** 最近一次 checkin_note 的时刻（用来判断这趟离开有没有留下结论）。 */
  private lastNoteAt = 0;
  /** 收尾提醒只补一次，补过就置为 Infinity 的等价值（用 awayNagged 记）。 */
  private awayNagged = false;

  constructor(deps: Deps) {
    this.deps = deps;
    mkdirSync(deps.dataDir, { recursive: true });
    this.store = new ThreadStore(join(deps.dataDir, 'threads.json'));
  }

  private get cfg(): CheckinConfigSection {
    return this.deps.cfg;
  }

  private get timezone(): string {
    return this.deps.timezone || 'Asia/Shanghai';
  }

  /** 提醒过一次的跟进还能留多久（分钟 → 毫秒，夹在 5–1440）。 */
  private staleAskedMs(): number {
    const min = Math.round(Number(this.cfg.staleMinutes));
    const clamped = Number.isFinite(min) ? Math.min(1440, Math.max(5, min)) : 60;
    return clamped * 60_000;
  }

  /** 陪伴默认是开的；老配置里没有这个键，不能因此当成关。 */
  private companionEnabled(): boolean {
    return this.cfg.companion !== false;
  }

  /** 现在生效的门槛（配置是热更新的，每次现读）。 */
  private limits(): { sameApp: number; gap: number; perHour: number; perDay: number } {
    const int = (v: unknown, fallback: number, min: number, max: number): number => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    return {
      sameApp: int(this.cfg.sameAppMinutes, 90, 5, 480),
      gap: int(this.cfg.softGapMinutes, 90, 0, 480),
      perHour: int(this.cfg.softPerHour, 2, 0, 12),
      perDay: int(this.cfg.softPerDay, 3, 0, 24),
    };
  }

  /**
   * 「隔多久看一眼屏幕」的分钟数：0 = 关掉这种由头，上限 12 小时。
   * 老配置里没有这个键（`defaults()` 只补整个缺失的 world），别把它当成「用户填了 0」。
   */
  private lookEveryMinutes(): number {
    const raw = this.cfg.lookEveryMinutes;
    const n = raw === undefined || raw === null ? LOOK_DEFAULT_MIN : Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(LOOK_MAX_MIN, n);
  }

  // ---------- World 接口 ----------

  envPromptVars(): Record<string, string> {
    const now = Date.now();
    const lim = this.limits();
    // 名字统一用 `<world id>.<变量>`，和 console.pin / lite.now 一样，值表是全 World 合并的，靠点号当命名空间。
    const vars: Record<string, string> = {
      'checkin.now': this.clockText(now),
      'checkin.quiet': `${this.cfg.quietFrom}–${this.cfg.quietTo}`,
      'checkin.pending': String(this.store.pending().length),
      'checkin.watch': this.cfg.watchActivity ? '在观察前台窗口' : '没在观察窗口',
      'checkin.limits': [
        lim.perDay > 0 ? `一天最多 ${lim.perDay} 条` : '一天不限条数',
        lim.perHour > 0 ? `每小时最多 ${lim.perHour} 条` : '每小时不限',
        lim.gap > 0 ? `两条之间至少隔 ${lim.gap} 分钟` : `两条之间不设间隔，被无视时按 ${GAP_FALLBACK_MIN} 分钟的基数退避`,
        `同一个程序得先连续待满 ${lim.sameApp} 分钟`,
        `键鼠停着超过 ${FOCUS_IDLE_MS / 60_000} 分钟时，要看画面还在不在动；画面停住超过 ${STILL_WINDOW_MS / 60_000} 分钟就不给由头了`,
      ].join('、'),
      'checkin.away':
        `键鼠有 ${this.awayMinutes()} 分钟没动就算 TA 离开了（看视频时放宽到 ${this.awayMinutes() * 2} 分钟）。` +
        '走久了还没回来，系统会给你一个由头；想在 QQ 上问一句，就自己去 QQ 那边的工具里找会话，不想找就先等着。' +
        `递给你之后再过 ${AWAY_VERDICT_MIN} 分钟还没用 checkin_note 落账，会补一条只让你记账、不许开口的收尾（只补一次）。`,
      'checkin.stale': `${Math.round(this.staleAskedMs() / 60_000)} 分钟`,
      'checkin.backGap': `${Math.round(BACK_MIN_GAP_MS / 60_000)} 分钟`,
      'checkin.awayVerdict': `${Math.round(this.awayVerdictMs() / 60_000)} 分钟`,
      'checkin.companion': this.companionEnabled()
        ? `陪着看 ${this.companionMinutes()} 分钟，每 ${Math.round(this.companionEveryMs() / 60_000)} 分钟递一眼（一共 ${this.companionTotal()} 眼，第一眼带 speak）`
        : '连着摸你两下已经关掉了，收不到这种陪伴',
      'checkin.look': this.lookEveryMinutes() > 0
        ? `不管窗口有没有换，每隔 ${this.lookEveryMinutes()} 分钟会主动看一眼 TA 现在在做什么`
        : '「按时间看一眼屏幕」关着，只有同一个程序待久了才给由头',
      'checkin.focus':
        `他手停着不动、但屏幕上的东西一直在变的时候，人是在的（看书、看画、看片都这样）——` +
        `这种时候照样可以搭话，只是要就着屏幕上的内容说，别问「你在干嘛」「你还在吗」。` +
        `屏幕停住超过 ${STILL_WINDOW_MS / 60_000} 分钟以上，才当他真的不在。`,
    };
    // 0.1.7 及以前发布的是下划线名；这一版仍留别名，别人改过自己的 ENV_PROMPT 也不会渲染出裸的 {{…}}。
    // 计划 0.2.0 删掉——新写的模板一律用点号，下面这些别名不进 promptDocs.vars、也不出现在任何文档里。
    vars.checkin_now = vars['checkin.now'];
    vars.checkin_quiet = vars['checkin.quiet'];
    vars.checkin_pending = vars['checkin.pending'];
    vars.checkin_watch = vars['checkin.watch'];
    vars.checkin_limits = vars['checkin.limits'];
    vars.checkin_away = vars['checkin.away'];
    vars.checkin_companion = vars['checkin.companion'];
    vars.checkin_stale = vars['checkin.stale'];
    vars.checkin_backGap = vars['checkin.backGap'];
    vars.checkin_awayVerdict = vars['checkin.awayVerdict'];
    vars.checkin_look = vars['checkin.look'];
    vars.checkin_focus = vars['checkin.focus'];
    return vars;
  }

  tools(): ToolDef[] {
    return [this.noteTool(), this.listTool(), this.doneTool(), this.activityTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const zh = language === 'zh';
    const lamp: WorldLamp = {
      label: t.lampLabel,
      state: this.host ? 'online' : 'offline',
      hint: this.cfg.watchActivity ? t.lampHintWatching : t.lampHintOff,
    };
    const pending = this.store.pending().length;
    return {
      label: t.moduleLabel,
      lamps: [lamp],
      badges: [{ label: t.badgePending, value: String(pending), tone: pending > 0 ? 'on' : 'plain' }],
      panels: [
        {
          id: 'probe',
          title: t.panelProbeTitle,
          description: t.panelProbeDescription,
          getMethods: ['status'],
        },
        {
          id: 'pending',
          title: t.panelPendingTitle,
          description: t.panelPendingDescription,
          getMethods: ['list'],
        },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      config: checkinConfigGroups(language),
      promptDocs: [
        {
          key: 'worlds.checkin.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          // 声明了 vars，控制台的提示词页才会列出变量、能看当前值、能「预览变量」；
          // 不声明就只有一屏裸 {{…}}。
          vars: [
            { name: 'checkin.now', description: zh ? '拼这段前缀时的本地钟点。' : 'Local time when this prefix was assembled.' },
            { name: 'checkin.quiet', description: zh ? '安静时段；这段时间里它不会主动搭话。' : 'Quiet hours; it never speaks up during this window.' },
            { name: 'checkin.pending', description: zh ? '还挂着的跟进条数。' : 'How many follow-ups are still open.' },
            { name: 'checkin.watch', description: zh ? '有没有在观察前台窗口。' : 'Whether foreground windows are being watched.' },
            { name: 'checkin.limits', description: zh ? '一天/每小时上限、两条之间的最短间隔、同一个程序的门槛。' : 'Daily and hourly caps, the minimum gap, and the per-app threshold.' },
            { name: 'checkin.away', description: zh ? '离开的判定（分钟，看视频放宽一倍）和走久了递由头的口径；要不要在 QQ 上问、问给谁，交给模型自己找。' : 'How absence is judged (doubled while watching video) and what the cue says; whether to ask on QQ and who to ask is up to the model.' },
            { name: 'checkin.stale', description: zh ? '提醒过一次、一直没有结果的跟进，过多少分钟自动销账。' : 'How long an asked, still unanswered follow-up stays before it is swept.' },
            { name: 'checkin.backGap', description: zh ? '两次「回来时说一句」之间至少隔多久。' : 'Minimum gap between two welcome-back lines.' },
            { name: 'checkin.awayVerdict', description: zh ? '递出「他走久了」之后，等多久还没落账就补一条只记账、不许开口的收尾（固定 20 分钟，只补一次）。' : 'After the away cue, how long to wait for a recorded verdict before sending one record-only nudge (fixed at 20 minutes, sent once).' },
            { name: 'checkin.companion', description: zh ? '连摸两下之后陪多久、隔多久递一眼、一共几眼。' : 'How long the post-pet company lasts, how often a glance arrives, and how many glances in total.' },
            { name: 'checkin.look', description: zh ? '「按时间看一眼屏幕」这种由头的间隔；关掉时这里会写明只有程序待久了才给。' : 'Interval of the timed screen glance cue; when off, this says only the stay-in-one-app cue remains.' },
            { name: 'checkin.focus', description: zh ? '键鼠停着时怎么判断他还在不在看：看画面有没有在变，以及停住多久才算真不在。' : 'How it tells whether he is still watching while the mouse is idle: by whether the screen keeps changing, and how long a frozen screen counts as gone.' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 「按时间看一眼」从启动那一刻开始计时：刚打开就递一眼没有意义，等满一个间隔再说
    this.lastLookAt = Date.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // 定时器不该把进程钉住不让退出
    this.timer.unref?.();

    host.log.info(
      `checkin: ${this.cfg.watchActivity ? '看前台窗口' : '只看跟进'}；安静 ${this.cfg.quietFrom}–${this.cfg.quietTo}；` +
        `挂着 ${this.store.pending().length} 条`,
    );

    // 连戳两下是打招呼，连摸两下是陪着看一会儿；两件都跟「要不要监测前台窗口」没关系，各有开关。
    if (this.cfg.pokeNudge || this.companionEnabled()) this.startPokeWatch(host);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pokeTimer) {
      clearInterval(this.pokeTimer);
      this.pokeTimer = null;
    }
    this.host = null;
    this.store.save();
  }

  // ---------- 连戳两下 ----------

  /**
   * 盯着事件库，看桌宠有没有被戳。之所以轮询而不是等回调：
   * WorldHost 没有「被戳」的钩子，事件库是唯一能看见别家 World 事件的地方。
   */
  private startPokeWatch(host: WorldHost): void {
    if (this.pokeTimer) return;
    this.pokeTimer = setInterval(() => {
      void this.watchPoke();
    }, POKE_POLL_MS);
    this.pokeTimer.unref?.();
    const what = [this.cfg.pokeNudge ? '连戳两下说话' : '', this.companionEnabled() ? '连摸两下陪着看' : ''].filter(Boolean);
    host.log.info(`checkin: 盯着桌宠的触碰（${what.join('、')}）`);
  }

  private async watchPoke(): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      const latest = host.store.latestCursor();
      if (this.pokeCursor === null) {
        this.pokeCursor = latest;
        return;
      }
      if (latest <= this.pokeCursor) return;
      const events = host.store.range({ fromCursor: this.pokeCursor + 1, toCursor: latest, limit: 200 });
      this.pokeCursor = latest;
      // 桌宠把 2.5 秒内的同种触碰合并成一条事件，实际触碰几下写在 meta.touch.count 里
      // （连戳两下 = 一条事件、count 2），所以数的是 count，不是事件条数。
      // 「摸」和「戳」分开数：摸是撸毛，戳是敲一下。
      const touched = events.reduce(
        (acc, e) => {
          if (e.type !== POKE_TYPE) return acc;
          const kind = touchKind(e);
          if (kind !== 'poke' && kind !== 'pet') return acc;
          const count = Number((e.meta as { touch?: { count?: unknown } } | undefined)?.touch?.count);
          const n = Number.isFinite(count) && count > 0 ? Math.min(count, 10) : 1;
          if (kind === 'pet') acc.pets += n;
          else acc.pokes += n;
          return acc;
        },
        { pokes: 0, pets: 0 },
      );
      const now = Date.now();
      if (touched.pets) this.notePets(touched.pets, now);
      if (!touched.pokes) return;
      const pokes = touched.pokes;
      // 合并窗口边缘可能拆成两条事件，所以也允许前后两次轮询凑够两下。
      this.pokeSeen = this.pokeSeenAt > 0 && now - this.pokeSeenAt <= POKE_DOUBLE_MS ? this.pokeSeen + pokes : pokes;
      this.pokeSeenAt = now;
      if (this.pokeSeen < 2) return;
      this.pokeSeen = 0;
      if (now - this.lastPokeAt < POKE_MIN_GAP_MS) return;
      this.lastPokeAt = now;
      const look = await this.lookSample();
      if (!look) return;
      await this.pushPoke(look);
    } catch (err) {
      host.log.warn(`checkin: 看戳没看成：${msg(err)}`);
    }
  }

/**
   * 被戳之后递一句话的由头，顺带把这一眼截下来。
   * 戳完那一秒前台往往就是 Coo 自己（鼠标还在桌宠身上），所以文案要交代清楚
   * 「这次看到的是上一次的窗口」，别让他以为你连他刚在干什么都没看见。
   */
  private async pushPoke(look: Look): Promise<void> {
    const host = this.host;
    if (!host) return;
    const now = Date.now();
    const { sample } = look;
    const idleMs = sample.idleMs + Math.max(0, now - sample.at);
    const streak = this.continuousMinutes();
    const shot = await this.takeShot();
    // 刚跟他说过话，半小时内别再补一句「回来啦」
    this.lastBackAt = now;
    const eye =
      `前台是「${sample.proc || '（不知道）'}」，窗口标题「${briefTitle(sample.title)}」，` +
      `${idleMs < 60_000 ? '刚刚还在动' : `${Math.round(idleMs / 60_000)} 分钟没动键鼠`}` +
      `${isWatchingVideo(sample.proc, sample.title) ? '（看着片子）' : ''}。`;
    const body =
      '使用者连着戳了两下桌宠（就是戳你）。' +
      (look.selfNow ? '他戳完还没切回原来的窗口，这会儿前台是我自己，' + '所以下面这一眼是戳之前的样子：' : '我顺手看了一眼他这会儿在做什么：') +
      eye +
      (streak > 0 ? `同一件事已经连着 ${streak} 分钟了。` : '') +
      (shot ? '截了一张图，你自己看。' : '') +
      '他连戳两下多半是想听你说句话（也可能只是手欠）；有想说的就说一句，一两行。要是不想接，就当没这回事。';
    await host.pushEvent(
      {
        type: 'checkin.activity',
        ts: new Date(now).toISOString(),
        source: this.id,
        text: body,
        tags: ['speak'],
        blobs: shot ? [shot] : undefined,
        meta: { proc: sample.proc, streakMinutes: streak, idleMs, poke: true, selfNow: look.selfNow },
      },
      { trigger: 'debounce' },
    );
  }

  // ---------- 连摸两下，陪着看一会儿 ----------

  /** 陪多久（分钟）：设置里能改，夹在 1–60。 */
  private companionMinutes(): number {
    const n = Math.round(Number(this.cfg.companionMinutes));
    return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : COMPANION_MIN;
  }

  /** 隔多久递一眼（毫秒）：夹在 30 秒–30 分钟，并且不会超过总时长。 */
  private companionEveryMs(): number {
    const n = Math.round(Number(this.cfg.companionEveryMinutes) * 60_000);
    const every = Number.isFinite(n) && n >= 30_000 ? Math.min(30 * 60_000, n) : COMPANION_EVERY_MIN * 60_000;
    return Math.min(every, this.companionMinutes() * 60_000);
  }

  /** 这一趟一共递几眼。 */
  private companionTotal(): number {
    return Math.max(1, Math.round((this.companionMinutes() * 60_000) / this.companionEveryMs()));
  }

  /** 摸了桌宠：攒够两下就开一段「陪你一会儿」，之后按节奏递图，不再需要他继续摸。 */
  private notePets(count: number, now: number): void {
    this.petSeen = this.petSeenAt > 0 && now - this.petSeenAt <= PET_WINDOW_MS ? this.petSeen + count : count;
    this.petSeenAt = now;
    if (this.petSeen < PET_MIN_TOUCHES) return;
    this.petSeen = 0;
    this.startCompanion(now);
  }

  private startCompanion(now: number): void {
    if (!this.companionEnabled()) return;
    // 已经在陪了就不再重开计时器：他摸得勤的时候时间不该越拖越长。
    if (this.companionUntil > now) return;
    const minutes = this.companionMinutes();
    this.companionUntil = now + minutes * 60_000;
    this.companionNextAt = now;
    this.companionCount = 0;
    this.host?.log.info(
      `checkin: 摸了两下，接下来 ${minutes} 分钟每 ${Math.round(this.companionEveryMs() / 60_000)} 分钟看一眼（共 ${this.companionTotal()} 眼）`,
    );
  }

  /** 陪伴期间按节奏递一眼；时间到就自己停，不用他再管。 */
  private async tickCompanion(host: WorldHost, now: number): Promise<void> {
    if (!this.companionUntil) return;
    if (!this.companionEnabled() || now >= this.companionUntil) {
      host.log.info(`checkin: 陪伴结束（这趟递了 ${this.companionCount} 眼）`);
      this.companionUntil = 0;
      this.companionNextAt = 0;
      return;
    }
    if (now < this.companionNextAt) return;
    // 先把下一次排好，别因为这一眼失败卡在原地反复重试。
    this.companionNextAt = now + this.companionEveryMs();
    await this.pushCompanion(host, now);
  }

  private async pushCompanion(host: WorldHost, now: number): Promise<void> {
    const look = await this.lookSample();
    if (!look) return;
    const { sample } = look;
    const shot = await this.takeShot();
    this.companionCount += 1;
    const index = this.companionCount;
    const minutes = this.companionMinutes();
    const total = this.companionTotal();
    const minutesLeft = Math.max(0, Math.round((this.companionUntil - now) / 60_000));
    const idleMs = sample.idleMs + Math.max(0, now - sample.at);
    const where =
      `前台是「${sample.proc || '（不知道）'}」，窗口标题「${briefTitle(sample.title)}」，` +
      `${idleMs < 60_000 ? '刚刚还在动' : `${Math.round(idleMs / 60_000)} 分钟没动键鼠`}` +
      `${isWatchingVideo(sample.proc, sample.title) ? '（看着片子）' : ''}。`;
    const body =
      '使用者连着摸了你几下（顺着毛摸的那种，摸两下以上），说想让你陪着看一会儿。' +
      `这是这 ${minutes} 分钟里的第 ${index}/${total} 眼，还剩约 ${minutesLeft} 分钟。` +
      (look.selfNow ? '他摸完还没切回原来的窗口，这会儿前台是我自己，所以下面这一眼是摸之前的样子：' : '') +
      where +
      (shot ? '截了一张图，你自己看。' : '') +
      '不用每眼都开口：看到有意思的、他明显在跟你玩、或者他卡在那儿了，再搭一句（气泡，一两行）；其余时候看完就放着。';
    try {
      await host.pushEvent(
        {
          type: 'checkin.companion',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          // 第一眼允许开口打个招呼，后面几眼只是看着，省得五分钟里被催着说五句话。
          tags: index === 1 ? ['speak'] : [],
          blobs: shot ? [shot] : undefined,
          meta: { proc: sample.proc, idleMs, companion: true, index, total, minutesLeft, selfNow: look.selfNow },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      host.log.warn(`checkin: 这一眼没递出去：${msg(err)}`);
    }
  }

  // ---------- 离开 / 回来 ----------

  /** 配置里的「多久不动算人不在」，夹在 1–240 分钟。 */
  private awayMinutes(): number {
    return Math.max(1, Math.min(240, Math.round(Number(this.cfg.awayMinutes) || 15)));
  }

  /** 这次算「人不在」的 idle 阈值；看片时放宽一倍（捏着手柄不碰键鼠是常态）。 */
  private awayThreshold(sample: Sample): number {
    const base = this.awayMinutes() * 60_000;
    return isWatchingVideo(sample.proc, sample.title) ? base * 2 : base;
  }

  /**
   * 取一张画面指纹，和上一张比一比，记下「画面最后一次变」的时刻。
   * 只在键鼠停着、需要判断「他是不是还在看」的时候才调，平时一次都不截。
   * 拿不到画面就当「不知道」——不额外拦，仍按原来的离开判定走。
   */
  private async refreshPrint(now: number): Promise<void> {
    if (this.printAt && now - this.printAt < PRINT_MIN_INTERVAL_MS) return;
    const next = await (this.deps.print ?? capturePrint)();
    if (!next) return;
    this.printAt = now;
    if (!this.lastPrint) {
      // 第一次拿到画面：当成「刚从在变的状态开始看」，从这里起算静止了多久
      this.lastPrint = next;
      this.lastChangeAt = now;
      return;
    }
    if (changedRatio(this.lastPrint, next, PRINT_CELL_DELTA) > PRINT_CHANGE_RATIO) {
      this.lastChangeAt = now;
    }
    this.lastPrint = next;
  }

  /**
   * 键鼠停着的时候，他到底还在不在看——这是「画面有没有在变」能回答的，
   * `idleMs` 回答不了（看书看画时手就是不动，人却一直在）。
   * 返回 true = 画面在变，当成「他在看」；false = 画面停住了，别去打扰。
   * 拿不到画面时返回 true（不知道就别多拦）。
   */
  private async focusWatching(now: number): Promise<boolean> {
    await this.refreshPrint(now);
    if (!this.lastChangeAt) return true;
    return now - this.lastChangeAt <= STILL_WINDOW_MS;
  }

  /**
   * 递出「他走久了」之后，等多久还没落账就补一条收尾。
   * 固定 20 分钟，不跟 awayMinutes 联动、也不进设置页（这是记账时限，不是离开判定）。
   */
  private awayVerdictMs(): number {
    return AWAY_VERDICT_MIN * 60_000;
  }

  /**
   * 用一个采样判断走没走、回没回。采样间隔就是这套判定的计时精度：
   * 一分钟采一次的话，离开和回来各可能差一分钟，所以文案里写「大约」。
   */
  private async watchAway(sample: Sample, now: number): Promise<void> {
    const threshold = this.awayThreshold(sample);
    if (sample.idleMs >= threshold) {
      if (this.awaySince === null) this.awaySince = now - sample.idleMs;
      await this.maybeAskAway(sample, now);
      return;
    }
    if (this.awaySince === null) return;
    const awayMs = now - this.awaySince;
    this.awaySince = null;
    this.awayAsked = false;
    this.awayAt = null;
    this.awayNagged = false;
    if (awayMs < threshold) return;
    if (!this.cfg.backNudge) return;
    if (this.inQuiet(now)) return;
    if (now - this.lastBackAt < BACK_MIN_GAP_MS) return;
    this.lastBackAt = now;
    await this.pushBack(sample, awayMs, now);
  }

  /**
   * 人走了好一阵还没回来，递一个由头。
   * 扩展自己发不了 QQ，也不再存「问给谁」：发消息是另一个 World 的工具，World 之间不能互调，
   * 所以这里只把「他可能走开了」这件事递过去，去哪儿问、要不要问，都交给模型看工具列表决定。
   */
  private async maybeAskAway(sample: Sample, now: number): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (this.awayAsked) return;
    if (this.awaySince === null) return;
    const awayMs = now - this.awaySince;
    if (awayMs < this.awayThreshold(sample)) return;
    if (this.inQuiet(now)) return;
    this.awayAsked = true;
    this.awayAt = now;
    this.awayNagged = false;
    const minutes = Math.round(awayMs / 60_000);
    const spent = awayMs >= BACK_LONG_MS ? `大约 ${Math.round(minutes / 60)} 小时` : `大约 ${minutes} 分钟`;
    // 这时候屏幕上多半是锁屏，截了也没用，还白费 token，所以不带图。
    const body =
      `使用者已经离开电脑${spent}了（走之前前台是「${sample.proc || '（不知道）'}」）。` +
      '「离开」只说明他人不在这台电脑前，别处有没有跟你说过话不算数——他要是在 QQ 上回了你，' +
      '那正好说明人还在外面，不是回来了。\n' +
      '现在先自己想他去了哪：翻一下对话，他走之前有没有交代过（「我出去一趟」「先睡会儿」）；' +
      '再看一眼工具列表里有没有课程表、日程表这类东西（有就查一句，没有就跳过），这会儿他是不是本来就有课、有自习、有安排。\n' +
      '先分清「知道」和「猜」：他走前交代过（「我出去一趟」「先去吃饭」），或者课程表、日程表里查得到，才算知道；' +
      '按「这个点该吃饭了」「这么晚一般睡了」推出来的，都是猜，不算数。\n' +
      '知道就按知道的来，不用问：本来在上课/有事，人不在是正常的，别说「人呢」「翘课了」这种话，' +
      '等他回来再顺口说一句「下课啦」就够。\n' +
      '只有猜、或者什么都不知道：回来问一句「刚才去哪儿啦」就够，不用非得发到手机上；真要现在问，' +
      '就自己看一眼工具列表里有没有能把话送到手机上的东西（QQ 那边的发送工具、别的通知渠道都算；名字别猜，' +
      '没有就是没装），有的话优先发给他本人，别往群里发，一两句，别追问、别连着发第二条。\n' +
      '不管问不问，这一步都要收尾：用 `checkin_note` 记一条。问过了记「等他回」，先别 `checkin_done`，' +
      '等他真答了再结；查到事实的记「日程：…」；只是猜的就记「猜的：估计去吃饭了，还没问，回来问一句」——' +
      '猜的不算结论，这条照样挂在待跟进里，别现在结掉。记了我就不再来问你这趟的事了。';
    try {
      await host.pushEvent(
        {
          type: 'checkin.away',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: [],
          meta: { proc: sample.proc, awayMinutes: minutes, idleMs: sample.idleMs, back: false },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      this.awayAsked = false;
      host.log.warn(`checkin: 离开的由头没递出去：${msg(err)}`);
    }
  }

  /**
   * 这趟离开还没落账（没调 checkin_note）就补一条：
   * 只让模型记结论、明确不许开口——逼出结论一次，但拿用户当提醒对象的事只做一次。
   */
  private async nagAwayVerdict(now: number): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (this.awayAt === null || this.awayNagged) return;
    if (this.awaySince === null) return;
    if (now - this.awayAt < this.awayVerdictMs()) return;
    if (this.lastNoteAt >= this.awayAt) return;
    if (this.inQuiet(now)) return;
    this.awayNagged = true;
    const minutes = Math.round((now - this.awaySince) / 60_000);
    const body =
      `使用者已经离开 ${minutes} 分钟了，上一趟你还没有收尾。` +
      '**这条不要开口，也不要给 TA 发任何消息**，只做一件事：用 `checkin_note` 写下你的结论。' +
      '他走前说过、或者日程里查得到的，就写事实；只是按时间、按习惯猜的，就写「猜的：估计去吃饭了，还没问」——' +
      '猜的不算结论，留着回来问过再结，别现在 `checkin_done`。' +
      '记完这趟就算完了，我不会再问你。';
    try {
      await host.pushEvent(
        {
          type: 'checkin.away',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: [],
          meta: { awayMinutes: minutes, back: false, verdict: 'reminder' },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      this.awayNagged = false;
      host.log.warn(`checkin: 落账提醒没递出去：${msg(err)}`);
    }
  }

  /** 「你回来啦」：只在回来这一步说，走的时候不打扰。 */
  private async pushBack(sample: Sample, awayMs: number, now: number): Promise<void> {
    const host = this.host;
    if (!host) return;
    const minutes = Math.round(awayMs / 60_000);
    const spent = awayMs >= BACK_LONG_MS ? `大约 ${Math.round(minutes / 60)} 小时` : `大约 ${minutes} 分钟`;
    const shot = await this.takeShot();
    const body =
      `使用者刚离开了一会儿又回来了（${spent}）。` +
      `现在前台是「${sample.proc || '（不知道）'}」，窗口标题「${briefTitle(sample.title)}」。` +
      (shot ? '顺手截了一张图，你自己看。' : '') +
      '回来一般是想接着干刚才的事；想打个招呼就说一句短的（一两行，比如「回来啦」），不想说就当没看见。' +
      '要是你知道他这会儿本来应该在上课、自习或做某件具体的事（日程或课程表里查得到的话），可以顺口带一句。' +
      '这趟你只是猜的、或者根本没问到，回来就问一句「刚才去哪儿啦」——别替他编答案（比如「饭吃过了嘛」）。' +
      '走之前你要过一句「去哪了」并记在待跟进的，这会儿正好问结果，问到了就 `checkin_done` 结掉。';
    try {
      await host.pushEvent(
        {
          type: 'checkin.activity',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: ['speak'],
          blobs: shot ? [shot] : undefined,
          meta: { proc: sample.proc, back: true, awayMinutes: minutes, idleMs: sample.idleMs },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      host.log.warn(`checkin: 回来这句没说成：${msg(err)}`);
    }
  }

  // ---------- 调度 ----------

  private async tick(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const now = Date.now();
    this.store.rollDay(this.dayKey(now));

    // 提醒过还没结果的，留一阵就自己清掉；不然列表会一直挂着过去的事
    const stale = this.store.sweep(now, this.staleAskedMs(), STALE_UNASKED_MS);
    if (stale.length) {
      host.log.info(`checkin: 清掉 ${stale.length} 条过期的跟进`);
    }

    // 到点的跟进：安静时段先不吵，等出来再说
    if (!this.inQuiet(now)) {
      for (const th of this.store.due(now)) this.pushDue(host, th, now);
    }

    if (this.cfg.watchActivity) {
      const every = Math.max(15, this.cfg.sampleSeconds) * 1000;
      if (!this.lastSampleAt || now - this.lastSampleAt >= every) {
        await this.sampleNow();
      }
    }

    if (!this.inQuiet(now)) await this.maybeLook(host, now);

    if (!this.inQuiet(now) && now - this.lastEvalAt >= EVAL_MS) {
      this.lastEvalAt = now;
      await this.maybeNudge(host, now);
    }

    // 递过「他走久了」但一直没落账的，补一次收尾（只记账、不开口）
    if (!this.inQuiet(now)) await this.nagAwayVerdict(now);

    // 陪伴不看安静时段：是他自己摸出来的，有内容就递。
    await this.tickCompanion(host, now);
  }

  private pushDue(host: WorldHost, thread: Thread, now: number): void {
    if (!this.store.markAsked(thread.id, now)) return;
    const body =
      `我自己记着的一件事到点了：${thread.text}。现在 ${this.clockText(now)}。` +
      '要问就现在问一句，不想问就让它过去。';
    void host
      .pushEvent(
        {
          type: 'checkin.due',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: ['speak'],
          meta: {
            threadId: thread.id,
            dueAt: new Date(thread.dueAt).toISOString(),
            askedAt: new Date(now).toISOString(),
          },
        },
        { trigger: 'flush' },
      )
      .catch((err) => host.log.warn(`checkin: 跟进没能送出去：${msg(err)}`));
  }

  /** 副通道：长时间待在同一件事上，给一个可以搭话的由头。 */
  private async maybeNudge(host: WorldHost, now: number): Promise<void> {
    const current = this.samples[this.samples.length - 1];
    if (!current || !current.proc) return;
    // 人不在，别对着空屏幕说话。采样可能已经放了几分钟，要把这段流逝补上；
    // 在看片子的话键鼠长时间不动是正常的，阈值放宽。
    const idleNow = current.idleMs + Math.max(0, now - current.at);
    const away = this.awayThreshold(current);
    if (idleNow > away) return;
    // 键鼠停着不代表人不在：看书画画时手就是不动。这时候看画面有没有在变——
    // 画面停了十分钟以上才当「人大概走了」，画面还在动就照常说话。
    const focused = idleNow > FOCUS_IDLE_MS;

    const streak = this.continuousMinutes();
    const lim = this.limits();
    if (streak < lim.sameApp) return;

    const day = this.dayKey(now);

    const soft = this.store.soft();
    if (lim.perDay > 0 && soft.day === day && soft.count >= lim.perDay) return;
    if (lim.perHour > 0 && this.store.countSince(now, 60 * 60_000) >= lim.perHour) return;

    // 间隔填 0 时也要有个基数，否则「被无视就退避」等于没退避
    const base = lim.gap > 0 ? lim.gap : GAP_FALLBACK_MIN;
    const gap = base * 60_000 * Math.min(2 ** soft.ignored, 2 ** IGNORED_MAX);
    if (soft.lastAt && now - soft.lastAt < gap) return;

    // 上次搭话后他一句话都没接 → 退避一步；接了 → 回到基准
    const ignored = soft.lastAt > 0 && !this.spokeSince(soft.lastAt) ? Math.min(soft.ignored + 1, IGNORED_MAX) : 0;

    // 前面那些便宜的条件都过了，才值得真去取一张画面指纹
    if (focused && !(await this.focusWatching(now))) return;

    const shot = await this.takeShot();
    const focusNote = focused ? `他 ${Math.round(idleNow / 60_000)} 分钟没动键鼠了，但画面一直在变（多半在看书、看画或者看片）。` : '';
    const body =
      `他已经在「${current.proc}」前面连着待了 ${streak} 分钟，中间没换过窗口` +
      `（窗口标题：${briefTitle(current.title)}）。最近一小时：${this.recentSummary(now)}。` +
      focusNote +
      (shot ? '顺手截了一张图，你自己看。' : '') +
      '要是这会儿有句短的想说，就说出来（气泡，一两行）；说完回去接着干你的。真没话说再沉默。';

    this.store.rollDay(day);
    this.store.markSoft(day, now, ignored);

    try {
      await host.pushEvent(
        {
          type: 'checkin.activity',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: ['speak'],
          blobs: shot ? [shot] : undefined,
          meta: {
            proc: current.proc,
            streakMinutes: streak,
            idleMs: current.idleMs,
            focused,
            ignored,
          },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      host.log.warn(`checkin: 搭话没能送出去：${msg(err)}`);
    }
  }

  /**
   * 另一条给由头的路：不管窗口换没换，每隔 N 分钟主动看一眼屏幕，
   * 让他知道你现在在做什么。跟「同一程序待久了」互不影响，各有各的开关。
   */
  private async maybeLook(host: WorldHost, now: number): Promise<void> {
    const every = this.lookEveryMinutes();
    if (!every || !this.cfg.watchActivity) return;
    if (this.lastLookAt && now - this.lastLookAt < every * 60_000) return;
    const current = this.samples[this.samples.length - 1];
    if (!current || !current.proc || isSelfApp(current.proc)) return;
    // 人不在，看了也白看
    const idleNow = current.idleMs + Math.max(0, now - current.at);
    if (idleNow > this.awayThreshold(current)) return;
    const focused = idleNow > FOCUS_IDLE_MS;
    if (focused && !(await this.focusWatching(now))) return;

    const prev = this.lastLookAt;
    this.lastLookAt = now;
    const streak = this.continuousMinutes();
    const shot = await this.takeShot();
    const idleNote = `${idleNow < 60_000 ? '刚刚还在动键鼠' : `键鼠有 ${Math.round(idleNow / 60_000)} 分钟没动`}`;
    const focusNote = focused ? '，不过画面一直在变——他还在看，只是没动手' : '';
    const body =
      `你每隔 ${every} 分钟会看一眼 TA 现在在做什么。这会儿前台是「${current.proc}」` +
      `（窗口标题：${briefTitle(current.title)}），` +
      idleNote +
      focusNote +
      (streak > 0 ? `，同一件事已经连着 ${streak} 分钟` : '') +
      `。最近一小时：${this.recentSummary(now)}。` +
      (shot ? '顺手截了一张整个屏幕的图，你自己看。' : '') +
      '看一眼就知道他在忙什么了：想说句短的就这会儿说（气泡，一两行），没想说的就当没这一眼。';

    try {
      await host.pushEvent(
        {
          type: 'checkin.activity',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: ['speak'],
          blobs: shot ? [shot] : undefined,
          meta: {
            proc: current.proc,
            look: true,
            idleMs: current.idleMs,
            streakMinutes: streak,
            focused,
          },
        },
        { trigger: 'flush' },
      );
    } catch (err) {
      this.lastLookAt = prev;
      host.log.warn(`checkin: 这一眼没递出去：${msg(err)}`);
    }
  }

  // ---------- 手动看一眼（面板） ----------

  /** 立刻采一次前台窗口，不看采样间隔。 */
  private async sampleNow(): Promise<Sample | null> {
    if (!this.cfg.watchActivity) return null;
    this.lastSampleAt = Date.now();
    const sample = await sampleForeground();
    if (!sample) return null;
    // 走没走、回没回，光看这一次的 idleMs 就知道了（采样本身就是计时器）
    await this.watchAway(sample, Date.now());
    // 自己的窗口（桌宠、控制台）不算「他在干什么」
    if (isSelfApp(sample.proc)) return null;
    this.pushSample(sample);
    return sample;
  }

  /**
   * 「看一眼」的正确姿势：先真采一次；采到的是 Coo 自己（刚戳完桌宠、刚点面板按钮，
   * 前台就是我），或者采失败，就用最近一次真实样本顶上——否则一戳就什么都看不见。
   */
  private async lookSample(): Promise<Look | null> {
    if (!this.cfg.watchActivity) return null;
    this.lastSampleAt = Date.now();
    const fresh = await sampleForeground();
    if (fresh && !isSelfApp(fresh.proc)) {
      this.pushSample(fresh);
      return { sample: fresh, selfNow: false, fromLast: false };
    }
    const last = this.lastRealSample();
    if (!last) return null;
    return { sample: last, selfNow: Boolean(fresh), fromLast: true };
  }

  private pushSample(sample: Sample): void {
    this.samples.push(sample);
    if (this.samples.length > SAMPLES_MAX) {
      this.samples.splice(0, this.samples.length - SAMPLES_MAX);
    }
  }

  /** 最近一条真实样本；太久以前的不算（半小时前在干什么没意义）。 */
  private lastRealSample(): Sample | null {
    const last = this.samples[this.samples.length - 1];
    if (!last) return null;
    return Date.now() - last.at <= 30 * 60_000 ? last : null;
  }

  /** 当前模型能不能看图；没接上宿主或宿主没给能力时算不知道。 */
  private canSeeImages(): boolean | null {
    const facts = this.host?.modelFacts as { accepts?: (mime: string) => boolean } | undefined;
    if (!facts?.accepts) return null;
    try {
      return facts.accepts('image/jpeg');
    } catch {
      return null;
    }
  }

  /** 要搭话时截一张图；关掉了、或当前模型看不了图，就当没截。 */
  private async takeShot(): Promise<BlobInput | null> {
    if (!this.cfg.screenshot) return null;
    if (this.canSeeImages() !== true) return null;
    const shot = await captureScreen();
    if (!shot) return null;
    return {
      bytes: shot.bytes,
      mime: shot.mime,
      name: 'screen.jpg',
      fallbackText: '（顺带截了一张当时的屏幕）',
    };
  }

  private probeStatus(): Record<string, unknown> {
    const now = Date.now();
    const current = this.samples[this.samples.length - 1];
    const lim = this.limits();
    const soft = this.store.soft();
    return {
      watching: this.cfg.watchActivity,
      screenshot: this.cfg.screenshot,
      pokeNudge: this.cfg.pokeNudge,
      companion: this.companionEnabled(),
      companionMinutes: this.companionMinutes(),
      companionEveryMinutes: Math.round(this.companionEveryMs() / 60_000),
      companionTotal: this.companionTotal(),
      companionNow: this.companionUntil > now,
      companionLeft: this.companionUntil > now ? Math.round((this.companionUntil - now) / 60_000) : 0,
      companionCount: this.companionCount,
      backNudge: this.cfg.backNudge,
      awayMinutes: this.awayMinutes(),
      awaySince: this.awaySince ? new Date(this.awaySince).toISOString() : null,
      lastBackAt: this.lastBackAt ? new Date(this.lastBackAt).toISOString() : null,
      canSeeImages: this.canSeeImages(),
      quiet: this.inQuiet(now),
      clock: this.clockText(now),
      sampleSeconds: Math.max(15, this.cfg.sampleSeconds),
      samples: this.samples.length,
      lastSampleAt: this.lastSampleAt ? new Date(this.lastSampleAt).toISOString() : null,
      streakMinutes: this.continuousMinutes(),
      pending: this.store.pending().length,
      staleMinutes: Math.round(this.staleAskedMs() / 60_000),
      awayAsked: this.awayAsked,
      awayVerdictMinutes: Math.round(this.awayVerdictMs() / 60_000),
      // null = 这趟没有待落账的由头；false = 已递由头、还没落账；true = 补过收尾（这趟不再提）
      awayVerdict: this.awayAt === null ? null : this.awayNagged ? 'nagged' : 'waiting',
      awayVerdictNoted: this.awayAt !== null && this.lastNoteAt >= this.awayAt,
      lookEveryMinutes: this.lookEveryMinutes(),
      lastLookAt: this.lastLookAt ? new Date(this.lastLookAt).toISOString() : null,
      lookDueIn: this.lookEveryMinutes() > 0 && this.lastLookAt
        ? Math.max(0, Math.round((this.lastLookAt + this.lookEveryMinutes() * 60_000 - now) / 60_000))
        : 0,
      focusIdleMinutes: FOCUS_IDLE_MS / 60_000,
      stillMinutes: STILL_WINDOW_MS / 60_000,
      // 键鼠停着时它凭什么判断「他还在看」：画面有没有在变
      screenChanging: this.lastChangeAt ? now - this.lastChangeAt <= STILL_WINDOW_MS : null,
      lastChangeAt: this.lastChangeAt ? new Date(this.lastChangeAt).toISOString() : null,
      printAt: this.printAt ? new Date(this.printAt).toISOString() : null,
      limits: lim,
      saidToday: soft.day === this.dayKey(now) ? soft.count : 0,
      saidLastHour: this.store.countSince(now, 60 * 60_000),
      foreground: current
        ? {
            proc: current.proc,
            title: briefTitle(current.title),
            idleMs: current.idleMs + Math.max(0, now - current.at),
            media: isWatchingVideo(current.proc, current.title),
            at: new Date(current.at).toISOString(),
          }
        : null,
      recentHour: this.samples.length > 2 ? this.recentSummary(now) : '还没什么记录',
    };
  }

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'pending') return this.pendingPanel(method, args);
    if (panel !== 'probe') throw new Error(`不认识的面板：${panel}`);
    if (method === 'status') return this.probeStatus();
    if (method === 'sample') {
      const sample = await this.sampleNow();
      return { ...this.probeStatus(), taken: Boolean(sample) };
    }
    if (method === 'nudge') {
      const opts = (args[0] ?? {}) as { force?: unknown };
      if (opts.force === false) {
        const sample = await this.sampleNow();
        return { ...this.probeStatus(), pushed: false, reason: sample ? '只采样' : '只采样（前台是 Coo 自己，不算数）' };
      }
      const look = await this.lookSample();
      if (!look) return { ...this.probeStatus(), pushed: false, reason: '没采到前台窗口' };
      const result = await this.nudgeNow(look);
      return { ...this.probeStatus(), ...result };
    }
    throw new Error(`不认识的方法：${method}`);
  }

  /**
   * 「待跟进」面板：列出还没结掉的事，也能直接结掉一条，
   * 「提醒过之后多久自己清掉」这项也放在这里改（它只影响这一栏里的东西）。
   */
  private async pendingPanel(method: string, args: unknown[]): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (method === 'close') {
      const opts = (args[0] ?? {}) as { id?: unknown };
      const id = typeof opts.id === 'string' ? opts.id.trim().replace(/^#/, '') : '';
      if (!id) throw new Error('要结掉哪一条？给我编号。');
      const hit = this.store.find({ id });
      if (!hit) throw new Error(`没找到 #${id}（可能已经结掉了）。`);
      this.store.close(hit.id, 'done');
    } else if (method === 'save') {
      const opts = (args[0] ?? {}) as { staleMinutes?: unknown };
      const raw = Number(opts.staleMinutes);
      if (!Number.isFinite(raw)) throw new Error('清掉的时长要填数字（分钟）。');
      const minutes = Math.min(1440, Math.max(5, Math.round(raw)));
      this.cfg.staleMinutes = minutes;
      this.deps.persist?.({ staleMinutes: minutes });
    } else if (method !== 'list') {
      throw new Error(`不认识的方法：${method}`);
    }
    const threads = this.store
      .pending()
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((t) => ({
        id: shortId(t.id),
        text: t.text,
        dueAt: t.dueAt,
        dueText: this.dueText(t.dueAt),
        overdue: t.dueAt <= now,
        asked: Boolean(t.askedAt),
      }));
    return {
      total: threads.length,
      threads,
      clock: this.clockText(now),
      staleMinutes: Math.round(this.staleAskedMs() / 60_000),
    };
  }

  /** 手动赶一条 checkin.activity 出去：不看连续时长、每日次数、间隔那些门。 */
  private async nudgeNow(look: Look): Promise<{ pushed: boolean; reason?: string }> {
    const host = this.host;
    if (!host) return { pushed: false, reason: '还没启动' };
    const now = Date.now();
    const { sample } = look;
    const idleMs = sample.idleMs + Math.max(0, now - sample.at);
    const streak = this.continuousMinutes();
    const shot = await this.takeShot();
    // 刚跟他说过话，半小时内别再补一句「回来啦」
    this.lastBackAt = now;
    const eye =
      `前台是「${sample.proc || '（不知道）'}」，` +
      `窗口标题「${briefTitle(sample.title)}」，` +
      `${idleMs < 60_000 ? '刚刚还在动' : `${Math.round(idleMs / 60_000)} 分钟没动键鼠`}` +
      `${isWatchingVideo(sample.proc, sample.title) ? '（看着片子）' : ''}。`;
    const body =
      `使用者刚在控制台催了一下，是想让你主动说一句话（这是在验证气泡能不能出来）。` +
      (look.selfNow ? '按按钮的时候前台是我自己，' + '所以这一眼是刚才的样子：' : '我采到的：') +
      eye +
      (streak > 0 ? `同一件事已经连着 ${streak} 分钟了。` : '') +
      (shot ? '截了一张图，你自己看。' : '') +
      '随便接一句就行，说给自己听也可以。';
    try {
      await host.pushEvent(
        {
          type: 'checkin.activity',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          tags: ['speak'],
          blobs: shot ? [shot] : undefined,
          meta: { proc: sample.proc, streakMinutes: streak, idleMs, forced: true },
        },
        { trigger: 'flush' },
      );
      return { pushed: true };
    } catch (err) {
      return { pushed: false, reason: msg(err) };
    }
  }

  // ---------- 工具 ----------

  private noteTool(): ToolDef {
    return {
      name: 'checkin_note',
      description:
        '记下一件以后要回头问的事（他约了人、说要修东西、明天要早起这类）。到点会有人提醒你，' +
        '到那时再决定说不说。别把每句话都记成待办，只记真的会想知道结果的那些。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要跟进的事，一句短话，写清他哪天说的什么' },
          afterMinutes: {
            type: 'integer',
            minimum: 1,
            maximum: 10080,
            description: '过多少分钟再来提；不给就两小时后',
          },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const body = typeof args.text === 'string' ? args.text.trim() : '';
        if (!body) return '没写要记什么，那就没记。';
        if (this.store.pending().length >= MAX_PENDING) {
          return `挂着的已经 ${MAX_PENDING} 条了，先清掉几条再记新的。`;
        }
        const minutes = clampInt(args.afterMinutes, 120, 1, 10080);
        const dueAt = Date.now() + minutes * 60_000;
        const thread = this.store.add(body, dueAt);
        // 「他走了这趟，模型有没有留下结论」就靠这个时间点判断
        this.lastNoteAt = Date.now();
        return `记下了（#${shortId(thread.id)}）：${body}。${this.dueText(dueAt)}`;
      },
    };
  }

  private listTool(): ToolDef {
    return {
      name: 'checkin_list',
      description: '看现在还有哪些挂着要跟进的事，以及各自什么时候提。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const list = this.store.pending();
        if (!list.length) return '没有挂着的事。';
        return list
          .map((t) => `#${shortId(t.id)} ${t.text}（${t.askedAt ? '已经问过一次了' : this.dueText(t.dueAt)}）`)
          .join('\n');
      },
    };
  }

  private doneTool(): ToolDef {
    return {
      name: 'checkin_done',
      description: '这件事有结果了、不用再问，标掉它。也可以用来放弃（他明显不想聊那件事）。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '编号，写前几位就行' },
          text: { type: 'string', description: '或者写这件事里的几个字，按原文找' },
        },
      },
      handler: async (args) => {
        const thread = this.store.find({
          id: typeof args.id === 'string' ? args.id : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
        });
        if (!thread) return '没找到对应的那条，可能已经清掉了。';
        this.store.close(thread.id, 'done');
        return `好，这条不提了：${thread.text}`;
      },
    };
  }

  private activityTool(): ToolDef {
    return {
      name: 'checkin_activity',
      description:
        '看看他现在在电脑前做什么：前台是哪个程序、窗口标题、多久没动键鼠，以及最近一小时换过哪些程序。' +
        '只在真的要接话，或者他问「你看得见我在干嘛吗」的时候用，别每轮都念。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.activityReport(),
    };
  }

  private activityReport(): string {
    if (!this.cfg.watchActivity) return '没在观察前台窗口（配置里关掉了）。';
    const current = this.samples[this.samples.length - 1];
    if (!current) return '还没采到，等一下再看。';
    const now = Date.now();
    const idleMs = current.idleMs + Math.max(0, now - current.at);
    const idle =
      idleMs < 60_000 ? '刚刚还在动' : `${Math.round(idleMs / 60_000)} 分钟没动键鼠`;
    const media = isWatchingVideo(current.proc, current.title) ? '（看着片子，键鼠不动是正常的）' : '';
    const every = Math.max(15, this.cfg.sampleSeconds);
    const lines = [
      `现在前台：${current.proc || '（不知道）'}，窗口：${briefTitle(current.title)}，${idle}${media}。`,
      `我是每 ${every >= 60 ? `${Math.round(every / 60)} 分钟` : `${every} 秒`}看一眼的，中间切走切回我看不见。`,
    ];
    if (this.samples.length > 2) {
      lines.push(`连着 ${this.continuousMinutes()} 分钟没换过窗口。`);
      lines.push(`最近一小时：${this.recentSummary(now)}。`);
    }
    return lines.join('\n');
  }

  // ---------- 小工具 ----------

  private minuteOfDay(now: number): number {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: this.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const [h, m] = fmt.format(new Date(now)).split(':');
      return (Number(h) % 24) * 60 + Number(m);
    } catch {
      const d = new Date(now);
      return d.getHours() * 60 + d.getMinutes();
    }
  }

  private clockText(now: number): string {
    const m = this.minuteOfDay(now);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  private dayKey(now: number): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(now));
    } catch {
      const d = new Date(now);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }

  private inQuiet(now: number): boolean {
    const from = parseClock(this.cfg.quietFrom, 30);
    const to = parseClock(this.cfg.quietTo, 270);
    if (from === to) return false;
    const m = this.minuteOfDay(now);
    return from < to ? m >= from && m < to : m >= from || m < to;
  }

  /** 当前程序连续待了多久（分钟）。 */
  private continuousMinutes(): number {
    if (!this.samples.length) return 0;
    const current = this.samples[this.samples.length - 1];
    const maxGap = Math.max(90, this.cfg.sampleSeconds * 3) * 1000;
    let first = current.at;
    for (let i = this.samples.length - 1; i > 0; i -= 1) {
      const prev = this.samples[i - 1];
      const here = this.samples[i];
      if (here.proc !== current.proc) break;
      if (here.at - prev.at > maxGap) break;
      first = prev.at;
    }
    return Math.max(0, Math.round((current.at - first) / 60_000));
  }

  private recentSummary(now: number): string {
    const since = now - 60 * 60_000;
    const counts = new Map<string, number>();
    for (const s of this.samples) {
      if (s.at < since || !s.proc) continue;
      counts.set(s.proc, (counts.get(s.proc) ?? 0) + 1);
    }
    if (!counts.size) return '没什么记录';
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([proc, n]) => `${proc} ${n} 次`)
      .join('、');
  }

  private dueText(dueAt: number): string {
    const now = Date.now();
    if (dueAt <= now + 60_000) return '马上就能提';
    if (this.dayKey(dueAt) === this.dayKey(now)) return `今天 ${this.clockText(dueAt)} 提你`;
    const days = Math.round((dueAt - now) / 86_400_000);
    if (days <= 1) return `明天 ${this.clockText(dueAt)} 提你`;
    return `${days} 天后 ${this.clockText(dueAt)} 提你`;
  }

  /** 上次主动开口之后，他说过话没有。 */
  private spokeSince(sinceMs: number): boolean {
    const host = this.host;
    if (!host) return false;
    try {
      const events = host.store.range({
        origin: 'external',
        fromTs: new Date(sinceMs).toISOString(),
        limit: 200,
      });
      return events.some((e) => typeof e.text === 'string' && SPEAK_RE.test(e.text));
    } catch {
      return false;
    }
  }
}

function parseClock(raw: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function shortId(id: string): string {
  return id.slice(0, 4);
}

/** 桌宠事件里带的触碰种类：poke / pet / throw / drop。 */
function touchKind(e: { meta?: Record<string, unknown> }): unknown {
  const touch = e.meta?.touch;
  if (!touch || typeof touch !== 'object') return undefined;
  return (touch as { kind?: unknown }).kind;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
