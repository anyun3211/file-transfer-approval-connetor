'use strict';

const dingtalk = require('../services/dingtalk');
const storage = require('../services/storage');
const aliyunUser = require('../services/aliyunUser');

/**
 * 处理 EventBridge 推送的事件，发起钉钉审批流
 *
 * EventBridge CloudEvents 格式 data 字段:
 * {
 *   "headers": {...},
 *   "path": "/event-bridge",
 *   "body": { "userName", "fileName", "filePath", "taskId", "regionId", ... },
 *   "httpMethod": "POST",
 *   "queryString": {}
 * }
 *
 * 也支持直接 HTTP POST JSON body（EventBridge 使用 TEMPLATE/JSONPATH 转换后）
 */
async function handleEventBridge(requestBody) {
  // 兼容两种格式：CloudEvents 完整格式 和 直接业务数据
  let eventData = requestBody.data;
  console.log(`[EventBridge] 收到文件传输审批事件: eventData=${JSON.stringify(eventData)}`);

  // 字段名映射：适配 EventBridge 实际投递的字段名（如 endUserId → userName）
  const userName = eventData.userName || eventData.endUserId;
  const fileName = eventData.fileName;
  const filePath = eventData.filePath || eventData.sourcePath || eventData.targetPath;
  const taskId = eventData.taskId;
  const regionId = eventData.regionId;
  const taskType = eventData.taskType;

  const missing = [];
  if (!userName) missing.push('userName/endUserId');
  if (!fileName) missing.push('fileName');
  if (!filePath) missing.push('filePath/sourcePath/targetPath');
  if (!taskId) missing.push('taskId');
  if (!regionId) missing.push('regionId');
  if (!taskType) missing.push('taskType');

  if (missing.length > 0) {
    throw new Error(`缺少必填字段: ${missing.join(', ')}`);
  }

  console.log(`[EventBridge] 收到文件传输审批事件: userName=${userName}, fileName=${fileName}, taskId=${taskId}`);

  // 1. 通过无影用户服务查询钉钉用户ID
  let displayName = userName;
  let originatorUserId = eventData.originatorUserId;
  if (!originatorUserId && userName) {
    try {
      const userInfo = await aliyunUser.describeUser(userName);
      originatorUserId = userInfo.externalId;
      if (userInfo.nickName) {
        displayName = `${userName}(${userInfo.nickName})`;
      }
    } catch (err) {
      console.error(`[EventBridge] 查询用户钉钉ID失败: ${err.message}`);
      // 用户不存在时记录错误日志到 OSS
      await storage.saveErrorLog(taskId, `用户不存在或无影账号未关联钉钉: ${err.message}`, eventData);
      throw new Error(`无法获取钉钉用户ID，审批流终止: ${err.message}`);
    }
  }

  // 2. 查询钉钉用户所属部门ID（deptId 为必填参数）
  let deptId = eventData.deptId;
  if (!deptId && originatorUserId) {
    try {
      deptId = await dingtalk.getUserDeptId(originatorUserId);
    } catch (err) {
      console.error(`[EventBridge] 查询用户部门失败: ${err.message}`);
      await storage.saveErrorLog(taskId, `查询用户部门失败: ${err.message}`, eventData);
      throw new Error(`无法获取用户部门ID，审批流终止: ${err.message}`);
    }
  }

  // 3. 发起钉钉审批
  const { processInstanceId } = await dingtalk.createApprovalInstance({
    userName: displayName,
    fileName,
    filePath,
    taskId,
    regionId,
    originatorUserId,
    deptId,
    taskType
  });

  // 2. 保存映射关系到 OSS
  await storage.saveMapping(processInstanceId, {
    taskId,
    regionId,
    ossBucketRegionId: eventData.ossBucketRegionId || regionId,
    ossBucketName: eventData.ossBucketName || '',
    userName,
    fileName,
    filePath,
  });

  return {
    success: true,
    processInstanceId,
    message: '审批流已发起',
  };
}

module.exports = { handleEventBridge };
