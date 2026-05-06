'use strict';

const https = require('https');

const APP_KEY = process.env.DINGTALK_APP_KEY;
const APP_SECRET = process.env.DINGTALK_APP_SECRET;
const PROCESS_CODE = process.env.DINGTALK_PROCESS_CODE;

// accessToken 缓存
let tokenCache = { token: null, expireAt: 0 };

/**
 * 发起 HTTPS JSON 请求
 */
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * 获取企业内部应用 accessToken（带缓存）
 * POST https://api.dingtalk.com/v1.0/oauth2/accessToken
 */
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expireAt > now) {
    return tokenCache.token;
  }

  console.log('[DingTalk] 获取 accessToken...');
  const url = new URL('https://api.dingtalk.com/v1.0/oauth2/accessToken');
  const { statusCode, data } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { appKey: APP_KEY, appSecret: APP_SECRET });

  if (statusCode !== 200 || !data.accessToken) {
    throw new Error(`获取 accessToken 失败: ${JSON.stringify(data)}`);
  }

  // 提前 5 分钟过期，避免边界情况
  tokenCache = {
    token: data.accessToken,
    expireAt: now + (data.expireIn - 300) * 1000,
  };

  console.log('[DingTalk] accessToken 获取成功');
  return data.accessToken;
}

/**
 * 查询钉钉用户所属部门ID列表
 * POST https://oapi.dingtalk.com/topapi/v2/user/get
 *
 * @param {string} userId - 钉钉用户ID
 * @returns {number} 首个部门ID
 */
async function getUserDeptId(userId) {
  const accessToken = await getAccessToken();

  const url = new URL(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${accessToken}`);
  const { statusCode, data } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    language: 'zh_CN',
    userid: userId,
  });

  if (statusCode !== 200 || data.errcode !== 0) {
    throw new Error(`查询用户部门失败: ${JSON.stringify(data)}`);
  }

  const deptList = data.result?.dept_id_list;
  if (!deptList || deptList.length === 0) {
    throw new Error(`用户 ${userId} 未归属任何部门`);
  }

  console.log(`[DingTalk] 查询用户部门: userId=${userId}, deptId=${deptList[0]}`);
  return deptList[0];
}

/**
 * 发起审批实例
 * POST https://api.dingtalk.com/v1.0/workflow/processInstances
 *
 * @param {object} params
 * @param {string} params.userName - 用户名
 * @param {string} params.fileName - 文件名
 * @param {string} params.filePath - 文件路径
 * @param {string} params.taskId - 传输任务ID
 * @param {string} params.regionId - 地域ID
 * @param {string} params.originatorUserId - 审批发起人钉钉UserID
 * @param {number} params.deptId - 发起人部门ID
 * @returns {object} { processInstanceId }
 */
async function createApprovalInstance(params) {
  const accessToken = await getAccessToken();
  const taskType = params.taskType == 'UPLOAD' ? "上传" : "下载";
  const procName = "["+params.userName+"]发起文件["+params.fileName+"]"+taskType+"申请";

  const formComponentValues = [
    { name: '文件传输申请', value:  procName},
    { name: '用户名', value: params.userName },
    { name: '文件名', value: params.fileName },
    { name: '文件路径', value: params.filePath },
    { name: '任务ID', value: params.taskId },
    { name: '地域', value: params.regionId },
  ];

  const body = {
    processCode: PROCESS_CODE,
    originatorUserId: params.originatorUserId,
    deptId: Number(params.deptId),
    formComponentValues,
  };

  console.log('[DingTalk] 发起审批实例:', JSON.stringify(body));

  const url = new URL('https://api.dingtalk.com/v1.0/workflow/processInstances');
  const { statusCode, data } = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': accessToken,
    },
  }, body);

  if (statusCode !== 200 || !data.instanceId) {
    throw new Error(`发起审批实例失败: ${JSON.stringify(data)}`);
  }

  console.log(`[DingTalk] 审批实例创建成功: ${data.instanceId}`);
  return { processInstanceId: data.instanceId };
}

module.exports = { getAccessToken, getUserDeptId, createApprovalInstance };
