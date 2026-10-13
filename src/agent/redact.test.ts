/**
 * 密钥脱敏单元测试：常见密钥形状（sk-*、Bearer、AWS、GitHub、私钥块、
 * KEY=value 字段）与递归深度脱敏；并验证开关语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactDeep, redactText, secretRedactionEnabled, setSecretRedaction } from './redact.js';

test('redactText：sk- 形状密钥替换', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz';
  assert.equal(redactText(`my key is ${key}`), `my key is ${REDACTED}`);
});

test('redactText：Bearer token 保留前缀', () => {
  assert.equal(
    redactText('Authorization: Bearer abcdefghijklmnop1234'),
    `Authorization: Bearer ${REDACTED}`
  );
  // 过短的 token 不误伤
  assert.equal(redactText('Bearer short'), 'Bearer short');
});

test('redactText：AWS access key id', () => {
  assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), REDACTED);
});

test('redactText：GitHub / GitLab token', () => {
  assert.equal(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'), REDACTED);
  assert.equal(redactText('glpat-abcdefghijklmnop1234'), REDACTED);
});

test('redactText：私钥块整块替换', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----';
  const out = redactText(pem);
  assert.ok(!out.includes('MIIsecret'));
  assert.ok(out.includes('BEGIN PRIVATE KEY'));
  assert.ok(out.includes(REDACTED));
});

test('redactText：KEY/TOKEN/SECRET 字段值替换（须含字母与数字）', () => {
  assert.equal(redactText('API_KEY=abc12345'), `API_KEY=${REDACTED}`);
  assert.equal(redactText('TOKEN="xy12zw34"'), `TOKEN="${REDACTED}"`);
  // 纯字母值不误伤
  assert.equal(redactText('TOKEN=abcdefghij'), 'TOKEN=abcdefghij');
  // 非密钥名不处理
  assert.equal(redactText('SOME_VAR=abc12345'), 'SOME_VAR=abc12345');
});

test('redactText：普通代码/文本不受影响', () => {
  const code = 'const msg = "hello world"; // nothing secret here';
  assert.equal(redactText(code), code);
  assert.equal(redactText(''), '');
});

test('redactDeep：递归处理对象/数组字符串', () => {
  const input = {
    content: [{ type: 'text', text: 'token sk-abcdefghijklmnopqrstuvwxyz' }],
    note: 'safe',
  };
  const out = redactDeep(input);
  assert.equal(out.content[0].text, `token ${REDACTED}`);
  assert.equal(out.note, 'safe');
  // 非字符串值原样
  assert.equal(redactDeep({ n: 42, b: true, nil: null }).n, 42);
});

test('redactDeep：密钥名字段整值替换（含裸随机串）', () => {
  const out = redactDeep({ client_secret: 'nothing-secret-shaped', password: 'hunter2', username: 'alice' });
  assert.equal(out.client_secret, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.username, 'alice');
});

test('redactText/redactDeep：开关关闭时原样返回', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz';
  assert.equal(secretRedactionEnabled(), true);
  setSecretRedaction(false);
  try {
    assert.equal(secretRedactionEnabled(), false);
    assert.equal(redactText(key), key);
    assert.equal(redactDeep({ client_secret: 'x' }).client_secret, 'x');
  } finally {
    setSecretRedaction(true);
  }
  assert.equal(secretRedactionEnabled(), true);
  assert.equal(redactText(key), REDACTED);
});