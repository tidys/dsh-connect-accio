# dsh-connect-accio

把本机已登录的 **Accio** 模型接入 **DeepSeek Harness (DSH)**。

插件不要求你复制 token、也不接管 Accio 的登录流程：它读取 Accio 已经存在本机的凭据，用
**当前 Windows 用户的 DPAPI 密钥**解密，并用 **Accio 自带的 SecurityGuard 原生库**给请求签名。

## 功能

- **实时模型目录** —— 从 Accio 网关拉取，当前账号可用 15 个模型（DeepSeek V4 Pro / V4.1 Flash、
  GLM-5.3、Kimi K2.6、MiniMax M3、Qwen 3.8 系列等），带真实上下文窗口与多模态标注。
- **完整工具调用** —— DSH 的本地工具循环可用：模型产出 `tool_calls`，DSH 本地执行后再回传。
- **思维链分离** —— Accio 把思维链放在带 `thought` 标记的 part 里，插件映射到
  `reasoning_content`，不会污染正文。
- **token 自动刷新** —— 到期前自动刷新；刷新会轮换 refresh token，因此并发调用被合并为单次。

## 安装

```sh
dsh plugin --profile desktop add <本插件目录或 npm 包名>
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

## 已知限制

- **仅 Windows** —— 凭据解密依赖 DPAPI，签名依赖 Windows 构建的 `security_guard.node`。
- **需要 Accio 已登录** —— 插件不提供登录入口；请先在 Accio 桌面端登录。
- **签名依赖 Accio 的安装** —— `security_guard.node` 是 Accio 的一部分，卸载 Accio 后插件失效。
- **模型计费在 Accio 侧** —— 每次对话都消耗 Accio 账号的额度；只有拉取目录和刷新 token 不消耗。
- **刷新的 token 只留在内存** —— 轮换后的 refresh token 不会写回 Accio 的私有凭据文件。
  重启插件会重新读取磁盘上的凭据；如果磁盘上的 refresh token 已因轮换失效，请在 Accio 中重新登录。

## 许可

MIT
