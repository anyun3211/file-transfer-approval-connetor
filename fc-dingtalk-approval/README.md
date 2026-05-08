# 无影文件传输审批系统 - 部署操作文档

## 一、系统概述

本系统集成钉钉审批流与阿里云无影（ECD）文件传输任务，实现自动化审批。核心流程：

```
无影文件传输事件 → EventBridge → FC函数 → 发起钉钉审批
钉钉审批完成 → HTTP回调 → FC函数 → 提交审批结果到无影
```

**技术栈**：Node.js 18+、函数计算 FC 3.0、EventBridge、钉钉开放平台 API、OSS

---

## 二、钉钉侧配置

### 2.1 创建审批流

1. 登录 [钉钉 OA 管理后台](https://oa.dingtalk.com)
2. 创建工作流，配置审批表单字段：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 文件传输申请 | 文本 | 表单说明 |
| 用户名 | 文本 | 无影终端用户名 |
| 文件名 | 文本 | 传输文件名称 |
| 文件路径 | 文本 | 源路径/目标路径 |
| 任务类型 | 文本 | UPLOAD / DOWNLOAD |
| 任务ID | 文本 | 传输任务唯一标识 |
| 地域 | 文本 | 资源所在地域 |

3. 记录 **流程编码** `PROCESS_CODE`（如 `PROC-8308F2C9-E852-46E2-A4B3-*****AF`）

### 2.2 创建应用并授权

1. 登录 [钉钉开放平台](https://open.dingtalk.com)，创建企业内部应用
2. 记录以下信息：
   - **AppKey** → 环境变量 `DINGTALK_APP_KEY`
   - **AppSecret** → 环境变量 `DINGTALK_APP_SECRET`
   - **CorpId** → 环境变量 `DINGTALK_CORP_ID`（在企业管理后台 → 组织管理中获取）
3. 进入应用 → 权限管理，授予以下权限：
   - **成员信息读权限**（查询用户所属部门）
   - **工作流实例写权限**（发起审批流程）

### 2.3 创建 HTTP 事件订阅

> **重要**：此步骤需与 FC 函数部署**同步进行**，因为钉钉会立即验证回调地址的有效性。

1. 进入应用 → 事件与回调 → HTTP 事件订阅
2. 配置：
   - **请求网址**：`https://<FC_HTTP_TRIGGER_URL>/dingtalk-callback`
   - 钉钉会自动生成 **Token** 和 **AES Key**，记录：
     - Token → 环境变量 `DINGTALK_CALLBACK_TOKEN`
     - AES Key（43位）→ 环境变量 `DINGTALK_CALLBACK_AES_KEY`
3. 订阅事件：审批事件 → 审批任务开始、审批任务结束、审批任务转交
4. 订阅范围（可选精确配置）：
   ```
   /v1.0/event/bpms_task_change/processCode/{PROCESS_CODE}/type/finish
   ```
   示例：
   ```
   /v1.0/event/bpms_task_change/processCode/PROC-8308F2C9-E852-46E2-A4B3-******AF/type/finish
   ```
5. 点击"验证"，FC 收到 `check_url` 事件后返回加密验证响应，验证通过即完成

---

## 三、阿里云平台配置

### 3.1 开通 OSS 并创建 Bucket

1. 登录 [OSS 控制台](https://oss.console.aliyun.com)
2. 创建 Bucket：
   - **名称**：如 `test-file-approval`（全局唯一）
   - **地域**：与 FC 函数同地域（建议 `cn-shanghai`）
   - **访问权限**：私有
3. 可选：配置生命周期规则，自动清理过期映射文件 (可选，根据实际需求来)
   - 前缀：`approval-mappings/`
   - 过期天数：7 天

### 3.2 创建 RAM 角色

1. 登录 [RAM 控制台](https://ram.console.aliyun.com)
2. 创建角色：
   - **信任实体**：阿里云服务 → 函数计算 (FC)
   - **角色名称**：`fc-dingtalk-approval-role`
3. 附加自定义权限策略：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject",
        "oss:PutObject",
        "oss:DeleteObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:<ACCOUNT_ID>:<BUCKET_NAME>/approval-mappings/*",
        "acs:oss:*:<ACCOUNT_ID>:<BUCKET_NAME>/approval-mappings/error-logs/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecd:TransferTaskApprovalCallback",
        "ecd:DescribeUser"
      ],
      "Resource": "*"
    }
  ]
}
```

> 将 `<ACCOUNT_ID>` 替换为阿里云账户 ID（12位数字），`<BUCKET_NAME>` 替换为实际 Bucket 名称。

4. 记录角色 ARN（如 `acs:ram::<ACCOUNT_ID>:role/fc-dingtalk-approval-role`）


### 3.3 创建 FC 函数

1. 登录 [函数计算控制台](https://fcnext.console.aliyun.com)
2. 创建函数：

| 配置项 | 建议值 |
|--------|--------|
| 函数名 | `fc-dingtalk-approval` |
| 运行时 | `Node.js 20` |
| Handler | `src/index.handler` |
| 内存 | 512 MB |
| 执行超时 | 30 秒 |
| 执行角色 | `fc-dingtalk-approval-role`（上一步创建） |

3. 上传代码：将项目目录（含 `node_modules`）打包为 ZIP 上传
4. 创建 HTTP 触发器（用于接收钉钉回调）
5. 记录 HTTP 触发器 URL，用于钉钉事件订阅配置

#### 环境变量配置

在 FC 函数配置中添加以下环境变量：

**钉钉相关（必填）：**

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DINGTALK_APP_KEY` | 钉钉应用 AppKey | `dingxxxxxxxxx` |
| `DINGTALK_APP_SECRET` | 钉钉应用 AppSecret | `xxxxxxxxxxxxx` |
| `DINGTALK_PROCESS_CODE` | 审批流程编码 | `PROC-8308F2C9-E852-...` |
| `DINGTALK_CORP_ID` | 钉钉应用 AppKey | `dinge4a8fd7********` |
| `DINGTALK_CALLBACK_TOKEN` | 回调 Token | 钉钉事件订阅自动生成 |
| `DINGTALK_CALLBACK_AES_KEY` | 回调 AES 密钥（43位） | 钉钉事件订阅自动生成 |

