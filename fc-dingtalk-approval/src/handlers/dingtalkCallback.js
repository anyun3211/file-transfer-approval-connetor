'use strict';

const { DingTalkCrypto } = require('../utils/crypto');
const storage = require('../services/storage');
const aliyunEcd = require('../services/aliyunEcd');

const CALLBACK_TOKEN = process.env.DINGTALK_CALLBACK_TOKEN;
const CALLBACK_AES_KEY = process.env.DINGTALK_CALLBACK_AES_KEY;
const CORP_ID = process.env.DINGTALK_CORP_ID;

// 已处理的审批实例ID集合（简易幂等，实例级别有效）
const processedInstances = new Set();

/**
 * 处理钉钉审批回调
 *
 * 钉钉回调 POST body 格式（加密后）:
 * { "encrypt": "..." }
 *
 * URL query 参数:
 * signature, timestamp, nonce
 *
 * 解密后业务数据:
 * {
 *   "EventType": "bpms_instance_change",
 *   "processInstanceId": "xxxx",
 *   "type": "finish",           // start | finish | terminate
 *   "result": "agree",          // agree | refuse（finish时有值）
 *   "processCode": "PROC-xxx",
 *   "title": "xxx",
 *   "staffId": "xxx"
 * }
 */
async function handleDingtalkCallback(query, requestBody) {
  console.log(`[DingTalkCallback] CORP_ID: ${CORP_ID} 收到回调, query=${JSON.stringify(query)}, body=${JSON.stringify(requestBody)}`);

  const crypto = new DingTalkCrypto(CALLBACK_TOKEN, CALLBACK_AES_KEY, CORP_ID);

  const { signature, timestamp, nonce } = query;
  const { encrypt } = requestBody;

  if (!encrypt) {
    throw new Error('回调数据缺少 encrypt 字段');
  }

  // 验签并解密
  const plainText = crypto.decryptAndVerify(signature, timestamp, nonce, encrypt);
  console.log(`[DingTalkCallback] 解密后数据: ${plainText}`);

  // 解析业务事件
  let eventData;
  try {
    eventData = JSON.parse(plainText);
  } catch (err) {
    console.error('[DingTalkCallback] 解析事件数据失败:', plainText, err.message);
    const successResponse = crypto.encryptResponse('success');
    return { response: successResponse };
  }

  console.log(`[DingTalkCallback] eventData类型: ${typeof eventData}, eventData=${JSON.stringify(eventData)}`);
  const { EventType, processInstanceId, type, result } = eventData;
  console.log(`[DingTalkCallback] 事件: EventType=${EventType}, instanceId=${processInstanceId}, type=${type}, result=${result}`);
  console.log(`[DingTalkCallback] EventType类型: ${typeof EventType}, 值: "${EventType}", 是否等于check_url: ${EventType === 'check_url'}`);

  if (EventType === 'check_url') {
    // 验证回调URL：必须返回加密后的原始明文（钉钉会校验解密后是否一致）
    console.log('[DingTalkCallback] 验证回调URL请求，返回原始明文加密响应');
    const checkResponse = crypto.encryptResponse("success");
    console.log(`[DingTalkCallback] check_url 响应: ${JSON.stringify(checkResponse)}`);
    return { response: checkResponse };
  }

  // 普通事件：返回加密的 "success"
  const successResponse = crypto.encryptResponse('success');
  console.log(`[DingTalkCallback] 构造响应: ${JSON.stringify(successResponse)}`);

  // 只处理审批实例结束事件
  if (EventType === 'bpms_task_change' && type === 'finish') {
    // 幂等检查
    console.log(`[DingTalkCallback] 处理审批结束事件 : ${processInstanceId}`);
    if (processedInstances.has(processInstanceId)) {
      console.log(`[DingTalkCallback] 重复事件，跳过: ${processInstanceId}`);
      return { response: successResponse };
    }
    processedInstances.add(processInstanceId);

    // 同步等待审批结果处理完成，避免 FC 运行时提前销毁上下文
    try {
      await processApprovalResult(processInstanceId, result);
    } catch (err) {
      console.error(`[DingTalkCallback] 处理审批结果失败: instanceId=${processInstanceId}, error=${err.message}`, err.stack);
      processedInstances.delete(processInstanceId);
    }
  }

  return { response: successResponse };
}

/**
 * 处理审批结果：查询映射 → 调用阿里云API
 */
async function processApprovalResult(processInstanceId, approvalResult) {
  // 1. 从 OSS 读取映射关系
  console.log(`[ProcessApproval] [${processInstanceId}] 开始读取 OSS 映射...`);
  const mapping = await storage.getMapping(processInstanceId);
  console.log(`[ProcessApproval] [${processInstanceId}] OSS 映射读取完成: mapping=${JSON.stringify(mapping)}`);
  if (!mapping) {
    console.error(`[ProcessApproval] [${processInstanceId}] 未找到审批映射，终止处理`);
    return;
  }

  // 2. 转换审批结果: agree → Approved, refuse → Rejected
  const result = approvalResult === 'agree' ? 'Approved' : 'Rejected';
  console.log(`[ProcessApproval] [${processInstanceId}] 审批结果转换: ${approvalResult} → ${result}`);

  // 3. 调用阿里云 OpenAPI 提交审批结果
  console.log(`[ProcessApproval] [${processInstanceId}] 开始调用 OpenAPI, taskId=${mapping.taskId}, result=${result}`);
  await aliyunEcd.transferTaskApprovalCallback({
    regionId: mapping.regionId,
    taskId: mapping.taskId,
    result: result,
    ossBucketRegionId: mapping.ossBucketRegionId,
    ossBucketName: mapping.ossBucketName,
  });
  console.log(`[ProcessApproval] [${processInstanceId}] OpenAPI 调用完成`);

  // 4. 清理 OSS 映射数据
  console.log(`[ProcessApproval] [${processInstanceId}] 开始清理 OSS 映射...`);
  await storage.deleteMapping(processInstanceId);
  console.log(`[ProcessApproval] [${processInstanceId}] OSS 映射清理完成`);

  console.log(`[ProcessApproval] [${processInstanceId}] 审批结果处理全部完成: taskId=${mapping.taskId}, result=${result}`);
}

module.exports = { handleDingtalkCallback };
