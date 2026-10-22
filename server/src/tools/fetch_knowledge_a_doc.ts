import type { Script2ShotConfig } from "../config.js";
import { load_config } from "../config.js";
import {
  resolve_lark_cli,
  run_cli,
  STDERR_LIMIT,
  type LarkCliErrorCode,
} from "../lark_cli.js";
import { extract_html_title, fetch_web_page, format_local_iso } from "../web_fetch.js";

/**
 * `fetch_knowledge_a_doc` 工具（架构 §6.1、§8）。
 *
 * - 只读：只发 `docs +fetch` 与按需的 `wiki +node-get`，都是 Risk=read 的调用。
 * - 输入解析顺序（brief 冻结）：`/wiki/<token>` URL 与 `wikcn*` token ⇒ 先
 *   `wiki +node-get` 解析出 `obj_token` 再读；`/docx/<token>` URL 与 `doccn*` token ⇒
 *   直接读；其他原始 token ⇒ 先按文档读，失败再按节点解析一次。
 * - 读取命令固定为 `docs +fetch --doc <token> --doc-format markdown --revision-id -1
 *   --format json`；markdown 模式不提供 block id，因此不传 `--detail`
 *   （`source_block_id` 由下游留空，将来需要 block id 时改用 xml 模式）。
 * - `title` 取正文首个 Markdown 标题行；取不到时回退 `wiki +node-get` 的节点标题并写
 *   warning，两级都取不到时 `title` 为空字符串并写 warning。
 * - 返回值一律是结果对象，不抛异常；`DOC_FETCH_FAILED` 的 `details.doc` 始终是输入原文。
 */

export type FetchKnowledgeADocErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "DOC_FETCH_FAILED";

export type FetchDocWarningCode = "DOC_TITLE_FROM_NODE" | "DOC_TITLE_MISSING";

export interface FetchDocWarning {
  code: FetchDocWarningCode | ReferenceWarningCode;
  message: string;
}

export type ReferenceWarningCode =
  | "REFERENCE_EXPAND_FAILED"
  | "REFERENCE_NEEDS_RENDER"
  | "REFERENCE_TRUNCATED"
  | "REFERENCE_LIMIT_EXCEEDED"
  | "REFERENCE_SKIPPED";

export type FetchedReferenceKind = "feishu_doc" | "web_page";

export type FetchedReferenceStatus = "ok" | "failed" | "needs_render";

