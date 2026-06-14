import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lintScript = join(repoRoot, 'scripts', 'lint.mjs');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');

function runLint(args) {
  return spawnSync(process.execPath, [lintScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function fixture(name) {
  return join(fixturesDir, name);
}

test('clean.md has no issues', () => {
  const result = runLint([fixture('clean.md')]);
  assert.match(result.stdout, /共发现 0 处问题/);
  assert.equal(result.status, 0);
});

test('fixable.md detects all mechanical issues', () => {
  const result = runLint([fixture('fixable.md')]);
  for (const ruleId of [
    'fullwidth-digit',
    'ellipsis',
    'multi-exclaim',
    'cn-en-space',
    'fullwidth-paren-spacing',
  ]) {
    assert.match(result.stdout, new RegExp(`\\[${ruleId}\\]`));
  }
  assert.equal(result.status, 1);
});

test('--fix corrects mechanical issues in fixable.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-test-'));
  const target = join(dir, 'fixable.md');
  writeFileSync(target, readFileSync(fixture('fixable.md'), 'utf8'));

  try {
    runLint([target, '--fix']);
    const lines = readFileSync(target, 'utf8').split('\n');

    assert.equal(lines.find((l) => l.startsWith('全角数字')), '全角数字：123');
    assert.equal(lines.find((l) => l.startsWith('省略号')), '省略号：这是一段文本……');
    assert.equal(lines.find((l) => l.startsWith('感叹号连用')), '感叹号连用：太棒了！');
    assert.equal(
      lines.find((l) => l.startsWith('中英文间缺少空格')),
      '中英文间缺少空格：中文 English 混排',
    );
    assert.equal(lines.find((l) => l.startsWith('全角括号内多余空格')), '全角括号内多余空格：（文本）');

    const verify = runLint([target]);
    assert.match(verify.stdout, /共发现 0 处问题/);
    assert.equal(verify.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('heading-skip-level detects level jumps', () => {
  const result = runLint([fixture('heading-skip-level.md')]);
  assert.match(result.stdout, /\[heading-skip-level\]/);
  assert.equal(result.status, 1);
});

test('heading-orphan detects sole child heading', () => {
  const result = runLint([fixture('heading-orphan.md')]);
  assert.match(result.stdout, /\[heading-orphan\]/);
  assert.equal(result.status, 1);
});

test('heading-duplicate-name detects heading matching ancestor', () => {
  const result = runLint([fixture('heading-duplicate-name.md')]);
  assert.match(result.stdout, /\[heading-duplicate-name\]/);
  assert.equal(result.status, 1);
});

test('heading-trailing-period detects heading ending with period', () => {
  const result = runLint([fixture('heading-trailing-period.md')]);
  assert.match(result.stdout, /\[heading-trailing-period\]/);
  assert.equal(result.status, 1);
});

test('sentence-length detects overly long clauses', () => {
  const result = runLint([fixture('sentence-length.md')]);
  assert.match(result.stdout, /\[sentence-length\]/);
  assert.equal(result.status, 1);
});

test('ellipsis-with-deng detects "……等"', () => {
  const result = runLint([fixture('ellipsis-with-deng.md')]);
  assert.match(result.stdout, /\[ellipsis-with-deng\]/);
  assert.equal(result.status, 1);
});

test('thousand-separator-missing flags large numbers but not standard references', () => {
  const result = runLint([fixture('thousand-separator-missing.md')]);
  assert.match(result.stdout, /:3:\d+\s+\[thousand-separator-missing\]/);
  assert.doesNotMatch(result.stdout, /:5:\d+\s+\[thousand-separator-missing\]/);
  assert.equal(result.status, 1);
});

test('filename-convention flags non-conforming filenames', () => {
  const result = runLint([fixture('bad_file_name.md')]);
  assert.match(result.stdout, /\[filename-convention\]/);
});

test('filename-convention exempts README.md', () => {
  const result = runLint([join(repoRoot, 'README.md')]);
  assert.doesNotMatch(result.stdout, /\[filename-convention\]/);
});
