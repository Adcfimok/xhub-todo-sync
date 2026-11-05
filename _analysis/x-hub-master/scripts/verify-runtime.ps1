# 实机验收辅助：从日志核对 P1a 的关键改动是否真的生效
#
# 用法（跑完 npm run tauri:dev 并操作过界面之后执行）：
#   pwsh -File scripts/verify-runtime.ps1
#   pwsh -File scripts/verify-runtime.ps1 -LogPath "D:\app\data\logs\x-hub.log"   # 便携版/自定义数据目录
#
# 它只读日志、不改任何东西。逐项告诉你是「已生效 / 未观察到 / 有问题」，
# 把「资产作用域收紧 + 独立协议 + 本机源码目录直挂」这三件事从"目测"变成"有据可查"。

param(
  [string]$LogPath = "$env:APPDATA\x-hub\logs\x-hub.log"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $LogPath)) {
  Write-Host "找不到日志文件：$LogPath" -ForegroundColor Red
  Write-Host "提示：便携版的数据根在 exe 同目录的 data\\logs\\，请用 -LogPath 指定。" -ForegroundColor Yellow
  exit 2
}

$lines = Get-Content -LiteralPath $LogPath
# 只关心最后一次启动之后的记录（之前的都是历史版本留下的）
$startIdx = -1
for ($i = $lines.Count - 1; $i -ge 0; $i--) {
  if ($lines[$i] -match '=====+ x-hub 启动 =====+') { $startIdx = $i; break }
}
$session = if ($startIdx -ge 0) { $lines[$startIdx..($lines.Count - 1)] } else { $lines }

$pass = 0; $fail = 0; $wait = 0
function Report($state, $title, $detail) {
  switch ($state) {
    'PASS' { $script:pass++; Write-Host "[PASS] $title" -ForegroundColor Green }
    'FAIL' { $script:fail++; Write-Host "[FAIL] $title" -ForegroundColor Red }
    default { $script:wait++; Write-Host "[待验证] $title" -ForegroundColor Yellow }
  }
  if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray }
}

Write-Host ""
Write-Host "日志：$LogPath"
Write-Host ("本轮启动记录：{0} 行" -f $session.Count)
Write-Host "─────────────────────────────────────────────"

# 1) 独立协议：扩展入口必须是 xhub-ext:// 而不是 asset.localhost
$entryLines = $session | Where-Object { $_ -match '扩展入口就绪' }
$extProto = $entryLines | Where-Object { $_ -match 'xhub-ext\.localhost' }
$legacyProto = $entryLines | Where-Object { $_ -match 'asset\.localhost|\.xhpack' }
if ($extProto.Count -gt 0) {
  Report 'PASS' "扩展走独立协议加载（xhub-ext）" ("共 {0} 次，例如：{1}" -f $extProto.Count, (@($extProto)[-1] -replace '^.*扩展入口就绪:\s*', ''))
} elseif ($legacyProto.Count -gt 0) {
  Report 'FAIL' "扩展仍在走旧的 asset 协议" "看到 .xhpack/asset.localhost 记录 —— 说明跑的是旧构建"
} else {
  Report 'WAIT' "没有观察到扩展加载记录" "请在实机里打开任意一个已装扩展，然后重跑本脚本"
}

# 2) 本机源码目录（开发扩展）是否已应用
$devApplied = $session | Where-Object { $_ -match '本机源码目录已应用' }
$devAdded = $session | Where-Object { $_ -match '本机扩展目录已添加' }
if ($devApplied.Count -gt 0) {
  Report 'PASS' "本机源码目录已重放（启动时按配置放行源码目录）" @($devApplied)[-1]
} elseif ($devAdded.Count -gt 0) {
  Report 'PASS' "本机源码目录本次会话内已添加（登记即加载）" @($devAdded)[-1]
} else {
  Report 'WAIT' "未观察到本机源码目录记录" "若你还没在「扩展中心 → 我的扩展」里添加目录，属正常"
}

# 3) 资产作用域是否放行失败（白名单目录创建/放行出错会让图标/壁纸/剪贴板图片显示不出来）
$aclFail = $session | Where-Object { $_ -match '资产作用域(目录创建|放行)失败' }
if ($aclFail.Count -gt 0) {
  Report 'FAIL' "资产作用域放行出错（图标/壁纸/剪贴板图片可能显示不出来）" @($aclFail)[-1]
} else {
  Report 'PASS' "资产作用域放行无报错"
}

# 4) 扩展协议拒绝记录（说明有人在探测越界路径，属正常防护；也说明安全校验在工作）
$protoReject = $session | Where-Object { $_ -match '扩展协议拒绝' }
if ($protoReject.Count -gt 0) {
  Report 'PASS' "扩展协议拒绝了越界/非法请求（安全校验在工作）" ("共 {0} 条" -f $protoReject.Count)
} else {
  Report 'PASS' "扩展协议无拒绝记录"
}

# 5) 服务端相关（账号 / 发布）—— 只有登录或发布过才会有
$accountLogin = $session | Where-Object { $_ -match '登录成功|已退出账号|账号会话已失效' }
if ($accountLogin.Count -gt 0) {
  Report 'PASS' "账号相关记录" @($accountLogin)[-1]
} else {
  Report 'WAIT' "未观察到账号相关记录" "若还没登录，属正常"
}
$publishLog = $session | Where-Object { $_ -match '发布打包完成|发布提交完成' }
if ($publishLog.Count -gt 0) {
  Report 'PASS' "发布链路记录" @($publishLog)[-1]
} else {
  Report 'WAIT' "未观察到发布记录" "若还没点过「发布」，属正常"
}

# 6) 错误总览
#    注意：`asset protocol not configured to allow the path` 是**安全边界在工作**的证据
#    （探针或扩展试图读数据根被挡下），不算故障——单独统计，不计入 ERROR。
$assetDenied = $session | Where-Object { $_ -match '\[ERROR\].*asset protocol not configured to allow the path' }
if ($assetDenied.Count -gt 0) {
  Report 'PASS' ("资产协议拒绝了 {0} 次越界文件访问（安全边界在工作）" -f $assetDenied.Count) (@($assetDenied)[-1])
  Report 'WAIT' "   ↳ 若你不是在跑安全探针，说明有扩展在尝试读数据目录，值得看一眼是谁"
}
$errors = $session | Where-Object { $_ -match '\[ERROR\]' -and $_ -notmatch 'asset protocol not configured to allow the path' }
if ($errors.Count -eq 0) {
  Report 'PASS' "本次会话无非预期 ERROR"
} else {
  Report 'FAIL' ("本次会话有 {0} 条 ERROR" -f $errors.Count) @($errors)[-1]
}

Write-Host "─────────────────────────────────────────────"
Write-Host ("通过 {0} ｜ 需人工看 {1} ｜ 失败 {2}" -f $pass, $wait, $fail)
Write-Host ""
Write-Host "提醒：本脚本只能证明「后端日志」层面的事；界面观感（图标/壁纸/剪贴板图片、热重载）" -ForegroundColor DarkGray
Write-Host "      仍需按 x-hub-server docs/ACCEPTANCE-signing-migration.md §二（客户端实机验收）目测一遍。" -ForegroundColor DarkGray
Write-Host ""

exit $(if ($fail -gt 0) { 1 } else { 0 })
