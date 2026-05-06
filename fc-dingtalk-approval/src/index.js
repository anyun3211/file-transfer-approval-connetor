'use strict';

const { handleEventBridge } = require('./handlers/eventBridge');
const { handleDingtalkCallback } = require('./handlers/dingtalkCallback');
const { refreshCredentials } = require('./services/storage');

/**
 * 构造标准响应对象
 */
function makeResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/**
 * FC Handler 入口（callback 模式）
 * 支持两种触发方式：
 *   1. HTTP 触发器 —— event 为 FC 3.0 HTTP 请求对象（含 body 字段）
 *   2. EventBridge 直接触发 —— event 为 CloudEvents JSON 对象（含 type, source, data 等字段）
 *
 * 路由优先级（安全优先，防止 HTTP 伪造 EventBridge 事件）：
 *   1. 先判断是否为 HTTP 请求（event 包含 body 字段）
 *      - path 匹配 /dingtalk-callback → 进入钉钉回调处理
 *      - path 匹配 /health             → 健康检查
 *      - 其它 path                      → 返回 404
 *   2. 非 HTTP 请求时，判断是否为 EventBridge 事件（type + source 匹配）
 *      - 匹配 → 进入 EventBridge 处理
 *      - 不匹配 → 返回错误
 */
exports.handler = async (event, context, callback) => {
  // event 可能是 Buffer、字符串或对象，统一 parse 为对象
  let eventObj;
  if (typeof event === 'string' || Buffer.isBuffer(event)) {
    eventObj = JSON.parse(event.toString());
  } else {
    eventObj = event;
  }

  // 使用 FC context 中的临时凭证（RAM 角色授权）
  if (context && context.credentials) {
    refreshCredentials(context.credentials);
    // 同步到环境变量，供其他阿里云 OpenAPI 服务使用
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = context.credentials.accessKeyId;
    process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = context.credentials.accessKeySecret;
    if (context.credentials.securityToken) {
      process.env.ALIBABA_CLOUD_SECURITY_TOKEN = context.credentials.securityToken;
    }
  }

  try {
    // -------- 1. HTTP 触发器（event 包含 body 字段） --------
    // 安全优先：只要存在 body 字段即视为 HTTP 请求，防止通过 HTTP 伪造 EventBridge 事件格式
    if ('body' in eventObj) {
      const path = eventObj.rawPath || '/';
      const method = eventObj.requestContext?.http?.method || 'GET';
      const query = eventObj.queryParameters || {};

      console.log(`[Router] HTTP ${method} ${path}`);

      // 健康检查
      if (path.endsWith('/health')) {
        return callback(null, makeResponse(200, { status: 'ok', timestamp: new Date().toISOString() }));
      }

      // 钉钉审批回调入口
      if (path.endsWith('/dingtalk-callback')) {
        let bodyStr = eventObj.body || '{}';
        if (eventObj.isBase64Encoded) {
          bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8');
        }
        console.log(`[Router] bodyStr: ${bodyStr}`);
        const body = JSON.parse(bodyStr);
        const { response: callbackResponse } = await handleDingtalkCallback(query, body);
        console.log(`[Router] 回调结果: ${JSON.stringify(callbackResponse)}`);
        return callback(null, {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: callbackResponse,
        });
      }

      // 未匹配的 HTTP 路径 → 404
      return callback(null, makeResponse(404, { error: 'Not Found', path }));
    }

    // -------- 2. EventBridge FC 直接调用（非 HTTP，无 body 字段） --------
    if (
      eventObj.type === 'gws:FileTransferEvent:TransferFileApprovalEvent' &&
      eventObj.source === 'acs.gws'
    ) {
      console.log(`[Router] EventBridge 直接触发, id=${eventObj.id}, type=${eventObj.type}`);
      const result = await handleEventBridge(eventObj);
      console.log(`[Router] EventBridge 处理完成: ${JSON.stringify(result)}`);
      return callback(null, { statusCode: 200, body: JSON.stringify(result) });
    }

    // 未识别的事件格式
    console.error(`[Router] 未识别的事件格式: type=${eventObj.type}, source=${eventObj.source}`);
    return callback(null, makeResponse(400, { error: 'Unknown event format' }));
  } catch (err) {
    console.error(`[Router] 处理请求失败: ${err.message}`, err.stack);
    return callback(null, makeResponse(500, { error: err.message }));
  }
};
