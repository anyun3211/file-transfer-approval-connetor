'use strict';

const OSS = require('ali-oss');

const BUCKET = process.env.OSS_BUCKET;
const REGION = process.env.OSS_REGION || 'oss-cn-shanghai';
const PREFIX = process.env.OSS_PREFIX || 'approval-mappings';

let ossClient = null;

function getOSSClient() {
  console.log(`[Storage] 获取 OSS 客户端 REGION ${REGION} BUCKET: ${BUCKET}`);
  if (!ossClient) {
    // 在 FC 中优先使用角色授权（通过 context.credentials），这里 fallback 到环境变量
    ossClient = new OSS({
      region: REGION,
      bucket: BUCKET,
      accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      stsToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN
    });
  }
  console.log(`[Storage] 获取 OSS 客户端 ossClient ${ossClient}`);
  return ossClient;
}

/**
 * 保存审批映射关系
 * @param {string} processInstanceId - 钉钉审批实例ID
 * @param {object} data - 映射数据
 */
async function saveMapping(processInstanceId, data) {
  const client = getOSSClient();
  const key = `${PREFIX}/${processInstanceId}.json`;
  const content = JSON.stringify({
    ...data,
    processInstanceId,
    createdAt: new Date().toISOString(),
  });
  await client.put(key, Buffer.from(content, 'utf8'));
  console.log(`[Storage] 保存映射: ${key}`);
}

/**
 * 查询审批映射关系
 * @param {string} processInstanceId - 钉钉审批实例ID
 * @returns {object|null} 映射数据
 */
async function getMapping(processInstanceId) {
  const client = getOSSClient();
  const key = `${PREFIX}/${processInstanceId}.json`;
  try {
    console.log(`[Storage] 读取映射: ${key}`);
    const result = await client.get(key);
    console.log(`[Storage] 读取映射: ${result}`);
    const data = JSON.parse(result.content.toString('utf8'));
    console.log(`[Storage] 读取映射: ${key} data: ${data}`);
    return data;
  } catch (err) {
    console.warn(`[Storage] 读取映射失败: ${key}`, err.message);
    if (err.code === 'NoSuchKey') {
      console.warn(`[Storage] 映射不存在: ${key}`);
      return null;
    }
    throw err;
  }
}

/**
 * 删除审批映射关系（审批完成后清理）
 * @param {string} processInstanceId - 钉钉审批实例ID
 */
async function deleteMapping(processInstanceId) {
  const client = getOSSClient();
  const key = `${PREFIX}/${processInstanceId}.json`;
  try {
    await client.delete(key);
    console.log(`[Storage] 删除映射: ${key}`);
  } catch (err) {
    console.warn(`[Storage] 删除映射失败: ${key}`, err.message);
  }
}

/**
 * 使用 FC context 中的临时凭证重新初始化 OSS 客户端
 * @param {object} credentials - FC context.credentials
 */
function refreshCredentials(credentials) {
  if (credentials) {
    ossClient = new OSS({
      region: REGION,
      bucket: BUCKET,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      stsToken: credentials.securityToken,
    });
  }
}

/**
 * 保存错误日志到 OSS
 * @param {string} taskId - 传输任务ID
 * @param {string} reason - 错误原因
 * @param {object} eventData - 原始事件数据
 */
async function saveErrorLog(taskId, reason, eventData) {
  const client = getOSSClient();
  const date = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  const key = `${PREFIX}/error-logs/${date}/${taskId}_${timestamp}.json`;
  const content = JSON.stringify({
    taskId,
    reason,
    eventData,
    createdAt: new Date().toISOString(),
  }, null, 2);
  await client.put(key, Buffer.from(content, 'utf8'));
  console.log(`[Storage] 错误日志已保存: ${key}`);
}

module.exports = { saveMapping, getMapping, deleteMapping, refreshCredentials, saveErrorLog };
