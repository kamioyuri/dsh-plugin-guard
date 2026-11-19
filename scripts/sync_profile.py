#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本插件的 lib/ 产物同步到已安装的 profile 插件目录。

file: 安装是复制，改代码重建后需同步并重启 dsh。
用法：
  python scripts/sync_profile.py <profile>     # profile 名，如 web / headless
  python scripts/sync_profile.py web --dry-run
"""
import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG_NAME = "@yuri/dsh-plugin-guard"
HOME = os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh"))


def main() -> None:
    ap = argparse.ArgumentParser(description="同步插件产物到已安装 profile")
    ap.add_argument("profile", help="profile 名，如 web")
    ap.add_argument("--dry-run", action="store_true", help="只打印将复制的路径")
    args = ap.parse_args()

    profile_dir = os.path.join(HOME, "profiles", args.profile)
    dst = os.path.join(profile_dir, "node_modules", PKG_NAME.replace("/", os.sep))
    src_lib = os.path.join(ROOT, "lib")
    if not os.path.isdir(src_lib):
        print(f"[sync] 错误：未找到 lib/，请先构建：{src_lib}", file=sys.stderr)
        sys.exit(1)

    print(f"[sync] src: {src_lib}")
    print(f"[sync] dst: {dst}")
    if not os.path.isdir(dst):
        print(f"[sync] 警告：目标插件目录不存在，可能尚未安装。请先运行：", file=sys.stderr)
        print(f"       dsh plugin --profile {args.profile} add file:{ROOT}", file=sys.stderr)
        sys.exit(1)
    if args.dry_run:
        print("[sync] dry-run，未复制。")
        return

    dst_lib = os.path.join(dst, "lib")
    # 先复制成功再替换，避免中途失败删掉 profile 里的 lib。
    tmp_lib = dst_lib + ".sync-tmp"
    if os.path.isdir(tmp_lib):
        shutil.rmtree(tmp_lib)
    shutil.copytree(src_lib, tmp_lib)
    if os.path.isdir(dst_lib):
        shutil.rmtree(dst_lib)
    os.rename(tmp_lib, dst_lib)
    for f in ("cordis.patch.yml",):
        s = os.path.join(ROOT, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(dst, f))
    print("[sync] OK：产物已同步，请重启 dsh 生效。")


if __name__ == "__main__":
    main()
