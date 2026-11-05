#requires -Version 7
<#
.SYNOPSIS
  【已停用】本地打包发布扩展。

.NOTES
  ⚠️ 扩展发布自 2026-09 起**统一走服务端审核台**：
      客户端「发布」→ 服务端关卡 + AI 预审 + 人工审核 → 服务端签名并推送 COS。
  本脚本已停用（默认拒绝执行），原因：
    1. 发布入口必须唯一 —— 本机脚本与服务端同时写 COS/registry，会造成「两方各自 upsert」，
       线上出现过「清单与签名不是同一版」导致所有客户端拒收整份清单的故障；
    2. 私钥纪律 —— 服务端接管签发后，本机不应再持有可用于发布的私钥（见 x-hub-server
       docs/ACCEPTANCE-signing-migration.md §一）。

  确需应急绕过（服务端不可用、要手工救场）时：设置环境变量 XHUB_ALLOW_LOCAL_PUBLISH=1。
  绕过前请先确认服务端当前没有并发发布，并在之后用 x-hub-server 的 `npm run verify:registry`
  核对线上清单与签名是同一对。

.DESCRIPTION
  打包扩展并生成本地发布产物（市场清单 v2）。
  生成到 <OutDir>（默认 <仓库>/dist-market）：
    packages/<id>/<version>/<id>-<version>.xhpack — 扩展包（zip 格式，后缀统一 .xhpack，不可变路径）
    icons/<id>.<ext>                              — 图标（manifest.icon 存在时）
    registry.json                                 — 合并后的完整清单（upsert 该扩展）
    registry.json.sig                             — Ed25519 分离签名（base64 文本）

.PARAMETER ExtDir
  扩展源码目录（含 manifest.json）。
.PARAMETER SignKey
  Ed25519 私钥 PEM 路径（默认取环境变量 XHUB_SIGNING_KEY）。
.PARAMETER Endpoint
  市场根 URL，默认取环境变量 XHUB_DIST_BASE_URL（如 http://IP:8080）拼 /extensions；两者都缺则报错。
.PARAMETER OutDir
  产物根目录，默认 <仓库>/dist-market。
.EXAMPLE
  # 正常流程（推荐）：不要用本脚本，改走服务端审核台
  ./scripts/publish-extension.ps1 -ExtDir <扩展源码目录> -SignKey <私钥文件>
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtDir,
  [string]$SignKey = $env:XHUB_SIGNING_KEY,
  [string]$Endpoint = $(if ($env:XHUB_DIST_BASE_URL) { "$($env:XHUB_DIST_BASE_URL.TrimEnd('/'))/extensions" } else { '' }),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist-market')
)

$ErrorActionPreference = 'Stop'

# ---------- 停用闸（发布入口唯一化）----------
if ($env:XHUB_ALLOW_LOCAL_PUBLISH -ne '1') {
  throw @'
本脚本已停用：扩展发布统一走服务端审核台。

  客户端「扩展中心 → 发布」→ 服务端关卡 + AI 预审 + 人工审核 → 服务端签名并推送 COS
  服务端仓：x-hub-server（发布台 /console/，自检 npm run push:check、npm run verify:registry）

应急绕过（仅在服务端不可用时）：$env:XHUB_ALLOW_LOCAL_PUBLISH = '1'
'@
}
Write-Warning 'XHUB_ALLOW_LOCAL_PUBLISH=1：正在用已停用的本地通道发布。请确认服务端当前没有并发发布，事后用 verify:registry 核对清单与签名。'

# ---------- 校验入参 ----------
$manifestPath = Join-Path $ExtDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "未找到 manifest.json: $manifestPath" }
if (-not $SignKey) { throw '缺少签名私钥：请用 -SignKey 指定或设置环境变量 XHUB_SIGNING_KEY' }
if (-not $Endpoint) { throw '未指定市场端点：请用 -Endpoint 传入或设置环境变量 XHUB_DIST_BASE_URL' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js（用于 Ed25519 签名）' }

$manifest = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$id = $manifest.id
$version = $manifest.version
if (-not $id -or -not $version) { throw 'manifest.json 缺少 id 或 version' }
if (-not ($version -match '^\d+\.\d+\.\d+$')) { throw "version 需为语义化版本（x.y.z），实际: $version" }

# ---------- 1. 打包 xhpack（zip 格式，后缀统一 .xhpack；manifest.json 必须位于包根） ----------
$pkgDir = Join-Path $OutDir "packages\$id\$version"
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
$zip = Join-Path $pkgDir "$id-$version.xhpack"
$tmpZip = Join-Path $env:TEMP "$($id.Replace('.', '-'))-$version-$([guid]::NewGuid().ToString('N')).xhpack"
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
Compress-Archive -Path (Join-Path $ExtDir '*') -DestinationPath $tmpZip -CompressionLevel Optimal
Move-Item -LiteralPath $tmpZip -Destination $zip -Force
$sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zip).Length

