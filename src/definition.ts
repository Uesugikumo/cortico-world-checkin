import type { WorldDefinition } from 'cortico/world.ts';
import { CHECKIN_DEFAULTS, type CheckinConfigSection } from './config.ts';
import { CheckinWorld } from './world.ts';

export const CHECKIN: WorldDefinition<CheckinConfigSection> = {
  id: 'checkin',
  label: 'Where Are You',
  defaults: () => ({ ...CHECKIN_DEFAULTS }),
  /**
   * 自描述（契约 v6）。给人和扩展市场看，不进提示词；
   * 内容与 world.ts 的 tools() 保持一致。
   */
  describe: {
    tools: [
      {
        name: 'checkin_note',
        tags: ['write'],
        summary: '记下一件以后要回头问的事',
        description:
          '记下一件以后要回头问的事（他约了人、说要修东西、明天要早起这类）。到点会有人提醒你。' +
          '别把每句话都记成待办，只记真的会想知道结果的那些。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要跟进的事，一句短话' },
            afterMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: '过多少分钟再来提；不给就两小时' },
          },
          required: ['text'],
        },
      },
      {
        name: 'checkin_list',
        tags: ['read'],
        summary: '看还有哪些挂着要跟进的事',
        description: '看现在还有哪些挂着要跟进的事，以及各自什么时候提。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'checkin_done',
        tags: ['write'],
        summary: '把一条跟进标掉',
        description: '这件事有结果了、不用再问，标掉它；也可以用来放弃。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '编号，写前几位就行' },
            text: { type: 'string', description: '或者写这件事里的几个字' },
          },
        },
      },
      {
        name: 'checkin_activity',
        tags: ['read'],
        summary: '看他现在在电脑前做什么',
        description:
          '看他现在在电脑前做什么：前台程序、窗口标题、多久没动键鼠、最近一小时换过哪些程序。' +
          '别每轮都念。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'journal_read',
        tags: ['read'],
        summary: '翻自己的心事本',
        description: '翻《心事.md》：上一条在琢磨什么、还有哪些问题没答，顺带列出待跟进的事。醒来的时候先看它。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'journal_append',
        tags: ['write'],
        summary: '往心事本里写一条',
        description: '写一条：答的是哪个问题、答了什么、今天有没有冒出新问题。太短或者跟上一条一样会被拒收。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', description: '答的是哪一句问题，或者「今天在想……」' },
            answer: { type: 'string', description: '认真答的那一段；太短会被拒收' },
            fresh: { type: 'string', description: '顺带冒出来的新问题，一句；没有就不填' },
          },
          required: ['answer'],
        },
      },
    ],
    events: [
      {
        type: 'checkin.due',
        tags: ['speak'],
        description: '一条跟进到点了：正文写着当初记下的事和现在的时间。',
      },
      {
        type: 'checkin.activity',
        tags: ['speak'],
        description: '一个可以搭话的由头：他在同一个程序前待了很久、他连着戳了两下桌宠、或者他离开一阵子又回来了。',
      },
      {
        type: 'checkin.away',
        tags: [],
        description: '他离开电脑一阵子还没回来：正文写着他走了多久、离开前在做什么，让你自己判断要不要、以及去哪儿问一句。一趟只递一次；递了之后一直没落账，会再补一条只让记账、不许开口的收尾（也只补一次）。',
      },
      {
        type: 'checkin.companion',
        tags: [],
        description:
          '他连着摸了你两下以上，接下来按设置陪一阵（默认十分钟、每两分钟一眼）递他的屏幕（带截图）。第一眼带 speak，后面几眼只是看着，不必每眼都开口。',
      },
      {
        type: 'checkin.wake',
        tags: ['speak'],
        description:
          '醒来了：安静时段结束、或者到了你设的钟点。正文让它翻《心事.md》答一句、再看有没有应过没做的事。安静时段里或人不在时只写不出声。',
      },
    ],
  },
  create: (ctx) =>
    new CheckinWorld({
      dataDir: ctx.dataDir,
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      persist: ctx.persist,
      // 只有测试会在 ctx 上塞一个假的「画面指纹」，框架不传这个字段
      print: (ctx as { print?: () => Promise<Uint8Array | null> }).print,
    }),
};
