'use strict';

const OpenApi = require('@alicloud/openapi-client');
const ECD = require('@alicloud/ecd20200930');
const Util = require('@alicloud/tea-util');

let ecdClient = null;

/**
 * 获取无影云电脑 SDK 客户端
 * 优先使用 FC 角色授权的 STS 临时凭证，fallback 到环境变量 AK/SK
 */
function getEcdClient(regionId) {
  const config = new OpenApi.Config({});

  // FC 环境中通过角色授权自动注入的临时凭证
  const akId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || process.env.FC_ACCESS_KEY_ID;
  const akSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || process.env.FC_ACCESS_KEY_SECRET;
  const stsToken = process.env.ALIBABA_CLOUD_SECURITY_TOKEN || process.env.FC_SECURITY_TOKEN;

  config.accessKeyId = akId;
  config.accessKeySecret = akSecret;
  if (stsToken) {
    config.securityToken = stsToken;
  }
  config.endpoint = `ecd.${regionId}.aliyuncs.com`;

  return new ECD.default(config);
}

/**
 * 提交文件传输审批结果
 * API: TransferTaskApprovalCallback
 *
 * @param {object} params
 * @param {string} params.regionId - 地域ID，如 cn-hangzhou
 * @param {string} params.taskId - 传输任务ID
 * @param {string} params.result - 审批结果: "Approved" | "Rejected"
 * @param {string} [params.ossBucketRegionId] - 文件所在 bucket 地域
 * @param {string} [params.ossBucketName] - 文件所在 bucket 名称
 * @returns {object} API响应
 */
async function transferTaskApprovalCallback(params) {
  console.log(`[AliyunECD] 提交审批结果: taskId=${params.taskId}, result=${params.result}, region=${params.regionId}`);
  const client = getEcdClient(params.regionId);

  const request = new ECD.TransferTaskApprovalCallbackRequest({
    taskId: params.taskId,
    result: params.result,
  });

  if (params.ossBucketRegionId) {
    request.ossBucketRegionId = params.ossBucketRegionId;
  }
  if (params.ossBucketName) {
    request.ossBucketName = params.ossBucketName;
  }

  const runtime = new Util.RuntimeOptions({});

  console.log(`[AliyunECD] 提交审批结果: request=${JSON.stringify(request)}`);

  try {
    const response = await client.transferTaskApprovalCallbackWithOptions(request, runtime);
    console.log(`[AliyunECD] 审批结果提交成功: RequestId=${response.body.requestId}`);
    return response.body;
  } catch (err) {
    console.error(`[AliyunECD] 审批结果提交失败:`, err.message);
    throw err;
  }
}

module.exports = { transferTaskApprovalCallback };
