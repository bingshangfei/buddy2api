#!/usr/bin/env python3
"""make-icon.py — 把 PNG 转成多尺寸 .ico（Windows 快捷方式用）。

用法：
    python scripts/make-icon.py <源图.png> <输出.ico>

处理：
  - 转 RGBA（保留透明）
  - 居中裁剪成正方形（ICO 各尺寸都是方的，非方图直接缩放会变形）
  - 生成 16/24/32/48/64/128/256 各尺寸
"""

import sys
import pathlib
from PIL import Image


def make_icon(src: str, dst: str) -> None:
    img = Image.open(src).convert('RGBA')

    # 居中裁剪成正方形
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))

    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    out = pathlib.Path(dst)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format='ICO', sizes=sizes)

    print(f'{out} 已生成（源 {w}x{h} → 裁剪 {side}x{side}，尺寸 {[s[0] for s in sizes]}）')
    print(f'大小: {out.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    make_icon(sys.argv[1], sys.argv[2])
