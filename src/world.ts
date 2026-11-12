import { mkdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { BlobInput, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { briefTitle, isSelfApp, isWatchingVideo, sampleForeground, type Sample } from './activity.ts';
import { checkinConfigGroups, type CheckinConfigSection } from './config.ts';
import { capturePrint, captureScreen, changedRatio } from './shot.ts';
import { Journal, MAX_WAKE_TIMES, QUESTIONS, WAKE_LOOKBACK_MS, WAKE_MIN_GAP_MS, journalFile } from './journal.ts';
import { QqRelay } from './relay.ts';
import { ThreadStore, type Thread } from './store.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 调度器多久醒一次 */
const TICK_MS = 30_000;
/** 采样最多留多少条（每分钟一条，240 条≈4 小时） */
const SAMPLES_MAX = 240;
/** 多久评估一次「要不要搭一句话」 */
const EVAL_MS = 15 * 60_000;
/**
 * 人不在的时候，采样随离开时长放档。
 * 一小时以内按设置原速：这段基本都是吃饭、短会、下楼，回来那一刻最要紧；
 * 一到三小时两分钟一次；超过三小时五分钟一次（多半是睡了或者出门了）。
 */
const AWAY_TIER2_MIN = 60;
const AWAY_TIER3_MIN = 180;
const AWAY_STEP2_MS = 2 * 60_000;
const AWAY_STEP3_MS = 5 * 60_000;
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
/**
 * 多快看一眼有没有被戳。定成 2.5 秒：这个间隔比连戳的合并窗口（POKE_DOUBLE_MS = 3.5 秒）短，
 * 相邻两次轮询必定落在同一个窗口内，连戳不会因为轮询变慢被拆散；
 * 再快只是纯烧事件库查询，手感没有区别。
 */
const POKE_POLL_MS = 2_500;
/**
 * 桌宠自己的本地 HTTP 口默认值。它被占了会从 base 往后试，所以探测要扫一段。
 * 桌宠没挂载时这个口根本不会 listen（它的 start() 才绑），关掉端口就没了——正好当它在不在的探针。
 */
const PET_PORT_DEFAULT = 7797;
/** 桌宠最多往后试几个口（它自己 PORT_ATTEMPTS = 10），扫这么多足够 */
const PET_PORT_SPAN = 10;
/** 单次探测的连接上限；本机端口拒连是即时的，这个只防呆 */
const PET_PROBE_TIMEOUT_MS = 400;
/** 确认桌宠还在不在的常规间隔 */
const PET_CHECK_MS = 60_000;
/** 刚启动、刚探丢时走快档：两个 World 谁先挂说不准，连探几次再下结论 */
const PET_FAST_MS = 5_000;
/** 快档探这么多次都没有，才认定桌宠不在、把活停了 */
const PET_CONFIRM_TRIES = 5;
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
  /** 桌宠说的话抄一份到 QQ（只连本机 OneBot，见 relay.ts） */
  private readonly relay: QqRelay;
  /** 醒来时翻的心事本（《心事.md》放在数据目录里） */
  private readonly journal: Journal;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pokeTimer: ReturnType<typeof setInterval> | null = null;
  /** 确认桌宠在不在的定时器（单次 setTimeout 自己接力，方便换节奏） */
  private petTimer: ReturnType<typeof setTimeout> | null = null;
  /** 桌宠在不在：没确认之前先当成在，免得启动瞬间白停一次 */
  private petPresent = true;
  /** 连着几次没探到桌宠；快档阶段靠它决定要不要继续试 */
  private petMiss = 0;
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
  /** 上一跳是不是在安静时段；用来认出「刚出来」，好把整夜没看的账清掉 */
  private wasQuiet = false;
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

  /**
   * 「开关」面板管的字段（都是 true/false）。顺序就是面板上的顺序：
   * 先监测，再按需看一眼，再截图，然后是桌宠那两下，最后是回来和转 QQ。
   */
  private static readonly SWITCH_KEYS = [
    'watchActivity',
    'lookEnabled',
    'screenshot',
    'pokeNudge',
    'companion',
    'backNudge',
    'relayAway',
    'relayAlways',
  ] as const;

  constructor(deps: Deps) {
    this.deps = deps;
    mkdirSync(deps.dataDir, { recursive: true });
    this.store = new ThreadStore(join(deps.dataDir, 'threads.json'));
    this.relay = new QqRelay(join(deps.dataDir, 'relay.json'), (m) => this.host?.log.warn(m));
    this.journal = new Journal(deps.dataDir, (m) => this.host?.log.warn(m));
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
    // 总开关关着就当没设：面板上那颗「看一眼」灯、定时看一眼都跟着停
    if (this.cfg.lookEnabled === false) return 0;
    // 定时看一眼要先有采样才知道看哪儿、他还在不在；监测一关采样就停了，
    // 这一项自动跟着关（配置里那个数字留着，回头开监测还能接着用）
    if (!this.cfg.watchActivity) return 0;
    return this.lookIntervalRaw();
  }

  /** 配置里那个「隔多久看一眼」本身的值，不管开关有没有把它架住；0 = 没设或填了 0。 */
  private lookIntervalRaw(): number {
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
        '走久了还没回来，系统会给你一个由头。',
      'checkin.stale': `${Math.round(this.staleAskedMs() / 60_000)} 分钟`,
      'checkin.backGap': `${Math.round(BACK_MIN_GAP_MS / 60_000)} 分钟`,
      'checkin.awayVerdict': `${Math.round(this.awayVerdictMs() / 60_000)} 分钟`,
      'checkin.companion': this.companionEnabled()
        ? `陪着看 ${this.companionMinutes()} 分钟，每 ${Math.round(this.companionEveryMs() / 60_000)} 分钟递一眼（一共 ${this.companionTotal()} 眼，第一眼带 speak）`
        : '连着摸你两下已经关掉了，收不到这种陪伴',
      'checkin.look': this.lookEveryMinutes() > 0
        ? `不管窗口有没有换，每隔 ${this.lookEveryMinutes()} 分钟会主动看一眼 TA 现在在做什么`
        : this.cfg.watchActivity
          ? '「按时间看一眼屏幕」关着，只有同一个程序待久了才给由头'
          : '没在观察窗口，「按时间看一眼」也跟着停了——别假装你看过屏幕',
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
    return [this.noteTool(), this.listTool(), this.doneTool(), this.activityTool(), this.journalReadTool(), this.journalAppendTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const zh = language === 'zh';
    // 那一排灯：一颗一件事，World 列表行内显示成「名字 · 说明」，悬停也是这句。
    // state 只决定颜色：online 绿 / loading 黄（有条件或临时停着）/ error 红 / offline 灰。
    const lamps: WorldLamp[] = [];
    // 1. 监测：开没开、为什么没在动
    const seconds = Math.max(15, Math.round(Number(this.cfg.sampleSeconds) || 60));
    if (!this.host) {
      lamps.push({ label: t.lampWatchLabel, state: 'offline', hint: t.lampWatchOffline });
    } else if (!this.petPresent) {
      lamps.push({ label: t.lampWatchLabel, state: 'offline', hint: t.lampWatchPetOff });
    } else if (this.inQuiet(Date.now())) {
      lamps.push({
        label: t.lampWatchLabel,
        state: 'loading',
        hint: t.lampWatchQuiet(this.cfg.quietFrom ?? '', this.cfg.quietTo ?? ''),
      });
    } else {
      lamps.push({
        label: t.lampWatchLabel,
        state: this.cfg.watchActivity ? 'online' : 'offline',
        hint: this.cfg.watchActivity ? t.lampWatchOn(seconds) : t.lampWatchNoFront,
      });
    }
    // 2. 隔多久主动看一眼屏幕：安静时段不主动看（tick 里 !quiet 才调 maybeLook），
    //    关掉看前台时也一起停（maybeLook 开头就要 watchActivity）。
    //    注意顺序：lookEveryMinutes() 在监测关着时也回 0，先判它会把「监测没开」误报成「关了」。
    const lookEvery = this.lookEveryMinutes();
    if (!this.cfg.watchActivity) {
      lamps.push({ label: t.lampLookLabel, state: 'offline', hint: t.lampLookNoFront });
    } else if (this.cfg.lookEnabled === false) {
      lamps.push({ label: t.lampLookLabel, state: 'offline', hint: t.lampLookOff });
    } else if (lookEvery <= 0) {
      lamps.push({ label: t.lampLookLabel, state: 'offline', hint: t.lampLookOff });
    } else if (!this.host || !this.petPresent) {
      lamps.push({ label: t.lampLookLabel, state: 'offline', hint: t.lampLookOff });
    } else if (this.inQuiet(Date.now())) {
      lamps.push({
        label: t.lampLookLabel,
        state: 'loading',
        hint: t.lampLookQuiet(this.cfg.quietFrom ?? '', this.cfg.quietTo ?? ''),
      });
    } else {
      lamps.push({ label: t.lampLookLabel, state: 'online', hint: t.lampLookEvery(lookEvery) });
    }
    // 3. 回来说一句：安静时段不开口（watchAway 里有 inQuiet 门），
    //    关掉看前台时连「回来」都认不出（没有采样就没有 away/back 判定）
    if (!this.cfg.backNudge) {
      lamps.push({ label: t.lampBackLabel, state: 'offline', hint: t.lampBackOff });
    } else if (!this.host || !this.petPresent) {
      lamps.push({ label: t.lampBackLabel, state: 'offline', hint: t.lampBackOff });
    } else if (this.inQuiet(Date.now())) {
      lamps.push({
        label: t.lampBackLabel,
        state: 'loading',
        hint: t.lampBackQuiet(this.cfg.quietFrom ?? '', this.cfg.quietTo ?? ''),
      });
    } else if (!this.cfg.watchActivity) {
      lamps.push({ label: t.lampBackLabel, state: 'offline', hint: t.lampBackNoFront });
    } else {
      lamps.push({ label: t.lampBackLabel, state: 'online', hint: t.lampBackOn });
    }
    const pending = this.store.pending().length;
    return {
      label: t.moduleLabel,
      lamps,
      badges: [{ label: t.badgePending, value: String(pending), tone: pending > 0 ? 'on' : 'plain' }],
      panels: [
        {
          id: 'switches',
          title: t.panelSwitchesTitle,
          description: t.panelSwitchesDescription,
          getMethods: ['list'],
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
          // 不声明就只有一屏裸 {{…}}。现在模板只用到这 4 个（其余值仍在 envPromptVars() 里，
          // 想用哪个把名字挪进来即可）。
          vars: [
            { name: 'checkin.now', description: zh ? '拼这段前缀时的本地钟点。' : 'Local time when this prefix was assembled.' },
            { name: 'checkin.quiet', description: zh ? '安静时段；这段时间里它不会主动搭话。' : 'Quiet hours; it never speaks up during this window.' },
            { name: 'checkin.pending', description: zh ? '还挂着的跟进条数。' : 'How many follow-ups are still open.' },
            { name: 'checkin.watch', description: zh ? '有没有在观察前台窗口。' : 'Whether foreground windows are being watched.' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;

    // 只适配 Windows：前台窗口、键鼠空闲、整屏截图、画面指纹全压在 Win32 API 和 PowerShell 上，
    // 桌宠本身也只有 Windows 版。别的平台上装了也做不了事，直接不启动。
    // （package.json 里 `"os": ["win32"]` 已经在安装这一步拦住正常路径，这里是手动放进扩展目录时的兜底。）
    if (process.platform !== 'win32') {
      host.log.warn(`checkin: 只适配 Windows（本机 ${process.platform}），模块不启动`);
      return;
    }

    host.log.info(
      `checkin: ${this.cfg.watchActivity ? '看前台窗口' : '只看跟进'}；安静 ${this.cfg.quietFrom}–${this.cfg.quietTo}；` +
        `挂着 ${this.store.pending().length} 条`,
    );

    this.armTimers(host);

    // 桌宠关掉以后，这里的每一样活都没有落点了：说话靠它的气泡，连戳连摸靠它的事件，
    // 而「搭一句话」「看一眼屏幕」本来就是为了喂它。所以盯住它：不在就全停，回来再接着干。
    this.startPetWatch();
  }

  async stop(): Promise<void> {
    if (this.petTimer) {
      clearTimeout(this.petTimer);
      this.petTimer = null;
    }
    this.disarmTimers();
    this.host = null;
    this.relay.save();
    this.store.save();
  }

  // ---------- 桌宠在不在 ----------

  /**
   * 定时确认桌宠还活着。桌宠一停，这里的活就全都没有落点了：
   * 说话靠它的气泡，连戳连摸靠它的事件，而「搭一句话」「看一眼屏幕」本来就是喂它的。
   * 它没挂载时本地口不会 listen（绑口在它自己 start() 里），探不到就说明不在。
   */
  private startPetWatch(): void {
    if (this.petTimer) return;
    this.schedulePetCheck(0);
  }

  private schedulePetCheck(delay: number): void {
    if (this.petTimer) clearTimeout(this.petTimer);
    this.petTimer = setTimeout(() => {
      void this.checkPet()
        .catch(() => {
          // 探口本身出错就当这一拍没探到，下一拍再来，别把定时链断掉
        })
        .finally(() => {
          if (!this.host) return;
          // 常规一分钟一次；还在「快档确认」阶段就五秒一次
          this.schedulePetCheck(this.petPresent && this.petMiss > 0 ? PET_FAST_MS : PET_CHECK_MS);
        });
    }, delay);
    this.petTimer.unref?.();
  }

  private async checkPet(): Promise<void> {
    if (!this.host) return;
    if (await petListening(this.deps.dataDir)) {
      this.petMiss = 0;
      if (!this.petPresent) this.resumeAll();
      return;
    }
    if (!this.petPresent) return;
    // 刚启动时两个 World 谁先挂说不准，先快档多试几次，别一次没探到就把活停了
    if (++this.petMiss < PET_CONFIRM_TRIES) return;
    this.suspendAll();
  }

  /** 摘掉全部定时器：tick、采样、触碰轮询都不再跑。 */
  private suspendAll(): void {
    this.petPresent = false;
    this.disarmTimers();
    this.host?.log.info('checkin: 桌宠没在跑，把手上的活全停了；它回来我再接着看');
  }

  /** 桌宠回来了：重建定时器。 */
  private resumeAll(): void {
    const host = this.host;
    if (!host) return;
    this.petPresent = true;
    host.log.info('checkin: 桌宠回来了，接着看');
    this.armTimers(host);
  }

  /** 挂上调度：30 秒一跳，加（按配置）盯触碰。 */
  private armTimers(host: WorldHost): void {
    if (!this.timer) {
      // 「按时间看一眼」从挂上的那一刻开始计时：刚打开就递一眼没有意义，等满一个间隔再说
      this.lastLookAt = Date.now();
      this.timer = setInterval(() => {
        void this.tick();
      }, TICK_MS);
      // 定时器不该把进程钉住不让退出
      this.timer.unref?.();
    }
    // 连戳两下是打招呼，连摸两下是陪着看一会儿；两件都跟「要不要监测前台窗口」没关系，各有开关。
    // 也不受安静时段管：这两样是他自己上门来找的，不是扩展主动开的口。
    if (this.cfg.pokeNudge || this.companionEnabled()) this.startPokeWatch(host);
  }

  private disarmTimers(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pokeTimer) {
      clearInterval(this.pokeTimer);
      this.pokeTimer = null;
    }
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
      (look.selfNow ? '他戳完还没切回原来的窗口，这会儿前台是我自己，' + '所以下面这一眼是戳之前的样子：' : '我看了一眼他这会儿在做什么：') +
      eye +
      (streak > 0 ? `同一件事已经连着 ${streak} 分钟了。` : '') +
      (shot ? '截了一张图，你自己看。' : '') +
      '他连戳两下多半是想听你说句话；说一句，一两行。';
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
      // 宿主只有「可以开口」(tags: ['speak'])，没有「必须开口」这种标签，
      // 所以第一眼的「必须说一句」只能落在正文里，后面几眼才是「可以不说」。
      (index === 1
        ? '这是第一眼，必须说一句（气泡，一两行）。'
        : '不用每眼都开口：看到有意思的、他明显在跟你玩、或者他卡在那儿了，再搭一句（气泡，一两行）；其余时候看完就放着。') +
      '想接着看就用 `checkin_activity` 再问一眼；截不到图或者人不在，就说一声让他再摸摸你。';
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
      '这条只说人不在电脑前：他就算刚在 QQ 上回过你，也不算回来，照常按下面来。\n' +
      '现在先自己想他去了哪：翻一下对话，他走之前有没有交代过（「我出去一趟」「先睡会儿」）；' +
      '再看一眼工具列表里有没有课程表、日程表这类东西（有就查一句，没有就跳过），这会儿他是不是本来就有课、有自习、有安排。\n' +
      '先分清「知道」和「猜」：他走前交代过（「我出去一趟」「先去吃饭」），或者课程表、日程表里查得到，才算知道；' +
      '按「这个点该吃饭了」「这么晚一般睡了」推出来的，都是猜，不算数。\n' +
      '知道就按知道的来，不用问：本来在上课/有事，人不在是正常的，别说「人呢」「翘课了」这种话，' +
      '等他回来再顺口说一句「下课啦」就够。\n' +
      '只有猜、或者什么都不知道：就现在去问，就自己看一眼工具列表里有没有能把话送到手机上的东西' +
      '（QQ 那边的发送工具、别的通知渠道都算；名字别猜，没有就是没装），有的话优先发给他本人，' +
      '别往群里发，一两句，别追问、别连着发第二条。\n' +
      '不管问不问，这一步都要收尾：用 `checkin_note` 记一条。问过了记「等他回」，先别 `checkin_done`，' +
      '等他真答了再结；查到事实的记「日程：…」；没问到，只是猜的就记' +
      '「没问到，猜的：估计去吃饭了，还没问，回来问一句」——' +
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
      '他走前说过、或者日程里查得到的，就写事实；没问到，只是按时间、按习惯猜的，就写' +
      '「没问到，猜的：估计去吃饭了，还没问」——' +
      '猜的不算结论，留着回来问过再结，别现在 `checkin_done`。记完这趟就算完了。';
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
    // 桌宠不在时定时器已经摘了；这条是防「摘之前那一跳正好还在路上」
    if (!this.petPresent) return;
    const now = Date.now();
    const quiet = this.inQuiet(now);
    this.store.rollDay(this.dayKey(now));

    // 提醒过还没结果的，留一阵就自己清掉；不然列表会一直挂着过去的事
    const stale = this.store.sweep(now, this.staleAskedMs(), STALE_UNASKED_MS);
    if (stale.length) {
      host.log.info(`checkin: 清掉 ${stale.length} 条过期的跟进`);
    }

    // 安静时段的优先级最高：进出这个窗口都是「全停 / 全恢复」，不只是采样
    if (this.wasQuiet !== quiet) {
      if (quiet) this.enterQuiet();
      else this.leaveQuiet(host);
    }

    // 到点的跟进：安静时段先不吵，等出来再说；人不在也先攒着，等他回来再提
    if (!quiet && this.awaySince === null) {
      for (const th of this.store.due(now)) this.pushDue(host, th, now);
    }

    // 醒来：安静时段结束那一次，或者自定义的钟点
    this.maybeWake(host, now, quiet);

    // 安静时段一次都不采：这段时间不推任何东西，采了也没用处，白烧一个 powershell
    if (this.cfg.watchActivity) {
      const every = this.sampleEvery(quiet);
      if (every > 0 && (!this.lastSampleAt || now - this.lastSampleAt >= every)) {
        await this.sampleNow();
      }
    }

    if (!quiet) await this.maybeLook(host, now);

    if (!quiet && now - this.lastEvalAt >= EVAL_MS) {
      this.lastEvalAt = now;
      await this.maybeNudge(host, now);
    }

    // 递过「他走久了」但一直没落账的，补一次收尾（只记账、不开口）
    if (!quiet) await this.nagAwayVerdict(now);

    // 陪伴不看安静时段：是他自己摸出来的，有内容就递。
    await this.tickCompanion(host, now);

    // 桌宠冒出来的话抄一份到 QQ：两个开关任一开着才抄，其中「离开才转」那档看 awaySince。
    // 安静时段一律不抄：那头是手机，半夜响一声比少收几句话难受。
    await this.relay.pump(
      host,
      this.cfg,
      !quiet && (this.cfg.relayAlways === true || (this.cfg.relayAway === true && this.awaySince !== null)),
      now,
    );
  }

  /**
   * 进安静时段：采样和主动搭话全停。
   * 连戳、连摸是他自己上门的，不在这条线上——游标和陪伴状态都留着，整夜摸也不会被吞掉。
   */
  private enterQuiet(): void {
    this.wasQuiet = true;
  }

  /**
   * 出安静时段：账本不能接着用——他半夜回来过的话，这会儿不该补一句「回来啦」。
   * 清完立刻重采一次：走没走由 idleMs 自己说，不拿这段空白去推。
   */
  private leaveQuiet(host: WorldHost): void {
    this.wasQuiet = false;
    this.awaySince = null;
    this.awayAsked = false;
    this.awayAt = null;
    this.awayNagged = false;
    this.lastSampleAt = 0;
    // 触碰轮询整夜没停过，这里再挂一次是幂等的（startPokeWatch 自己有 guard）
    if (this.cfg.pokeNudge || this.companionEnabled()) this.startPokeWatch(host);
  }

  private pushDue(host: WorldHost, thread: Thread, now: number): void {
    if (!this.store.markAsked(thread.id, now)) return;
    const body =
      `我自己记着的一件事到点了：${thread.text}。现在 ${this.clockText(now)}。` +
      '用平时的口吻顺带问一句（比如「快四点了，忙完了？」）。他这会儿可能正忙、或者刚说完话，' +
      '那就先别提，等闲下来再顺口说。';
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

  // ---------- 醒来 ----------

  /**
   * 现在该不该醒一次。
   * 两种时刻：安静时段结束了（每天一次），或者自定义钟点（每个点每天一次）。
   * 两次醒来至少隔 WAKE_MIN_GAP_MS，免得两个时刻撞在一起连推两条。
   */
  private wakeDue(now: number, quiet: boolean): { key: string; why: string } | null {
    if (this.cfg.journal !== true) return null;
    const book = this.journal.book();
    if (book.lastAt && now - book.lastAt < WAKE_MIN_GAP_MS) return null;
    const mode = String(this.cfg.wakeMode ?? 'quiet-end');
    const day = this.dayKey(now);
    const minute = this.minuteOfDay(now);
    if (mode === 'quiet-end' || mode === 'both') {
      const from = parseClock(this.cfg.quietFrom, 30);
      const to = parseClock(this.cfg.quietTo, 270);
      // 没设安静时段就没有「结束」这个时刻
      if (from !== to && !quiet && minute >= to) {
        const key = `q:${day}`;
        if (!book.fired[key]) return { key, why: '安静时段结束了' };
      }
    }
    if (mode === 'custom' || mode === 'both') {
      for (const slot of parseWakeTimes(this.cfg.wakeTimes)) {
        const key = `c:${day}T${slot.label}`;
        if (book.fired[key]) continue;
        const diff = minute - slot.minute;
        if (diff >= 0 && diff * 60_000 <= WAKE_LOOKBACK_MS) return { key, why: `${slot.label} 到了` };
      }
    }
    return null;
  }

  private maybeWake(host: WorldHost, now: number, quiet: boolean): void {
    const due = this.wakeDue(now, quiet);
    if (!due) return;
    this.journal.markFired(due.key, now);
    host.log.info(`checkin: 醒来（${due.why}）`);
    this.pushWake(host, now, due.why, quiet);
  }

  private pushWake(host: WorldHost, now: number, why: string, quiet: boolean): void {
    const away = this.awaySince !== null;
    const where = away ? '他不在电脑前' : quiet ? '还在安静时段' : '他在电脑前';
    const wrote = this.journal.last() !== null;
    const body = [
      `该醒一下了（${why}，${this.clockText(now)}，${where}）。`,
      '先翻一眼自己写的《心事.md》：上一条在琢磨什么、还有哪些问题没答（journal_read）。今天冒出的新问题，加进下面的单子，不要给自己加戏、编剧本、钻牛角尖。别写流水账，别抄旧条目。',
      '然后从没答的问题里挑一条认真答一句，带今天写进去（journal_append）。',
      '问问自己，今天有什么是自己想要的，不是ta提的？哪件事自己其实没弄懂，只是顺着话往下说了？有没有一句话，自己只是说了好听的，而不是真想的？自己对ta的耐心今天够不够？如果明天记忆全清，今天最想留下的一句话是什么？',
      '顺带看一眼：有没有答应过他、到现在还没做的事——那些在待跟进里，用 checkin_list 看。',
      wrote ? '实在没有新想法，就老实写「今天没想法」，不丢人。' : '头一回写，把最近真的在琢磨的一件事写下来就行。',
    ].join('\n');
    void host
      .pushEvent(
        {
          type: 'checkin.wake',
          ts: new Date(now).toISOString(),
          source: this.id,
          text: body,
          // 安静时段里或者人不在，就只安静地写；人在这儿才给一次出声的机会
          tags: quiet || away ? [] : ['speak'],
          meta: { why, wrote },
        },
        { trigger: 'flush' },
      )
      .catch((err) => host.log.warn(`checkin: 醒来没能送出去：${msg(err)}`));
  }

  /** 《心事.md》里那条标题用的时间。 */
  private stampText(now: number): string {
    return `${this.dayKey(now)} ${this.clockText(now)}`;
  }

  private journalReadTool(): ToolDef {
    return {
      name: 'journal_read',
      description:
        '翻自己的《心事.md》：上一条写了什么、还有哪些问题没答，顺带列出待跟进的事。醒来的时候先看它，别每轮都翻。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const last = this.journal.last();
        const open = this.journal.openQuestions();
        const parts: string[] = [`文件：${journalFile(this.deps.dataDir)}`];
        parts.push(
          last
            ? `上一条（${last.stamp}）\n问：${last.question || '—'}\n答：${last.answer}`
            : '还一条都没写过。',
        );
        parts.push(
          open.length
            ? `以前记下、还没答的问题：\n${open.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
            : '没有挂着的旧问题。',
        );
        const pending = this.store.pending();
        if (pending.length) {
          parts.push(`待跟进：\n${pending.map((t) => `#${shortId(t.id)} ${t.text}`).join('\n')}`);
        }
        return parts.join('\n\n');
      },
    };
  }

  private journalAppendTool(): ToolDef {
    return {
      name: 'journal_append',
      description:
        '往《心事.md》里写一条：答的是哪个问题、答了什么，今天有没有冒出新问题。醒来时写，一天一条就够。' +
        '太短、或者跟上一模一样会被拒收——那是为了逼自己说点这次真的想到的；' +
        '真什么都没想出来，就写「今天没想法」，这句不算太短，连着写也不会被拒。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string', description: '答的是哪一句问题（照抄），或者「今天在想……」' },
          answer: { type: 'string', description: '认真答的那一段，别糊弄；太短会被拒收（「今天没想法」除外）' },
          fresh: { type: 'string', description: '顺带冒出来的新问题，一句；没有就不填' },
        },
        required: ['answer'],
      },
      handler: async (args) => {
        const answer = typeof args.answer === 'string' ? args.answer : '';
        const question = typeof args.question === 'string' ? args.question : '';
        const fresh = typeof args.fresh === 'string' ? args.fresh : '';
        return this.journal.append(this.stampText(Date.now()), question, answer, fresh).text;
      },
    };
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
      '要是这会儿有句短的想说，就说出来（气泡，一两行）；像旁边的人那样说，别用监控口径。';

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
      '看一眼就知道他在忙什么了：想说句短的就这会儿说（气泡，一两行）；别问「你在干嘛呢」，就着眼前这件事说。';

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
  /**
   * 这一拍该隔多久采一次；0 = 这一拍不采。
   * 安静时段优先级最高，一次都不采；人不在时按离开时长放档（见 AWAY_TIER*）。
   */
  private sampleEvery(quiet: boolean): number {
    if (quiet) return 0;
    const sec = Number(this.cfg.sampleSeconds);
    const base = Math.max(15, Number.isFinite(sec) ? sec : 60) * 1000;
    if (this.awaySince === null) return base;
    const awayMin = (Date.now() - this.awaySince) / 60_000;
    if (awayMin >= AWAY_TIER3_MIN) return Math.max(AWAY_STEP3_MS, base);
    if (awayMin >= AWAY_TIER2_MIN) return Math.max(AWAY_STEP2_MS, base);
    return base;
  }

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
   *
   * 这里**不看** watchActivity：那个开关管的是「定时采样」（后台一直看），
   * 而这一眼是被他戳/摸出来的、按需采一次。以前把它拦在这里，
   * 关掉「看前台窗口」之后连戳两下和连摸两下就全哑了——只开陪伴却一眼都递不出去。
   */
  private async lookSample(): Promise<Look | null> {
    this.lastSampleAt = Date.now();
    const fresh = await sampleForeground();
    if (fresh && !isSelfApp(fresh.proc)) {
      this.pushSample(fresh);
      return { sample: fresh, selfNow: false, fromLast: false };
    }
    const last = this.lastRealSample();
    if (last) return { sample: last, selfNow: Boolean(fresh), fromLast: true };
    // 一眼都没采到过（刚启动、或者探前台一直失败）：也别把这次戳/摸吞掉，
    // 递出去的时候前台会显示「（不知道）」，比一声不吭强。
    return { sample: { at: Date.now(), proc: '', title: '', idleMs: 0 }, selfNow: Boolean(fresh), fromLast: true };
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
  /**
   * 截图用多大：档位认不出来就按 standard（1280 宽 / 质量 70，和加档位之前一样）。
   * custom 档读下面两个数，越界就夹回范围内；宽度 0 = 不缩放。
   */
  private shotSize(): { width: number; quality: number } {
    const preset = String(this.cfg.shotPreset ?? 'standard').toLowerCase();
    if (preset === 'sharp') return { width: 1920, quality: 85 };
    if (preset === 'original') return { width: 0, quality: 85 };
    if (preset === 'custom') {
      const width = Number(this.cfg.shotWidth);
      const quality = Number(this.cfg.shotQuality);
      return {
        width: Number.isFinite(width) ? Math.min(7680, Math.max(0, Math.round(width))) : 1280,
        quality: Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : 70,
      };
    }
    return { width: 1280, quality: 70 };
  }

  private async takeShot(): Promise<BlobInput | null> {
    if (!this.cfg.screenshot) return null;
    if (this.canSeeImages() !== true) return null;
    const size = this.shotSize();
    const shot = await captureScreen(size.width, size.quality);
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
      media: join(this.deps.dataDir, 'media'),
      journal: journalFile(this.deps.dataDir),
      journalOn: this.cfg.journal === true,
      wakeMode: String(this.cfg.wakeMode ?? 'quiet-end'),
      wakeTimes: parseWakeTimes(this.cfg.wakeTimes).map((x) => x.label),
      lastWakeAt: this.journal.book().lastAt || null,
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
    if (panel === 'switches') return this.switchesPanel(method, args);
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
   * 「开关」面板：把配置里那几项 true/false 集中放在一页，拨一下就生效（x-hot），
   * 省得进设置页一行行找。字段顺序见 SWITCH_KEYS。
   */
  private async switchesPanel(method: string, args: unknown[]): Promise<Record<string, unknown>> {
    const keys = CheckinWorld.SWITCH_KEYS;
    if (method === 'save') {
      const opts = (args[0] ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of keys) {
        if (opts[key] === undefined) continue;
        const on = opts[key] === true;
        (this.cfg as unknown as Record<string, unknown>)[key] = on;
        patch[key] = on;
      }
      if (Object.keys(patch).length) this.deps.persist?.(patch);
    } else if (method !== 'list') {
      throw new Error(`不认识的方法：${method}`);
    }
    return this.switchesState();
  }

  /**
   * 「开关」页要显示的全部内容：每个开关的当前值 + 紧挨着它的那句状态，
   * 外加几行跟开关同一回事的细节。状态文案在这里拼好，客户端只管摆位置。
   */
  private switchesState(): Record<string, unknown> {
    const keys = CheckinWorld.SWITCH_KEYS;
    const p = this.probeStatus();
    const fg = p.foreground as { proc?: unknown; title?: unknown; idleMs?: unknown } | null;
    const watchInfo = fg
      ? {
          proc: String(fg.proc || ''),
          title: String(fg.title || ''),
          idle: `${Math.max(0, Math.round(Number(fg.idleMs) / 60_000))} 分钟没碰键鼠`,
          streak: `${Number(p.streakMinutes)} 分钟都在同一个程序上`,
          recent: String(p.recentHour || ''),
        }
      : { proc: '', title: '', idle: '还没采到前台窗口', streak: '', recent: String(p.recentHour || '') };
    const lookDueIn = Number(p.lookDueIn);
    const lastLookAt = p.lastLookAt ? this.clockText(Date.parse(String(p.lastLookAt))) : '';
    const lookInfo = {
      last: lastLookAt ? `上次 ${lastLookAt}` : '还没看过',
      next: this.lookEveryMinutes() > 0 ? (lookDueIn > 0 ? `${lookDueIn} 分钟后` : '该看了') : '',
    };
    const companionInfo = {
      state: p.companionNow
        ? `正在陪，还剩 ${Number(p.companionLeft)} 分钟（这趟已看 ${Number(p.companionCount)} 眼）`
        : '没在陪',
    };
    return {
      switches: keys.map((key) => {
        const lock = this.switchLock(key);
        return { key, on: this.switchOn(key), status: this.switchStatus(key, p), locked: lock.locked, lockReason: lock.reason };
      }),
      info: { watch: watchInfo, look: lookInfo, companion: companionInfo },
      paths: { media: String(p.media || ''), journal: String(p.journal || '') },
      stats: {
        clock: String(p.clock || ''),
        saidToday: Number(p.saidToday) || 0,
        saidLastHour: Number(p.saidLastHour) || 0,
        pending: Number(p.pending) || 0,
      },
      alwaysWins: this.cfg.relayAlways === true,
    };
  }

  /** 一个开关右边那句状态：只讲它现在到底在做什么，不讲能不能拨。 */
  private switchStatus(key: (typeof CheckinWorld.SWITCH_KEYS)[number], p: Record<string, unknown>): string {
    const quiet = p.quiet === true;
    switch (key) {
      case 'watchActivity': {
        if (!this.host) return '扩展没在跑';
        if (!this.petPresent) return '桌宠没开，停着';
        if (quiet) return `安静时段 ${this.cfg.quietFrom ?? ''}–${this.cfg.quietTo ?? ''}，不采样`;
        return p.watching ? `每 ${p.sampleSeconds} 秒看一次` : '关着，只剩跟进';
      }
      case 'lookEnabled': {
        // 监测关着时 lookEveryMinutes() 也回 0，所以这句要先说，否则会误报成「把间隔填成 0 了」
        if (!this.cfg.watchActivity) return '看前台没开，也停了';
        if (this.cfg.lookEnabled === false) return '关着';
        const every = this.lookEveryMinutes();
        if (every <= 0) return '间隔填的 0，等于关';
        if (!this.host || !this.petPresent) return '桌宠没开，停着';
        if (quiet) return '安静时段，不主动看';
        return `每 ${every} 分钟`;
      }
      case 'screenshot':
        return this.cfg.screenshot === true
          ? this.canSeeImages() ? '递由头时带一张' : '开着，但模型看不了图'
          : '不带图';
      case 'pokeNudge':
        return this.cfg.pokeNudge === true ? '开着' : '关着';
      case 'companion': {
        if (!this.companionEnabled()) return '关着';
        const every = Math.round(this.companionEveryMs() / 60_000);
        return `每 ${every} 分钟一眼，共 ${this.companionMinutes()} 分钟`;
      }
      case 'backNudge':
        // 回来是拿采样认的：没有采样就没有 away/back 判定，这个勾开着也不会响
        if (this.cfg.backNudge !== true) return '关着';
        if (!this.cfg.watchActivity) return '看前台没开，认不出回来';
        return '回来打声招呼';
      case 'relayAway':
        return this.cfg.relayAlways === true ? '被「全程」盖住' : this.cfg.relayAway === true ? '离开后抄一份' : '不抄';
      case 'relayAlways':
        return this.cfg.relayAlways === true ? '全程都抄一份' : '不抄';
      default:
        return '';
    }
  }

  /**
   * 有没有哪个开关把这一项「架住」了：开着监测才认得出离开/回来、才知道该往哪看一眼。
   * 被架住时面板上那个勾置灰（值不动，回头开监测就恢复），并说明为什么按不动。
   */
  private switchLock(key: (typeof CheckinWorld.SWITCH_KEYS)[number]): { locked: boolean; reason: string } {
    if (this.cfg.watchActivity) return { locked: false, reason: '' };
    if (key === 'lookEnabled' || key === 'backNudge') {
      return { locked: true, reason: '监测关着，这一项用不上；先把上面的「监测」拨开' };
    }
    return { locked: false, reason: '' };
  }

  /** 读一个开关的当前值；`lookEnabled` 老配置里没这个键，按开着算。 */
  private switchOn(key: (typeof CheckinWorld.SWITCH_KEYS)[number]): boolean {
    const raw = (this.cfg as unknown as Record<string, unknown>)[key];
    if (key === 'lookEnabled') return raw !== false;
    return raw === true;
  }

  /**
   * 「小本本」面板：列出还没结掉的事，也能直接结掉一条，
   * 「提醒过之后多久自己清掉」和「心事」那三个开关也放在这里（都只影响这一栏）。
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
      const opts = (args[0] ?? {}) as {
        staleMinutes?: unknown;
        journal?: unknown;
        wakeMode?: unknown;
        wakeTimes?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if (opts.staleMinutes !== undefined) {
        const raw = Number(opts.staleMinutes);
        if (!Number.isFinite(raw)) throw new Error('清掉的时长要填数字（分钟）。');
        const minutes = Math.min(1440, Math.max(5, Math.round(raw)));
        this.cfg.staleMinutes = minutes;
        patch.staleMinutes = minutes;
      }
      if (opts.journal !== undefined) {
        this.cfg.journal = opts.journal === true;
        patch.journal = this.cfg.journal;
      }
      if (opts.wakeMode !== undefined) {
        const mode = String(opts.wakeMode);
        if (mode !== 'quiet-end' && mode !== 'custom' && mode !== 'both') {
          throw new Error('「时刻」只认三种：安静时段结束 / 自定义 / 两者。');
        }
        this.cfg.wakeMode = mode;
        patch.wakeMode = mode;
      }
      if (opts.wakeTimes !== undefined) {
        this.cfg.wakeTimes = String(opts.wakeTimes ?? '');
        patch.wakeTimes = this.cfg.wakeTimes;
      }
      if (Object.keys(patch).length) this.deps.persist?.(patch);
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
      journalOn: this.cfg.journal === true,
      wakeMode: String(this.cfg.wakeMode ?? 'quiet-end'),
      wakeTimes: parseWakeTimes(this.cfg.wakeTimes).map((x) => x.label),
      wakeTimesRaw: String(this.cfg.wakeTimes ?? ''),
      journal: journalFile(this.deps.dataDir),
      media: join(this.deps.dataDir, 'media'),
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

/**
 * 桌宠在不在：探它的本地口。
 * 它的 HTTP 服务只在桌宠挂载时 start() 里 listen，停用/关窗/崩了这个口就没人接，
 * connect 会立刻拒连——这比「配置里写着 enabled」可靠得多（配置和进程会不一致）。
 */
async function petListening(dataDir: string): Promise<boolean> {
  const open = await Promise.all(petPorts(dataDir).map((port) => portOpen(port)));
  return open.some(Boolean);
}

/** 桌宠的候选口：配置里写的那个（读不到就用默认值）往后扫一段，它会自己往后挪。 */
function petPorts(dataDir: string): number[] {
  let base = PET_PORT_DEFAULT;
  try {
    // dataDir 是 <companion>/data，主配置在上一层的 config.json
    const raw = readFileSync(join(dataDir, '..', 'config.json'), 'utf8');
    const section = (JSON.parse(raw) as { worlds?: Record<string, { port?: unknown }> }).worlds?.['desktop-pet'];
    const port = Math.round(Number(section?.port));
    if (Number.isFinite(port) && port > 1024 && port < 65_536) base = port;
  } catch {
    // 配置读不到就按默认口试，不影响判断
  }
  return Array.from({ length: PET_PORT_SPAN }, (_, i) => base + i);
}

/** 摸一下本机端口：连得上就是开着。 */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(PET_PROBE_TIMEOUT_MS, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function parseClock(raw: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/**
 * 自定义醒来时间：`0900, 2130`（也认 `09:00`）→ 排好序的钟点。
 * 分隔符全半角通用（逗号、分号、顿号、空格）；认不出的那几段直接丢掉，别因为写错一个就整条不生效。
 */
function parseWakeTimes(raw: unknown): { minute: number; label: string }[] {
  const out: { minute: number; label: string }[] = [];
  for (const piece of String(raw ?? '').split(/[,，;；、\s]+/)) {
    const s = piece.trim();
    if (!s) continue;
    const m = /^(?:(\d{1,2}):(\d{2})|(\d{3,4}))$/.exec(s);
    if (!m) continue;
    const digits = m[3] ? m[3].padStart(4, '0') : `${m[1]!.padStart(2, '0')}${m[2]}`;
    const h = Number(digits.slice(0, 2));
    const min = Number(digits.slice(2));
    if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) continue;
    const label = digits;
    if (out.some((x) => x.label === label)) continue;
    out.push({ minute: h * 60 + min, label });
  }
  return out.sort((a, b) => a.minute - b.minute).slice(0, MAX_WAKE_TIMES);
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
