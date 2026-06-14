#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const FILENAME_EXCEPTIONS = new Set([
  'README',
  'LICENSE',
  'CHANGELOG',
  'CONTRIBUTING',
  'SKILL',
  'CLAUDE',
  'CODE_OF_CONDUCT',
  'SECURITY',
]);

const DEFAULT_MAX_SENTENCE_LENGTH = 40;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function shouldUseColor(mode) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if ('NO_COLOR' in process.env || process.env.TERM === 'dumb') return false;
  if ('FORCE_COLOR' in process.env) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout.isTTY);
}

function createPainter(enabled) {
  const paint = (code, value) => enabled ? `${code}${value}${ANSI.reset}` : String(value);
  return {
    bold: (value) => paint(ANSI.bold, value),
    dim: (value) => paint(ANSI.dim, value),
    red: (value) => paint(ANSI.red, value),
    green: (value) => paint(ANSI.green, value),
    yellow: (value) => paint(ANSI.yellow, value),
    cyan: (value) => paint(ANSI.cyan, value),
  };
}

function collectMarkdownFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      result.push(full);
    }
  }
  return result;
}

function mergeSpans(spans) {
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [spans[0]];
  for (const [start, end] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// 保护代码、URL、HTML 标签和 Markdown 链接目标，避免修改技术语法。
function protectedSpans(line) {
  const spans = [];

  // 支持 `code`、``code with ` inside`` 等常见行内代码写法。
  for (const m of line.matchAll(/(`+)(.*?)\1/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }

  // Markdown 行内链接：只保护目标地址，链接文本仍参与检查。
  for (const m of line.matchAll(/!?\[[^\]]*\]\((?:\\.|[^)])*\)/g)) {
    const open = m[0].indexOf('](');
    if (open !== -1) {
      const start = m.index + open + 2;
      spans.push([start, m.index + m[0].length - 1]);
    }
  }

  for (const pattern of [
    /https?:\/\/[^\s<>()]+/g,
    /<[^>]+>/g,
    /<!--.*?-->/g,
  ]) {
    for (const m of line.matchAll(pattern)) spans.push([m.index, m.index + m[0].length]);
  }

  return mergeSpans(spans);
}

function overlaps(index, length, spans) {
  const end = index + length;
  return spans.some(([start, stop]) => index < stop && end > start);
}

function visibleTextOutsideSpans(line, spans = protectedSpans(line)) {
  let result = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    result += line.slice(cursor, start);
    cursor = end;
  }
  return result + line.slice(cursor);
}

function hasHan(text) {
  return /\p{Script=Han}/u.test(text);
}

function applyPatternFix(
  line,
  pattern,
  replacer,
  messageFn,
  { requireHan = false, matchFilter = null } = {},
) {
  const spans = protectedSpans(line);
  if (requireHan && !hasHan(visibleTextOutsideSpans(line, spans))) return { line, hits: [] };

  const hits = [];
  const matches = [...line.matchAll(pattern)];
  let result = line;
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    if (overlaps(m.index, m[0].length, spans)) continue;
    if (matchFilter && !matchFilter(m, line)) continue;
    hits.push({ index: m.index, message: messageFn(m) });
    const replacement = replacer(m);
    result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0].length);
  }
  hits.reverse();
  return { line: result, hits };
}


function hasHanInClause(line, index) {
  const boundaries = /[。！？；：!?;]/g;
  let start = 0;
  let end = line.length;
  for (const m of line.matchAll(boundaries)) {
    if (m.index < index) start = m.index + m[0].length;
    else {
      end = m.index;
      break;
    }
  }
  return hasHan(visibleTextOutsideSpans(line.slice(start, end)));
}

// --- 可安全自动修复的机械规则 ---

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
      const r1 = applyPatternFix(
        line,
        /\.{3,}/g,
        () => '……',
        (m) => `"${m[0]}" 应替换为中文省略号 "……"`,
        { matchFilter: (m, source) => hasHanInClause(source, m.index) },
      );
      const r2 = applyPatternFix(
        r1.line,
        /。{2,}/g,
        () => '……',
        (m) => `"${m[0]}" 应替换为中文省略号 "……"`,
      );
      const r3 = applyPatternFix(
        r2.line,
        /(?<!…)…(?!…)/g,
        () => '……',
        () => '单个 "…" 应替换为 "……"',
      );
      return { line: r3.line, hits: [...r1.hits, ...r2.hits, ...r3.hits] };
    },
  },
  {
    id: 'multi-exclaim',
    run(line) {
      return applyPatternFix(
        line,
        /[!！]{2,}/g,
        (m) => m[0][0],
        (m) => `"${m[0]}" 不得多个感叹号连用`,
        { matchFilter: (m, source) => hasHanInClause(source, m.index) },
      );
    },
  },
  {
    id: 'cn-en-space',
    run(line) {
      return applyPatternFix(
        line,
        /(?<=\p{Script=Han})(?=[A-Za-z])|(?<=[A-Za-z])(?=\p{Script=Han})/gu,
        () => ' ',
        () => '中英文之间缺少空格',
      );
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

function processFixableLine(line, disabled = new Set()) {
  let current = line;
  const issues = [];
  for (const rule of FIXABLE_RULES) {
    if (disabled.has('all') || disabled.has(rule.id)) continue;
    const result = rule.run(current);
    for (const hit of result.hits) {
      issues.push({
        ruleId: rule.id,
        col: hit.index + 1,
        message: hit.message,
        fixable: true,
        severity: 'error',
      });
    }
    current = result.line;
  }
  return { line: current, issues };
}

// --- Markdown 区域跟踪 ---

function fenceMask(lines) {
  const mask = lines.map(() => false);
  let active = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!active) {
      const opening = line.match(/^\s*(`{3,}|~{3,})/);
      if (!opening) continue;
      active = { char: opening[1][0], length: opening[1].length };
      mask[i] = true;
      continue;
    }

    mask[i] = true;
    const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === active.char && closing[1].length >= active.length) {
      active = null;
    }
  }
  return mask;
}

