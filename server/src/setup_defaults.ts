/**
 * 插件默认配置（架构 §7.3「默认知识库」）。
 *
 * 这里是默认值的唯一来源：`write_config` 与 setup Skill 的说明都引用本模块，
 * `config.ts` 的缺省回填也从这里取值，不各自硬编码；本模块保持零依赖。
 * 默认原始库与 AI 库可被用户替换；`project_roots` 给出根节点到项目 ID 的默认映射。
 */

export interface SetupDefaults {
  lark: {
    profile: string;
    space_a: string;
    base_b: string;
    project_roots: Array<{ node_token: string; project_id: string }>;
  };
  retrieval: {
    default_top_k: number;
  };
}

export const SETUP_DEFAULTS: SetupDefaults = {
  lark: {
    profile: "cli_aa20f40faa785d11",
    space_a: "7695983197091302359",
    base_b: "WRrVblDbqaEFOSs39P0cFzilnfd",
    project_roots: [
      { node_token: "Ou9Vw0emviJajPklYjQc4fqjnie", project_id: "wufu-linmen" },
    ],
  },
  retrieval: {
    default_top_k: 12,
  },
};
