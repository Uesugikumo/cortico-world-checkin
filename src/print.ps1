# Shrink the whole screen to a 32x18 grayscale grid and print one line of
# 0-255 integers separated by commas. Only used to tell whether the picture
# keeps changing; nothing is written to disk and the model never sees it.
# On any failure, print nothing and exit 1.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($vs.Width -le 0 -or $vs.Height -le 0) { exit 1 }

  $full = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($full)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $full.Size)
  $g.Dispose()

  $cols = 32
  $rows = 18
  $small = New-Object System.Drawing.Bitmap($cols, $rows)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g2.DrawImage($full, 0, 0, $cols, $rows)
  $g2.Dispose()
  $full.Dispose()

  $cells = New-Object 'int[]' ($cols * $rows)
  for ($y = 0; $y -lt $rows; $y++) {
    for ($x = 0; $x -lt $cols; $x++) {
      $c = $small.GetPixel($x, $y)
      $cells[$y * $cols + $x] = [int](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
    }
  }
  $small.Dispose()
  [Console]::Out.Write(($cells -join ','))
} catch {
  exit 1
}
