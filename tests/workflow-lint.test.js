/**
 * workflow-lint.test.js — workflow 内 shell 脚本的静态回归守护。
 *
 * 缘起（CI run 35984148683，feature-20260924-macos-dmg）：workflow 里写了 `（$dataRoot）`，
 * macOS 自带的 /bin/bash 3.2 把全角 `）` 的字节吞进变量名 → `set -u` 报 unbound variable；
 * 更糟的是该 bash 打印错误后以 0 退出，使「脚本中途夭折」被 GitHub 报成绿（假绿）——
 * 该次 dmg 回路的 data-root / start.sh / curl 断言其实一条都没跑。
 *
 * 规则：shell 中 `$VAR` 后面紧跟非 ASCII 字符一律禁止，改写 `${VAR}` 明确变量边界。
 * 纯文本扫描，Windows 亦可运行（无需 bash、无需 macOS）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// $VAR 紧跟一个非 ASCII 字符（如全角括号、冒号、✅）
const ANTI_PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/;

test('workflow 内禁止 `$VAR` 紧跟非 ASCII 字符（须写 ${VAR}）', () => {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, `未找到任何 workflow 文件：${WORKFLOW_DIR}`);

  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = ANTI_PATTERN.exec(line);
      if (m) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.equal(
    hits.length,
    0,
    '以下位置 `$VAR` 后紧跟非 ASCII 字符——macOS bash 3.2 会把该字符字节吞进变量名、'
      + `触发 set -u unbound variable（并可能以 0 退出造成假绿）。请改写成 \${VAR}：\n${hits.join('\n')}`,
  );
});
