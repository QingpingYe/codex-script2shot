/**
 * 网页引用读取（架构 §6.5，2026-10-22）。
 *
 * - 只接受 http / https，只发 GET；不提交表单、不带账号凭据。
 * - 响应体上限 2 MB、请求超时 30 秒；超限时截断并在结果里标记 `truncated`。
 * - 只处理 text/html、application/xhtml+xml、text/plain；其余类型返回不支持。
 * - HTML 转纯文本后判断是否需要浏览器渲染（JS 壳页面），由调用方决定后续处理。
 */

export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** 静态提取出的正文短于该长度时，视为需要浏览器渲染。 */
export const WEB_RENDER_TEXT_THRESHOLD = 200;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; script2shot-knowledge-sync/0.1; +local codex plugin)";

export type WebFetchErrorCode =
  | "WEB_URL_INVALID"
  | "WEB_FETCH_TIMEOUT"
  | "WEB_FETCH_FAILED"
  | "WEB_CONTENT_TYPE_UNSUPPORTED";

export interface WebFetchFailure {
  ok: false;
  error: {
    code: WebFetchErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface WebFetchSuccess {
  ok: true;
  /** 跟随重定向后的最终 URL。 */
  final_url: string;
  status_code: number;
  content_type: string;
  /** 页面标题（HTML `<title>`），取不到时为空字符串。 */
  title: string;
  /** 转成纯文本后的正文。 */
  text: string;
  bytes_read: number;
  truncated: boolean;
  /** 静态 HTML 里没有可用正文，需要浏览器渲染。 */
  needs_render: boolean;
  /** 读取时刻，带时区偏移的 ISO 8601。 */
  retrieved_at: string;
}

export type WebFetchResult = WebFetchSuccess | WebFetchFailure;

export interface FetchWebPageOptions {
  timeout_ms?: number;
  max_bytes?: number;
  /** 默认 globalThis.fetch；测试可注入受控实现。 */
  fetch_impl?: typeof fetch;
  /** 默认 new Date()；测试可固定读取时刻。 */
  now?: () => Date;
}

export async function fetch_web_page(
  url: string,
  options: FetchWebPageOptions = {},
): Promise<WebFetchResult> {
  const raw = typeof url === "string" ? url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return failure("WEB_URL_INVALID", `网页链接无法解析：${raw === "" ? "(空字符串)" : raw}`, {
      url: raw,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failure(
      "WEB_URL_INVALID",
      `只支持 http / https 网页链接，实际协议：${parsed.protocol}`,
      { url: raw, protocol: parsed.protocol },
    );
  }

  const timeout_ms = options.timeout_ms ?? WEB_FETCH_TIMEOUT_MS;
  const max_bytes = options.max_bytes ?? WEB_FETCH_MAX_BYTES;
  const fetch_impl = options.fetch_impl ?? fetch;
  const retrieved_at = format_local_iso((options.now ?? (() => new Date()))());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetch_impl(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    const content_type = response.headers.get("content-type") ?? "";
    const supported =
      content_type === "" ||
      /text\/html|application\/xhtml\+xml|text\/plain/i.test(content_type);
    if (!supported) {
      return failure(
        "WEB_CONTENT_TYPE_UNSUPPORTED",
        `网页引用只支持文本内容，实际返回：${content_type}`,
        {
          url: parsed.toString(),
          status_code: response.status,
          content_type,
        },
      );
    }
    if (response.status >= 400) {
      return failure("WEB_FETCH_FAILED", `网页返回 HTTP ${response.status}。`, {
        url: parsed.toString(),
        status_code: response.status,
        content_type,
      });
    }

    const raw_text = await read_body(response, max_bytes);
    if (!raw_text.ok) {
      return raw_text;
    }
    const is_html = /text\/html|application\/xhtml\+xml/i.test(content_type) || content_type === "";
    const text = is_html ? html_to_text(raw_text.text) : raw_text.text.trim();
    const title = is_html ? (extract_html_title(raw_text.text) ?? "") : "";
    const needs_render =
      text.trim().length < WEB_RENDER_TEXT_THRESHOLD || looks_like_js_shell(text);

    return {
      ok: true,
      final_url: response.url === "" ? parsed.toString() : response.url,
      status_code: response.status,
      content_type,
      title,
      text,
      bytes_read: raw_text.bytes_read,
      truncated: raw_text.truncated,
      needs_render,
      retrieved_at,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return failure("WEB_FETCH_TIMEOUT", `读取网页超时（${timeout_ms} ms）。`, {
        url: parsed.toString(),
        timeout_ms,
      });
    }
    return failure("WEB_FETCH_FAILED", `读取网页失败：${describe_error(error)}`, {
      url: parsed.toString(),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 把 HTML 转成纯文本：去掉脚本/样式，块级标签转换行，解码实体，压缩空白。 */
export function html_to_text(html: string): string {
  const without_comments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const without_blocks = without_comments.replace(
    /<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  const with_breaks = without_blocks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|table|blockquote|pre|figure)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ");
  const decoded = decode_html_entities(with_breaks);
  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""));
  return lines.join("\n").trim();
}

/** 取 HTML 的 `<title>` 文本；取不到时返回 undefined。 */
export function extract_html_title(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) {
    return undefined;
  }
  const title = decode_html_entities(match[1].replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? undefined : title;
}

/** 解码常见 HTML 实体与数字实体。 */
export function decode_html_entities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    middot: "·",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safe_from_code_point(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safe_from_code_point(code) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

/** 常见 JS 壳页面的提示语。 */
function looks_like_js_shell(text: string): boolean {
  return /(enable|need(ed)?)\s+javascript|需要(启用|开启)\s*javascript|请开启\s*javascript/i.test(
    text,
  );
}

async function read_body(
  response: Response,
  max_bytes: number,
): Promise<
  | { ok: true; text: string; bytes_read: number; truncated: boolean }
  | WebFetchFailure
> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    const bytes_read = Buffer.byteLength(text, "utf8");
    return { ok: true, text, bytes_read, truncated: bytes_read > max_bytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes_read = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    const remaining = max_bytes - bytes_read;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, Math.max(remaining, 0)));
      bytes_read += Math.max(remaining, 0);
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes_read += value.byteLength;
  }

  const charset = charset_of(response.headers.get("content-type") ?? "");
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { ok: true, text: decode_buffer(joined, charset), bytes_read, truncated };
}

function charset_of(content_type: string): string | undefined {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(content_type);
  return match === null ? undefined : match[1].toLowerCase();
}

function decode_buffer(buffer: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function safe_from_code_point(code: number): string {
  if (code < 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 按本地时区输出带偏移的 ISO 8601（架构 §6.5 的检索日期口径）。 */
export function format_local_iso(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset_minutes = -date.getTimezoneOffset();
  const sign = offset_minutes >= 0 ? "+" : "-";
  const abs = Math.abs(offset_minutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function failure(
  code: WebFetchErrorCode,
  message: string,
  details?: Record<string, unknown>,
): WebFetchFailure {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
