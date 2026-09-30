/*
 * 聊天消息单美元行内公式归一化（spec: specs/message-single-dollar-math.md）。
 *
 * `@streamdown/math` 打开 `singleDollarTextMath` 后，remark-math 把整行内相邻的
 * 两个存活 `$` 配成行内公式，KaTeX 数学模式忽略空格：散文里的美元金额
 * （`$5M … $0 … $5`）一旦配对，中间整段文字会被渲染成无空格的斜体数学串。
 * 本模块在 Streamdown 之前做唯一的 `$` 语义裁决：逐行贪心配对，判定为公式的
 * 保留原文，其余成对转义为 `\$`，使 remark-math 看到的存活 `$` 与这里的
 * 配对决策一致。
 */

const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const texCommandPattern = /\\[A-Za-z]+/;
// 多词内容只有在结构化 LaTeX 信号下才判定为公式。裸 `*`、`/`、`+`、`-`、括号
// 在散文与 `**加粗**` 标记里同样常见，曾把整段散文交给 KaTeX 吞掉空格。
const multiWordMathSignalPattern = /[\\{}^_=<>|∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
// 无空白内容沿用宽特征：`$x^2$`、`$a+b$`、`$f(x)$` 这类紧凑公式。
const singleWordMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const simpleMathIdentifierPattern = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

type MarkdownFence = { marker: string; length: number };
type InlineCodeRange = { start: number; end: number };

function getMarkdownFence(line: string): MarkdownFence | null {
  const match = markdownFencePattern.exec(line);

  if (!match) {
    return null;
  }

  const sequence = match[1] ?? "";
  return {
    marker: sequence[0] ?? "",
    length: sequence.length,
  };
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

/** 成对反引号 run 的范围；未闭合时其后按普通文本处理。 */
function getInlineCodeRanges(line: string): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);

    if (codeStart === -1) {
      break;
    }

    let codeFenceEnd = codeStart + 1;
    while (line[codeFenceEnd] === "`") {
      codeFenceEnd++;
    }

    const codeMarker = line.slice(codeStart, codeFenceEnd);
    const codeEnd = line.indexOf(codeMarker, codeFenceEnd);

    if (codeEnd === -1) {
      break;
    }

    ranges.push({ start: codeStart, end: codeEnd + codeMarker.length });
    cursor = codeEnd + codeMarker.length;
  }

  return ranges;
}

/**
 * 整行贪心配对：候选 `$` 按出现顺序两两成对（跳过 `$$` run、行内代码、
 * 已转义字符），拒绝对两侧同时转义。这样 remark-math 对存活 `$` 的顺序
 * 配对与这里的判定一一对应，不会再出现跨段落/跨行内代码的错误配对。
 */
function normalizeSingleDollarMathInLine(line: string): string {
  if (!line.includes("$")) {
    return line;
  }

  const codeRanges = getInlineCodeRanges(line);
  const isInsideInlineCode = (index: number): boolean =>
    codeRanges.some((range) => index >= range.start && index < range.end);
  const candidates: number[] = [];

  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "$") {
      continue;
    }

    if (isInsideInlineCode(index)) {
      continue;
    }

    // `$$…$$` 双美元公式交还 remark-math 处理，单个候选不与相邻 `$` 组队。
    if (line[index - 1] === "$" || line[index + 1] === "$") {
      continue;
    }

    if (isEscapedMarkdownCharacter(line, index)) {
      continue;
    }

    candidates.push(index);
  }

  const escapedIndexes = new Set<number>();

  for (let pair = 0; pair + 1 < candidates.length; pair += 2) {
    const openIndex = candidates[pair] as number;
    const closingIndex = candidates[pair + 1] as number;
    const content = line.slice(openIndex + 1, closingIndex);
    const isCompactCurrencyRange = isLikelyCompactCurrencyRangeText(line, closingIndex, content);

    if (isCompactCurrencyRange || !isLikelySingleDollarMath(content)) {
      escapedIndexes.add(openIndex);
      escapedIndexes.add(closingIndex);
    }
  }

  if (escapedIndexes.size === 0) {
    return line;
  }

  let output = "";
  let cursor = 0;

  for (const index of escapedIndexes) {
    output += line.slice(cursor, index) + "\\$";
    cursor = index + 1;
  }

  output += line.slice(cursor);
  return output;
}

export function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }

  let output = "";
  let cursor = 0;
  let activeFence: MarkdownFence | null = null;

  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getMarkdownFence(line);

    if (activeFence) {
      output += line + newline;

      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null;
      }
    } else {
      output += normalizeSingleDollarMathInLine(line) + newline;

      if (fence) {
        activeFence = fence;
      }
    }

    cursor = lineEnd + newline.length;
  }

  return output;
}
