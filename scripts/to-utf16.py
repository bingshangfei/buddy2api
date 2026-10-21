#!/usr/bin/env python3
"""to-utf16.py — 把 VBScript 文件安全地转成 UTF-16LE（幂等）。

背景：cscript 按 ANSI 解析 UTF-8 文件时，中文会被误读、报"未结束的字符串常量"
或"无效字符"；所以含中文的 .vbs 必须存成 UTF-16LE with BOM。
但重复转换会把内容毁掉（每个字符后插入 NUL），所以这里做幂等检测。

用法：
    python scripts/to-utf16.py scripts/start.vbs [more.vbs ...]

判据：读入后先尝试按 BOM 判定的编码解码；若结果里不含 NUL 字符且能识别出
VBScript 关键字，说明编码已正确 —— 直接跳过，不重写。
"""

import pathlib
import sys


def decode_any(raw: bytes) -> tuple[str, str]:
    """按 BOM / 内容猜测编码并解码，返回 (文本, 编码说明)。"""
    if raw[:2] == b'\xff\xfe':
        return raw[2:].decode('utf-16-le'), 'UTF-16LE'
    if raw[:3] == b'\xef\xbb\xbf':
        return raw[3:].decode('utf-8'), 'UTF-8 BOM'
    # 无 BOM：UTF-16LE 的中文文本按 UTF-8 解码通常会炸
    try:
        return raw.decode('utf-8'), 'UTF-8'
    except UnicodeDecodeError:
        return raw.decode('utf-16-le'), 'UTF-16LE (no BOM)'


def looks_like_vbscript(text: str) -> bool:
    head = text[:400]
    return 'Option Explicit' in head or 'Dim ' in head or "' " in head


def convert(path: pathlib.Path) -> str:
    raw = path.read_bytes()
    text, enc = decode_any(raw)

    # 幂等保护：内容干净（无 NUL）且像 VBScript → 已正确，不重写
    if '\x00' not in text and looks_like_vbscript(text) and raw[:2] == b'\xff\xfe':
        return '已是正确的 UTF-16LE，跳过'

    # 修复历史损坏：去掉被误插入的 NUL 字符
    cleaned = text.replace('\x00', '')
    fixed = cleaned != text

    path.write_bytes(b'\xff\xfe' + cleaned.encode('utf-16-le'))
    note = '（修复了重复编码产生的 NUL 字符）' if fixed else ''
    return f'{enc} → UTF-16LE{note}'


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    for arg in sys.argv[1:]:
        p = pathlib.Path(arg)
        if not p.exists():
            print(f'{arg}: 文件不存在')
            return 1
        print(f'{p.name}: {convert(p)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
