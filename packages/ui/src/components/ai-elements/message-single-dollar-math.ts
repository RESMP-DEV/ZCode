/*
 * 聊天消息单美元行内公式归一化（spec: specs/message-single-dollar-math.md）。
 *
 * `@streamdown/math` 打开 `singleDollarTextMath` 后，remark-math 把存活 `$` 顺序
 * 配成行内公式，KaTeX 数学模式忽略空格：散文里的美元金额（`$5M … $0 … $5`）
 * 一旦配对，中间整段文字会被渲染成无空格的斜体数学串。本模块在 Streamdown
 * 之前做唯一的 `$` 语义裁决：按段落贪心配对，判定为公式的保留原文，被拒绝
 * 的配对只转义开侧 `$`（闭侧滚动为下一对的候选），使 remark-math 对存活 `$`
 * 的配对结果与这里的判定一一对应。
 *
 * 与 remark-math 对齐的边界事实（2026-09-30 实测）：
 * - 行内公式的 `$` 可以跨段内软换行配对 → 归一化按整段（含换行）扫描；
 * - 链接目的地址与标题里的 `\$` 会被 CommonMark 转义还原 → 转义无害；
 * - 自动链接 `<scheme:…>` 与行内 HTML 标签是原子节点，内部 `$` 不参与配对
 *   且转义不会被还原 → 从候选中剔除；
 * - 行内代码内的 `$` 不是文本 → 不参与配对。
 */

