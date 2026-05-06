'use strict';

const EdsUser = require('@alicloud/eds-user20210308');
const OpenApi = require('@alicloud/openapi-client');

/**
 * 获取 eds-user（无影便捷账号管理）OpenAPI 客户端
 * 优先使用 FC 角色授权的 STS 临时凭证，fallback 到环境变量 AK/SK
 */
function getEdsUserClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || process.env.FC_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || process.env.FC_ACCESS_KEY_SECRET,
    securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN || process.env.FC_SECURITY_TOKEN,
  });
  config.endpoint = 'eds-user.cn-shanghai.aliyuncs.com';
  return new EdsUser.default(config);
}

/**
 * 查询无影便捷账号用户信息
 * API: DescribeUser
 * 通过 EndUserId 查询，返回包含 ExternalInfo.ExternalId（钉钉用户ID）
 *
 * @param {string} endUserId - 无影用户名（如 yanzhi）
 * @returns {object} { endUserId, externalId, externalName, wyId }
 */
async function describeUser(endUserId) {
  const client = getEdsUserClient();

  const request = new EdsUser.DescribeUserRequest({
    endUserId,
    requireExtraAttributes: ['ExternalInfo'],
  });

  console.log(`[AliyunUser] 查询用户信息: EndUserId=${endUserId}`);

  try {
    const response = await client.describeUser(request);
    const user = response.body.user;

    if (!user) {
      throw new Error(`用户不存在: ${endUserId}`);
    }

    const result = {
      endUserId: user.endUserId,
      externalId: user.externalInfo?.externalId,
      externalName: user.externalInfo.externalName,
      nickName: user.nickName,
      wyId: user.wyId,
    };

    console.log(`[AliyunUser] 查询成功: externalId=${result.externalId}, externalName=${result.externalName}`);
    return result;
  } catch (err) {
    console.error(`[AliyunUser] 查询用户失败: ${err.message}`);
    throw err;
  }
}

module.exports = { describeUser };
