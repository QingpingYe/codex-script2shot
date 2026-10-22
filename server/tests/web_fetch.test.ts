import { describe, expect, test } from "vitest";
import {
  decode_html_entities,
  extract_html_title,
  fetch_web_page,
  html_to_text,
  WEB_RENDER_TEXT_THRESHOLD,
} from "../src/web_fetch.js";

function html_response(
  body: string,
  options: { status?: number; content_type?: string } = {},
): typeof fetch {
  return async () =>
    new Response(body, {
      status: options.status ?? 200,
      headers: { "content-type": options.content_type ?? "text/html; charset=utf-8" },
    });
}

describe("html_to_text", () => {
  test("drops script/style/head and keeps block text", () => {
    const html = [
      "<html><head><title>页面标题</title><style>.a{color:red}</style></head>",
      "<body><h1>标题</h1><p>第一段</p><p>第二段&nbsp;续</p>",
      "<script>var a = 1 < 2;</script></body></html>",
    ].join("");

    expect(html_to_text(html)).toBe("标题\n第一段\n第二段 续");
  });

  test("decodes named and numeric entities", () => {
    expect(decode_html_entities("A &amp; B &#65; &#x42; &hellip;")).toBe("A & B A B …");
  });

  test("extracts title from html", () => {
    expect(extract_html_title("<html><head><title> Seedance &amp; 技巧 </title></head></html>")).toBe(
      "Seedance & 技巧",
    );
    expect(extract_html_title("<html><body>无标题</body></html>")).toBeUndefined();
  });
});

describe("fetch_web_page", () => {
  test("reads static html and reports text, title and retrieval time", async () => {
    const long_text = "火山引擎官方提示词指南正文段落。".repeat(30);
    const result = await fetch_web_page("https://example.com/guide", {
      fetch_impl: html_response(`<html><head><title>Seedance 2.0 指南</title></head><body><p>${long_text}</p></body></html>`),
      now: () => new Date("2026-10-22T09:30:05+08:00"),
    });

    if (!result.ok) {
      throw new Error(`期望读取成功：${JSON.stringify(result)}`);
    }
    expect(result.title).toBe("Seedance 2.0 指南");
    expect(result.text).toContain("火山引擎官方提示词指南正文段落");
    expect(result.needs_render).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test("flags JS shell pages as needs_render", async () => {
    const result = await fetch_web_page("https://example.com/spa", {
      fetch_impl: html_response("<html><body>You need to enable JavaScript to run this app.</body></html>"),
    });

    if (!result.ok) {
      throw new Error("期望读取成功（内容为空也要返回 needs_render）");
    }
    expect(result.needs_render).toBe(true);
    expect(result.text.length).toBeLessThan(WEB_RENDER_TEXT_THRESHOLD);
  });

  test("rejects non http protocols", async () => {
    const result = await fetch_web_page("ftp://example.com/file", {
      fetch_impl: html_response("x"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("WEB_URL_INVALID");
  });

  test("rejects unsupported content types", async () => {
    const result = await fetch_web_page("https://example.com/doc.pdf", {
      fetch_impl: html_response("%PDF-1.7", { content_type: "application/pdf" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("WEB_CONTENT_TYPE_UNSUPPORTED");
  });

  test("reports http errors as fetch failures", async () => {
    const result = await fetch_web_page("https://example.com/missing", {
      fetch_impl: html_response("<html><body>not found</body></html>", { status: 404 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("WEB_FETCH_FAILED");
    expect(result.error.details?.status_code).toBe(404);
  });

  test("marks truncated responses when body exceeds max bytes", async () => {
    const result = await fetch_web_page("https://example.com/long", {
      fetch_impl: html_response(`<html><body><p>${"内容".repeat(500)}</p></body></html>`),
      max_bytes: 64,
    });

    if (!result.ok) {
      throw new Error("期望读取成功（截断不算失败）");
    }
    expect(result.truncated).toBe(true);
    expect(result.bytes_read).toBeLessThanOrEqual(64);
  });
});