**OSS 相关：**

| 变量名 | 说明 | 是否必填 | 默认值 |
|--------|------|---------|--------|
| `OSS_BUCKET` | Bucket 名称 | 是 | - |
| `OSS_REGION` | OSS 地域 | 是 | `oss-cn-shanghai` |
| `OSS_PREFIX` | 对象前缀 | 否 | `approval-mappings` |

**阿里云凭证（使用 RAM 角色时无需手动配置）：**

> FC 平台会通过 RAM 角色自动注入 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`ALIBABA_CLOUD_SECURITY_TOKEN`，代码会自动读取。

### 3.4 配置 EventBridge

1. 登录 [EventBridge 控制台](https://eventbridge.console.aliyun.com)
2. 创建事件规则：
   - **事件源**：阿里云服务 → `acs.gws`
   - **事件类型**：`gws:FileTransferEvent:TransferFileApprovalEvent`
3. 配置目标：
   - **目标类型**：函数计算 (FC)
   - **函数**：选择 `fc-dingtalk-approval`
   - **推送方式**：建议启用自动重试（最多 3 次）
4. 启用规则

**EventBridge 推送的事件格式：**

```json
{
  "data": {
    "endUserId": "f646b47c7***",
    "fileName": "example.pdf",
    "taskId": "trt-j3kzck2c4******",
    "taskType": "UPLOAD",
    "regionId": "cn-hangzhou",
    "sourcePath": "/Users/user/Downloads/example.pdf",
    "targetPath": "C:\\Users\\user\\Downloads\\example.pdf"
  },
  "source": "acs.gws",
  "type": "gws:FileTransferEvent:TransferFileApprovalEvent",
  "id": "uuid",
  "time": "2026-05-03T02:32:59.083Z"
}
```

---

## 四、部署顺序与依赖关系

```
┌─────────────────────┐    ┌──────────────────────┐
│  钉钉：创建审批流     │    │  阿里云：创建 RAM 角色 │
│  钉钉：创建应用授权   │    │  阿里云：创建 OSS Bucket│
└────────┬────────────┘    └──────────┬───────────┘
         │                            │
         └────────────┬───────────────┘
                      ▼
         ┌────────────────────────┐
         │  创建 FC 函数           │
         │  配置环境变量           │
         │  上传代码               │
         │  创建 HTTP 触发器       │
         └────────────┬───────────┘
                      │
         ┌────────────┴───────────────────┐
         ▼                                ▼
┌─────────────────────┐    ┌──────────────────────┐
│  钉钉：配置事件订阅   │    │  阿里云：配置 EventBridge│
│  （填入 FC 回调 URL） │    │  （目标指向 FC 函数）   │
│  （同步记录 Token/Key）│    └──────────────────────┘
└─────────────────────┘
         │
         ▼ Token/AES Key 写入 FC 环境变量
```

> **关键同步点**：钉钉事件订阅配置时会立即验证回调地址，因此：
> 1. FC 函数必须先部署完成且 HTTP 触发器可访问
> 2. 在钉钉配置事件订阅时生成的 Token 和 AES Key 需**立即**写入 FC 环境变量
> 3. 写入后重新部署或刷新 FC 函数配置，再在钉钉侧点击"验证"

---

## 五、部署验证清单

### 部署前检查

- [ ] 钉钉应用已创建，获取 AppKey / AppSecret / CorpId
- [ ] 钉钉审批流已创建，获取 ProcessCode
- [ ] RAM 角色已创建，权限策略已附加（OSS + ECD + EDS-User）
- [ ] OSS Bucket 已创建（私有权限）
- [ ] FC 函数已创建，环境变量已配置
- [ ] 代码已打包上传（含 node_modules）
- [ ] HTTP 触发器已创建

### 部署后验证

- [ ] `GET /health` 返回 200 OK
- [ ] 钉钉事件订阅验证通过（check_url）
- [ ] EventBridge 规则已启用
- [ ] 手动触发一次文件传输事件，FC 日志正常
- [ ] 钉钉收到审批通知
- [ ] OSS 中生成了映射文件（`approval-mappings/<instanceId>.json`）
- [ ] 审批通过后，FC 日志显示审批结果已提交到无影 API

---

## 六、常见问题排查

| 问题 | 可能原因 | 排查方法 |
|------|---------|---------|
| 钉钉事件订阅验证失败 | FC 函数未部署 / Token/AES Key 不匹配 | 检查 FC 日志中 `check_url` 处理，确认环境变量 |
| EventBridge 事件无响应 | 规则未启用 / 事件类型不匹配 | EventBridge 控制台查看事件追踪 |
| 审批流发起失败 | 用户未关联钉钉 / 部门查询失败 | 检查 OSS `error-logs/` 目录 |
| 审批结果未提交 | FC 超时 / RAM 权限不足 | 检查 FC 日志中 `TransferTaskApprovalCallback` 调用 |
| HTTP 回调 500 错误 | 解密失败 / 环境变量缺失 | FC 日志搜索 `decrypt` 或 `DingTalkCallback` 错误 |
| OSS 读写失败 | RAM 角色权限不足 / Bucket 不存在 | 确认权限策略中 Resource ARN 正确 |

---

## 七、项目依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `ali-oss` | ^6.21.0 | OSS 客户端 |
| `dingtalk-encrypt` | ^2.1.1 | 钉钉回调加解密 |
| `@alicloud/ecd20200930` | ^4.23.4 | 无影 ECD API |
| `@alicloud/eds-user20210308` | ^2.1.0 | 无影用户管理 API |
| `@alicloud/openapi-client` | ^0.4.12 | 阿里云 OpenAPI 基础库 |
| `@alicloud/tea-util` | ^1.4.9 | 阿里云 SDK 工具库 |

---

## 八、依赖服务收费说明

本系统依赖多个云服务和开放平台，以下为各服务的计费模型概览：

### 8.1 函数计算 FC

| 计费维度 | 说明 |
|---------|------|
| 调用次数 | 每月前 100 万次免费，超出后按 ¥1.33 / 百万次 |
| 执行时长 | 按 vCPU 秒和内存 GB 秒计费，每月有免费额度（40 万 GB-s） |
| 公网流量 | 出方向流量按 ¥0.8/GB 计费 |

> **本项目预估**：审批场景调用频率较低，通常可在免费额度内覆盖。

### 8.2 对象存储 OSS

| 计费维度 | 说明 |
|---------|------|
| 存储费用 | 标准存储 ¥0.12/GB/月 |
| 请求费用 | PUT/GET 等请求 ¥0.01/万次 |
| 流量费用 | 内网访问免费，公网出流量 ¥0.50/GB |

> **本项目预估**：仅存储审批映射 JSON 文件（KB 级别），存储和请求费用可忽略不计。建议配置生命周期策略自动清理过期文件以避免积累。

### 8.3 EventBridge

| 计费维度 | 说明 |
|---------|------|
| 事件投递 | 每月前 500 万次免费，超出后按 ¥2.00 / 百万次 |
| 自定义总线 | 默认总线免费 |

> **本项目预估**：文件传输审批事件量有限，通常在免费额度内。

### 8.4 钉钉开放平台

| 计费维度 | 说明 |
|---------|------|
| API 调用 | **免费**，但有频率限制（通常 20 次/秒/应用） |
| 事件订阅 | 免费 |

> **注意**：高并发审批场景需关注 API 限流，避免短时间内大量发起审批或查询用户信息。

### 8.5 无影 ECD / EDS-User API

| 计费维度 | 说明 |
|---------|------|
| OpenAPI 调用 | 接口调用本身**不额外收费** |
| 无影桌面服务 | 按桌面实例规格、使用时长或包年包月计费（与本项目代码无关，属基础设施成本） |

> **说明**：本项目仅调用 `TransferTaskApprovalCallback` 和 `DescribeUser` 接口，不产生额外 API 费用。无影桌面的实例费用由业务侧独立承担。

---

## 九、风险评估

### 9.1 安全风险

| 风险项 | 说明 | 缓解建议 |
|-------|------|----------|
| 敏感凭证明文存储 | `DINGTALK_APP_SECRET`、`DINGTALK_CALLBACK_TOKEN`、`DINGTALK_CALLBACK_AES_KEY` 等以环境变量明文存储在 FC 配置中 | 迁移至阿里云**密钥管理服务 KMS**，通过 FC 集成 KMS 动态获取密钥 |
| 回调地址暴露 | HTTP 触发器 URL 公网可达，存在被恶意调用的风险 | 依赖钉钉加密签名验证机制（已实现），可额外配置 WAF 或 IP 白名单 |

### 9.2 可用性风险

| 风险项 | 说明 | 缓解建议 |
|-------|------|----------|
| FC 冷启动延迟 | 首次调用或长时间空闲后冷启动可能耗时数秒，钉钉回调超时阈值较短 | 配置 FC **预留实例**（会产生额外费用），或优化代码包体积减少冷启动时间 |
| EventBridge 投递失败 | 网络抖动或 FC 异常可能导致事件投递失败 | 启用 EventBridge **自动重试**（建议最多 3 次）并配置**死信队列（DLQ）**，将失败事件转存至 MNS 或 OSS 供人工排查 |
| 钉钉 API 限流 | 默认频率限制约 20 次/秒，高并发文件传输场景可能触发限流 | 实现请求排队和指数退避重试机制，或申请钉钉提升调用频率上限 |

### 9.3 数据一致性风险

| 风险项 | 说明 | 缓解建议 |
|-------|------|----------|
| OSS 映射文件与审批状态不一致 | FC 执行中途失败可能导致映射文件已写入但审批未发起，或审批已完成但映射文件未更新 | 在审批回调处理中增加幂等校验，查询钉钉审批实例状态进行核对 |
| FC 超时导致审批结果未提交 | 审批回调处理超过 FC 执行超时（30s），导致 `TransferTaskApprovalCallback` 未调用 | 适当增大 FC 超时配置，拆分耗时操作为异步步骤，或引入消息队列解耦 |

### 9.4 成本风险

| 风险项 | 说明 | 缓解建议 |
|-------|------|----------|
| 异常重试导致调用量放大 | EventBridge 重试 + FC 内部重试可能导致同一事件被多次处理，放大调用量和费用 | 实现幂等处理逻辑，通过 `taskId` 去重；合理设置重试上限 |
| OSS 错误日志持续积累 | `error-logs/` 目录下的日志文件会持续增长，长期运行后占用存储空间 | 配置 OSS **生命周期规则**，对 `approval-mappings/error-logs/` 前缀设置自动过期删除（建议 30 天） |