const texCommandPattern = /\\[A-Za-z]+/;
// 多词内容只有在结构化 LaTeX 信号下才判定为公式。裸 `*`、`/`、`+`、`-`、括号
// 在散文与 `**加粗**` 标记里同样常见，曾把整段散文交给 KaTeX 吞掉空格。
const multiWordMathSignalPattern = /[\\{}^_=<>|∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
// 无空白内容沿用宽特征：`$x^2$`、`$a+b$`、`$f(x)$` 这类紧凑公式。
const singleWordMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
// 完整数学标识符：`x`、`data`、`count`、`3.14`；上限 5 字符避免把普通单词全吃进数学。
const simpleMathIdentifierPattern = /^(?:[A-Za-z][A-Za-z0-9_]{0,4}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;
const markdownFencePattern = /^( {0,3})(`{3,}|~{3,})/;
// 自动链接与行内 HTML 标签是原子节点：内部字符不参与 remark 的行内解析。
const atomicTextPatterns = [/<[a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*>/g, /<\/?[a-zA-Z][^<>\n]*>/g];

type MarkdownFence = { marker: string; length: number; indent: number };
type MaskRange = { start: number; end: number };

function getMarkdownFence(line: string): MarkdownFence | null {
  const match = markdownFencePattern.exec(line);

  if (!match) {
    return null;
  }

  const sequence = match[2] ?? "";
  return {
    marker: sequence[0] ?? "",
    length: sequence.length,
    indent: (match[1] ?? "").length,
  };
}

/** CommonMark 收围栏：同字符、长度不短于开侧、缩进不深于开侧，且整行只有围栏标记与空白。 */
function isActiveFenceCloser(
  line: string,
  fence: MarkdownFence | null,
  active: MarkdownFence,
): boolean {
  if (!fence) {
    return false;
  }

  if (
    fence.marker !== active.marker ||
    fence.length < active.length ||
    fence.indent > active.indent
  ) {
    return false;
  }

  // 收围栏不允许 info string，只有标记与尾随空白；` 与 ~ 都不是正则特殊字符。
  return new RegExp(`^ {0,3}${active.marker}{${active.length},}[ \\t]*$`).test(line);
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

function isLikelySingleDollarMath(content: string): boolean {
  if (!content || content !== content.trim() || /[\r\n]/.test(content)) {
    return false;
  }

  if (texCommandPattern.test(content)) {
    return true;
  }

  if (/\s/.test(content)) {
    return multiWordMathSignalPattern.test(content);
  }

  if (simpleMathIdentifierPattern.test(content)) {
    return true;
  }

  return singleWordMathSyntaxPattern.test(content);
}

function isLikelyCompactCurrencyRangeText(
  text: string,
  closingIndex: number,
  content: string,
): boolean {
  if (!compactCurrencyRangePrefixPattern.test(content)) {
    return false;
  }

  return compactCurrencyAmountStartPattern.test(text.slice(closingIndex + 1));
}

/**
 * 成对反引号 run 的范围。CommonMark 行内代码：闭合 run 必须是与开侧等长的
 * 最长 backtick run——跳过更长的 run 继续找（`` `a``b` `` 整体是一个代码 span，
 * 不存在中间的假闭合）。
 */
function getInlineCodeRanges(text: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf("`", cursor);

    if (codeStart === -1) {
      break;
    }

    let runEnd = codeStart + 1;
    while (text[runEnd] === "`") {
      runEnd++;
    }

    const runLength = runEnd - codeStart;
    let scan = runEnd;
    let closeStart = -1;

    while (scan < text.length) {
      const candidateStart = text.indexOf("`", scan);

      if (candidateStart === -1) {
        break;
      }

      let candidateEnd = candidateStart + 1;
      while (text[candidateEnd] === "`") {
        candidateEnd++;
      }

      if (candidateEnd - candidateStart === runLength) {
        closeStart = candidateStart;
        break;
      }

      // run 是最长匹配：不等长时必须跳过整段 run，不能从其内部重新找。
      scan = candidateEnd;
    }

    if (closeStart === -1) {
      // 未闭合的开侧按字面文本处理，其后内容照常参与配对。
      break;
    }

    ranges.push({ start: codeStart, end: closeStart + runLength });
    cursor = closeStart + runLength;
  }

  return ranges;
}

function getAtomicTextRanges(text: string): MaskRange[] {
  const ranges: MaskRange[] = [];

  for (const pattern of atomicTextPatterns) {
    pattern.lastIndex = 0;

    for (const match of text.matchAll(pattern)) {
      const value = match[0] ?? "";
      const start = match.index ?? 0;

      if (value) {
        ranges.push({ start, end: start + value.length });
      }
    }
  }

  return ranges;
}

/**
 * 整段贪心配对：候选 `$` 按出现顺序取相邻两枚（跳过 `$$` run、行内代码、
 * 自动链接/行内 HTML、已转义字符）。拒绝的配对只转义开侧 `$`，闭侧滚动为
 * 下一对的开候选——这样存活 `$` 序列与 remark-math 的顺序配对完全一致，
 * 孤立金额后面的真公式（`$N$`、`$p < 0.05$`）得以保留。
 */
function normalizeMessageSingleDollarMathInParagraph(paragraph: string): string {
  if (!paragraph.includes("$")) {
    return paragraph;
  }

  const maskRanges = [...getInlineCodeRanges(paragraph), ...getAtomicTextRanges(paragraph)];
  const isMasked = (index: number): boolean =>
    maskRanges.some((range) => index >= range.start && index < range.end);
  const candidates: number[] = [];

  for (let index = 0; index < paragraph.length; index++) {
    if (paragraph[index] !== "$") {
      continue;
    }

    if (isMasked(index)) {
      continue;
    }

    // `$$…$$` 双美元公式交还 remark-math 处理，单个候选不与相邻 `$` 组队。
    if (paragraph[index - 1] === "$" || paragraph[index + 1] === "$") {
      continue;
    }

    if (isEscapedMarkdownCharacter(paragraph, index)) {
      continue;
    }

    candidates.push(index);
  }

  const escapedIndexes = new Set<number>();
  let pair = 0;

  while (pair + 1 < candidates.length) {
    const openIndex = candidates[pair] as number;
    const closingIndex = candidates[pair + 1] as number;
    const content = paragraph.slice(openIndex + 1, closingIndex);
    const isCompactCurrencyRange = isLikelyCompactCurrencyRangeText(
      paragraph,
      closingIndex,
      content,
    );

    if (isCompactCurrencyRange || !isLikelySingleDollarMath(content)) {
      escapedIndexes.add(openIndex);
      pair += 1;
    } else {
      pair += 2;
    }
  }

  if (escapedIndexes.size === 0) {
    return paragraph;
  }

  let output = "";
  let cursor = 0;

  for (const index of escapedIndexes) {
    output += paragraph.slice(cursor, index) + "\\$";
    cursor = index + 1;
  }

  output += paragraph.slice(cursor);
  return output;
}

export function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }

  const outputLines: string[] = [];
  let activeFence: MarkdownFence | null = null;
  let inDisplayMath = false;
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }

    outputLines.push(normalizeMessageSingleDollarMathInParagraph(paragraphLines.join("\n")));
    paragraphLines = [];
  };

  for (const line of markdown.split("\n")) {
    if (activeFence) {
      flushParagraph();
      outputLines.push(line);

      if (isActiveFenceCloser(line, getMarkdownFence(line), activeFence)) {
        activeFence = null;
      }

      continue;
    }

    if (inDisplayMath) {
      flushParagraph();
      outputLines.push(line);

      if (line.trimEnd().endsWith("$$")) {
        inDisplayMath = false;
      }

      continue;
    }

    const fence = getMarkdownFence(line);

    if (fence) {
      flushParagraph();
      outputLines.push(line);
      activeFence = fence;
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === "$$" || (trimmed.startsWith("$$") && !trimmed.endsWith("$$"))) {
      // 块级显示公式开栏：整块内容（含单个 `$`）原样交还 remark-math。
      flushParagraph();
      outputLines.push(line);
      inDisplayMath = true;
      continue;
    }

    if (trimmed.startsWith("$$")) {
      // 单行 `$$x$$` 双美元公式：无需进入块级状态。
      flushParagraph();
      outputLines.push(line);
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      outputLines.push(line);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return outputLines.join("\n");
}
