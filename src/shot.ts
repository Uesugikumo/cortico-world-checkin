import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 一张给模型看的截图；只在被要求搭话时截，不存文件。 */
export interface Shot {
  bytes: Uint8Array;
  mime: string;
}

const SHOT = fileURLToPath(new URL('./shot.ps1', import.meta.url));
const TIMEOUT_MS = 15_000;
/** 太大的图不如不给：超过这个尺寸就当没截到。 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 截一张前台窗口的图（取不到就整屏），缩放后以 JPEG 交回。
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
