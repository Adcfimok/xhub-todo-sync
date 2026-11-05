# upload-market.ps1 — 上传 dist-market 产物到分发端点
# ⚠️ 扩展发布自 2026-09 起统一走服务端（x-hub-server 审核台 → 服务端签名 → 推 COS）。
#    本脚本推送 dist-market（本地打包产物）的通道**默认停用**：它会把本机的清单覆盖上云，
#    与服务端并存时会出现「清单与签名不是同一版」，客户端会拒收整份清单。
#    应急绕过：设 XHUB_ALLOW_MANUAL_UPLOAD=1（仅在服务端不可用时；事后用 x-hub-server 的
#    npm run verify:registry 核对线上清单与签名是同一对）。
# 通道：-Target cos（默认，腾讯云 COS，现行唯一有效通道）/-Target sftp（备选，自建 Nginx）。
# R2 通道已于 2026-09 摘除（桶内 extensions/ 已清空、域名已作废，写进去也没人读），
# 保留 sftp 是因为自建分发仍是一条可用的应急路线。
# 用法:
#   .\scripts\upload-market.ps1                                  # cos → 腾讯云 COS（读 COS_* 环境变量）
#   .\scripts\upload-market.ps1 -Target sftp                     # → 自建服务器（读 XHUB_DEPLOY_*）
# 环境变量:
#   COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET(含 APPID 后缀) / COS_REGION(如 ap-guangzhou)
#   XHUB_DEPLOY_HOST / XHUB_DEPLOY_PORT(默认22) / XHUB_DEPLOY_USER(默认deploy) / XHUB_DEPLOY_KEY
# 依赖: rclone (winget install --id Rclone.Rclone)

param(
  [ValidateSet('cos', 'sftp')][string]$Target = 'cos',

  # —— cos（腾讯云 COS，长期主通道）——
  [string]$CosSecretId  = $env:COS_SECRET_ID,
  [string]$CosSecretKey = $env:COS_SECRET_KEY,
  [string]$CosBucket    = $env:COS_BUCKET,
  [string]$CosRegion    = $env:COS_REGION,

  # —— sftp（自建 Nginx，备选）——
  [string]$SftpHost    = $env:XHUB_DEPLOY_HOST,
  [string]$SftpPort    = $env:XHUB_DEPLOY_PORT,
  [string]$SftpUser    = $env:XHUB_DEPLOY_USER,
  [string]$SftpKeyPath = $env:XHUB_DEPLOY_KEY,
  [int]$HttpPort       = 8080,
  [string]$RemoteRoot  = "/srv/x-hub-dist",

  # —— 通用 ——
  [string]$DistDir = (Join-Path $PSScriptRoot "..\dist-market"),
  [string]$Prefix  = "extensions",
  # 抽查下载用的代理（如 http://127.0.0.1:7890）；直连对象存储慢的机器设置 XHUB_UPLOAD_PROXY 即可
  [string]$CheckProxy = $env:XHUB_UPLOAD_PROXY
)

$ErrorActionPreference = "Stop"

# ---------- 停用闸（发布入口唯一化）----------
$isDistMarket = (Split-Path -Leaf $DistDir) -eq 'dist-market'
if ($isDistMarket -and $env:XHUB_ALLOW_MANUAL_UPLOAD -ne '1') {
  throw @'
本通道已停用：扩展发布统一走服务端审核台，本脚本不再推送本机打包产物（dist-market）。

  正常流程：客户端「扩展中心 → 发布」→ 服务端关卡/审核 → 服务端签名并推送 COS
  线上自检：x-hub-server 仓 `npm run verify:registry`（清单与签名是否同一对）

应急绕过（仅在服务端不可用时）：$env:XHUB_ALLOW_MANUAL_UPLOAD = '1'
'@
}

if (-not (Test-Path (Join-Path $DistDir "registry.json"))) {
  Write-Error "本地产物缺失 registry.json：请先运行 publish-extension.ps1（$DistDir 不存在或未生成）。"
}

# --- 1. 检查 rclone（PATH 未生效时自动定位 winget 安装路径）---
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  $candidates = @()
  $pkg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "rclone.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) { $candidates += $pkg.FullName }
  $aliasPath = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\rclone.exe"
  if (Test-Path $aliasPath) { $candidates += $aliasPath }
  if ($candidates.Count -gt 0) {
    $env:PATH = "$(Split-Path $candidates[0]);$env:PATH"
  } else {
    Write-Error "未找到 rclone。请先安装: winget install --id Rclone.Rclone"
  }
}

# --- 2. 按通道配置临时 rclone remote（环境变量，不落地 config）+ 目标 URL ---
$noCacheHeader   = "Cache-Control: no-cache"
$immutableHeader = "Cache-Control: public, max-age=31536000, immutable"

