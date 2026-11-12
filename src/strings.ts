import type { Language } from 'cortico/core/language.ts';

export interface CheckinText {
  moduleLabel: string;
  lampWatchLabel: string;
  lampLookLabel: string;
  lampBackLabel: string;
  lampWatchOn: (seconds: number) => string;
  lampWatchNoFront: string;
  lampWatchQuiet: (from: string, to: string) => string;
  lampWatchPetOff: string;
  lampWatchOffline: string;
  lampLookEvery: (minutes: number) => string;
  lampLookOff: string;
  lampLookQuiet: (from: string, to: string) => string;
  lampLookNoFront: string;
  lampBackOn: string;
  lampBackOff: string;
  lampBackQuiet: (from: string, to: string) => string;
  lampBackNoFront: string;
  badgePending: string;
  groupTalkTitle: string;
  groupTalkDescription: string;
  groupPetTitle: string;
  groupPetDescription: string;
  groupAwayTitle: string;
  groupAwayDescription: string;
  groupLimitTitle: string;
  groupLimitDescription: string;
  watchTitle: string;
  watchDescription: string;
  quietFromTitle: string;
  quietFromDescription: string;
  quietToTitle: string;
  quietToDescription: string;
  sameAppTitle: string;
  sameAppDescription: string;
  lookTitle: string;
  lookDescription: string;
  lookEnabledTitle: string;
  lookEnabledDescription: string;
  softGapTitle: string;
  softGapDescription: string;
  softPerHourTitle: string;
  softPerHourDescription: string;
  softPerDayTitle: string;
  softPerDayDescription: string;
  sampleTitle: string;
  sampleDescription: string;
  screenshotTitle: string;
  screenshotDescription: string;
  shotPresetTitle: string;
  shotPresetDescription: string;
  shotWidthTitle: string;
  shotWidthDescription: string;
  shotQualityTitle: string;
  shotQualityDescription: string;
  pokeTitle: string;
  pokeDescription: string;
  companionTitle: string;
  companionDescription: string;
  companionMinutesTitle: string;
  companionMinutesDescription: string;
  companionEveryTitle: string;
  companionEveryDescription: string;
  awayTitle: string;
  awayDescription: string;
  backTitle: string;
  backDescription: string;
  staleTitle: string;
  staleDescription: string;
  promptDocTitle: string;
  promptDocDescription: string;
  panelProbeTitle: string;
  panelProbeDescription: string;
  panelPendingTitle: string;
  panelPendingDescription: string;
  panelSwitchesTitle: string;
  panelSwitchesDescription: string;
  groupRelayTitle: string;
  groupRelayDescription: string;
  relayAwayTitle: string;
  relayAwayDescription: string;
  relayAlwaysTitle: string;
  relayAlwaysDescription: string;
  relayTargetTitle: string;
  relayTargetDescription: string;
  relayApiTitle: string;
  relayApiDescription: string;
  relayTokenTitle: string;
  relayTokenDescription: string;
}