/** 展开后的引用目标（架构 §6.5）。 */
export interface FetchedReference {
  kind: FetchedReferenceKind;
  /** 原始引用：飞书文档 token 或网页 URL。 */
  ref: string;
  label?: string;
  status: FetchedReferenceStatus;
  title?: string;
  content?: string;
  content_length?: number;
  /** 仅飞书文档引用。 */
  revision_id?: number;
  retrieved_at: string;
  truncated?: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface FetchKnowledgeADocSuccess {
  doc_token: string;
  revision_id: number;
  title: string;
  content: string;
  tips: string;
  warnings: FetchDocWarning[];
  /** `expand_references: true` 时展开的引用目标；否则为空数组。 */
  references: FetchedReference[];
}

export interface FetchKnowledgeADocFailure {
  ok: false;
  error: {
    code: FetchKnowledgeADocErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type FetchKnowledgeADocResult = FetchKnowledgeADocSuccess | FetchKnowledgeADocFailure;

export interface FetchKnowledgeADocInput {
  /** 文档 token 或飞书文档 URL（必填）。 */
  doc: string;
  /** 缺省 false：只读文档正文，不展开正文里的引用。 */
  expand_references?: boolean;
  /** 展开引用的数量上限，缺省 10。 */
  max_references?: number;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
  /** 默认 new Date()；测试可固定引用检索时刻。 */
  now?: () => Date;
  /** 默认 globalThis.fetch；测试可注入受控网页读取实现。 */
  web_fetch_impl?: typeof fetch;
}

/** 展开引用时的固定上限（架构 §6.5）。 */
export const MAX_REFERENCES_DEFAULT = 10;
export const REFERENCE_CONTENT_LIMIT = 200_000;

/** `docs +fetch` 返回的正文载荷。 */
interface DocumentPayload {
  document_id: string;
  revision_id: number;
  content: string;
  tips: string;
}

interface ResolvedNode {
  obj_token: string;
  title: string | undefined;
}

type ClassifiedDoc =
  | { kind: "doc"; token: string }
  | { kind: "node"; token: string }
  | { kind: "unknown"; token: string };

interface StepFailure {
  ok: false;
  error: FetchKnowledgeADocFailure["error"];
}

export async function fetch_knowledge_a_doc(
  input: FetchKnowledgeADocInput,
): Promise<FetchKnowledgeADocResult> {
  const original = input.doc;

  const loaded = load_config();
  if ("error" in loaded) {
    return failure("CONFIG_INVALID", loaded.error.message, loaded.error.details);
  }
  if (!loaded.exists) {
    return failure(
      "CONFIG_MISSING",
      `未找到配置文件：${loaded.path}。请先运行 $setup 或 write_config 初始化配置。`,
      { path: loaded.path },
    );
  }

  const config = loaded.config;
  const cli = resolve_lark_cli(config, { env: input.env, home_dir: input.home_dir });
  if (!cli.ok) {
    return { ok: false, error: cli.error };
  }

  const doc_input = typeof original === "string" ? original.trim() : "";
  const classified = classify_doc_input(doc_input);

  const base = await read_document_result(cli.path, classified, config, input, original);
  if ("ok" in base || input.expand_references !== true) {
    return base;
  }
  return expand_doc_references(base, cli.path, input);
}

async function read_document_result(
  cli_path: string,
  classified: ClassifiedDoc,
  config: Script2ShotConfig,
  input: FetchKnowledgeADocInput,
  original: string,
): Promise<FetchKnowledgeADocResult> {
  // `doccn*` / `/docx/<token>`：直接按文档读。
  if (classified.kind === "doc") {
    return finish(await read_document(cli_path, classified.token, input.env), undefined, original);
  }

  // `wikcn*` / `/wiki/<token>`：先解析节点再读。
  if (classified.kind === "node") {
    const resolved = await resolve_node_token(
      cli_path,
      classified.token,
      config.lark.space_a,
      input.env,
    );
    if (!resolved.ok) {
      return with_original_doc(resolved, original);
    }
    return finish(
      await read_document(cli_path, resolved.node.obj_token, input.env),
      resolved.node.title,
      original,
    );
  }

  // 其他原始 token：先按文档读，失败再按节点解析一次。
  const direct = await read_document(cli_path, classified.token, input.env);
  if (direct.ok) {
    return finish(direct, undefined, original);
  }
  const resolved = await resolve_node_token(
    cli_path,
    classified.token,
    config.lark.space_a,
    input.env,
  );
  if (!resolved.ok) {
    return with_original_doc(combine_failures(direct, resolved), original);
  }
  return finish(
    await read_document(cli_path, resolved.node.obj_token, input.env),
    resolved.node.title,
    original,
  );
}

/** 形如 `/wiki/<token>` 或 `/docx/<token>` 的 URL 片段；token 允许字母数字与 `-` `_`。 */
const DOC_URL_PATTERN = /(?:^|\/)(wiki|docx)\/([A-Za-z0-9_-]+)/i;

function classify_doc_input(doc_input: string): ClassifiedDoc {
  const url_match = DOC_URL_PATTERN.exec(doc_input);
  if (url_match !== null) {
    return url_match[1].toLowerCase() === "wiki"
      ? { kind: "node", token: url_match[2] }
      : { kind: "doc", token: url_match[2] };
  }
  if (/^wikcn/i.test(doc_input)) {
    return { kind: "node", token: doc_input };
  }
  if (/^doccn/i.test(doc_input)) {
    return { kind: "doc", token: doc_input };
  }
  return { kind: "unknown", token: doc_input };
}

async function read_document(
  cli_path: string,
  doc_token: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; document: DocumentPayload } | StepFailure> {
  const args = [
    "docs",
    "+fetch",
    "--doc",
    doc_token,
    "--doc-format",
    "markdown",
    "--revision-id",
    "-1",
    "--format",
    "json",
  ];
  const run = await run_cli(cli_path, args, { env, expect_json: true });
  if (!run.ok) {
    return { ok: false, error: run.error };
  }
  if (run.code !== 0 || business_failed(run.json)) {
    return {
      ok: false,
      error: {
        code: "DOC_FETCH_FAILED",
        message: business_failure_message("docs +fetch", run.json, run.code),
        details: {
          command: "docs +fetch",
          exit_code: run.code,
          stderr: truncate(run.stderr),
          stderr_truncated: run.stderr.length > STDERR_LIMIT,
        },
      },
    };
  }

  const document = parse_document(run.json, doc_token);
  if (document === undefined) {
    return {
      ok: false,
      error: {
        code: "DOC_FETCH_FAILED",
        message:
          "lark-cli docs +fetch 返回缺少 data.document 的 document_id / revision_id / content，" +
          "无法解析正文。",
        details: { command: "docs +fetch" },
      },
    };
  }
  return { ok: true, document };
}

async function resolve_node_token(
  cli_path: string,
  node_token: string,
  space_a: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; node: ResolvedNode } | StepFailure> {
  const args = ["wiki", "+node-get", "--node-token", node_token];
  if (has_text(space_a)) {
    args.push("--space-id", space_a);
  }
  args.push("--as", "user");

  const run = await run_cli(cli_path, args, { env, expect_json: true });
  if (!run.ok) {
    return { ok: false, error: run.error };
  }
  if (run.code !== 0 || business_failed(run.json)) {
    return {
      ok: false,
      error: {
        code: "DOC_FETCH_FAILED",
        message: business_failure_message("wiki +node-get", run.json, run.code),
        details: {
          command: "wiki +node-get",
          exit_code: run.code,
          stderr: truncate(run.stderr),
          stderr_truncated: run.stderr.length > STDERR_LIMIT,
        },
      },
    };
  }

  // 真实响应形状待 Task 7 live 核对：同时接受 data.node 嵌套与 data 平铺。
  const node = first_record(run.json, [["data", "node"], ["node"], ["data"]]);
  const obj_token = optional_text(node?.obj_token);
  if (obj_token === undefined) {
    return {
      ok: false,
      error: {
        code: "DOC_FETCH_FAILED",
        message: "lark-cli wiki +node-get 返回缺少 obj_token，无法解析文档 token。",
        details: { command: "wiki +node-get" },
      },
    };
  }
  return { ok: true, node: { obj_token, title: optional_text(node?.title) } };
}

function parse_document(payload: unknown, requested_token: string): DocumentPayload | undefined {
  const document = first_record(payload, [["data", "document"], ["document"]]);
  if (document === undefined) {
    return undefined;
  }
  const revision_id = document.revision_id;
  if (typeof revision_id !== "number" || !Number.isFinite(revision_id)) {
    return undefined;
  }
  const content = document.content;
  if (typeof content !== "string") {
    return undefined;
  }
  return {
    // 真实形状带 document_id（Phase 1 fixture）；缺省时以本次请求的 token 兜底。
    document_id: optional_text(document.document_id) ?? requested_token,
    revision_id,
    content,
    tips: typeof document.tips === "string" ? document.tips : "",
  };
}

function finish(
  result: { ok: true; document: DocumentPayload } | StepFailure,
  node_title: string | undefined,
  original: string,
): FetchKnowledgeADocResult {
  if (!result.ok) {
    return with_original_doc(result, original);
  }
  return build_success(result.document, node_title);
}

function build_success(
  document: DocumentPayload,
  node_title: string | undefined,
): FetchKnowledgeADocSuccess {
  const warnings: FetchDocWarning[] = [];
  let title = extract_title(document.content);
  if (title === undefined) {
    if (has_text(node_title)) {
      title = node_title.trim();
      warnings.push({
        code: "DOC_TITLE_FROM_NODE",
        message: `正文没有 Markdown 标题行，title 回退为节点标题「${title}」。`,
      });
    } else {
      title = "";
      warnings.push({
        code: "DOC_TITLE_MISSING",
        message: "正文没有 Markdown 标题行，也没有可用的节点标题，title 为空字符串。",
      });
    }
  }
  return {
    doc_token: document.document_id,
    revision_id: document.revision_id,
    title,
    content: document.content,
    tips: document.tips,
    warnings,
    references: [],
  };
}

/**
 * 标题提取顺序（架构 §6.1，2026-10-22）：正文 `<title>` 标签 → 首个 Markdown 标题行。
 * 飞书 docx 正文里通常带 `<title>`，优先取它才能和 Wiki 节点标题一致。
 */
function extract_title(content: string): string | undefined {
  const html_title = extract_html_title(content);
  if (html_title !== undefined) {
    return html_title;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/** 文档引用卡片：`<cite doc-id="..." file-type="docx" title="...">`。 */
const CITE_PATTERN = /<cite\b([^>]*)>/gi;
const CITE_ATTR_PATTERN = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]*)\]\(\s*(https?:\/\/[^\s)]+)[^)]*\)/g;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'()\[\]]+/g;
const FEISHU_DOC_URL_PATTERN = /(?:^|\/)(?:docx|wiki)\/([A-Za-z0-9_-]+)/i;
const BINARY_URL_PATTERN =
  /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|pdf|zip|gz|7z|rar|mp4|mov|avi|mkv|mp3|wav|m4a|flac|docx?|xlsx?|pptx?)(\?|#|$)/i;

export interface DetectedReference {
  kind: FetchedReferenceKind;
  /** 飞书文档 token 或网页 URL。 */
  ref: string;
  label?: string;
}

/**
 * 找出正文里可展开的引用（架构 §6.5）：飞书文档引用卡片、飞书文档链接、网页链接。
 * 不支持的引用形态写 warning 后跳过；同一目标只保留一条。
 */
export function detect_references(
  content: string,
  warnings: FetchDocWarning[],
): DetectedReference[] {
  const detected: DetectedReference[] = [];
  const seen = new Set<string>();
  const push = (reference: DetectedReference): void => {
    const key = `${reference.kind}:${reference.ref}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    detected.push(reference);
  };

  for (const match of content.matchAll(CITE_PATTERN)) {
    const attributes = parse_cite_attributes(match[1]);
    const doc_id = attributes["doc-id"];
    const file_type = attributes["file-type"];
    const title = attributes["title"];
    if (doc_id === undefined || doc_id === "") {
      warnings.push({
        code: "REFERENCE_SKIPPED",
        message: `文档引用卡片缺少 doc-id，已跳过：${match[0]}`,
      });
      continue;
    }
    if (file_type !== undefined && file_type !== "docx") {
      warnings.push({
        code: "REFERENCE_SKIPPED",
        message: `文档引用卡片 file-type=${file_type} 暂不支持展开（第一版只支持 docx），已跳过 ${doc_id}。`,
      });
      continue;
    }
    push(
      title === undefined
        ? { kind: "feishu_doc", ref: doc_id }
        : { kind: "feishu_doc", ref: doc_id, label: title },
    );
  }

  const linked_urls = new Set<string>();
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const label = match[1].trim();
    const url = match[2];
    linked_urls.add(url);
    const classified = classify_reference_url(url, warnings);
    if (classified === undefined) {
      continue;
    }
    push(label === "" ? classified : { ...classified, label });
  }
  for (const url of content.match(BARE_URL_PATTERN) ?? []) {
    if (linked_urls.has(url)) {
      continue;
    }
    const classified = classify_reference_url(url, warnings);
    if (classified !== undefined) {
      push(classified);
    }
  }
  return detected;
}

function classify_reference_url(
  url: string,
  warnings: FetchDocWarning[],
): DetectedReference | undefined {
  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }
  const feishu = FEISHU_DOC_URL_PATTERN.exec(url);
  if (feishu !== null) {
    return { kind: "feishu_doc", ref: feishu[1] };
  }
  if (BINARY_URL_PATTERN.test(url)) {
    warnings.push({
      code: "REFERENCE_SKIPPED",
      message: `网页引用指向二进制资源，暂不展开：${url}`,
    });
    return undefined;
  }
  return { kind: "web_page", ref: url };
}

function parse_cite_attributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(CITE_ATTR_PATTERN)) {
    attributes[match[1].toLowerCase()] = match[2].trim();
  }
  return attributes;
}

async function expand_doc_references(
  base: FetchKnowledgeADocSuccess,
  cli_path: string,
  input: FetchKnowledgeADocInput,
): Promise<FetchKnowledgeADocSuccess> {
  const warnings: FetchDocWarning[] = [...base.warnings];
  const detected = detect_references(base.content, warnings);
  const max_references = normalize_max_references(input.max_references);
  if (detected.length > max_references) {
    warnings.push({
      code: "REFERENCE_LIMIT_EXCEEDED",
      message:
        `正文里检测到 ${detected.length} 条引用，超过上限 ${max_references} 条；` +
        `只展开前 ${max_references} 条。`,
    });
  }

  const now = input.now ?? (() => new Date());
  const references: FetchedReference[] = [];
  for (const reference of detected.slice(0, max_references)) {
    references.push(
      reference.kind === "feishu_doc"
        ? await expand_feishu_reference(reference, cli_path, input, now, warnings)
        : await expand_web_reference(reference, input, now, warnings),
    );
  }
  return { ...base, warnings, references };
}

async function expand_feishu_reference(
  reference: DetectedReference,
  cli_path: string,
  input: FetchKnowledgeADocInput,
  now: () => Date,
  warnings: FetchDocWarning[],
): Promise<FetchedReference> {
  const retrieved_at = format_local_iso(now());
  const read = await read_document(cli_path, reference.ref, input.env);
  if (!read.ok) {
    warnings.push({
      code: "REFERENCE_EXPAND_FAILED",
      message: `飞书文档引用 ${reference.ref} 读取失败：${read.error.message}`,
    });
    return {
      kind: "feishu_doc",
      ref: reference.ref,
      ...(reference.label === undefined ? {} : { label: reference.label }),
      status: "failed",
      retrieved_at,
      error: read.error,
    };
  }
  const capped = cap_reference_content(read.document.content, reference.ref, warnings);
  const title = extract_title(read.document.content) ?? reference.label;
  return {
    kind: "feishu_doc",
    ref: reference.ref,
    ...(reference.label === undefined ? {} : { label: reference.label }),
    status: "ok",
    ...(title === undefined ? {} : { title }),
    content: capped.content,
    content_length: read.document.content.length,
    revision_id: read.document.revision_id,
    retrieved_at,
    truncated: capped.truncated,
  };
}

async function expand_web_reference(
  reference: DetectedReference,
  input: FetchKnowledgeADocInput,
  now: () => Date,
  warnings: FetchDocWarning[],
): Promise<FetchedReference> {
  const fetched = await fetch_web_page(reference.ref, {
    fetch_impl: input.web_fetch_impl,
    now,
  });
  if (!fetched.ok) {
    warnings.push({
      code: "REFERENCE_EXPAND_FAILED",
      message: `网页引用 ${reference.ref} 读取失败：${fetched.error.message}`,
    });
    return {
      kind: "web_page",
      ref: reference.ref,
      ...(reference.label === undefined ? {} : { label: reference.label }),
      status: "failed",
      retrieved_at: format_local_iso(now()),
      error: fetched.error,
    };
  }
  if (fetched.needs_render) {
    warnings.push({
      code: "REFERENCE_NEEDS_RENDER",
      message:
        `网页引用 ${reference.ref} 是 JS 渲染页面，静态 HTML 里没有正文；` +
        "请用会话内的网页/浏览器工具读取全文后再归纳。",
    });
  }
  if (fetched.truncated) {
    warnings.push({
      code: "REFERENCE_TRUNCATED",
      message: `网页引用 ${reference.ref} 的响应超过 2 MB，已截断；如需全文请拆分来源页面。`,
    });
  }
  const capped = cap_reference_content(fetched.text, reference.ref, warnings);
  const title = fetched.title === "" ? reference.label : fetched.title;
  return {
    kind: "web_page",
    ref: reference.ref,
    ...(reference.label === undefined ? {} : { label: reference.label }),
    status: fetched.needs_render ? "needs_render" : "ok",
    ...(title === undefined || title === "" ? {} : { title }),
    content: capped.content,
    content_length: fetched.text.length,
    retrieved_at: fetched.retrieved_at,
    truncated: capped.truncated || fetched.truncated,
  };
}

function cap_reference_content(
  content: string,
  ref: string,
  warnings: FetchDocWarning[],
): { content: string; truncated: boolean } {
  if (content.length <= REFERENCE_CONTENT_LIMIT) {
    return { content, truncated: false };
  }
  warnings.push({
    code: "REFERENCE_TRUNCATED",
    message:
      `引用 ${ref} 的正文超过 ${REFERENCE_CONTENT_LIMIT} 字符，已截断；` +
      "如需全文请拆分来源文档。",
  });
  return { content: content.slice(0, REFERENCE_CONTENT_LIMIT), truncated: true };
}

function normalize_max_references(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MAX_REFERENCES_DEFAULT;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) {
    return 1;
  }
  return Math.min(rounded, 50);
}

function with_original_doc(
  failure_result: StepFailure,
  original: string,
): FetchKnowledgeADocFailure {
  return {
    ok: false,
    error: {
      ...failure_result.error,
      details: { ...(failure_result.error.details ?? {}), doc: original },
    },
  };
}

/** 兜底路径两级都失败：保留首次（按文档读）的错误码，把节点解析失败附在同一错误里。 */
function combine_failures(primary: StepFailure, fallback: StepFailure): StepFailure {
  return {
    ok: false,
    error: {
      ...primary.error,
      message: `${primary.error.message} 按节点解析也失败：${fallback.error.message}`,
      details: { ...(primary.error.details ?? {}), node_lookup_failed: true },
    },
  };
}

function failure(
  code: FetchKnowledgeADocErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FetchKnowledgeADocFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function business_failed(payload: unknown): boolean {
  return is_record(payload) && payload.ok === false;
}

function business_failure_message(
  command: string,
  payload: unknown,
  exit_code: number,
): string {
  if (is_record(payload)) {
    const error = payload.error;
    if (is_record(error) && typeof error.message === "string" && error.message.trim() !== "") {
      return `lark-cli ${command} 失败：${error.message}`;
    }
    if (typeof payload.message === "string" && payload.message.trim() !== "") {
      return `lark-cli ${command} 失败：${payload.message}`;
    }
  }
  return `lark-cli ${command} 失败（exit code ${exit_code}）。`;
}

function read_path(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!is_record(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function first_record(
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): Record<string, unknown> | undefined {
  for (const candidate_path of paths) {
    const candidate = read_path(value, candidate_path);
    if (is_record(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function optional_text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function has_text(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function truncate(text: string, limit = STDERR_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
