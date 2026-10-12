# dsh-connect-accio

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![release](https://img.shields.io/badge/release-v0.2.0-blue)](https://github.com/tidys/dsh-connect-accio/releases/tag/v0.2.0)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

把本机已登录的 **Accio** 模型接入 **DeepSeek Harness (DSH)**。

---

## Accio 是什么

[**Accio**](https://www.accio-ai.com) 是阿里巴巴国际站推出的 **AI 电商工作台**（桌面客户端，
Electron 应用）。它内置一个 Agent 执行环境，背后聚合了多家模型供应商，以**积分（credits）计费**：

- 免费注册送 500 积分，每天再自动补 100 积分；
- 模型按倍率扣积分（如 Qwen 3.8 Flash 倍率 0.03 很便宜，GPT/旗舰级倍率更高）；
- 同一个账号里能用 **DeepSeek V4 Pro / V4.1 Flash、GLM-5.3、Kimi K2.6、MiniMax M3、
  Qwen 3.8 全系** 等模型。

**下载地址**（按你的区域选一个，客户端里登录后本插件才能工作）：

| 区域 | 官网 | 桌面端下载 |
| --- | --- | --- |
| 中国大陆 | [www.accio-ai.com](https://www.accio-ai.com) | [work-download.accio-ai.com](https://work-download.accio-ai.com/package/) |
| 国际版 | [www.accio.com](https://www.accio.com) | 同上（客户端内自动选择区域） |

> 本插件在 **Accio 0.34.3** 上开发并验证。Accio 是闭源客户端，其接口随版本可能变化。

## 这个插件在做什么

DSH 本身不带 Accio 的接入能力。这个插件在**本机**把两者连起来：

```
你在 DSH 里选一个 Accio 模型发消息
        │
        ▼
DSH 的 PiAiAdapter（OpenAI 线格式）
        │
        ▼
插件宿主侧（本插件，运行在 DSH 进程里）
        │   ① 读凭据   ② 签名请求   ③ 翻译协议
        ▼
Accio 网关  ->  Accio 账号计费  ->  模型回复
```

具体做三件事：

1. **拿凭据，但不碰登录** —— 读取 Accio 已经写在本机的 `credentials.enc`，用当前 Windows
   用户的 DPAPI 密钥解密。**不复制 token、不记录密码、不接管登录流程**，你在 Accio 里登录
   一次即可，退出登录插件也随之失效。
2. **补齐请求签名** —— Accio 网关要求每个请求带阿里 SecurityGuard 的签名头。插件直接加载
   **Accio 自带的** `security_guard.node` 原生库来签名，不做逆向算法、不做中间人抓包。
3. **翻译协议** —— Accio 用的是 Gemini 风格的信封 + 私有 SSE，DSH 用的是 OpenAI 线格式。
   插件在本机回环端口上做双向转换，让工具调用、思维链、用量统计都能正常往返。

**安全边界**：所有请求都发生在你自己的机器、你自己的登录态下，计费走你自己的 Accio 账号。
插件的取数路由只接受 loopback 来源，外部网页无法读取你的账号数据。

---

## 功能

- **实时模型目录** —— 从 Accio 网关拉取，当前账号可用 15 个模型（DeepSeek V4 Pro / V4.1 Flash、
  GLM-5.3、Kimi K2.6、MiniMax M3、Qwen 3.8 系列等），带真实上下文窗口与多模态标注。
- **完整工具调用** —— DSH 的本地工具循环可用：模型产出 `tool_calls`，DSH 本地执行后再回传。
- **思维链分离** —— Accio 把思维链放在带 `thought` 标记的 part 里，插件映射到
  `reasoning_content`，不会污染正文。
- **token 自动刷新** —— 到期前自动刷新；刷新会轮换 refresh token，因此并发调用被合并为单次。
- **账号与积分详情卡片** —— 设置页显示账号信息（用户名、邮箱、ID、套餐、区域、手机绑定）、
  三类积分（每日 / 套餐 / 额外）的用量进度条与有效期、每日重置倒计时、积分来源与最近用量明细。

## 关于签到

**Accio 没有签到接口，本插件不提供签到按钮。** 这是实测结论，不是偷懒：

- 桌面端整个 bundle 里**不存在**任何签到路径或"签到"字样；
- 15 个可能的接口拼写（`/api/entitlement/checkin`、`/api/signin`、`/api/checkin` 等）**全部 404**；
- 积分来源记录显示每日积分是服务端自动发放的 `DAILY_REWARD`（"Daily refresh credits"），
  当天有效、次日自动刷新——是**定时刷新**，不是用户动作。

所以卡片改为**如实说明这一点**，并显示每日重置倒计时，而不是放一个永远失败的按钮。

## 安装

### 前置条件

| 依赖 | 说明 |
| --- | --- |
| **Windows 10/11** | 凭据解密依赖 DPAPI，签名依赖 Windows 版 `security_guard.node` |
| **DeepSeek Harness** | 已安装并可启动（`dsh` 命令可用） |
| **Accio 桌面端已登录** | 插件读取本机登录态，不提供登录入口 |

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile desktop add github:tidys/dsh-connect-accio
```

### 从本地目录安装（开发 / 源码运行）

```sh
git clone https://github.com/tidys/dsh-connect-accio.git
dsh plugin --profile desktop add .\dsh-connect-accio
```

> `--profile` 后面跟你的 profile 名；默认桌面版是 `desktop`。可用 `dsh --help` 查看。

### 启用

1. **重启 DSH**（插件在启动时加载，热更新不覆盖宿主 provider）。
2. 打开 **设置 → 插件**，应能看到带 Accio 图标的 **DSH Connect Accio** 卡片：
   - 卡片上半部分是账号信息与三类积分；
   - 模型选择器里出现 Accio 的 15 个模型（Standard、DeepSeek V4 Pro、GLM-5.3 等）。
3. 选一个 Accio 模型开始对话即可，计费走你的 Accio 账号。

### 验证是否加载成功

卡片若显示「未登录或登录已失效」，先确认 Accio 桌面端已登录；若模型选择器里没有
Accio 条目，查看 DSH 启动日志中的 `dsh-connect-accio:` 行，常见原因是找不到
`security_guard.node`（见下方[配置](#配置)一节的 `ACCIO_SECURITY_GUARD_DIR`）。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-connect-accio
```

`remove` 只移除依赖；`dsh plugin add` 同时写入的 bundle 条目要手动从 profile 的
`package.json`（`dsh.profile.bundles` 数组）里删掉，然后再重启 DSH：

```sh
# profile 位置（默认桌面 profile）
%USERPROFILE%\.dsh\profiles\desktop\package.json
```

装完需要重启 DSH。

## 工作原理

```
DSH PiAiAdapter
  -> 回环 shim（OpenAI 线格式，127.0.0.1 + 进程内随机 bearer）
  -> AccioClient
  -> POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?sg_k=<md5(requestId)>
  -> SSE: content.parts[].text | function_call，thought 标记，usage_metadata
```

凭据链路：

```
%APPDATA%\Accio\Local State        os_crypt.encrypted_key（base64，"DPAPI" 前缀）
        │  DPAPI CryptUnprotectData（当前 Windows 用户）
        ▼
   32 字节 OSCrypt AES 密钥
        │  AES-256-GCM，blob = "v10" + 12B nonce + 密文 + 16B tag
        ▼
%APPDATA%\Accio\credentials.enc  ->  { accessToken, refreshToken, expiresAt, sgcookie, user }
```

请求签名由 Accio 自带的 `security_guard.node`（阿里 SecurityGuard）完成，**不需要中间人抓包**：

```js
sg.getSecurityFactorsForWeb(JSON.stringify({
  appkey: '35336201',                 // win32；darwin 为 35337600
  urlInput: fullUrlWithQuery,         // 必须含 ?sg_k=，签的是将要请求的那个 URL
}))
// -> pctb-x-sign / pctb-x-umt / pctb-x-api / pctb-x-t ...
```

## 配置

| 字段 | 说明 |
| --- | --- |
| `userDataDir` | Accio 的 Electron 用户数据目录；留空自动探测（默认 `%APPDATA%\Accio`） |
| `configRoot` | Accio 配置根目录（含 `utdid`）；留空自动探测（默认 `~/.accio`） |
| `securityGuardDir` | `security_guard.node` 所在目录；留空自动探测（含读取注册表安装路径） |
| `enabled` | 是否启用，默认 `true` |
| `lastCatalog` | 上次发现的模型目录，用于离线回退 |

多数情况下三项路径留空即可。若 Accio 装在非标准位置且注册表读取失败，设置
环境变量 `ACCIO_SECURITY_GUARD_DIR` 指向
`<Accio 安装目录>\resources\app.asar.unpacked\node_modules\@phoenix-common\security-guard`。

## 账号与积分接口

设置卡片通过插件自有的只读路由 `/plugins/dsh-connect-accio/credits` 取数；该路由只接受
loopback 来源（外部 Origin 返回 403），并聚合以下 Accio 接口：

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/userinfo` | 账号身份（**POST**，token 在 body） |
| `GET /api/entitlement/currentSubscription` | 三类积分与套餐（**GET**，token 在 query） |
| `GET /api/entitlement/quota` | 已用比例与每日重置倒计时 |
| `GET /api/entitlement/listGrantRecords` | 积分来源与有效期 |
| `GET /api/entitlement/listUserMessageBill` | 最近逐条用量 |
| `GET /api/entitlement/queryCreditUsageTrend` | 每日用量趋势 |

> 注意两个接口的**传参方式不同**：`userinfo` 必须 POST 且 token 放在 body，其余为 GET 且
> token 放在 query。用错会得到 `405 Method Not Allowed` 或 `400 Bad Request`。

这些查询**都是只读、不消耗积分**。

## 已知限制

- **仅 Windows** —— 凭据解密依赖 DPAPI，签名依赖 Windows 构建的 `security_guard.node`。
- **需要 Accio 已登录** —— 插件不提供登录入口；请先在 Accio 桌面端登录。
- **签名依赖 Accio 的安装** —— `security_guard.node` 是 Accio 的一部分，卸载 Accio 后插件失效。
- **模型计费在 Accio 侧** —— 每次对话都消耗 Accio 账号的额度；只有拉取目录和刷新 token 不消耗。
- **刷新的 token 只留在内存** —— 轮换后的 refresh token 不会写回 Accio 的私有凭据文件。
  重启插件会重新读取磁盘上的凭据；如果磁盘上的 refresh token 已因轮换失效，请在 Accio 中重新登录。

## 许可

MIT
