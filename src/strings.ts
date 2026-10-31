import type { Language } from 'cortico/core/language.ts';

export interface CheckinText {
  moduleLabel: string;
  lampLabel: string;
  lampHintWatching: string;
  lampHintOff: string;
  badgePending: string;
  groupTalkTitle: string;
  groupTalkDescription: string;
  groupPetTitle: string;
  groupPetDescription: string;
  groupAwayTitle: string;
  groupAwayDescription: string;
  groupOtherTitle: string;
  groupOtherDescription: string;
  watchTitle: string;
  watchDescription: string;
  quietFromTitle: string;
  quietFromDescription: string;
  quietToTitle: string;
  quietToDescription: string;
  sameAppTitle: string;
  sameAppDescription: string;
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
  askTitle: string;
  askDescription: string;
  askToTitle: string;
  askToDescription: string;
  promptDocTitle: string;
  promptDocDescription: string;
  panelProbeTitle: string;
  panelProbeDescription: string;
  panelPendingTitle: string;
  panelPendingDescription: string;
}

const ZH: CheckinText = {
  moduleLabel: 'Where Are You',
  lampLabel: '运行',
  lampHintWatching: '在跟进挂着的事，也会看前台窗口',
  lampHintOff: '只跟进挂着的事，不看窗口',
  badgePending: '待跟进',
  groupTalkTitle: '搭话',
  groupTalkDescription: '它多久递一个由头、一天最多说几条、什么时候闭嘴。',
  groupPetTitle: '桌宠上的动作',
  groupPetDescription: '摸它、戳它之后会发生什么；搭话要不要带截图也在这组。',
  groupAwayTitle: '离开与回来',
  groupAwayDescription: '人走开了它怎么看、回来时说一句、走久了要不要在 QQ 上问一声。',
  groupOtherTitle: '其他',
  groupOtherDescription: '采样间隔和跟进记录自动清理。一般不用动。',
  watchTitle: '看前台窗口',
  watchDescription: '隔一段时间记一下前台是哪个程序（只看进程名和窗口标题，不落盘）。关掉就只做跟进。',
  quietFromTitle: '安静从',
  quietFromDescription: '本地时间 HH:MM，这段时间不搭话（到点的跟进也会等你回来再提）。',
  quietToTitle: '安静到',
  quietToDescription: '本地时间 HH:MM，可以跨午夜。',
  sameAppTitle: '同一程序待满',
  sameAppDescription: '一直在同一个窗口前待够这么久，才会递一个由头。可调小，代价是更容易被小事打断。',
  softGapTitle: '两条之间至少隔',
  softGapDescription: '被无视会自动翻倍，最多八倍。0 = 不设间隔。',
  softPerHourTitle: '每小时最多',
  softPerHourDescription: '0 = 不限。只在真的开口时计数，沉默不算。',
  softPerDayTitle: '一天最多',
  softPerDayDescription: '包含每小时那条限制，两个都满足才会开口。0 = 不限。',
  sampleTitle: '多久看一眼',
  sampleDescription: '多久看一次前台窗口。样本只在内存里存最近约四小时。',
  screenshotTitle: '搭话时截一张图',
  screenshotDescription: '真要开口的时候截一张前台窗口的图给模型看（JPEG、约 1280 宽、不存文件）。当前模型看不了图时自动跳过。',
  pokeTitle: '连戳两下就搭话',
  pokeDescription: '连着戳它两下（两下要在两三秒内），它就看一眼你正在做什么，再决定要不要说句话。单戳一下不算。',
  companionTitle: '连摸两下就陪着看',
  companionDescription:
    '连着摸它两下以上，接下来一阵子它隔一会儿就看一眼你的屏幕（带截图，不落盘）。第一眼可以开口打招呼，后面几眼只看不说，除非真有事。摸一下不算。',
  companionMinutesTitle: '陪着看多久',
  companionMinutesDescription: '连摸两下之后这段陪伴持续多久（1–60）。到点自己停。',
  companionEveryTitle: '隔多久递一眼',
  companionEveryDescription: '陪伴期间每隔多久递一眼你的屏幕。填得不小于总时长时就只看一眼。',
  awayTitle: '多久不动算离开',
  awayDescription: '键鼠停这么久就算走开了，这段时间不搭话；回来时再开口。看视频的时候按两倍算。',
  backTitle: '回来说一句',
  backDescription: '你走开过一阵子又回来，它可以说一句「回来啦」。半小时内最多一次，安静时段不说。',
  staleTitle: '提醒过的跟进多久清掉',
  staleDescription: '一条跟进提醒过一次、之后一直没有结果，过了这么久就自己从列表里清掉（5–1440）。从来没提醒到的保留三天。',
  askTitle: '走多久后在 QQ 问',
  askDescription: '离开超过这么久还没回来，就递一个由头，让它决定要不要用 qq_send 问一句。安静时段不问。',
  askToTitle: '问哪个 QQ 或群',
  askToDescription: '填 QQ 号就是私聊（例如 123456789）。想发到群里，写「群123456」或「群:123456」。留空就只在桌面上等着，不走 QQ。',
  promptDocTitle: 'Where Are You 提示词',
  promptDocDescription: '告诉模型什么时候该开口、什么时候闭嘴。',
  panelProbeTitle: '状态',
  panelProbeDescription: '它现在看到的画面、采样间隔、今天说了几条，都在这页；整页只读。',
  panelPendingTitle: '待跟进',
  panelPendingDescription: '它记着以后要回头问的事：到点会自己提，这里可以先看，也可以直接结掉。',
};

