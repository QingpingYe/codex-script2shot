/**
 * 检索匹配的文本归一化（架构 §10.2；Task 2 简报）。
 *
 * 固定顺序：Unicode NFKC 归一 -> 小写 -> 所有空白串压缩为单个 ASCII 空格 ->
 * 去除首尾空白。中文按 NFKC 结果原样保留。函数必须幂等：索引写入和检索
 * 匹配两侧都调用本函数，不得各自实现。
 */
export function normalize_text(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
