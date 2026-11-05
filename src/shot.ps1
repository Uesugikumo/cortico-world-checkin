# 截一张图给模型看：整个屏幕（多显示器时是所有屏幕的并集），按指定宽度缩放后以 JPEG 交回。
# -Width 0 = 保持原始分辨率不缩放；-Quality 1–100（数字越大越清楚、也越大）。
# 只把 base64 吐到 stdout，不写文件、不落盘。
param(
  [int]$Width = 1280,
  [int]$Quality = 70
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()

if ($Width -gt 0 -and $w -gt $Width) {
  $nw = $Width
  $nh = [int][Math]::Round($h * $Width / $w)
} else {
  $nw = $w; $nh = $h
}

if ($nw -ne $w -or $nh -ne $h) {
  $small = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose()
} else {
  $small = $bmp
}
if (-not [object]::ReferenceEquals($small, $bmp)) { $bmp.Dispose() }

$ms = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
# 注意：这里必须把质量显式转成 [long]（带括号），否则 New-Object 会挑错重载，Save 时报 "Parameter is not valid"。
$qualityParam = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$encParams.Param[0] = $qualityParam
$small.Save($ms, $codec, $encParams)
$small.Dispose()

[Convert]::ToBase64String($ms.ToArray())
