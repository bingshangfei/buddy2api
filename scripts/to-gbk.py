#!/usr/bin/env python3
"""to-gbk.py — 把含中文的 .cmd 批处理转成系统 ANSI 代码页（中文 Windows = GBK/936）。

背景：cmd.exe 按字节解析批处理文件，UTF-8 的中文多字节序列会让它读错位，
表现为「把某行的后半截当成命令执行」（实测：
    '日自动签到（每天' is not recognized as an internal or external command
）。用系统 ANSI 代码页保存即可，同时不要 `chcp 65001`（切代码页本身会加剧错位）。

用法：
    python scripts/to-gbk.py scripts/login.cmd [more.cmd ...]

幂等：已能按 GBK 解码且不含替换字符时跳过。
"""

import pathlib
import sys


def convert(path: pathlib.Path) -> str:
    raw = path.read_bytes()

    # 已经能用 GBK 干净解码 → 判定已转换
    try:
        text = raw.decode('gbk')
        if text.encode('gbk') == raw:
            return '已是 GBK，跳过'
    except UnicodeDecodeError:
        pass

    # 尝试 UTF-8（含/不含 BOM）
    body = raw[3:] if raw.startswith(b'\xef\xbb\xbf') else raw
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError:
        return '无法按 UTF-8 解码，跳过（避免二次损坏）'

    # 去掉 chcp 65001（GBK 编码下不需要，且会加剧错位）
    lines = [l for l in text.replace('\r\n', '\n').split('\n')
             if l.strip().lower() != 'chcp 65001 >nul']
    cleaned = '\r\n'.join(lines)

    path.write_bytes(cleaned.encode('gbk'))
    return 'UTF-8 → GBK（并移除 chcp 65001）'


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
