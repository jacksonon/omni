import assert from 'node:assert/strict';
import test from 'node:test';
import { secureEqual, startBroker } from './broker.js';

test('共享服务认证使用等长常量时间比较', () => {
  assert.equal(secureEqual('same', 'same'), true);
  assert.equal(secureEqual('same', 'diff'), false);
  assert.equal(secureEqual('same', ''), false);
});

test('broker 身份探测需要认证且不暴露服务凭据，跨站写请求被拒绝', async () => {
  const token = 'test-only-broker-token-01234567890123456789';
  const broker = await startBroker({ port: 0, token, record: false });
  const base = `http://127.0.0.1:${broker.port}`;
  try {
    assert.equal((await fetch(`${base}/_omni/health`)).status, 401);
    assert.equal((await fetch(`${base}/_omni/health`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const response = await fetch(`${base}/_omni/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assert.equal(health.product, 'omni-shared-server');
    assert.equal(health.protocol, 1);
    assert.equal(health.token, undefined);
    assert.equal(health.providers, undefined);
    assert.equal((await fetch(`${base}/_omni/workspaces`, { headers: { cookie: `omni_broker=${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/_omni/workspaces`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, origin: 'https://attacker.invalid', 'content-type': 'application/json',
    }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/_omni/connect?ticket=invalid`)).status, 401);
  } finally { await broker.close(true); }
});
