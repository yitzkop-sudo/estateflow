$ErrorActionPreference = "Stop"

$url = "https://pub-6d24529af5b6438f895cf5350a9bd511.r2.dev/23190155e9b148adad91627d9a9c3ee1/6c0f2c3a1e5a48439b2569994e87805a/58bbe4275cf24d9ba3a7fa65397e02f7.png"
$out = "transloadit_image.png"

Invoke-WebRequest -Uri $url -OutFile $out
$size = (Get-Item $out).Length

Write-Host ("downloaded: " + $out + ", size: " + $size + " bytes")