function frontmatterMask(lines) {
  const mask = lines.map(() => false);
  if (lines[0]?.trim() !== '---') return mask;

  mask[0] = true;
  for (let i = 1; i < lines.length; i++) {
    mask[i] = true;
    if (lines[i].trim() === '---') break;
  }
  return mask;
}

function htmlCommentMask(lines) {
  const mask = lines.map(() => false);
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inComment || line.includes('<!--')) mask[i] = true;
    if (line.includes('<!--') && !line.includes('-->', line.indexOf('<!--') + 4)) inComment = true;
    if (inComment && line.includes('-->')) inComment = false;
  }
  return mask;
}

function isTableRow(line) {
  return visibleTextOutsideSpans(line).includes('|');
}

function parseLintDirectives(lines) {
  const disabledByLine = lines.map(() => new Set());
  const disabled = new Set();
  let disableNext = null;

  for (let i = 0; i < lines.length; i++) {
    if (disableNext) {
      disabledByLine[i] = new Set([...disabled, ...disableNext]);
      disableNext = null;
    } else {
      disabledByLine[i] = new Set(disabled);
    }

    for (const m of lines[i].matchAll(/<!--\s*lint-(disable-next-line|disable|enable)\s+([^>]+?)\s*-->/g)) {
      const action = m[1];
      const ids = m[2].split(/[,\s]+/).filter(Boolean);
      if (action === 'disable-next-line') disableNext = new Set(ids);
      else if (action === 'disable') for (const id of ids) disabled.add(id);
      else for (const id of ids) disabled.delete(id);
    }
  }

  return disabledByLine;
}

function isDisabled(issue, directives) {
  if (issue.lineNo <= 0) return false;
  const disabled = directives[issue.lineNo - 1];
  return disabled?.has(issue.ruleId) || disabled?.has('all');
}

// --- 结构规则与写作建议 ---

