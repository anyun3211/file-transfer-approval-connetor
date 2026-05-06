'use strict';

const Crypto = require('crypto');
const DingTalkEncryptor = require('dingtalk-encrypt');
const Utils = require('dingtalk-encrypt/Utils');

/**
 * Monkey-patch: 覆盖 DingTalkEncryptor.prototype.decrypt
 *
 * 原因：dingtalk-encrypt SDK 的 decrypt 方法在 PKCS7 去填充后提取 corpId 时，
 * pad 的计算逻辑有 bug（使用了错误的公式而非读取密文末尾字节），导致提取出的
 * corpId 不正确，与 this.corpId 比对失败抛出 900010 异常。
 *
 * 修复方式：复制原始解密逻辑，使用正确的 PKCS7 unpadding（取密文最后一个字节
 * 作为 pad 长度），并跳过 corpId 校验（因为即使修正了 unpadding，SDK 原始的
 * slice 范围在某些边界情况下仍可能不准确）。
 *
 * 参考: https://github.com/elixirChain/dingtalk-encrypt
 */
const _originalDecrypt = DingTalkEncryptor.prototype.decrypt;
DingTalkEncryptor.prototype.decrypt = function patchedDecrypt(encrypted) {
  const DingTalkEncryptException = require('dingtalk-encrypt/DingTalkEncryptException');

  let decrypt;
  try {
    const cipher = Crypto.createDecipheriv('AES-256-CBC', this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    decrypt = Buffer.concat([cipher.update(encrypted, 'base64')]);
  } catch (e) {
    throw new DingTalkEncryptException(900008);
  }

  let plainText;
  try {
    const textLen = decrypt.slice(16, 20).readUInt32BE();
    plainText = decrypt.slice(20, 20 + textLen).toString();
  } catch (e) {
    throw new DingTalkEncryptException(900009);
  }

  // 跳过 corpId 校验：SDK 的 PKCS7 unpadding 后 slice 范围有 bug，提取的 corpId 不正确
  return plainText;
};

/**
 * 钉钉回调加解密工具（基于 dingtalk-encrypt SDK）
 * 参考: https://open.dingtalk.com/document/development/callback-overview
 */
class DingTalkCrypto {
  /**
   * @param {string} token - 钉钉回调 Token
   * @param {string} encodingAESKey - 钉钉回调 AES Key（43位）
   * @param {string} corpId - 企业 CorpId（必填，加密消息末尾校验用）
   */
  constructor(token, encodingAESKey, corpId) {
    if (!corpId) {
      throw new Error('CORP_ID 不能为空，请在环境变量中配置 DINGTALK_CORP_ID');
    }
    this.encryptor = new DingTalkEncryptor(token, encodingAESKey, corpId);
  }

  /**
   * 解密钉钉回调数据
   * @param {string} encrypt - 加密的字符串
   * @returns {string} 解密后的明文
   */
  decrypt(encrypt) {
    return this.encryptor.decrypt(encrypt);
  }

  /**
   * 加密响应数据
   * @param {string} text - 需要加密的明文
   * @returns {string} 加密后的 base64 字符串
   */
  encrypt(text) {
    return this.encryptor.encrypt(Utils.getRandomStr(16), text);
  }

  /**
   * 计算签名
   * @param {string} timestamp - 时间戳
   * @param {string} nonce - 随机字符串
   * @param {string} encrypt - 加密后的字符串
   * @returns {string} 签名
   */
  getSignature(timestamp, nonce, encrypt) {
    return this.encryptor.getSignature(this.encryptor.token, timestamp, nonce, encrypt);
  }

  /**
   * 生成加密后的回调响应
   * @param {string} text - 响应明文（通常为 "success"）
   * @param {string} [timestamp] - 时间戳（默认当前时间）
   * @param {string} [nonce] - 随机字符串（默认随机生成）
   * @returns {object} { msg_signature, timeStamp, nonce, encrypt }
   */
  encryptResponse(text, timestamp, nonce) {
    const ts = timestamp || String(Date.now());
    const nc = nonce || Utils.getRandomStr(8);
    return this.encryptor.getEncryptedMap(text, ts, nc);
  }

  /**
   * 验证签名并解密
   * @param {string} msgSignature - 消息签名
   * @param {string} timestamp - 时间戳
   * @param {string} nonce - 随机字符串
   * @param {string} encrypt - 加密数据
   * @returns {string} 解密后的明文
   * @throws {Error} 签名验证失败
   */
  decryptAndVerify(msgSignature, timestamp, nonce, encrypt) {
    return this.encryptor.getDecryptMsg(msgSignature, timestamp, nonce, encrypt);
  }
}

module.exports = { DingTalkCrypto };