const EN: CheckinText = {
  moduleLabel: 'Where Are You',
  lampLabel: 'Running',
  lampHintWatching: 'Following up on notes, and watching the foreground window',
  lampHintOff: 'Following up on notes only',
  badgePending: 'Pending',
  groupTalkTitle: 'Small talk',
  groupTalkDescription: 'How often a reason to speak arrives, how many lines a day, and when to stay quiet.',
  groupPetTitle: 'Pet actions',
  groupPetDescription: 'What a pet or a poke does; whether speaking up comes with a screenshot.',
  groupAwayTitle: 'Away and back',
  groupAwayDescription: 'How it reads you stepping away, says a line when you return, and whether to ask on QQ.',
  groupOtherTitle: 'Other',
  groupOtherDescription: 'Sampling interval and auto-clearing of raised follow-ups. Rarely worth touching.',
  watchTitle: 'Watch foreground window',
  watchDescription: 'Occasionally records which process is in front (process name and window title only — nothing written to disk or sent anywhere). Turn off to keep follow-ups only.',
  quietFromTitle: 'Quiet from',
  quietFromDescription: 'Local time HH:MM. No small talk during this window (due follow-ups wait until you are back).',
  quietToTitle: 'Quiet to',
  quietToDescription: 'Local time HH:MM; may cross midnight.',
  sameAppTitle: 'Same app for at least',
  sameAppDescription: 'Only after staying in the same window this long does it offer a reason to speak. Lower means more interruptions.',
  softGapTitle: 'Gap between check-ins',
  softGapDescription: 'Doubles when ignored, up to eight times. 0 = no minimum gap.',
  softPerHourTitle: 'Max per hour',
  softPerHourDescription: '0 = unlimited. Only counts times it actually spoke; silence does not count.',
  softPerDayTitle: 'Max per day',
  softPerDayDescription: 'Applies on top of the hourly cap; both must allow it. 0 = unlimited.',
  sampleTitle: 'Sample every',
  sampleDescription: 'How often the foreground window is sampled. Samples stay in memory (about four hours).',
  screenshotTitle: 'Screenshot when speaking up',
  screenshotDescription: 'Captures the foreground window as a JPEG (about 1280 wide, no file kept) so the model can see it. Skipped when the current model cannot read images.',
  pokeTitle: 'Double-poke the pet to speak up',
  pokeDescription: 'Poke it twice within a couple of seconds and it will take a look at what you are doing, then decide whether to say a line. A single poke does nothing.',
  companionTitle: 'Two pets and it looks along',
  companionDescription:
    'Pet it twice or more and, for a while, it glances at your screen now and then (with a screenshot, never written to disk). The first look may greet you; the rest just watch, unless something is really worth a line. One pet does nothing.',
  companionMinutesTitle: 'Look along for',
  companionMinutesDescription: 'How long the company after two pets lasts (1-60). It stops by itself at the end.',
  companionEveryTitle: 'A glance every',
  companionEveryDescription: 'How often a glance arrives while looking along. If it is not shorter than the total, you only get one look.',
  awayTitle: 'Away after',
  awayDescription: 'This long without keyboard or mouse counts as away: it stays quiet, and says hello when you come back. Doubled while a video is playing.',
  backTitle: 'Greet me when I am back',
  backDescription: 'May say a line when you return after being away. At most once every half hour, never in quiet hours.',
  staleTitle: 'Auto-clear asked follow-ups',
  staleDescription: 'A follow-up that was raised once and never resolved is dropped from the list after this long (5-1440). Never-raised ones are kept for three days.',
  askTitle: 'Ask on QQ after being away',
  askDescription: 'Away longer than this and still not back: hand it a cue to decide whether to ask via qq_send. Never during quiet hours.',
  askToTitle: 'Which QQ or group',
  askToDescription: 'A QQ number is a private chat (e.g. 123456789). To ask in a group, write 群123456 or group:123456. Empty means it just waits on the desktop.',
  promptDocTitle: 'Where Are You prompt',
  promptDocDescription: 'Tells the model when to speak up and when to stay silent.',
  panelProbeTitle: 'Status',
  panelProbeDescription: 'What it sees right now, the sampling interval, and how much it has said today — read only.',
  panelPendingTitle: 'Pending follow-ups',
  panelPendingDescription: 'Things it means to ask you about later: raised when due. See them here, or close them now.',
};

export function text(language: Language): CheckinText {
  return language === 'zh' ? ZH : EN;
}
