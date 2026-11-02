import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 一张给模型看的截图；只在被要求搭话时截。扩展自己不写文件，交给框架后由附件库按内容哈希落盘。 */
export interface Shot {
  bytes: Uint8Array;
  mime: string;
}

const SHOT = fileURLToPath(new URL('./shot.ps1', import.meta.url));
const PRINT = fileURLToPath(new URL('./print.ps1', import.meta.url));
const TIMEOUT_MS = 15_000;
/** 太大的图不如不给：超过这个尺寸就当没截到。 */
const MAX_BYTES = 4 * 1024 * 1024;
/** 画面指纹的格子数（32x18），跟 print.ps1 里保持一致。 */
export const PRINT_CELLS = 32 * 18;

/**
 * 截一张整个屏幕的图（多显示器时是所有屏幕的并集），缩放后以 JPEG 交回。
 * 非 Windows、脚本报错、或尺寸离谱时返回 null——搭话照常进行，只是没有图。
 */
export function captureScreen(): Promise<Shot | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHOT],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const b64 = stdout
          .trim()
          .split(/\r?\n/)
          .filter((row) => row.trim())
          .pop();
        if (!b64) {
          resolve(null);
          return;
        }
        const buf = Buffer.from(b64, 'base64');
        // JPEG 的 SOI 标记，顺带挡住 base64 解出来是别的东西的情况
        if (buf.length < 512 || buf.length > MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) {
          resolve(null);
          return;
        }
        resolve({ bytes: new Uint8Array(buf), mime: 'image/jpeg' });
      },
    );
  });
}

/**
 * 画面指纹：整个屏幕缩成 32x18 的灰度格（576 个 0–255）。
 * 只在本机内存里用来判断「画面有没有在变」——不落盘、不进事件、不给模型。
 * 拿不到（非 Windows、锁屏、远程桌面、脚本报错）时返回 null，调用方按「不知道」处理。
 */
export function capturePrint(): Promise<Uint8Array | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PRINT],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const raw = stdout.trim();
        if (!raw) {
          resolve(null);
          return;
        }
        const parts = raw.split(',');
        if (parts.length !== PRINT_CELLS) {
          resolve(null);
          return;
        }
        const cells = new Uint8Array(PRINT_CELLS);
        for (let i = 0; i < PRINT_CELLS; i += 1) {
          const n = Number(parts[i]);
          if (!Number.isFinite(n) || n < 0 || n > 255) {
            resolve(null);
            return;
          }
          cells[i] = n;
        }
        resolve(cells);
      },
    );
  });
}

/**
 * 两张指纹之间「明显变了」的格子占比。
 * 用占比而不是整屏平均差：任务栏的秒数、鼠标光标这种小面积变化过不了阈值，
 * 而整页翻书、视频换镜头会大块变动。
 */
export function changedRatio(prev: Uint8Array, next: Uint8Array, cellDelta = 24): number {
  if (prev.length !== next.length || prev.length === 0) return 0;
  let changed = 0;
  for (let i = 0; i < prev.length; i += 1) {
    if (Math.abs(prev[i] - next[i]) > cellDelta) changed += 1;
  }
  return changed / prev.length;
}
