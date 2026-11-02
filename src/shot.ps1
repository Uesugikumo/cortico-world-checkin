# 截一张图给模型看：整个屏幕（多显示器时是所有屏幕的并集），缩到 1280 宽、JPEG 质量 70。
# 只把 base64 吐到 stdout，不写文件、不落盘。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height

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