const ZH: CheckinText = {
  moduleLabel: 'Where Are You',
  lampWatchLabel: '监测',
  lampLookLabel: '看一眼',
  lampBackLabel: '回来',
  lampWatchOn: (seconds) => `看前台，每 ${seconds} 秒一次（离开/回来/待久/落账靠它）`,
  lampWatchNoFront: '只看跟进：离开、回来、待久、落账 都停',
  lampWatchQuiet: (from, to) => `安静时段 ${from}–${to}，不采样`,
  lampWatchPetOff: '桌宠没开，整个停了',
  lampWatchOffline: '没在运行',
  lampLookEvery: (minutes) => `每 ${minutes} 分钟主动看一眼`,
  lampLookOff: '主动看：关',
  lampLookQuiet: (from, to) => `安静时段 ${from}–${to}，不主动看`,
  lampLookNoFront: '看前台没开，主动看也跟着停',
  lampBackOn: '回来时说一句',
  lampBackOff: '回来不说话',
  lampBackQuiet: (from, to) => `安静时段 ${from}–${to}，回来也不说`,
  lampBackNoFront: '看前台没开，认不出回来',
  badgePending: '小本本',
  groupTalkTitle: '搭话',
  groupTalkDescription: '监测、截图、间隔、持续：看窗口的频率，和什么时候递一个由头（待够了，或者到点看一眼）。',
  groupPetTitle: '桌宠上的动作',
  groupPetDescription: '摸它、戳它之后会发生什么。',
  groupAwayTitle: '离开与回来',
  groupAwayDescription: '人走开了它怎么看、回来时说一句。想在 QQ 上问，交给提示词和 QQ 那边的工具，这里不再填目标。',
  groupLimitTitle: '限制',
  groupLimitDescription: '两条之间隔多久、一小时和一天最多几条、哪段时间闭嘴。',
  watchTitle: '监测',
  watchDescription: '状态页的「监测」就是它：隔一段时间记一下前台是哪个程序（只看进程名和窗口标题，不落盘）。关掉就只做跟进；「看一眼屏幕」和「欢迎回来」都靠它认人，一起停。',
  quietFromTitle: '安静从',
  quietFromDescription: '本地时间 HH:MM，这段时间不搭话（到点的跟进也会等你回来再提）。',
  quietToTitle: '安静到',
  quietToDescription: '本地时间 HH:MM，可以跨午夜。',
  sameAppTitle: '持续',
  sameAppDescription: '一直在同一个窗口前待够这么久，才会递一个由头。可调小，代价是更容易被小事打断。',
  lookTitle: '看一眼屏幕',
  lookDescription: '另一种给由头的方式：不管换没换窗口，每隔这么久主动看一眼你屏幕，让它知道你现在在做什么。0 = 关掉，只按上面的「持续」给。',
  lookEnabledTitle: '看一眼',
  lookEnabledDescription: '开着就隔一阵自己看一眼屏幕。关掉后定时看一眼全停；戳两下、摸两下、到点提醒都不受影响。「监测」关着时这一项也用不上，会自动停、开关置灰——数字留着，回头开监测就接着用。',
  softGapTitle: '两条之间至少隔',
  softGapDescription: '被无视会自动翻倍，最多八倍。0 = 不设间隔，但退避仍按 5 分钟起算。',
  softPerHourTitle: '每小时最多',
  softPerHourDescription: '只在真的开口时计数，沉默不算。0 = 不限。',
  softPerDayTitle: '一天最多',
  softPerDayDescription: '包含每小时那条限制，两个都满足才会开口。0 = 不限。',
  sampleTitle: '间隔',
  sampleDescription: '多久看一次前台窗口。样本只在内存里存最近约四小时。',
  screenshotTitle: '截图',
  screenshotDescription: '真要开口的时候截一张整个屏幕的图给模型看。图由框架按内容哈希存进 data/media，控制台「运行诊断 → 数据清理 → 附件库」里能清。当前模型看不了图时自动跳过。',
  shotPresetTitle: '清晰度',
  shotPresetDescription: 'standard = 1280 宽、质量 70（原先那档，够看）；sharp = 1920 宽、质量 85（字更清楚，图大约大一倍）；original = 不缩放、质量 85（原始分辨率，最清楚也最大）；custom = 用下面两个数自己定。',
  shotWidthTitle: '宽度',
  shotWidthDescription: '只有清晰度选 custom 时才起作用。0 = 不缩放，保持原始分辨率。',
  shotQualityTitle: '画质',
  shotQualityDescription: '只有清晰度选 custom 时才起作用。1–100，越大越清楚、文件也越大（建议 70–90）。',
  pokeTitle: '连戳两下就搭话',
  pokeDescription: '连着戳它两下（两下要在两三秒内），它就看一眼你正在做什么，再决定要不要说句话。单戳一下不算。',
  companionTitle: '连摸两下就陪着看',
  companionDescription:
    '连着摸它两下以上，接下来一阵子它隔一会儿就看一眼你的屏幕（带截图；截图由框架存进 data/media，可清）。第一眼可以开口打招呼，后面几眼只看不说，除非真有事。摸一下不算。',
  companionMinutesTitle: '陪着看多久',
  companionMinutesDescription: '连摸两下之后这段陪伴持续多久（1–60）。到点自己停。',
  companionEveryTitle: '隔多久递一眼',
  companionEveryDescription: '陪伴期间每隔多久递一眼你的屏幕。填得不小于总时长时就只看一眼。',
  awayTitle: '多久不动算离开',
  awayDescription: '键鼠停这么久就算走开了，这段时间不搭话；回来时再开口。看视频的时候按两倍算。',
  backTitle: '回来说一句',
  backDescription: '你走开过一阵子又回来，它可以说一句「回来啦」。半小时内最多一次，安静时段不说。它靠「监测」认人：监测关着就认不出你回来了，这一项用不上（开关置灰）。',
  staleTitle: '提醒过的跟进多久清掉',
  staleDescription: '一条跟进提醒过一次、之后一直没有结果，过了这么久就自己从列表里清掉（5–1440）。从来没提醒到的保留三天。',
  promptDocTitle: 'Where Are You 提示词',
  promptDocDescription: '告诉模型什么时候该开口、什么时候闭嘴。',
  panelProbeTitle: '状态',
  panelProbeDescription: '它现在看到的画面、采样间隔、今天说了几条，都在这页；整页只读。',
  panelSwitchesTitle: '开关',
  panelSwitchesDescription:
    '拨一下就生效，不用点保存：一行一个开关，右边写着它现在的状态。监测、看一眼、截图、连戳两下、连摸两下、欢迎回来、离开时转 QQ、全程转 QQ；和设置页是同一份配置，两边改都算。',
  panelPendingTitle: '小本本',
  panelPendingDescription:
    '它记着以后要回头问的事：到点会自己提，这里可以先看，也可以直接结掉。提醒过一次、之后一直没有结果的会自动清掉。底下的「心事」那三项决定它醒来时写不写、什么时候写，最底下是心事.md 的路径。',
  groupRelayTitle: '转 QQ',
  groupRelayDescription:
    '桌宠冒出来的话，抄一份发到你 QQ 上。读的是桌宠自己记的对话，不经过模型的工具调用，所以它绕不开。只连本机，不出网。',
  relayAwayTitle: '人不在就转 QQ',
  relayAwayDescription: '判定成「人不在电脑前」的时候，桌宠说的话抄一份发到 QQ；人在的时候不转。',
  relayAlwaysTitle: '一直都转 QQ',
  relayAlwaysDescription: '不管人在不在，桌宠说的每一句都抄一份到 QQ。桌宠关着的时候没有气泡，也就没得转。',
  relayTargetTitle: '发到哪个号',
  relayTargetDescription: '填 QQ 号。留空就用「最近一次跟你私聊」的那个号，最省事。',
  relayApiTitle: 'OneBot 地址',
  relayApiDescription: '本机 OneBot 的 HTTP 地址（SnowLuma / NapCat 都是这个形状），默认 http://127.0.0.1:3000。不走 WS，不会挤掉宿主自己的 QQ 连接。',
  relayTokenTitle: 'OneBot 令牌',
  relayTokenDescription: 'HTTP 接口的 access token（在 OneBot 配置里），留空就不带鉴权。',
};

