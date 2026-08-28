/**
 * Markstream 浏览器打包入口（web/vendor-entry.mjs → web/vendor.js，由 bun 构建）。
 *
 * 只引入框架无关的 markstream 家族包：
 *   · stream-markdown-parser —— 流式 Markdown 解析器（markdown-it 系，产出流式友好 AST）
 *   · markstream-core       —— 平滑流式控制器（打字机节拍）
 *
 * 打包结果暴露 window.__markstream 给 web/markdown-renderer.js 使用；
 * web 前端（app.js）不直接依赖本入口，只依赖 markdown-renderer.js 的稳定接口——
 * 将来换其它 markdown 引擎只改 markdown-renderer.js 与这个入口。
 */
import { getMarkdown, parseMarkdownToStructure } from 'stream-markdown-parser';
import { createSmoothMarkdownStream } from 'markstream-core';

globalThis.__markstream = {
  getMarkdown,
  parseMarkdownToStructure,
  createSmoothMarkdownStream,
};