function checkHeadings(lines, skipMask) {
  const issues = [];
  const headings = [];
  const structurallyInvalidLines = new Set();
  lines.forEach((line, idx) => {
    if (skipMask[idx]) return;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ lineNo: idx + 1, level: m[1].length, text: m[2].trim() });
  });

  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      structurallyInvalidLines.add(headings[i].lineNo);
      issues.push({
        lineNo: headings[i].lineNo,
        col: 1,
        ruleId: 'heading-skip-level',
        severity: 'error',
        message: `标题层级从 H${headings[i - 1].level} 跳到 H${headings[i].level}，缺少过渡层级`,
      });
    }
  }

  const stack = [];
  const childrenCount = new Map();
  const headingInfo = [];
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    const parent = stack[stack.length - 1] || null;
    const key = `${parent ? parent.lineNo : 'root'}:${heading.level}`;
    childrenCount.set(key, (childrenCount.get(key) || 0) + 1);
    headingInfo.push({ ...heading, key, parent });

    if (stack.some((ancestor) => ancestor.text === heading.text)) {
      const ancestor = [...stack].reverse().find((item) => item.text === heading.text);
      structurallyInvalidLines.add(heading.lineNo);
      issues.push({
        lineNo: heading.lineNo,
        col: 1,
        ruleId: 'heading-duplicate-name',
        severity: 'error',
        message: `标题 "${heading.text}" 与上级标题（第 ${ancestor.lineNo} 行）同名`,
      });
    }
    stack.push(heading);
  }

  // “孤立标题”需要判断内容结构，正则无法可靠决定是否真的应合并，因此仅作为建议。
  for (const heading of headingInfo) {
    if (
      heading.level >= 3 &&
      childrenCount.get(heading.key) === 1 &&
      !structurallyInvalidLines.has(heading.lineNo)
    ) {
      issues.push({
        lineNo: heading.lineNo,
        col: 1,
        ruleId: 'heading-orphan',
        severity: 'warning',
        message: `标题 "${heading.text}" 在其上级下没有同级标题；请确认该层级是否确有必要`,
      });
    }
  }

  for (const heading of headings) {
    if (/[。.]$/.test(heading.text)) {
      issues.push({
        lineNo: heading.lineNo,
        col: 1,
        ruleId: 'heading-trailing-period',
        severity: 'error',
        message: `标题不应以句号结尾："${heading.text}"`,
      });
    }
  }

  return issues;
}

function stripMarkdownForProse(line) {
  return visibleTextOutsideSpans(line)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/[*_~]{1,3}/g, '')
    .trim();
}

function countSentenceUnits(text) {
  // 忽略空白和标点；英文单词按一个单位计算，中文按单字计算。
  const cleaned = text.replace(/[\p{P}\p{S}\s]/gu, ' ').trim();
  if (!cleaned) return 0;
  const tokens = cleaned.match(/\p{Script=Han}|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:\.\d+)?|[^\s]/gu) || [];
  return tokens.length;
}

function checkSentenceLength(lines, skipMask, maxLength) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (skipMask[idx] || /^\s{0,3}#{1,6}\s/.test(line) || isTableRow(line)) return;
    const text = stripMarkdownForProse(line);
    if (!text || !hasHan(text)) return;

    // 按真正的句末符号切分，不再把逗号、冒号、顿号误当作句末。
    for (const sentence of text.split(/(?<=[。！？!?；;])\s*/u)) {
      const value = sentence.trim();
      if (!value) continue;
      const length = countSentenceUnits(value);
      if (length > maxLength) {
        issues.push({
          lineNo: idx + 1,
          col: Math.max(1, line.indexOf(value.slice(0, 8)) + 1),
          ruleId: 'sentence-length',
          severity: 'warning',
          message: `句子约 ${length} 个语言单位，超过建议值 ${maxLength}；请结合语义判断是否拆分："${value.slice(0, 24)}${value.length > 24 ? '……' : ''}"`,
        });
      }
    }
  });
  return issues;
}

function checkEllipsisWithDeng(lines, skipMask) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (skipMask[idx]) return;
    const spans = protectedSpans(line);
    for (const m of line.matchAll(/(?:……|…)\s*(?:等|等等)/g)) {
      if (overlaps(m.index, m[0].length, spans)) continue;
      issues.push({
        lineNo: idx + 1,
        col: m.index + 1,
        ruleId: 'ellipsis-with-deng',
        severity: 'error',
        message: `省略号不应与“等/等等”连用："${m[0]}"`,
      });
    }
  });
  return issues;
}

const QUANTITY_UNITS = '(?:元|美元|人民币|欧元|日元|次|个|件|台|人|字|字符|字节|KB|MB|GB|TB|ms|s|秒|分钟|小时|天|公里|米|kg|g|%)';

