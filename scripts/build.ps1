# 构建脚本：npm install -> link_deps(junction 宿主依赖) -> tsdown 双端打包 -> 自检
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "[build] node version:" -ForegroundColor Cyan
node -v
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "dsh 0.1.x 需要 Node 22+，当前版本过低。" }

Write-Host "[build] npm install (--legacy-peer-deps) ..." -ForegroundColor Cyan
Push-Location $root
try {
    npm install --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }

    Write-Host "[build] link host deps (junction) ..." -ForegroundColor Cyan
    python scripts/link_deps.py
    if ($LASTEXITCODE -ne 0) { throw "link_deps 失败" }

    Write-Host "[build] tsdown (dual entry) ..." -ForegroundColor Cyan
    npx tsdown
    if ($LASTEXITCODE -ne 0) { throw "tsdown 打包失败" }

    Write-Host "[build] write type declaration ..." -ForegroundColor Cyan
    @'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
export declare const name: string
export declare const inject: string[]
export declare const Config: ReturnType<typeof z.object>
export declare function apply(ctx: Context, config?: Record<string, unknown>): void
'@ | Set-Content -Encoding UTF8 "$root\lib\index.d.ts"

    Write-Host "[build] self-check ..." -ForegroundColor Cyan
    if (-not (Test-Path "$root\lib\index.js")) { throw "缺少 lib/index.js" }
    if (-not (Test-Path "$root\lib\client.js")) { throw "缺少 lib/client.js" }
    $client = Get-Content "$root\lib\client.js" -Raw
    if ($client -match 'import\s*\(') { throw "浏览器产物含动态 import，违反沙箱约束" }
    if (-not $client.Contains('__ModuleLoader__')) { throw "浏览器产物缺少 ModuleLoader 包装" }
    Write-Host "[build] OK: lib/index.js + lib/client.js 已生成并通过自检。" -ForegroundColor Green
} finally {
    Pop-Location
}
