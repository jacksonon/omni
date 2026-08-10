/**
 * 工具层：Coding Agent 的"手"。
 *
 * 每个工具由两部分组成：
 * 1. `parameters`：JSON Schema，写给模型看的"说明书"（参数类型、必填项、描述）；
 * 2. `execute`：真正的执行逻辑，由我们自己的代码实现。
 *
 * 心智模型：模型不执行任何东西，它只输出"我要调用工具 X，参数是 Y"的 JSON，
 * 解析与执行都是这里的代码干的，执行结果再以 role=tool 喂回给模型。
 */
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { listDirectoryTool } from './list-directory.js';
import { searchCodeTool } from './search-code.js';
import { runCommandTool } from './run-command.js';
import type { Tool } from './types.js';

export type { Tool } from './types.js';
export { TOOL_OUTPUT_LIMIT, truncate } from './util.js';

/** 工具注册表：新增工具时在这里登记，并同步更新 AGENTS.md */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchCodeTool,
  runCommandTool,
];