function isCompactDate(value) {
  if (!/^(?:19|20)\d{6}$/.test(value)) return false;
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function looksLikeIdentifier(line, start, end) {
  const before = line.slice(Math.max(0, start - 20), start);
  const after = line.slice(end, Math.min(line.length, end + 20));
  const whole = line.slice(Math.max(0, start - 2), Math.min(line.length, end + 2));

  return (
    /(?:编号|序号|案号|工单|订单|版本|端口|邮编|电话|手机|日期|时间|QQ|ID|issue|ticket|case|port|version|v)\s*[:：#-]?\s*$/i.test(before) ||
    /[#@]\s*$/.test(before) ||
    /^\s*[-./]/.test(after) ||
    /[-./]\s*$/.test(before) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(whole) ||
    isCompactDate(line.slice(start, end)) ||
    (/[A-Fa-f0-9]$/.test(before) && /^[A-Fa-f0-9]/.test(after))
  );
}

function checkThousandSeparator(lines, skipMask) {
  const issues = [];
  lines.forEach((line, idx) => {
    if (skipMask[idx]) return;
    const spans = protectedSpans(line);
    for (const m of line.matchAll(/(?<![\d,])\d{5,}(?![\d,])/g)) {
      if (overlaps(m.index, m[0].length, spans)) continue;
      const end = m.index + m[0].length;
      if (looksLikeIdentifier(line, m.index, end)) continue;

      const before = line.slice(Math.max(0, m.index - 12), m.index);
      const after = line.slice(end, Math.min(line.length, end + 12));
      const hasQuantityContext =
        /[$￥€£]\s*$/.test(before) ||
        new RegExp(`^\\s*${QUANTITY_UNITS}`, 'i').test(after) ||
        /(?:金额|价格|费用|收入|支出|数量|总计|合计|容量|大小|长度|用户数|请求数)\s*[:：]?\s*$/.test(before);

      if (!hasQuantityContext) continue;
      issues.push({
        lineNo: idx + 1,
        col: m.index + 1,
        ruleId: 'thousand-separator-missing',
        severity: 'warning',
        message: `数量值 "${m[0]}" 可能需要千分位分隔符；编号、日期和电话号码无需添加`,
      });
    }
  });
  return issues;
}

function checkFilename(filePath) {
  const base = basename(filePath);
  const name = base.replace(/\.[^.]+$/, '');
  if (FILENAME_EXCEPTIONS.has(name.toUpperCase())) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return {
      lineNo: 0,
      col: 0,
      ruleId: 'filename-convention',
      severity: 'error',
      message: `文件名 "${base}" 不符合规范：应全小写、用半角连词线分隔、不含中文、下划线或空格`,
    };
  }
  return null;
}

function usage() {
  console.log(`用法：node lint.mjs [选项] [文件或目录中的 Markdown 文件...]

选项：
  --fix                    自动修复可安全修改的问题
  --strict                 将 warning 也视为失败（适合严格审阅）
  --no-warnings            不显示写作建议
  --color                  强制使用彩色输出
  --no-color               禁用彩色输出
  --max-sentence-length=N  设置句长建议阈值，默认 ${DEFAULT_MAX_SENTENCE_LENGTH}
  --help                   显示帮助

行内忽略：
  <!-- lint-disable-next-line sentence-length -->
  <!-- lint-disable heading-orphan -->
  <!-- lint-enable heading-orphan -->`);
}

function parseArgs(argv) {
  const options = {
    fix: false,
    strict: false,
    showWarnings: true,
    colorMode: 'auto',
    maxSentenceLength: DEFAULT_MAX_SENTENCE_LENGTH,
    files: [],
  };

  for (const arg of argv) {
    if (arg === '--fix') options.fix = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--no-warnings') options.showWarnings = false;
    else if (arg === '--color') options.colorMode = 'always';
    else if (arg === '--no-color') options.colorMode = 'never';
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('--max-sentence-length=')) {
      const value = Number(arg.slice(arg.indexOf('=') + 1));
      if (!Number.isInteger(value) || value < 10) throw new Error('--max-sentence-length 必须是大于等于 10 的整数');
      options.maxSentenceLength = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const color = createPainter(shouldUseColor(options.colorMode));
const targets = options.files.length > 0 ? options.files : collectMarkdownFiles('.');
let foundErrors = 0;
let fixedErrors = 0;
let remainingErrors = 0;
let warnings = 0;

for (const file of targets) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const inFence = fenceMask(lines);
  const inFrontmatter = frontmatterMask(lines);
  const inComment = htmlCommentMask(lines);
  const skipMask = lines.map((_, i) => inFence[i] || inFrontmatter[i] || inComment[i]);
  const directives = parseLintDirectives(lines);
  const fileIssues = [];

  const newLines = lines.map((line, idx) => {
    if (skipMask[idx]) return line;
    const result = processFixableLine(line, directives[idx]);
    fileIssues.push(...result.issues.map((issue) => ({ lineNo: idx + 1, ...issue })));
    return options.fix ? result.line : line;
  });

  // 在 --fix 模式下，检测型规则基于修复后的内容运行，避免必须执行两次才能发现后续问题。
  const analysisLines = options.fix ? newLines : lines;
  fileIssues.push(...checkHeadings(analysisLines, skipMask).map((issue) => ({ ...issue, fixable: false })));
  fileIssues.push(...checkSentenceLength(analysisLines, skipMask, options.maxSentenceLength).map((issue) => ({ ...issue, fixable: false })));
  fileIssues.push(...checkEllipsisWithDeng(analysisLines, skipMask).map((issue) => ({ ...issue, fixable: false })));
  fileIssues.push(...checkThousandSeparator(analysisLines, skipMask).map((issue) => ({ ...issue, fixable: false })));

  const filenameIssue = checkFilename(file);
  if (filenameIssue) fileIssues.push({ ...filenameIssue, fixable: false });

  const filtered = fileIssues
    .filter((issue) => !isDisabled(issue, directives))
    .filter((issue) => options.showWarnings || issue.severity !== 'warning')
    .sort((a, b) => a.lineNo - b.lineNo || a.col - b.col || a.ruleId.localeCompare(b.ruleId));

  for (const issue of filtered) {
    const loc = issue.lineNo > 0 ? `${file}:${issue.lineNo}:${issue.col}` : file;
    const rule = color.cyan(`[${issue.ruleId}]`);
    let prefix;
    let message;
    if (issue.severity === 'warning') {
      prefix = color.yellow(color.bold('WARNING'));
      message = color.yellow(issue.message);
    } else if (options.fix && issue.fixable) {
      prefix = color.green(color.bold('FIXED'));
      message = color.green(issue.message);
    } else {
      prefix = color.red(color.bold('ERROR'));
      message = color.red(issue.message);
    }
    console.log(`${color.dim(loc)}  ${rule} ${prefix}  ${message}`);

    if (issue.severity === 'warning') {
      warnings++;
    } else {
      foundErrors++;
      if (options.fix && issue.fixable) fixedErrors++;
      else remainingErrors++;
    }
  }

  if (options.fix && newLines.some((line, idx) => line !== lines[idx])) {
    writeFileSync(file, newLines.join('\n'));
  }
}

const failed = remainingErrors > 0 || (options.strict && warnings > 0);

if (failed) {
  const summary = options.fix
    ? `未通过：已自动修复 ${fixedErrors} 处，仍有 ${remainingErrors} 个错误${options.showWarnings ? `和 ${warnings} 条写作建议` : ''}。`
    : `未通过：发现 ${foundErrors} 个错误${options.showWarnings ? `和 ${warnings} 条写作建议` : ''}。`;
  console.log(`\n${color.red(color.bold(`✖ ${summary}`))}`);
} else if (warnings > 0 && options.showWarnings) {
  const fixed = options.fix && fixedErrors > 0 ? `已自动修复 ${fixedErrors} 处；` : '';
  console.log(`\n${color.green(color.bold('✓ 通过'))}${color.yellow(`：${fixed}仍有 ${warnings} 条写作建议。`)}`);
} else {
  const fixed = options.fix && fixedErrors > 0 ? `，已自动修复 ${fixedErrors} 处` : '';
  console.log(`\n${color.green(color.bold(`✓ 通过${fixed}，未发现剩余问题。`))}`);
}

process.exitCode = failed ? 1 : 0;
