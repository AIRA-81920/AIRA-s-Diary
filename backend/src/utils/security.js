// security.js — 公共安全工具（路径遍历防护 / UUID 白名单 / 密钥掩码）
// 功能：为全仓提供统一的路径拼接与输入校验原语，消除各控制器/服务中的重复防御代码
// 实现方式：
//   - safeJoin(base, ...segs)：path.resolve 后强制断言结果仍在 base 之下（防 ../ 与符号链接逃逸）
//   - UUID_RE / assertUuid(id)：灵感/文件夹/词块等实体的 id 一律为 UUID v4，格式不符直接拒绝
//   - isSafeUploadFilename(name)：上传文件名白名单（本服务生成的 UUID 文件名）
//   - maskSecret(v)：密钥掩码回显（sk-a9f9****c2a）
//   - isPrivateUrl(url)：SSRF 防护（禁止 http/私网 IP/localhost 字面量）

import path from 'path';

// UUID v4 格式白名单（大小写不敏感，允许无连字符变体一并拒绝——一律要求标准 36 位）
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 校验 id 是否为合法 UUID，不合法抛出 400 语义的异常
 * 功能：在所有以 req.params.id 拼文件路径 / SQL 的入口统一调用
 * @param {string} id - 待校验的实体 ID
 * @param {string} [name='id'] - 字段名（用于错误信息）
 * @throws {Error} status=400 的错误对象（由错误中间件统一转 JSON）
 */
export function assertUuid(id, name = 'id') {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    const err = new Error(`Invalid ${name}: must be a UUID`);
    err.status = 400;
    err.expose = true;
    throw err;
  }
}

/**
 * 安全路径拼接（防路径遍历）
 * 功能：拼接后断言结果仍位于 base 目录之内，否则抛 400
 *       范式照抄 inspirationController.getFileContent 已有的二次校验并推广到全部写路径
 * @param {string} base - 基础目录（绝对路径）
 * @param {...string} segs - 待拼接的路径段
 * @returns {string} 拼接后的绝对路径（保证位于 base 内）
 * @throws {Error} status=400
 */
export function safeJoin(base, ...segs) {
  const baseAbs = path.resolve(base);
  const abs = path.resolve(baseAbs, ...segs.map(String));
  if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) {
    const err = new Error('Path traversal blocked');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return abs;
}

// 本服务上传生成的文件名白名单：UUID + 受控图片/文本扩展名
// 功能：deleteAddendum / vision / distill 的文件读写入口统一校验，
//       杜绝 body 可控 filename（如 ../../../.env）造成的任意文件删除/读取外发
export const UPLOAD_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif|md|txt)$/i;

/**
 * 校验上传文件名是否为"本服务生成的 UUID 文件名"
 * @param {string} name - 文件名
 * @returns {boolean}
 */
export function isSafeUploadFilename(name) {
  return typeof name === 'string' && UPLOAD_FILENAME_RE.test(name);
}

/**
 * 密钥掩码
 * 功能：GET /settings/env 回显用，保留前 6 位 + 后 4 位，中间以 **** 代替
 *       短密钥（<=10 位）只保留尾 2 位；空值原样返回
 * @param {string} value - 原始密钥
 * @returns {string} 掩码后的值（含 **** 标记，前端据此识别"未修改"）
 */
export function maskSecret(value) {
  if (!value) return '';
  const v = String(value);
  if (v.length <= 6) return '****';
  if (v.length <= 10) return `${v.slice(0, 2)}****${v.slice(-2)}`;
  return `${v.slice(0, 6)}****${v.slice(-4)}`;
}

// 判断掩码值（前端不下发未修改的密钥）
export function isMasked(value) {
  return typeof value === 'string' && value.includes('****');
}

/**
 * SSRF 防护：校验 baseURL 是否安全
 * 功能：/settings/env/test 等"服务器代发请求"端点使用
 * 规则：
 *   1. 仅允许 https://（http 明文一律拒绝）
 *   2. 禁止 localhost / 127.0.0.0/8 / 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 / 169.254.0.0/16 / 0.0.0.0
 *   3. 禁止 file: 等其他协议
 * @param {string} baseURL - 待校验的基础地址
 * @returns {true | string} true 表示通过，字符串为拒绝原因
 */
export function checkBaseUrlSafe(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') return true; // 空值走默认官方端点，由调用方决定
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return '不是合法的 URL';
  }
  if (url.protocol !== 'https:') {
    return '仅允许 https:// 地址（明文 http 与自定义协议已被禁止）';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') {
    return '禁止访问 localhost / 回环地址';
  }
  // 私网 IPv4 段
  if (/^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^0\./.test(host)) {
    return '禁止访问内网 / 链路本地地址';
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return '禁止访问内网地址';
  }
  // IPv6 私网/本地段
  if (host === 'fc00::' || host.startsWith('fc') || host.startsWith('fd') ||
      host.startsWith('fe80')) {
    return '禁止访问内网地址';
  }
  return true;
}
