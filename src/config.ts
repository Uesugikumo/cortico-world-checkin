import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { text } from './strings.ts';

/**
 * World 自有配置默认值；enabled 由部署装配决定。
 * 「说几条」这类旋钮放在这里让人自己调，但默认值保守：宁可少说，不要吵。
 */
export const CHECKIN_DEFAULTS = {
  enabled: false,
  /** 要不要看前台窗口（关掉就只做跟进，完全不碰窗口信息） */
  watchActivity: true,
  /** 安静时段，本地时间 HH:MM；跨午夜也认 */
  quietFrom: '00:30',
  quietTo: '04:30',
  /** 同一个程序要连着待满多久才给一个由头（分钟） */
  sameAppMinutes: 90,
  /** 两条搭话之间至少隔多久（分钟），被无视会自动翻倍；0 = 不设间隔 */
  softGapMinutes: 90,
  /** 一小时内最多几条；0 = 不限 */
  softPerHour: 2,
  /** 一天最多几条；0 = 不限 */
  softPerDay: 3,
  /** 多久采一次前台窗口（秒） */
  sampleSeconds: 60,
  /** 要搭话的时候截一张图给模型看 */
  screenshot: true,
  /** 连戳两下桌宠就去看一眼、并且允许开口 */
  pokeNudge: true,
  /** 连摸两下桌宠就陪着看一阵（下面两个数决定多久、多密） */
  companion: true,
  /** 陪着看多久（分钟） */
  companionMinutes: 10,
  /** 陪着看的时候隔多久递一眼（分钟） */
  companionEveryMinutes: 2,
  /** 键鼠停了多久算「人不在」（分钟） */
  awayMinutes: 15,
  /** 人回来的时候说一句「你回来啦」 */
  backNudge: true,
  /** 提醒过一次的跟进，过多久还没结果就自己清掉（分钟） */
  staleMinutes: 60,
} as const;

/** config.json 的 `worlds.checkin` 节。 */
export interface CheckinConfigSection {
  enabled: boolean;
  watchActivity: boolean;
  quietFrom: string;
  quietTo: string;
  sameAppMinutes: number;
  softGapMinutes: number;
  softPerHour: number;
  softPerDay: number;
  sampleSeconds: number;
  screenshot: boolean;
  pokeNudge: boolean;
  companion: boolean;
  companionMinutes: number;
  companionEveryMinutes: number;
  awayMinutes: number;
  backNudge: boolean;
  staleMinutes: number;
}

/** 单位都走 `x-suffix`，标题里就不再写「（分钟）」这类后缀了。 */
const MINUTE = '分钟';
const SECOND = '秒';
const LINE = '条';

/**
 * 设置页按语义拆成四组（框架把每个 ConfigGroup 渲染成一个独立小节，
 * 保存也是按组提交，改一组不会牵连另一组）。
 * 顺序按「平时会动」往下排：看窗口和截图在最前，条数/间隔/安静时段并进「限制」放最下面。
 */
export function checkinConfigGroups(language: Language): ConfigGroup[] {
  const t = text(language);
  const owner = 'world:checkin' as const;
  return [
    {
      id: 'world:checkin',
      owner,
      schema: {
        type: 'object',
        title: t.groupTalkTitle,
        description: t.groupTalkDescription,
        properties: {
          'worlds.checkin.watchActivity': {
            type: 'boolean',
            title: t.watchTitle,
            'x-hot': true,
            description: t.watchDescription,
          },
          'worlds.checkin.screenshot': {
            type: 'boolean',
            title: t.screenshotTitle,
            'x-hot': true,
            description: t.screenshotDescription,
          },
          'worlds.checkin.sampleSeconds': {
            type: 'integer',
            title: t.sampleTitle,
            minimum: 15,
            maximum: 3600,
            'x-hot': true,
            'x-suffix': SECOND,
            description: t.sampleDescription,
          },
          'worlds.checkin.sameAppMinutes': {
            type: 'integer',
            title: t.sameAppTitle,
            minimum: 5,
            maximum: 480,
            'x-hot': true,
            'x-suffix': MINUTE,
            description: t.sameAppDescription,
          },
        },
      },
    },
    {
      id: 'world:checkin.pet',
      owner,
      schema: {
        type: 'object',
        title: t.groupPetTitle,
        description: t.groupPetDescription,
        properties: {
          'worlds.checkin.pokeNudge': {
            type: 'boolean',
            title: t.pokeTitle,
            'x-hot': true,
            description: t.pokeDescription,
          },
          'worlds.checkin.companion': {
            type: 'boolean',
            title: t.companionTitle,
            'x-hot': true,
            description: t.companionDescription,
          },
          'worlds.checkin.companionMinutes': {
            type: 'integer',
            title: t.companionMinutesTitle,
            minimum: 1,
            maximum: 60,
            'x-hot': true,
            'x-suffix': MINUTE,
            description: t.companionMinutesDescription,
          },
          'worlds.checkin.companionEveryMinutes': {
            type: 'integer',
            title: t.companionEveryTitle,
            minimum: 1,
            maximum: 30,
            'x-hot': true,
            'x-suffix': MINUTE,
            description: t.companionEveryDescription,
          },
        },
      },
    },
    {
      id: 'world:checkin.away',
      owner,
      schema: {
        type: 'object',
        title: t.groupAwayTitle,
        description: t.groupAwayDescription,
        properties: {
          'worlds.checkin.backNudge': {
            type: 'boolean',
            title: t.backTitle,
            'x-hot': true,
            description: t.backDescription,
          },
          'worlds.checkin.awayMinutes': {
            type: 'integer',
            title: t.awayTitle,
            minimum: 1,
            maximum: 240,
            'x-hot': true,
            'x-suffix': MINUTE,
            description: t.awayDescription,
          },
        },
      },
    },
    {
      id: 'world:checkin.limit',
      owner,
      schema: {
        type: 'object',
        title: t.groupLimitTitle,
        description: t.groupLimitDescription,
        properties: {
          'worlds.checkin.softGapMinutes': {
            type: 'integer',
            title: t.softGapTitle,
            minimum: 0,
            maximum: 480,
            'x-hot': true,
            'x-suffix': MINUTE,
            description: t.softGapDescription,
          },
          'worlds.checkin.softPerHour': {
            type: 'integer',
            title: t.softPerHourTitle,
            minimum: 0,
            maximum: 12,
            'x-hot': true,
            'x-suffix': LINE,
            description: t.softPerHourDescription,
          },
          'worlds.checkin.softPerDay': {
            type: 'integer',
            title: t.softPerDayTitle,
            minimum: 0,
            maximum: 24,
            'x-hot': true,
            'x-suffix': LINE,
            description: t.softPerDayDescription,
          },
          'worlds.checkin.quietFrom': {
            type: 'string',
            title: t.quietFromTitle,
            'x-hot': true,
            description: t.quietFromDescription,
          },
          'worlds.checkin.quietTo': {
            type: 'string',
            title: t.quietToTitle,
            'x-hot': true,
            description: t.quietToDescription,
          },
        },
      },
    },
  ];
}