# ---------- 2. 图标（可选）：复制到 icons/<id>.<ext>，清单 icon 指向 CDN ----------
$iconUrl = ''
if ($manifest.icon) {
  $iconSrc = Join-Path $ExtDir ($manifest.icon -replace '^\.?/', '')
  if (Test-Path -LiteralPath $iconSrc) {
    $ext = [System.IO.Path]::GetExtension($manifest.icon)
    $iconDestDir = Join-Path $OutDir 'icons'
    New-Item -ItemType Directory -Force -Path $iconDestDir | Out-Null
    Copy-Item -LiteralPath $iconSrc -Destination (Join-Path $iconDestDir "$id$ext") -Force
    $iconUrl = "$Endpoint/icons/$id$ext"
  } else {
    Write-Warning "manifest.icon 指向的文件不存在，跳过图标: $iconSrc"
  }
}

# ---------- 3. 市场条目：manifest 基础字段 + 可选 market.json 补充字段 ----------
function NonNull([string]$v) { if ($null -eq $v) { '' } else { $v } }
$entry = [ordered]@{
  id           = $id
  name         = NonNull $manifest.name
  version      = $version
  description  = NonNull $manifest.description
  runtime      = NonNull $manifest.runtime
  author       = NonNull $manifest.author
  downloadUrl  = "$Endpoint/packages/$id/$version/$id-$version.xhpack"
  sha256       = $sha256
  size         = $size
  icon         = $iconUrl
}
# 附加/覆盖字段（minAppVersion / changelog / homepage / required / description…）
$marketMeta = Join-Path $ExtDir 'market.json'
if (Test-Path -LiteralPath $marketMeta) {
  $meta = Get-Content -LiteralPath $marketMeta -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($p in $meta.PSObject.Properties) {
    if ($null -ne $p.Value) { $entry[$p.Name] = $p.Value }
  }
}

# ---------- 4. 合并 registry.json（upsert 该 id，保留其它条目） ----------
$registryPath = Join-Path $OutDir 'registry.json'
if (Test-Path -LiteralPath $registryPath) {
  $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($registry.schemaVersion -gt 2) { throw "registry.json schemaVersion=$($registry.schemaVersion) 高于当前支持 v2" }
} else {
  $registry = [pscustomobject]@{ schemaVersion = 2; updatedAt = ''; extensions = @($null) }
}
if ($null -eq $registry.extensions) { $registry.extensions = @($null) }
$others = @($registry.extensions | Where-Object { $_ -and $_.id -ne $id })
$registry.extensions = $others + [pscustomobject]$entry
$registry.updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# 幂等去重：同一 id 出现多次只保留最后一条
$seen = [System.Collections.Generic.HashSet[string]]::new()
$unique = @()
foreach ($e in @($registry.extensions)) {
  if ($e -and $seen.Add([string]$e.id)) { $unique += $e }
}
$registry.extensions = $unique

$registry | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $registryPath -Encoding utf8

# ---------- 5. Ed25519 分离签名 ----------
$sigPath = "$registryPath.sig"
node (Join-Path $PSScriptRoot 'pub-sign.mjs') $SignKey $registryPath $sigPath
if ($LASTEXITCODE -ne 0) { throw 'Ed25519 签名失败' }

# ---------- 6. 输出 ----------
Write-Host ''
Write-Host '==== 发布产物（上传到分发服务器 extensions/，与 dist-market 内容对应） ====' -ForegroundColor Cyan
Write-Host "xhpack  : $zip"
Write-Host "sha256   : $sha256"
Write-Host "size     : $size bytes"
if ($iconUrl) { Write-Host "icon     : $iconUrl" }
Write-Host "registry : $registryPath"
Write-Host "sig      : $sigPath"
Write-Host ''
Write-Host '⚠️ 本地产物已生成，但发布入口已统一到服务端。' -ForegroundColor Yellow
Write-Host '   正常流程：客户端「扩展中心 → 发布」，由服务端审核、签名并推送 COS。' -ForegroundColor Yellow
Write-Host '   应急上传：scripts\upload-market.ps1（需额外设 XHUB_ALLOW_MANUAL_UPLOAD=1）。' -ForegroundColor Yellow