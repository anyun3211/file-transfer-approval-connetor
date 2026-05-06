'use strict';

const assert = require('assert');
const { DingTalkCrypto } = require('../src/utils/crypto');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('\n=== DingTalkCrypto 测试 ===\n');

// 使用固定的测试参数
const token = 'test_token_123';
const encodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const corpId = 'ding1234567890';

const crypto = new DingTalkCrypto(token, encodingAESKey, corpId);

test('加密后解密应得到原文', () => {
  const plainText = '这是一条测试消息';
  const encrypted = crypto.encrypt(plainText);
  const decrypted = crypto.decrypt(encrypted);
  assert.strictEqual(decrypted, plainText);
});

test('加密后解密 JSON 数据', () => {
  const jsonData = JSON.stringify({
    EventType: 'bpms_instance_change',
    processInstanceId: 'test-instance-001',
    type: 'finish',
    result: 'agree',
  });
  const encrypted = crypto.encrypt(jsonData);
  const decrypted = crypto.decrypt(encrypted);
  const parsed = JSON.parse(decrypted);
  assert.strictEqual(parsed.EventType, 'bpms_instance_change');
  assert.strictEqual(parsed.result, 'agree');
});

test('签名验证通过', () => {
  const timestamp = '1234567890';
  const nonce = 'testnonce';
  const encrypted = crypto.encrypt('success');
  const signature = crypto.getSignature(timestamp, nonce, encrypted);

  // 验签+解密应成功
  const decrypted = crypto.decryptAndVerify(signature, timestamp, nonce, encrypted);
  assert.strictEqual(decrypted, 'success');
});

test('签名验证失败应抛出异常', () => {
  const timestamp = '1234567890';
  const nonce = 'testnonce';
  const encrypted = crypto.encrypt('success');

  assert.throws(() => {
    crypto.decryptAndVerify('wrong_signature', timestamp, nonce, encrypted);
  }, /签名验证失败/);
});

test('encryptResponse 返回正确格式', () => {
  const resp = crypto.encryptResponse('success');
  assert.ok(resp.msg_signature, '应包含 msg_signature');
  assert.ok(resp.timeStamp, '应包含 timeStamp');
  assert.ok(resp.nonce, '应包含 nonce');
  assert.ok(resp.encrypt, '应包含 encrypt');

  // 验证加密内容可以解密回 success
  const decrypted = crypto.decrypt(resp.encrypt);
  assert.strictEqual(decrypted, 'success');
});

test('不同明文加密结果不同（随机填充）', () => {
  const text = 'same_text';
  const enc1 = crypto.encrypt(text);
  const enc2 = crypto.encrypt(text);
  // 由于随机前缀，两次加密结果应不同
  assert.notStrictEqual(enc1, enc2);
  // 但都能正确解密
  assert.strictEqual(crypto.decrypt(enc1), text);
  assert.strictEqual(crypto.decrypt(enc2), text);
});

console.log('\n=== EventBridge Handler 参数解析测试 ===\n');

// 模拟 eventBridge handler 中的解析逻辑
function parseEventData(requestBody) {
  if (requestBody.data && requestBody.data.body) {
    return typeof requestBody.data.body === 'string'
      ? JSON.parse(requestBody.data.body)
      : requestBody.data.body;
  } else if (requestBody.userName || requestBody.taskId) {
    return requestBody;
  } else if (requestBody.data) {
    return requestBody.data;
  }
  throw new Error('无法解析');
}

test('解析 CloudEvents ORIGINAL 格式', () => {
  const input = {
    data: {
      body: { userName: '张三', fileName: 'test.xlsx', filePath: '/data/test.xlsx', taskId: 'trt-001', regionId: 'cn-hangzhou' },
      httpMethod: 'POST',
    },
  };
  const result = parseEventData(input);
  assert.strictEqual(result.userName, '张三');
  assert.strictEqual(result.taskId, 'trt-001');
});

test('解析直接业务数据格式', () => {
  const input = { userName: '李四', fileName: 'doc.pdf', filePath: '/docs/doc.pdf', taskId: 'trt-002', regionId: 'cn-shanghai' };
  const result = parseEventData(input);
  assert.strictEqual(result.userName, '李四');
  assert.strictEqual(result.regionId, 'cn-shanghai');
});

test('解析 CloudEvents data 直接包含业务数据', () => {
  const input = {
    data: { userName: '王五', fileName: 'img.png', filePath: '/imgs/img.png', taskId: 'trt-003', regionId: 'cn-beijing' },
  };
  const result = parseEventData(input);
  assert.strictEqual(result.userName, '王五');
});

test('解析 body 为字符串的情况', () => {
  const input = {
    data: {
      body: JSON.stringify({ userName: '赵六', fileName: 'a.txt', filePath: '/a.txt', taskId: 'trt-004', regionId: 'cn-hangzhou' }),
    },
  };
  const result = parseEventData(input);
  assert.strictEqual(result.userName, '赵六');
});

// 汇总结果
console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