const EN: CheckinText = {
  moduleLabel: 'Where Are You',
  lampWatchLabel: 'Monitor',
  lampLookLabel: 'Look',
  lampBackLabel: 'Back',
  lampWatchOn: (seconds) => `watching every ${seconds}s (away/back/idle/ledger)`,
  lampWatchNoFront: 'notes only: away, back, idle, ledger all off',
  lampWatchQuiet: (from, to) => `quiet ${from}–${to}, no sampling`,
  lampWatchPetOff: 'desktop pet is off, all stopped',
  lampWatchOffline: 'not running',
  lampLookEvery: (minutes) => `looks every ${minutes} min`,
  lampLookOff: 'periodic look: off',
  lampLookQuiet: (from, to) => `quiet ${from}–${to}, no look`,
  lampLookNoFront: 'needs window watching, which is off',
  lampBackOn: 'says a word when you are back',
  lampBackOff: 'silent when you are back',
  lampBackQuiet: (from, to) => `quiet ${from}–${to}, stays silent`,
  lampBackNoFront: 'needs window watching to notice you',
  badgePending: 'Notebook',
  groupTalkTitle: 'Small talk',
  groupTalkDescription: 'Monitoring, screenshot, interval and stay-for: how often it looks at the window, and when it offers a reason to speak (staying put, or a timed glance).',
  groupPetTitle: 'Pet actions',
  groupPetDescription: 'What a poke or a pet does.',
  groupAwayTitle: 'Away and back',
  groupAwayDescription: 'How it reads you stepping away, and says a line when you return. Asking on QQ is left to the prompt and the QQ tools — no target is configured here.',
  groupLimitTitle: 'Limits',
  groupLimitDescription: 'The gap between check-ins, hourly and daily caps, and when to stay quiet.',
  watchTitle: 'Monitoring',
  watchDescription: 'The row called Monitoring on the Status panel: it occasionally records which process is in front (process name and window title only — nothing written to disk or sent anywhere). Turn off to keep follow-ups only; scheduled glances and the welcome-back line both rely on it to know you, so they stop too.',
  quietFromTitle: 'Quiet from',
  quietFromDescription: 'Local time HH:MM. No small talk during this window (due follow-ups wait until you are back).',
  quietToTitle: 'Quiet to',
  quietToDescription: 'Local time HH:MM; may cross midnight.',
  sameAppTitle: 'Stay for',
  sameAppDescription: 'Only after staying in the same window this long does it offer a reason to speak. Lower means more interruptions.',
  lookTitle: 'Timed glance at the screen',
  lookDescription: 'A second way to get a cue: regardless of window switches, take a look every so often so it knows what you are doing. 0 = off, leaving only the stay-for cue above.',
  lookEnabledTitle: 'Timed glance',
  lookEnabledDescription: 'When on it looks at your screen every so often. Off stops all scheduled glances; double touch, pokes and due reminders still work. While Monitoring is off this needs no setting at all: it stops itself and the switch goes grey — the number is kept for when Monitoring comes back.',
  softGapTitle: 'Gap between check-ins',
  softGapDescription: 'Doubles when ignored, up to eight times. 0 = no minimum gap (backoff still starts from 5 minutes).',
  softPerHourTitle: 'Max per hour',
  softPerHourDescription: 'Only counts times it actually spoke; silence does not count. 0 = unlimited.',
  softPerDayTitle: 'Max per day',
  softPerDayDescription: 'Applies on top of the hourly cap; both must allow it. 0 = unlimited.',
  sampleTitle: 'Interval',
  sampleDescription: 'How often the foreground window is sampled. Samples stay in memory (about four hours).',
  screenshotTitle: 'Screenshot',
  screenshotDescription: 'Captures the whole screen as a JPEG so the model can see it. The framework stores attachments by content hash under data/media (clear them from Run diagnostics > Clear data > Attachments). Skipped when the current model cannot read images.',
  shotPresetTitle: 'Detail',
  shotPresetDescription: 'standard = 1280 wide at quality 70 (the old setting, good enough); sharp = 1920 wide at quality 85 (crisper text, roughly twice the bytes); original = no downscale at quality 85 (native resolution, sharpest and largest); custom = use the two numbers below.',
  shotWidthTitle: 'Width',
  shotWidthDescription: 'Only used when Detail is custom. 0 = no downscale, keep the native resolution.',
  shotQualityTitle: 'JPEG quality',
  shotQualityDescription: 'Only used when Detail is custom. 1–100; higher is crisper and bigger (70–90 is a good range).',
  pokeTitle: 'Double-poke the pet to speak up',
  pokeDescription: 'Poke it twice within a couple of seconds and it will take a look at what you are doing, then decide whether to say a line. A single poke does nothing.',
  companionTitle: 'Two pets and it looks along',
  companionDescription:
    'Pet it twice or more and, for a while, it glances at your screen now and then (with a screenshot; attachments live under data/media and can be cleared from the console). The first look may greet you; the rest just watch, unless something is really worth a line. One pet does nothing.',
  companionMinutesTitle: 'Look along for',
  companionMinutesDescription: 'How long the company after two pets lasts (1-60). It stops by itself at the end.',
  companionEveryTitle: 'A glance every',
  companionEveryDescription: 'How often a glance arrives while looking along. If it is not shorter than the total, you only get one look.',
  awayTitle: 'Away after',
  awayDescription: 'This long without keyboard or mouse counts as away: it stays quiet, and says hello when you come back. Doubled while a video is playing.',
  backTitle: 'Greet me when I am back',
  backDescription: 'May say a line when you return after being away. At most once every half hour, never in quiet hours. It relies on Monitoring to notice you: with Monitoring off it cannot tell you are back, so the switch goes grey.',
  staleTitle: 'Auto-clear asked follow-ups',
  staleDescription: 'A follow-up that was raised once and never resolved is dropped from the list after this long (5-1440). Never-raised ones are kept for three days.',
  promptDocTitle: 'Where Are You prompt',
  promptDocDescription: 'Tells the model when to speak up and when to stay silent.',
  panelProbeTitle: 'Status',
  panelProbeDescription: 'What it sees right now, the sampling interval, and how much it has said today — read only.',
  panelSwitchesTitle: 'Toggles',
  panelSwitchesDescription:
    'Flip one and it applies at once — no save button: one switch per row, with its current state on the right. Monitoring, timed glance, screenshots, double poke, double touch, back greeting, QQ mirror. Same config as the settings page.',
  panelPendingTitle: 'Notebook',
  panelPendingDescription: 'Things it means to ask you about later: raised when due. See them here, or close them now. One that was raised once and never resolved clears itself after a while. The journal controls at the bottom decide whether and when it thinks things over; the .md path is at the very bottom.',
  groupRelayTitle: 'Forward to QQ',
  groupRelayDescription:
    'Copies what the pet says over to your QQ. It reads the pet own chat log instead of tool calls, so going around the tools still lands here. Local only.',
  relayAwayTitle: 'Forward while I am away',
  relayAwayDescription: 'When you count as away from the keyboard, bubbles are also sent to QQ. Nothing is forwarded while you are at the desk.',
  relayAlwaysTitle: 'Forward everything',
  relayAlwaysDescription: 'Every bubble goes to QQ, whether you are away or not. With the pet closed there are no bubbles to forward.',
  relayTargetTitle: 'Send to',
  relayTargetDescription: 'A QQ number. Leave it empty to use the last person you chatted with privately.',
  relayApiTitle: 'OneBot endpoint',
  relayApiDescription: 'HTTP address of a local OneBot implementation (SnowLuma / NapCat), default http://127.0.0.1:3000. No WS, so the host own QQ link stays untouched.',
  relayTokenTitle: 'OneBot token',
  relayTokenDescription: 'access token of the HTTP endpoint (from the OneBot config). Empty means no auth.',
};

export function text(language: Language): CheckinText {
  return language === 'zh' ? ZH : EN;
}
