# cargo test 包装：修复 Windows 上测试 exe 无法启动的问题（STATUS_ENTRYPOINT_NOT_FOUND）。
#
# 根因：tauri/wry 导入的 comctl32!TaskDialogIndirect 只存在于 Common-Controls v6 程序集，
# 而 cargo 的测试 exe 不经 tauri-build 的 manifest 嵌入（后者只作用于 bin 目标），
# 缺激活上下文时 loader 用 comctl32 5.82 解析导入，进程启动即死。
# 处理：cargo test --no-run 后给每个测试 exe 嵌入 src-tauri/windows/app.manifest（幂等），
# 再运行测试（指纹未变不会重链，嵌入保持有效）。
param(
  [string[]]$TestArgs = @()
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'src-tauri\windows\app.manifest'
$cargoToml = Join-Path $root 'src-tauri\Cargo.toml'

# 定位 mt.exe（Windows SDK 自带；有 Rust msvc 工具链必然有 SDK）
$mt = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\mt.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $mt) { throw '未找到 Windows SDK mt.exe' }

# 1) 构建测试产物（不运行），从 cargo JSON 输出提取测试 exe 路径
$artifacts = cargo test --manifest-path $cargoToml --no-run --message-format=json @TestArgs 2>$null |
  ForEach-Object {
    try { $j = $_ | ConvertFrom-Json } catch { return }
    if ($j.reason -eq 'compiler-artifact' -and $j.executable -and $j.profile.test) { $j.executable }
  } | Sort-Object -Unique
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2) 给每个测试 exe 嵌入激活上下文（对已嵌入的 exe 覆盖 RT_MANIFEST，幂等）
foreach ($exe in $artifacts) {
  & $mt -nologo -manifest $manifest -outputresource:"$exe;#1" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "manifest 嵌入失败: $exe" }
}
Write-Host ("已为 {0} 个测试 exe 嵌入 Common-Controls v6 manifest" -f @($artifacts).Count)

# 3) 直接运行已嵌好 manifest 的测试 exe —— 这里**不能**再走 `cargo test`：
#    mt.exe 改过产物会让 cargo 判定输出失效并重新链接，把刚嵌入的 manifest 覆盖掉，
#    测试进程又变回 STATUS_ENTRYPOINT_NOT_FOUND。CI 是全新编译所以必现，
#    本地因为有上一次的指纹缓存才偶发不现（不可依赖）。
$failed = $false
foreach ($exe in $artifacts) {
  Write-Host ("运行测试: {0}" -f (Split-Path -Leaf $exe))
  & $exe @TestArgs
  if ($LASTEXITCODE -ne 0) { $failed = $true }
}
exit $(if ($failed) { 1 } else { 0 })
