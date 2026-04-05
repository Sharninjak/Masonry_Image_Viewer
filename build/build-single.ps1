param(
  [string]$InputHtml = ".\\MasonryViewer.html",
  [string]$InputCss = ".\\style.css",
  [string]$InputJs = ".\\script.js",
  [string]$OutputFile = ".\\dist\\MasonryImageViewer.html"
)

$ErrorActionPreference = "Stop"

function Assert-FileExists {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "File not found: $Path"
  }
}

Assert-FileExists -Path $InputHtml
Assert-FileExists -Path $InputCss
Assert-FileExists -Path $InputJs

$outputDir = Split-Path -Path $OutputFile -Parent
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$html = Get-Content -LiteralPath $InputHtml -Raw -Encoding UTF8
$css = Get-Content -LiteralPath $InputCss -Raw -Encoding UTF8
$js = Get-Content -LiteralPath $InputJs -Raw -Encoding UTF8

# Remove external style.css link
$html = [regex]::Replace(
  $html,
  '<link[^>]*href="style\.css"[^>]*>\s*',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

# Remove external script.js reference
$html = [regex]::Replace(
  $html,
  '<script[^>]*src="script\.js"[^>]*>\s*</script>\s*',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

# Remove external PWA/icon links to keep final output fully standalone
$html = [regex]::Replace(
  $html,
  '<link[^>]*rel="manifest"[^>]*>\s*',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

$html = [regex]::Replace(
  $html,
  '<link[^>]*rel="icon"[^>]*>\s*',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

$html = [regex]::Replace(
  $html,
  '<link[^>]*rel="apple-touch-icon"[^>]*>\s*',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

# Remove service worker registration from inlined JS (single-file mode)
$js = [regex]::Replace(
  $js,
  '^\s*navigator\.serviceWorker\.register\("sw\.js"\);?\s*$\r?\n?',
  '',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline
)

# Inject inline CSS before </head>
if ($html -notmatch '</head>') {
  throw 'Input HTML does not contain </head>'
}
$html = $html -replace '</head>', "<style>`n$css`n</style>`n</head>"

# Inject inline JS before </body>
if ($html -notmatch '</body>') {
  throw 'Input HTML does not contain </body>'
}
$html = $html -replace '</body>', "<script>`n$js`n</script>`n</body>"

Set-Content -LiteralPath $OutputFile -Value $html -Encoding UTF8

Write-Host "Built single file:" $OutputFile
Get-Item -LiteralPath $OutputFile | Select-Object FullName, Length