if ($Target -eq 'cos') {
  if (-not $CosSecretId -or -not $CosSecretKey -or -not $CosBucket -or -not $CosRegion) {
    Write-Error "缺少 COS 参数。请设置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET（含 APPID 后缀，如 x-hub-dist-125xxxxxxx）/ COS_REGION（如 ap-guangzhou）环境变量。"
  }

  $env:RCLONE_CONFIG_COS_TYPE              = "s3"
  $env:RCLONE_CONFIG_COS_PROVIDER          = "TencentCOS"
  $env:RCLONE_CONFIG_COS_ACCESS_KEY_ID     = $CosSecretId
  $env:RCLONE_CONFIG_COS_SECRET_ACCESS_KEY = $CosSecretKey
  $env:RCLONE_CONFIG_COS_ENDPOINT          = "cos.$CosRegion.myqcloud.com"

  $remote  = "cos:$CosBucket"
  $urlBase = "https://$CosBucket.cos.$CosRegion.myqcloud.com" + $(if ($Prefix) { "/$Prefix" } else { "" })
  Write-Host "通道: cos → $remote/$Prefix（缓存头随上传设置）"
} else {
  if (-not $SftpHost -or -not $SftpKeyPath) {
    Write-Error "缺少部署参数。请用 -SftpHost/-SftpKeyPath 传入，或设置 XHUB_DEPLOY_HOST / XHUB_DEPLOY_KEY 环境变量（XHUB_DEPLOY_USER 默认 deploy、XHUB_DEPLOY_PORT 默认 22）。"
  }
  if (-not ($SftpUser)) { $SftpUser = "deploy" }
  if (-not ($SftpPort)) { $SftpPort = "22" }
  if (-not (Test-Path -LiteralPath $SftpKeyPath)) { Write-Error "未找到私钥文件: $SftpKeyPath" }

  $env:RCLONE_CONFIG_XHUBSFTP_TYPE           = "sftp"
  $env:RCLONE_CONFIG_XHUBSFTP_HOST           = $SftpHost
  $env:RCLONE_CONFIG_XHUBSFTP_PORT           = $SftpPort
  $env:RCLONE_CONFIG_XHUBSFTP_USER           = $SftpUser
  $env:RCLONE_CONFIG_XHUBSFTP_KEY_FILE       = $SftpKeyPath
  # 首次连接跳过 host key 校验；要加固可预置 known_hosts 并改用 known_hosts_file 选项
  $env:RCLONE_CONFIG_XHUBSFTP_HOST_KEY_VERIFY = "false"

  $remote  = "xhubsftp:$RemoteRoot"
  $urlBase = "http://$SftpHost`:$HttpPort" + $(if ($Prefix) { "/$Prefix" } else { "" })
  Write-Host "通道: sftp → $remote/$Prefix（缓存头由服务器端 Nginx 管理）"
}

$dest = if ($Prefix) { "$remote/$Prefix" } else { $remote }
$useHeader = ($Target -ne 'sftp')   # 对象存储通道缓存头随上传设置；sftp 通道由 Nginx 管理

# --- 3. 上传（清单可回源，包/图标不可变）---
Write-Host "[1/3] 校验连接与目录（lsd）..."
rclone lsd $remote
if ($LASTEXITCODE -ne 0) { Write-Error "rclone lsd 失败，请检查通道凭据与目标目录。" }
Write-Host "      连接 OK" -ForegroundColor Green

Write-Host "[2/3] 上传 registry.json(.sig) ..."
if ($useHeader) {
  rclone copy $DistDir $dest --include "registry.json*" --header-upload $noCacheHeader -P
} else {
  rclone copy $DistDir $dest --include "registry.json*" -P
}
if ($LASTEXITCODE -ne 0) { Write-Error "registry 上传失败。" }
Write-Host "      registry OK" -ForegroundColor Green

Write-Host "[3/3] 上传 packages/** 与 icons/** ..."
if ($useHeader) {
  rclone copy $DistDir $dest --include "packages/**" --include "icons/**" --header-upload $immutableHeader -P
} else {
  rclone copy $DistDir $dest --include "packages/**" --include "icons/**" -P
}
if ($LASTEXITCODE -ne 0) { Write-Error "packages/icons 上传失败。" }
Write-Host "      packages/icons OK" -ForegroundColor Green

# --- 4. 验证 HTTP 可访问性 + sha256 抽查 ---
Write-Host "验证 HTTP 可访问性 ..."
foreach ($p in "registry.json", "registry.json.sig") {
  $url = "$urlBase/$p"
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
  "{0} -> HTTP {1} ({2} bytes)" -f $url, $r.StatusCode, $r.RawContentLength
  if ($r.StatusCode -ne 200) { Write-Error "$url 未返回 200" }
}

$local = Get-ChildItem "$DistDir\packages" -Recurse -Filter *.xhpack | Select-Object -First 1
if ($local) {
  $hash = (Get-FileHash $local.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $dl = Join-Path $env:TEMP "market-check-$($local.Name)"
  $rel = $local.FullName.Substring((Resolve-Path $DistDir).Path.Length + 1).Replace('\','/')
  # 用系统 curl（--max-time 硬超时）：Invoke-WebRequest 在部分网络环境下读 CDN 包体会挂住且超时参数兜不住
  # 直连对象存储慢的线路可设 XHUB_UPLOAD_PROXY（如 http://127.0.0.1:7890）让抽查走代理
  $curlArgs = @('-fsS', '--max-time', '120', '-o', $dl)
  if ($CheckProxy) { $curlArgs += @('-x', $CheckProxy) }
  $curlArgs += "$urlBase/$rel"
  curl.exe @curlArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "sha256 抽查下载失败（curl exit=$LASTEXITCODE，超时或非 2xx）：$urlBase/$rel —— 若直连对象存储过慢，请设置 XHUB_UPLOAD_PROXY 后重跑" }
  $dlHash = (Get-FileHash $dl -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $dlHash) { Write-Error "sha256 不一致！本地 $hash vs 远端 $dlHash" }
  Remove-Item $dl -Force
  "xhpack sha256 校验一致: $hash"
}
Write-Host "全部完成 ✔ 市场现已可访问: $urlBase/registry.json" -ForegroundColor Green
