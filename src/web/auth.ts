/**
 * Web 账号密码认证（局域网直连 / 远程隧道 / 小程序共用）。
 *
 * 设计取舍：
 *   · 口令用 scrypt(N=16384, r=8, p=1) + 随机盐哈希后存全局配置，不存明文；
 *   · 会话用 **HMAC 签名令牌**（无服务端状态）：重启后仍有效，改密码/轮换 secret
 *     即刻吊销全部旧会话——个人工具不需要设备级会话表；
 *   · 登录失败按来源 IP 限流（5 次后指数退避，封顶 15 分钟），防局域网内爆破；
 *   · 令牌同时可作为 `Authorization: Bearer` 使用——微信小程序等无法可靠保存
 *     Cookie 的客户端直接存返回的 token。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { WebAuthConfig } from '../config/index.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const DEFAULT_SESSION_DAYS = 30;

/** 生成口令哈希（写配置用） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** 校验口令；格式非法/版本不符一律 false（不抛错） */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // 防恶意配置把内存打爆：只接受与当前实现同量级的参数
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, KEY_LEN, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 生成 32 字节随机密钥（auth set 用） */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 常量时间字符串比较（用户名等） */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface SessionTokenPayload {
  /** 用户名 */
  u: string;
  /** 签发时间（ms） */
  iat: number;
  /** 过期时间（ms） */
  exp: number;
  /** 会话 id（登出撤销用） */
  jti?: string;
}

/** 会话令牌服务（HMAC 签名，无状态） */
export class WebAuth {
  private readonly username: string;
  private readonly passwordHash: string;
  private readonly secret: string;
  /** 已登出的会话 id → 过期时间（内存撤销表；进程重启后清空，令牌本身仍有效） */
  private readonly revoked = new Map<string, number>();
  readonly sessionDays: number;

  constructor(cfg: WebAuthConfig) {
    this.username = cfg.username;
    this.passwordHash = cfg.passwordHash;
    // 未配置 secret（手写配置）时从口令哈希派生——仍然高熵，且改密码即失效
    this.secret = cfg.secret?.trim() || createHmac('sha256', cfg.passwordHash).update('omni-web-session').digest('base64url');
    this.sessionDays = Math.max(1, Math.min(365, Math.floor(cfg.sessionDays ?? DEFAULT_SESSION_DAYS)));
  }

  /** 用户名 + 口令校验（无论用户名对错都跑一次 scrypt，避免时序泄露账号） */
  verifyCredentials(username: string, password: string): boolean {
    const pwOk = verifyPassword(password, this.passwordHash);
    const userOk = safeEqual(username, this.username);
    return pwOk && userOk;
  }

  get user(): string {
    return this.username;
  }

  /** 签发会话令牌 */
  issue(): { token: string; expiresAt: number } {
    const now = Date.now();
    const exp = now + this.sessionDays * 86_400_000;
    const payload: SessionTokenPayload = {
      u: this.username,
      iat: now,
      exp,
      jti: randomBytes(9).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = this.sign(body);
    return { token: `omni1.${body}.${sig}`, expiresAt: exp };
  }

  /** 校验令牌（签名 + 过期 + 用户名） */
  verifyToken(token: string | undefined | null): boolean {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'omni1') return false;
    const [, body, sig] = parts;
    const expected = this.sign(body!);
    const a = Buffer.from(sig!);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as SessionTokenPayload;
      if (payload.u !== this.username || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return false;
      if (payload.jti && this.revoked.has(payload.jti)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** 撤销单个会话（登出）；仅接受签名有效的令牌 */
  revoke(token: string | undefined | null): void {
    if (!token) return;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'omni1') return;
    const expected = this.sign(parts[1]!);
    const a = Buffer.from(parts[2]!);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as SessionTokenPayload;
      if (payload.jti) {
        this.revoked.set(payload.jti, payload.exp);
        // 顺手清理已过期条目（单用户场景规模很小）
        const now = Date.now();
        for (const [id, exp] of this.revoked) if (exp <= now) this.revoked.delete(id);
      }
    } catch {
      // 忽略坏令牌
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

/* ---------------- 登录限流 ---------------- */

interface Attempt {
  fails: number;
  lockedUntil: number;
  lastAt: number;
}

/** 按来源 IP 的登录失败限流（内存态；进程重启清零） */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempt>();
  private readonly windowMs = 15 * 60_000;

  /** 返回剩余锁定秒数；0 = 可尝试 */
  lockedFor(key: string): number {
    const a = this.attempts.get(key);
    if (!a) return 0;
    const now = Date.now();
    if (now - a.lastAt > this.windowMs) {
      this.attempts.delete(key);
      return 0;
    }
    return a.lockedUntil > now ? Math.ceil((a.lockedUntil - now) / 1000) : 0;
  }

  /** 记录一次失败；第 5 次起锁定 60s，此后每次翻倍（封顶 15 分钟） */
  fail(key: string): number {
    const now = Date.now();
    const a = this.attempts.get(key) ?? { fails: 0, lockedUntil: 0, lastAt: now };
    a.fails += 1;
    a.lastAt = now;
    if (a.fails >= 5) {
      const lockMs = Math.min(15 * 60_000, 60_000 * 2 ** (a.fails - 5));
      a.lockedUntil = now + lockMs;
    }
    this.attempts.set(key, a);
    return a.lockedUntil > now ? Math.ceil((a.lockedUntil - now) / 1000) : 0;
  }

  /** 成功登录：清零该来源 */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** 清理过期记录（每次登录时顺手调用，避免 Map 无限增长） */
  prune(): void {
    const now = Date.now();
    for (const [k, a] of this.attempts) {
      if (now - a.lastAt > this.windowMs && a.lockedUntil <= now) this.attempts.delete(k);
    }
  }
}

/* ---------------- 一次性配对码 ---------------- */

// 去掉易混淆字符（0/O、1/I），8 位 ≈ 40 bit，配合限流足够防爆破
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成一次性配对码（展示形如 ABCD-EFGH） */
export function generatePairCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += PAIR_ALPHABET[bytes[i]! % PAIR_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 归一化用户输入（忽略大小写、空格、连字符） */
export function normalizePairCode(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
