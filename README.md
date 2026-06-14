# chinese-tech-writing

中文技术文档写作规范 skill，适用于 Claude Code 及其他兼容 [skills CLI](https://github.com/vercel-labs/skills) 的 AI Agent。

涵盖标题层级、字间距、标点符号、数值格式、段落结构、文档体系等规范，每条规则均附有错误/正确对比示例。

## 安装

```bash
npx skills add fwqaaq/chinese-tech-writing -g
```

安装后，在 Claude Code 对话中输入 `/chinese-tech-writing` 即可激活。

## 检查脚本

`scripts/lint.mjs` 用于检测 Markdown 文档中违反本规范的写法，部分机械性问题支持自动修正。

```bash
# 检测仓库内所有 Markdown 文件
npm run lint

# 检测并自动修正可修复的问题
npm run lint:fix

# 检测指定文件
node scripts/lint.mjs path/to/file.md
```

可自动修正的问题包括：全角数字、省略号写法、感叹号连用、中英文间缺少空格、全角括号内多余空格。
标题层级、句子长度、千分位分隔符、文件命名等结构性问题仅报告位置，需人工复核。

## 模板

`templates/` 目录提供两份符合本规范的示例文档，可直接复制作为写作起点：

- [`templates/blog-post.md`](templates/blog-post.md)：技术博客文章模板。
- [`templates/readme.md`](templates/readme.md)：README / 技术文档模板，结构参考下文「文档体系」一节。

## 内容

| 章节 | 说明 |
| ------ | ------ |
| 标题规范 | 层级限制、禁止跳级、孤立编号处理、四级标题替代方案 |
| 文本与字间距 | 中英文空格、句子长度、写作风格、英文词汇处理 |
| 段落规范 | 单主题原则、字数控制、引用标注 |
| 数值规范 | 半角数字、千分号、数值范围、增减表达 |
| 标点符号 | 全角/半角选用、各符号具体用法与示例 |
| 文档体系 | 软件文档推荐结构、文件命名规范 |

## 来源

本 skill 基于 [document-style-guide](https://github.com/ruanyf/document-style-guide) 项目整理。
