# 截一张图给模型看：优先截前台窗口，取不到就整屏；缩到 1280 宽、JPEG 质量 70。
# 只把 base64 吐到 stdout，不写文件、不落盘。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CheckinShot {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height

try {
  $hwnd = [CheckinShot]::GetForegroundWindow()
  $rect = New-Object 'CheckinShot+RECT'
  if ($hwnd -ne [IntPtr]::Zero -and [CheckinShot]::GetWindowRect($hwnd, [ref]$rect)) {
    $left = [Math]::Max($rect.Left, $vs.Left)
    $top = [Math]::Max($rect.Top, $vs.Top)
    $right = [Math]::Min($rect.Right, $vs.Right)
    $bottom = [Math]::Min($rect.Bottom, $vs.Bottom)
    if (($right - $left) -ge 64 -and ($bottom - $top) -ge 64) {
      $x = $left; $y = $top; $w = $right - $left; $h = $bottom - $top
    }
  }
} catch { }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()

$target = 1280
if ($w -gt $target) { $nw = $target; $nh = [int][Math]::Round($h * $target / $w) } else { $nw = $w; $nh = $h }
$small = New-Object System.Drawing.Bitmap $nw, $nh
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $nw, $nh)
$g2.Dispose()
$bmp.Dispose()

$ms = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 70L
$small.Save($ms, $codec, $encParams)
$small.Dispose()

[Convert]::ToBase64String($ms.ToArray())
