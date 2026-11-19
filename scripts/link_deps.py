#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 dsh 发布包内的宿主依赖以 junction 方式整体链进本插件的 node_modules。

必须在 npm install 之后运行（npm install 会清掉 junction，且会装上版本不一致的
旧包：例如 package.json 声明 0.0.1-rc.1 而 lib 是 0.2.x，导致加载时缺
@deepseek-ai/dsh-scope 等传递依赖）。整体链接可保证所有宿主依赖版本一致。

Windows 用 junction（mklink /J 或 New-Item -ItemType Junction，都不需要管理员权限）。
"""
import os
import shutil
import subprocess
import sys

def _find_cache() -> str:
    """定位含 @deepseek-ai/* 的 node_modules（跨平台，无硬编码用户路径）。
    优先级：环境变量 DSH_CACHE > npx 缓存探测 > npm 全局缓存探测。"""
    explicit = os.environ.get("DSH_CACHE", "").strip()
    if explicit:
        return explicit

    home = os.path.expanduser("~")
    candidates = []
    # npx 缓存：<npm-cache>/_npx/<hash>/node_modules
    npx_root = os.path.join(home, ".npm", "_npx")
    if os.name == "nt":
        npx_root = os.path.join(os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local")), "npm-cache", "_npx")
    if os.path.isdir(npx_root):
        for entry in sorted(os.listdir(npx_root), reverse=True):
            p = os.path.join(npx_root, entry, "node_modules")
            if os.path.isdir(os.path.join(p, "@deepseek-ai")):
                candidates.append(p)
    # npm 缓存里的全局 node_modules
    try:
        out = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            candidates.append(out.stdout.strip())
    except Exception:
        pass

    for p in candidates:
        if os.path.isdir(os.path.join(p, "@deepseek-ai", "dsh-tools")):
            return p
    return candidates[0] if candidates else os.path.join(home, ".npm", "_npx")


CACHE_AI = _find_cache()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "node_modules", "@deepseek-ai")
SOURCE = os.path.join(CACHE_AI, "@deepseek-ai")


def is_link_or_missing(path: str) -> bool:
    """目标不存在，或已经是指向正确来源的 junction/symlink。"""
    if not os.path.exists(path):
        return True
    if os.path.islink(path):
        return True
    # Windows junction: os.path.islink 在部分 Python 版本对 junction 返回 False，
    # 用 os.readlink 再探一次，失败则视为实体目录。
    try:
        os.readlink(path)
        return True
    except OSError:
        return False


def link_whole(source: str, target: str) -> None:
    if not os.path.isdir(source):
        print(f"[link_deps] 错误：源目录不存在：{source}", file=sys.stderr)
        print("[link_deps] 请设置 DSH_CACHE 指向含 @deepseek-ai/* 的 node_modules。", file=sys.stderr)
        sys.exit(1)

    if not is_link_or_missing(target):
        # 是 npm install 装出的实体目录 —— 备份后移除，避免版本混杂。
        bak = target + ".npm-bak"
        if os.path.exists(bak):
            shutil.rmtree(bak)
        print(f"[link_deps] 检测到实体 @deepseek-ai 目录，备份到 {bak}")
        shutil.move(target, bak)

    if os.path.exists(target) or os.path.islink(target):
        print(f"[link_deps] 已链接，跳过: {target}")
        return

    os.makedirs(os.path.dirname(target), exist_ok=True)
    if os.name == "nt":
        # cmd /c mklink /J —— junction，无需管理员权限。
        subprocess.run(["cmd", "/c", "mklink", "/J", target, source], check=True, shell=False)
    else:
        os.symlink(source, target, target_is_directory=True)
    print(f"[link_deps] linked: {target} -> {source}")


def main() -> None:
    print(f"[link_deps] SOURCE = {SOURCE}")
    link_whole(SOURCE, TARGET)
    # 校验关键包版本一致性。
    pkg = os.path.join(TARGET, "dsh-tools", "package.json")
    if os.path.isfile(pkg):
        import json
        with open(pkg, encoding="utf-8") as f:
            print(f"[link_deps] dsh-tools version = {json.load(f).get('version')}")


if __name__ == "__main__":
    main()
