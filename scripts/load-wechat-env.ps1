<#
  从 Windows 用户环境变量读取微信凭据，注入当前进程。
  用法（在同一个 pwsh 调用里 dot-source 后再跑 node）：
      . <skill-root>\scripts\load-wechat-env.ps1
      node <skill-root>\scripts\publish.mjs --title ... --cover ... --content ...

  为什么需要它：本会话的进程早于设置环境变量的时刻，Windows 不会把新变量
  回溯注入已运行的进程，所以直接读 $env:WX_APPID 会得到空值。
  这里改从注册表 HKCU\Environment 读取 —— 注册表是权威且实时的。
#>

$envPath = 'HKCU:\Environment'
$missing = @()

foreach ($name in @('WX_APPID', 'WX_SECRET')) {
    # 1) 先看当前进程（已在新终端设过的情况）
    $val = [System.Environment]::GetEnvironmentVariable($name, 'Process')
    # 2) 进程没有就查用户级注册表（实时、权威、无需重启）
    if ([string]::IsNullOrEmpty($val)) {
        $val = (Get-ItemProperty -Path $envPath -Name $name -ErrorAction SilentlyContinue).$name
    }
    if ([string]::IsNullOrEmpty($val)) {
        $missing += $name
    } else {
        [System.Environment]::SetEnvironmentVariable($name, $val, 'Process')
    }
}

if ($missing.Count -eq 0) {
    Write-Host ("✅ 凭据已读入（AppID: {0}；WX_SECRET 长度 {1}，不显示内容）" -f $env:WX_APPID, $env:WX_SECRET.Length) -ForegroundColor Green
} else {
    Write-Host ("❌ 缺少：{0}" -f ($missing -join ', ')) -ForegroundColor Red
    Write-Host '请设置用户环境变量（任选一种，设置后无需重启）：' -ForegroundColor Yellow
    Write-Host '  ① 图形界面：Win 键搜索「编辑用户环境变量」→ 新建'
    Write-Host '       WX_APPID  = wx...（你的公众号 AppID）'
    Write-Host '       WX_SECRET = <你的 AppSecret>'
    Write-Host '  ② 命令行（新开一个终端执行一次，永久生效）：'
    Write-Host '       setx WX_APPID "wx你的AppID"'
    Write-Host '       setx WX_SECRET "wx你的AppSecret"'
    exit 1
}
