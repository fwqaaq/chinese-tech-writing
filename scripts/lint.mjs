#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const EXCLUDE_DIRS = new Set(['.git', 'node_modules']);
const FILENAME_EXCEPTIONS = new Set([
  'README',
  'LICENSE',
  'CHANGELOG',
  'CONTRIBUTING',
  'SKILL',
  'CLAUDE',
  'CODE_OF_CONDUCT',
]);

function collectMarkdownFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      result.push(full);
    }
  }
  return result;
}

// --- inline code span helpers (avoid flagging text inside `...`) ---

function codeSpans(line) {
  const spans = [];
  const re = /`[^`]*`/g;
  let m;
  while ((m = re.exec(line))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function overlaps(index, length, spans) {
  const end = index + length;
  return spans.some(([s, e]) => index < e && end > s);
}

function applyPatternFix(line, pattern, replacer, messageFn) {
  const spans = codeSpans(line);
  const hits = [];
  const matches = [...line.matchAll(pattern)];
  let result = line;
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    if (overlaps(m.index, m[0].length, spans)) continue;
    hits.push({ index: m.index, message: messageFn(m) });
    const rep = replacer(m);
    result = result.slice(0, m.index) + rep + result.slice(m.index + m[0].length);
  }
  hits.reverse();
  return { line: result, hits };
}

// --- fixable rules (mechanical, regex-based) ---

const FIXABLE_RULES = [
  {
    id: 'fullwidth-digit',
    run(line) {
      return applyPatternFix(
        line,
        /[０-９]/g,
        (m) => String.fromCharCode(m[0].codePointAt(0) - 0xff10 + 0x30),
        (m) => `全角数字 "${m[0]}" 应替换为半角数字`,
      );
    },
  },
  {
    id: 'ellipsis',
    run(line) {
      const r1 = applyPatternFix(line, /\.{3,}/g, () => '……', (m) => `"${m[0]}" 应替换为中文省略号 "……"`);
      const r2 = applyPatternFix(r1.line, /。{2,}/g, () => '……', (m) => `"${m[0]}" 应替换为中文省略号 "……"`);
      const r3 = applyPatternFix(r2.line, /(?<!…)…(?!…)/g, () => '……', () => '单个 "…" 应替换为 "……"');
      return { line: r3.line, hits: [...r1.hits, ...r2.hits, ...r3.hits] };
    },
  },
  {
    id: 'multi-exclaim',
    run(line) {
      return applyPatternFix(line, /[!！]{2,}/g, (m) => m[0][0], (m) => `"${m[0]}" 不得多个感叹号连用`);
    },
  },
  {
    id: 'cn-en-space',
    run(line) {
      const r1 = applyPatternFix(line, /([一-鿿])([A-Za-z])/g, (m) => `${m[1]} ${m[2]}`, () => '中英文之间缺少空格');
      const r2 = applyPatternFix(r1.line, /([A-Za-z])([一-鿿])/g, (m) => `${m[1]} ${m[2]}`, () => '中英文之间缺少空格');
      return { line: r2.line, hits: [...r1.hits, ...r2.hits] };
    },
  },
  {
    id: 'fullwidth-paren-spacing',
    run(line) {
      const r1 = applyPatternFix(line, /（\s+/g, () => '（', () => '全角括号内侧不应有空格');
      const r2 = applyPatternFix(r1.line, /\s+）/g, () => '）', () => '全角括号内侧不应有空格');
      return { line: r2.line, hits: [...r1.hits, ...r2.hits] };
    },
  },
];

function detectFixable(line) {
  const issues = [];
  for (const rule of FIXABLE_RULES) {
    for (const hit of rule.run(line).hits) {
      issues.push({ ruleId: rule.id, col: hit.index + 1, message: hit.message, fixable: true });
    }
  }
  return issues;
}

function applyFixable(line) {
  let current = line;
  for (const rule of FIXABLE_RULES) {
    current = rule.run(current).line;
  }
  return current;
}

// --- fence tracking (skip ``` / ~~~ code blocks entirely) ---

