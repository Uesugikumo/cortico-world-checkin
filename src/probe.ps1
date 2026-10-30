$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CiProbe {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();

  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

  public static string Run() {
    IntPtr handle = GetForegroundWindow();
    StringBuilder title = new StringBuilder(512);
    GetWindowTextW(handle, title, 512);
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    LASTINPUTINFO input = new LASTINPUTINFO();
    input.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref input);
    uint idle = GetTickCount() - input.dwTime;
    return pid + "\u0001" + idle + "\u0001" + title.ToString();
  }
}
"@

$raw = [CiProbe]::Run()
$parts = $raw.Split([char]1)
$targetPid = [int]$parts[0]
$idleMs = [long]$parts[1]
$title = $parts[2]
$proc = ''
try { $proc = (Get-Process -Id $targetPid -ErrorAction Stop).ProcessName } catch {}

[pscustomobject]@{ proc = $proc; title = $title; idleMs = $idleMs } | ConvertTo-Json -Compress -Depth 3
