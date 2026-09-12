#!/usr/bin/env node
/**
 * Mock LSP 服务器（测试用）：手写 Content-Length 帧 + JSON-RPC。
 * 支持 initialize / initialized / textDocument/{definition,hover,documentSymbol} / shutdown。
 */
'use strict';

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    const len = m ? Number(m[1]) : 0;
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.id == null) continue; // notification
    const send = (result) => {
      const json = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    };
    switch (msg.method) {
      case 'initialize':
        send({ capabilities: { definitionProvider: true, hoverProvider: true, documentSymbolProvider: true }, serverInfo: { name: 'mock-lsp' } });
        break;
      case 'textDocument/definition':
        send([{ uri: 'file:///mock/def.ts', range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } } }]);
        break;
      case 'textDocument/hover':
        send({ contents: { kind: 'markdown', value: '**x**: `number`' } });
        break;
      case 'textDocument/documentSymbol':
        send([
          { name: 'x', kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } } },
          { name: 'Foo', kind: 5, range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } }, children: [{ name: 'bar', kind: 6 }] },
        ]);
        break;
      case 'shutdown':
        send(null);
        break;
      default:
        send(null);
    }
  }
});