function fenceMask(lines) {
  const mask = [];
  let inFence = false;
  let fenceChar = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      mask.push(true);
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (line.trim()[0] === fenceChar) {
        inFence = false;
      }
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

// YAML frontmatter (--- ... ---) at the very top of the file
function frontmatterMask(lines) {
  const mask = lines.map(() => false);
  if (lines[0] !== '---') return mask;
  for (let i = 1; i < lines.length; i++) {
    mask[i] = true;
    if (lines[i] === '---') {
      mask[0] = true;
      break;
    }
  }
  return mask;
}

// Markdown table rows/separators (contain "|" outside inline code)
function isTableRow(line) {
  return codeSpans(line).length === 0
    ? line.includes('|')
    : line.replace(/`[^`]*`/g, '').includes('|');
}

// --- detect-only rules (structural / semantic, report only) ---

function checkHeadings(lines, inFenceMask) {
  const issues = [];
  const headings = [];
  lines.forEach((line, idx) => {
    if (inFenceMask[idx]) return;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ lineNo: idx + 1, level: m[1].length, text: m[2].trim() });
  });

  // 标题跳级
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      issues.push({
        lineNo: headings[i].lineNo,
        col: 1,
        ruleId: 'heading-skip-level',
        message: `标题层级从 H${headings[i - 1].level} 跳到 H${headings[i].level}，缺少过渡层级`,
      });
    }
  }

  // 孤立标题 / 与上级重名（level 1 视为文档标题，不参与孤立检测）
  const stack = [];
  const childrenCount = new Map();
  const headingInfo = [];
  for (const h of headings) {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1] || null;
    const key = `${parent ? parent.lineNo : 'root'}:${h.level}`;
    childrenCount.set(key, (childrenCount.get(key) || 0) + 1);
    headingInfo.push({ ...h, key });

    for (const ancestor of stack) {
      if (ancestor.text === h.text) {
        issues.push({
          lineNo: h.lineNo,
          col: 1,
          ruleId: 'heading-duplicate-name',
          message: `标题 "${h.text}" 与上级标题（第 ${ancestor.lineNo} 行）同名`,
        });
        break;
      }
    }
    stack.push(h);
  }
  for (const h of headingInfo) {
    if (h.level >= 2 && childrenCount.get(h.key) === 1) {
      issues.push({
        lineNo: h.lineNo,
        col: 1,
        ruleId: 'heading-orphan',
        message: `标题 "${h.text}" 在其上级下是孤立的唯一同级标题，应合并到上级或省略该层级`,
      });
    }
  }

  // 标题末尾句号
  for (const h of headings) {
    if (/[。.]$/.test(h.text)) {
      issues.push({
        lineNo: h.lineNo,
        col: 1,
        ruleId: 'heading-trailing-period',
        message: `标题不应以句号结尾："${h.text}"`,
      });
    }
  }

  return issues;
}

function checkSentenceLength(lines, inFenceMask, inFrontmatterMask) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (inFenceMask[idx] || inFrontmatterMask[idx]) return;
    if (/^#{1,6}\s/.test(line)) return;
    if (isTableRow(line)) return;

    const text = line
      .replace(/`[^`]*`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_]{1,2}/g, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .trim();
    if (!text) return;

    for (const clause of text.split(/[，。！？；：、]/)) {
      const len = [...clause].length;
      if (len > 40) {
        issues.push({
          lineNo: idx + 1,
          col: 1,
          ruleId: 'sentence-length',
          message: `句子过长（${len} 字）："${clause.slice(0, 20)}……"，建议拆分`,
        });
      }
    }
  });
  return issues;
}

function checkEllipsisWithDeng(lines, inFenceMask) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (inFenceMask[idx]) return;
    const spans = codeSpans(line);
    for (const m of line.matchAll(/(……|…)等/g)) {
      if (overlaps(m.index, m[0].length, spans)) continue;
      issues.push({
        lineNo: idx + 1,
        col: m.index + 1,
        ruleId: 'ellipsis-with-deng',
        message: `省略号不应与"等"连用："${m[0]}"`,
      });
    }
  });
  return issues;
}

function checkThousandSeparator(lines, inFenceMask, inFrontmatterMask) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (inFenceMask[idx] || inFrontmatterMask[idx]) return;
    const spans = codeSpans(line);
    // 排除 "GB/T 15834" 等标准/规范编号
    for (const m of line.matchAll(/(?<![\d,])(?<![A-Za-z/]{1,10}\s)\d{5,}(?![\d,])/g)) {
      if (overlaps(m.index, m[0].length, spans)) continue;
      issues.push({
        lineNo: idx + 1,
        col: m.index + 1,
        ruleId: 'thousand-separator-missing',
        message: `数值 "${m[0]}" 位数超过 4 位，应添加千分位分隔符（如有误判，如电话号码等，可忽略）`,
      });
    }
  });
  return issues;
}

function checkFilename(filePath) {
  const base = basename(filePath);
  const name = base.replace(/\.[^.]+$/, '');
  if (FILENAME_EXCEPTIONS.has(name.toUpperCase())) return null;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return {
      lineNo: 0,
      col: 0,
      ruleId: 'filename-convention',
      message: `文件名 "${base}" 不符合规范：应全小写、用半角连词线分隔、不含中文/下划线/空格`,
    };
  }
  return null;
}

// --- main ---

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const files = argv.filter((a) => a !== '--fix');
const targets = files.length > 0 ? files : collectMarkdownFiles('.');

let totalIssues = 0;
let remainingIssues = 0;

for (const file of targets) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const inFenceMask = fenceMask(lines);
  const inFrontmatterMask = frontmatterMask(lines);
  const fileIssues = [];

  const newLines = lines.map((line, idx) => {
    if (inFenceMask[idx]) return line;
    for (const issue of detectFixable(line)) {
      fileIssues.push({ lineNo: idx + 1, ...issue });
    }
    return fix ? applyFixable(line) : line;
  });

  fileIssues.push(...checkHeadings(lines, inFenceMask).map((i) => ({ ...i, fixable: false })));
  fileIssues.push(...checkSentenceLength(lines, inFenceMask, inFrontmatterMask).map((i) => ({ ...i, fixable: false })));
  fileIssues.push(...checkEllipsisWithDeng(lines, inFenceMask).map((i) => ({ ...i, fixable: false })));
  fileIssues.push(...checkThousandSeparator(lines, inFenceMask, inFrontmatterMask).map((i) => ({ ...i, fixable: false })));

  const filenameIssue = checkFilename(file);
  if (filenameIssue) fileIssues.push({ ...filenameIssue, fixable: false });

  fileIssues.sort((a, b) => a.lineNo - b.lineNo || a.col - b.col);

  for (const issue of fileIssues) {
    const loc = issue.lineNo > 0 ? `${file}:${issue.lineNo}:${issue.col}` : file;
    console.log(`${loc}  [${issue.ruleId}] ${issue.message}`);
    totalIssues++;
    if (!fix || !issue.fixable) remainingIssues++;
  }

  if (fix) {
    const changed = newLines.some((line, idx) => line !== lines[idx]);
    if (changed) writeFileSync(file, newLines.join('\n'));
  }
}

console.log(`\n共发现 ${totalIssues} 处问题${fix ? `，剩余 ${remainingIssues} 处需人工复核` : ''}。`);
process.exitCode = remainingIssues > 0 ? 1 : 0;
