import { ensureSharedServer, probeSharedServer } from './manager.js';
import { readServerRecord } from './discovery.js';

export async function runServerCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1];
  };
  if (sub === '_worker') {
    const { runWeb } = await import('../web/index.js');
    const overrides = JSON.parse(process.env.OMNI_WORKER_OVERRIDES || '{}');
    await runWeb(['--internal-worker', '--no-open', '--port', value('--port') ?? '0'], overrides);
    return 0;
  }
  if (sub === '_run') {
    const { startBroker } = await import('./broker.js');
    const port = Number(value('--port') ?? 3080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('服务端口无效');
    const broker = await startBroker({ port });
    const stop = (): void => { void broker.close(true); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await new Promise<void>((resolve) => broker.server.once('close', resolve));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    return 0;
  }
  if (sub === 'ensure' || sub === 'start') {
    const connection = await ensureSharedServer({ cwd: value('--cwd'), port: value('--port') ? Number(value('--port')) : undefined });
    if (args.includes('--json')) console.log(JSON.stringify(connection));
    else console.log(`Omni Server 已就绪：${connection.url}\n浏览器登录：${connection.browserUrl}`);
    return 0;
  }
  if (sub === 'status') {
    const record = await probeSharedServer(readServerRecord());
    const status = record ? { running: true, pid: record.pid, port: record.port, version: record.version } : { running: false };
    if (args.includes('--json')) console.log(JSON.stringify(status));
    else console.log(record ? `Omni Server running · pid ${record.pid} · http://127.0.0.1:${record.port} · v${record.version}` : 'Omni Server stopped');
    return 0;
  }
  if (sub === 'stop') {
    const record = await probeSharedServer(readServerRecord());
    if (!record) { console.log('Omni Server stopped'); return 0; }
    const r = await fetch(`http://127.0.0.1:${record.port}/_omni/shutdown`, { method: 'POST',
      headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ force: args.includes('--force') }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) { console.error((await r.json() as { error?: string }).error ?? '停止服务失败'); return 1; }
    console.log('Omni Server stopped'); return 0;
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log('omni server start|status|stop [--force]\nomni server ensure --json [--cwd <目录>] [--port <端口>]\n共享 server 独立于客户端存活；有运行中任务时 stop 拒绝，--force 取消并停止。');
    return 0;
  }
  console.error(`未知 server 子命令：${sub}`); return 1;
}
