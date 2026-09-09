$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$path = "transloadit_image.png"
$img = [System.Drawing.Image]::FromFile($path)

Write-Host ("path=" + $path)
Write-Host ("format=" + $img.RawFormat.ToString())
Write-Host ("width=" + $img.Width)
Write-Host ("height=" + $img.Height)

$img.Dispose()
