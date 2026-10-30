import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 一次前台窗口采样。只在内存里存，不落盘。 */
export interface Sample {
  at: number;
  /** 进程名，例如 Code / chrome */
  proc: string;
  /** 窗口标题 */
  title: string;
  /** 距离上次键鼠输入多久（毫秒） */
  idleMs: number;
}

const PROBE = fileURLToPath(new URL('./probe.ps1', import.meta.url));
const TIMEOUT_MS = 10_000;

/** 进程名归一化：去 .exe、转小写，避免 Code / code / Code.exe 被当成三个程序。 */
export function normalizeProc(raw: string): string {
  return raw.trim().replace(/\.exe$/i, '').toLowerCase();
}

/** 纯粹的播放器进程：人在看片时键鼠可能很久不动，不能当成「不在」。 */
const MEDIA_APPS = new Set([
  'mpv',
  'vlc',
  'potplayer',
  'potplayermini',
  'potplayermini64',
  'mpc-hc',
  'mpc-hc64',
  'mpc-be',
  'wmplayer',
  'kmplayer',
  'gomplayer',
  'qqlive',
  'iqiyi',
  'youku',
  'bilibili',
]);

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'vivaldi', 'opera', '360se', '360chrome', 'qqbrowser', 'safari']);

/** 浏览器里的视频站，靠标题认（YouTube 标题带 - YouTube，B 站带 哔哩哔哩）。 */
const MEDIA_SITE_RE = /(youtube|bilibili|哔哩哔哩|netflix|iqiyi|爱奇艺|youku|优酷|v\.qq\.com|腾讯视频|disney\+|prime video)/i;

/**
 * 是不是在「看点什么」。只用于放宽「人不在」的判定——
 * 看片五分钟不碰鼠标是常态，不该因此闭嘴。
 */
export function isWatchingVideo(proc: string, title: string): boolean {
  if (MEDIA_APPS.has(proc)) return true;
  if (BROWSERS.has(proc) && MEDIA_SITE_RE.test(title)) return true;
  return false;
}

/** 我们自己：桌宠/控制台的窗口不算「他在干什么」，采样时直接跳过。 */
const SELF_PROCS = new Set(['coopanion', 'cortico']);

export function isSelfApp(proc: string): boolean {
  return SELF_PROCS.has(normalizeProc(proc));
}

/** 采一次前台窗口；非 Windows 或读不到时返回 null。 */
export function sampleForeground(): Promise<Sample | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseSample(stdout));
      },
    );
  });
}

function parseSample(out: string): Sample | null {
  const line = out
    .trim()
    .split(/\r?\n/)
    .filter((row) => row.trim().startsWith('{'))
    .pop();
  if (!line) return null;
  try {
    const raw = JSON.parse(line) as { proc?: unknown; title?: unknown; idleMs?: unknown };
    return {
      at: Date.now(),
      proc: typeof raw.proc === 'string' ? normalizeProc(raw.proc) : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      idleMs: typeof raw.idleMs === 'number' && Number.isFinite(raw.idleMs) ? Math.max(0, raw.idleMs) : 0,
    };
  } catch {
    return null;
  }
}

/** 标题截短：别把一整串文件路径念给模型。 */
export function briefTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '（没有标题）';
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
}
