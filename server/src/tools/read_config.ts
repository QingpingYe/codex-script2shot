import path from "node:path";
import {
  CONFIG_FILE_NAME,
  load_config,
  resolve_home,
  type ConfigWarning,
  type ProjectRoot,
  type RetrievalConfig,
  type Script2ShotConfig,
} from "../config.js";

/**
 * `read_config` MCP Tool（架构 §7.3、§8）。
 *
 * - 只读：只调用 `load_config()`，不创建目录、不写文件；配置不存在时返回
 *   `exists: false` 且不带 `config`。
 * - `base_b` 一律掩码：快照里只有 `base_b_prefix`（前 6 位加 `…`），完整 token
 *   只留在 config.toml，不经过对话、日志或返回值。
 * - 校验与 warning 复用 `load_config()` 的结果，不出现第二套规则。
 */

export const BASE_TOKEN_PREFIX_LENGTH = 6;

export interface ReadConfigSnapshot {
  lark: {
    cli_path?: string;
    profile?: string;
    space_a?: string;
    base_b_prefix?: string;
    knowledge_cards_table_id?: string;
    sync_state_table_id?: string;
    project_roots: ProjectRoot[];
  };
  retrieval: RetrievalConfig;
}

export type ReadConfigResult =
  | { exists: false; path: string; warnings: ConfigWarning[] }
  | {
      exists: true;
      path: string;
      config: ReadConfigSnapshot;
      warnings: ConfigWarning[];
    }
  | {
      ok: false;
      error: {
        code: "CONFIG_INVALID";
        message: string;
        details: { path: string; field?: string };
      };
    };

export function read_config(): ReadConfigResult {
  const loaded = load_config();
  const config_path = path.join(resolve_home(), CONFIG_FILE_NAME);
  if ("error" in loaded) {
    return loaded;
  }
  if (!loaded.exists) {
    return { exists: false, path: loaded.path, warnings: [] };
  }
  return {
    exists: true,
    path: config_path,
    config: to_snapshot(loaded.config),
    warnings: loaded.warnings,
  };
}

const PASSTHROUGH_LARK_KEYS = [
  "cli_path",
  "profile",
  "space_a",
  "knowledge_cards_table_id",
  "sync_state_table_id",
] as const;

/** 把磁盘配置转成只读快照：`base_b` 换成掩码前缀，其余已知字段原样返回。 */
function to_snapshot(config: Script2ShotConfig): ReadConfigSnapshot {
  const snapshot: ReadConfigSnapshot["lark"] = {
    project_roots: config.lark.project_roots.map((root) => ({ ...root })),
  };
  for (const key of PASSTHROUGH_LARK_KEYS) {
    const value = config.lark[key];
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  if (config.lark.base_b !== undefined) {
    snapshot.base_b_prefix = `${config.lark.base_b.slice(0, BASE_TOKEN_PREFIX_LENGTH)}…`;
  }
  return { lark: snapshot, retrieval: { default_top_k: config.retrieval.default_top_k } };
}
