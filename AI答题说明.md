# AI 答题功能说明（OCS 5.4.2）

> **v2.7.1 起：题库已彻底移除。**
> 本模板只保留 AI 答题一条通道，脚本里不再有任何题库请求，服务端也不再下发题库配置。
> 旧 `config.json` 里的 `answererWrappers` 会在启动时自动删除；`gm-store.json` 里的也会在下次开浏览器时清空。
> 因此下文所有「与题库并行 / 优先级」的描述都只用于解释历史行为，实际不会发生。

把任意 OpenAI 兼容接口接成答题通道：题目和选项按固定格式发给模型，模型返回答案，再由脚本原有的解析器映射到选项上。

> **服务端版（ocs-server）怎么配？**
> 不需要打开脚本悬浮窗，直接打开控制台 `http://<设备IP>:8899` → 右上角 **⚙️ 配置** → 填「服务商 / 接口地址 / API Key / 模型」→ **测试连接** → **保存**。
> 保存后运行中的页面立即生效。本文后面的「界面操作」部分针对浏览器 + 油猴版，服务端版可跳过。
>
> **多个账号想用不同的接口 / Key？** 在左侧用户卡片上点 **AI**，勾选「这个用户单独配置」即可，
> 只影响这一个账号；没填的项沿用全局，Key 不回传到浏览器。

## 一、怎么用

1. 打开脚本悬浮窗 → **通用 → ⚙️ 全局设置 → 自动答题设置**，最下方找到新增的一行 **「AI 答题（大模型答题）」**。
2. 点击按钮 → 弹窗中依次填写：
   - **接口服务商**：选一个预设（OpenAI / DeepSeek / 通义千问 / Kimi / 智谱 / 硅基流动 / OpenRouter / Ollama），会自动填好 Base URL 和模型名；
   - **接口地址**：形如 `https://api.deepseek.com/v1`（脚本会自动补 `/chat/completions`）；
   - **API Key**：只保存在本机油猴存储，不会上传到别处；本地 Ollama 可留空；
   - **模型名称**、温度、最大回复长度、超时、请求方式（默认「自动」：优先 GM 请求以绕开跨域）；
   - 系统提示词 / 附加要求（例如指定教材口径），一般保持默认即可。
3. 点 **「测试连接」**，会用一道示例题验证 Key、地址、模型是否可用，并显示模型原始返回。
4. 点 **「保存并启用」** → 面板按钮变成 `✅ 已启用 · 模型名`，重新答题或刷新页面生效。

> 面板按钮状态：`点击配置 AI 接口` → 未配置；`⏸ 已配置未启用` → 配好了但开关是关的；`✅ 已启用 · xxx` → 正在使用。

## 二、和题库的关系

| 场景 | 行为 |
| --- | --- |
| 只配了 AI | 只走 AI，不再提示「你还没设置题库」 |
| 只配了题库 | 与原来完全一致 |
| 两者都有 | 并行请求，AI 的结果排在搜索结果第一位；题库命中时仍按原有相似度择优 |
| AI 调用失败 | 该题标记为搜题失败并展示错误原因，不影响其他题目、不中断答题 |

答案格式统一交给原有的 `resolveSingle / resolveMultiple / resolveJudgement / resolveCompletion` 处理，因此原来的选项匹配、随机作答、提交率、题库缓存等逻辑全部复用。

## 三、答案格式约定

系统提示词要求模型只输出一行 JSON：`{"answer":"..."}`

| 题型 | 期望输出 | 脚本处理 |
| --- | --- | --- |
| 单选 | `B` | 字母按顺序映射成选项原文，未命中则原样交给相似度匹配 |
| 多选 | `ACD` | 拆成多个字母 → 选项原文，按「答案分隔符」拼接 |
| 判断 | `正确` / `错误`（或 A/B、true/false） | 映射成页面上的「正确/错误」选项文本 |
| 填空 | `光合作用#叶绿体` | 按全局「答案分隔符」拆分，逐个填入空 |

模型若返回纯文本（非 JSON），会去掉「答案：」「A. 」等前缀后再匹配，兼容性优先。

## 四、代码结构（相对于原版新增/修改）

新增模块位置：`defaultAnswerWrapperHandler` 之前（约 4190 行起），整段以 `// ==================== AI 答题` 开头，包含：

- `AI_ANSWERER_PROVIDERS` / `AI_ANSWERER_DEFAULT_CONFIG`：服务商预设与默认配置
- `getAiAnswererConfig()` / `isAiAnswererReady()` / `hasAnswererSource()` / `isAiAnswererImageReady()`
- `resolveAiEndpoint()`：Base URL → `chat/completions` 地址
- `buildAiAnswererMessages()`：按题型拼 system + user（含图片多模态）
- `requestAiAnswererCompletion()`：带超时、重试、GM/fetch 自动降级
- `parseAiAnswererContent()` / `formatAiAnswererAnswer()`：解析与题型适配
- `searchAnswerByAI()`：产出一个与题库同构的 searchInfo
- `openAiAnswererModal()` / `renderAiAnswererButtonState()`：配置弹窗与面板按钮状态

对原代码的改动点（共 8 处）：

1. `defaultAnswerWrapperHandler`：允许「无题库但启用 AI」，并并行发起 AI 请求、把结果 unshift 到最前；
2. `workPreCheckMessage`、超星 iframe 工作流、在线搜题、学习页、章节测试、工作入口等 **6 处「未配置题库」判断** 改为 `hasAnswererSource(...)`；
3. 图片题优化提示：AI 支持图片时不再提示「题库不支持图片」；
4. `全局设置` 新增 `aiAnswererButton` / `aiAnswerer` 两个配置项（后者无 label，不渲染，仅存数据）。

## 五、注意事项

- AI 答案具有不确定性，考试 / 计分作业请谨慎开启；建议打开「答案提交方式」为「自动保存（不提交）」先观察。
- 模型越强准确率越高；`gpt-4o-mini`、`deepseek-chat`、`qwen-plus` 这类性价比模型已足够应付多数客观题。
- 一道题一次请求，线程数为 1 时最稳；开着 3 线程可能触发部分服务商的限流（429），脚本会自动重试 1 次。
- 图片题需要模型支持视觉（如 `gpt-4o`、`qwen-vl-*`、`glm-4v`），且需在「高级设置」中开启图片题优化。
- API Key 明文存于油猴 `GM_setValue`，请不要在公共电脑上保存。
