/**
 * 评估体系：任务集定义。
 *
 * 两套任务集：
 *   · EVAL_TASKS_MOCK —— 离线验证（本地 mock server，确定性输出，可进 CI）
 *   · EVAL_TASKS_REAL —— 真实 API（用 omni.json 配置的模型跑通用任务）
 *
 * 断言：expect 全部命中（stdout 子串）才算通过；notExpect 任一出现即失败。
 */
export interface EvalTask {
  name: string;
  prompt: string;
  /** 通过条件：stdout 必须包含的全部子串 */
  expect: string[];
  /** 失败条件：stdout 不得包含的任意子串 */
  notExpect?: string[];
  /** 单任务超时（毫秒，默认 120s） */
  timeoutMs?: number;
}

/** 离线 mock 任务：验证主循环端到端（工具调用 + 结果回传 + 最终回答） */
export const EVAL_TASKS_MOCK: EvalTask[] = [
  {
    name: '端到端工具调用',
    prompt: '执行一个命令验证运行环境',
    expect: ['mock-ok', '任务完成'],
  },
  {
    name: '流式回答',
    prompt: '告诉我你完成了什么',
    expect: ['mock 端到端验证'],
  },
];

/** 真实 API 任务：覆盖工具调用 / 文件读取 / 目录探索三条主链路 */
export const EVAL_TASKS_REAL: EvalTask[] = [
  {
    name: '运行命令',
    prompt: '运行 echo hello-omni 命令，并把输出告诉我',
    expect: ['hello-omni'],
    timeoutMs: 180_000,
  },
  {
    name: '目录探索',
    prompt: '列出当前目录下的文件（用 ls 命令）',
    expect: ['退出码: 0'],
    timeoutMs: 180_000,
  },
  {
    name: '文件读取',
    prompt: '读取 package.json 并告诉我它的 name 字段',
    expect: ['omni'],
    timeoutMs: 180_000,
  },
  {
    name: '当前路径',
    prompt: '告诉我当前工作目录的绝对路径',
    expect: ['omni'],
    timeoutMs: 180_000,
  },
];
