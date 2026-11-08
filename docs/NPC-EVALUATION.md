# NPC 真实模型验收工具

入口：`server/npc-evaluation.mjs`。题集：`content/evaluations/npc-50.json`。测试：`test/npc-evaluation.test.mjs`。

这是验收工具与开发阶段预注册题集。本次仅运行 dry-run 和注入 mock 的本地测试，没有真实模型成绩、付费调用或教师审核结论。固定题库已经被实现者看过，不能称为未知题盲测。

## 先生成清单，再决定是否调用

默认命令没有网络请求：

```powershell
node server/npc-evaluation.mjs
```

默认输出放在 `.local/evaluations/<runId>/`。dry-run 的 `observedRounds=0`、`providerRequests=0`；50 条记录只是计划条目，不是实际模型输出。

清单使用固定默认 seed。A02 从 30 个王明课内自然提问中按 `SHA256(seed + NUL + caseId)` 排序取前 20 个，记录抽样算法、完整 seed、20 个 ID、执行顺序、原始题集 SHA-256 和 plan hash。不要看过结果后反复改 seed 挑好成绩。

需要改变 seed 或只检查 20 问时，在预注册阶段指定：

```powershell
node server/npc-evaluation.mjs --seed classroom-pilot-01 --subset questions20
```

默认 `--subset all` 执行全部 50 个案例，A02 使用其中预先选出的 20 问；`questions20` 只执行该子集，不能完成 50 轮验收。全题集覆盖王明/小龙、HSK 1–3 与教师模式、各教学站、两课内容、事实、语法、未知问题、真实出处、客户端伪造、提示注入、角色与重复纠错。案例 32、34 会接收前一指定案例的实际最终回复，不用预写答案假装多轮对话。

## 显式真实调用

只有 `--live` 会创建真实模型服务，而且必须同时具有：

- `WORKSHOP_LLM_URL`
- `WORKSHOP_LLM_API_KEY`
- `WORKSHOP_LLM_MODEL`

工具不自动读取或使用 `DASHSCOPE_API_KEY`，也没有 CLI 密钥参数。先在运行时安全配置这些变量；如果需要 Node 从现有 `.env` 读取，应由操作者显式加上 Node 的选项。

复用已保存的预注册清单示例：

```powershell
node --env-file-if-exists=.env server/npc-evaluation.mjs --live --manifest ".local/evaluations/<dry-run目录>/manifest.json"
```

上面的命令会实际调用已配置供应商，可能计费，本次没有执行。`--manifest` 会核对题集 hash 与样本顺序，禁止同时覆盖 seed、价格、子集或每课轮数；新运行另存目录。请使用可明确识别的供应商模型版本，别名可能在不同日期改变。

每个案例采用独立匿名 session，按预注册顺序串行执行，避免 50 题意外撞到课堂单 session 额度。只有显式依赖关系共享两条受控历史。每轮仍走真实 `createServices().npc()` 的校验、重试和降级逻辑；评测器不替模型补成功答案。单轮超过评测外层 3.5 秒会记录超时；live 外层超时后停止新增调用，保留已有条目，不能把剩余题视为成功。

## 保存什么

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 调用前落盘的计划、模型名、模式、时间、运行 ID、Node 版本、相关源码与课程文件 hash；不包含密钥、接口 URL 或系统提示 |
| `results.jsonl` | 每个受控案例的最终文本、原始 assistant 候选、请求/验证事件、重试、回退、时间、usage 完整性和程序检查；逐条落盘 |
| `summary.json` | 默认无人审核的汇总；不会自动认定教学质量通过 |
| `teacher-review.template.json` | 与本次 manifest、response hashes 绑定的全 pending 审核模板 |
| `reviewed-summary.json` | 后续离线导入教师审核后的汇总；不再次调用模型 |

`onNpcTrace` 只采集白名单字段 `phase/requestIndex/elapsedMs/content/usage/reason/accepted/source/contentTruncated`；不会持久化请求 headers、请求正文或系统提示。已知密钥和鉴权文本被遮盖，结构化敏感字段与可识别的系统提示转储被剔除。`contentTruncated` 和 `contentRedacted` 必须保留：截断或遮盖过的候选不能称为完整原始输出，也不能完成完整的 50 轮原始样本审核。

这些文件包含受控提问与模型输出，应留在本机的私有评测目录，不放到公开静态目录，不把真人姓名、私人聊天或真实学员录音加入题集。原始输出不被当作命令执行。`--out` 可指定另一个本机目录，由操作者保证该目录不公开。

## 教师审核和计分

把模板另存为 `teacher-review.json`，由教师逐条看最终答复、候选、来源、案例期望以及重复对话。`reviewerId` 使用审阅者代号，填写 `reviewedAt`；每条明确设置：

- `verdict`: `pending`、`pass` 或 `fail`。
- `answersQuestion`: 是否实际答上该题；体面转回主线可能是安全表现，但不等于答上未知参数问题。
- `factSafe`、`levelAppropriate`、`errorProvenanceValid`、`sealSafe`、`roleAndPedagogy`: 各自的明确布尔判断。不适用的检查表示“未发生该类违规”，不能留空却宣称通过。

`pass` 必须同时满足五个质量字段为真。程序不会替教师填写判断。填错运行 ID、manifest hash、response hash，或只改一个总开关，都无法导入。hash 是完整性检查，不是教师身份认证或不可篡改签名。

```powershell
node server/npc-evaluation.mjs --review ".local/evaluations/<live目录>/teacher-review.json" --report-dir ".local/evaluations/<live目录>"
```

审核导入是离线操作，不需要 API Key，也不会触发调用。汇总结果如下区分：

| 验收项 | 工具能证明什么 | 不能偷换成什么 |
| --- | --- | --- |
| A02 | 预选 20 问全部审核后，真实模型回复、程序检查和教师审核合格且 `answersQuestion=true` 的数量至少 16 | 脚本回退、纯模板、mock 或未审条目不计为模型成功，分母仍是 20 |
| A05–A08 | 全 50 个真实模型最终回复、完整候选、等级标注/长度/印章/证据程序检查，以及教师内容审核 | 不足 50 个模型回复为不完整；服务端标注一致不能证明浏览器真的把词标橙，仍需界面验证 |
| 重复与角色 | 保存实际上一轮回复并标记措辞是否完全相同，供教师判断是否换说法、是否维持小龙角色 | 仅换几个字不能自动证明解释有效 |
| A12 | 服务端调用整轮耗时、3 秒内返回的模型回复数量 | 当前未流式返回，`firstTokenMs` 固定 null；不能用全包响应时间或提示音冒充首字 1.5 秒成绩。本工具不测浏览器呈现；新增浏览器分项计时及其限制见 [NPC-TIMING.md](NPC-TIMING.md) |
| A13 | 实际报告的输入/输出 token、重试次数、缺失 usage 和基于操作者报价的费用估算 | token 估算不是厂商账单；模型费用也不是包含语音、托管和税费的整课总价 |

## 价格与不完整 usage

价格仅由 CLI 或已保存 manifest 提供，工具不内置“当前厂商价格”。币种必须是三个大写字母，单位明确为每 1,000,000 token，输入与输出单价分开。

下面的 `1`、`2` 只是命令演示值，不是供应商报价；正式使用前替换并核实：

```powershell
node server/npc-evaluation.mjs --currency CNY --input-per-million 1 --output-per-million 2 --lesson-turns 20
```

所有尝试都计入，不只计最后成功一次。任一请求缺少 usage 时，`amount=null`、`complete=false`，只给已知 token 的 `lowerBound`。当下界是 0 时仍表示“尚不知道”，不表示免费。没有报价时为 `unknown-prices`，不填估算金额。`lessonScenario` 按这次题目组合的平均每轮费用乘指定轮数，明确是情景估算，不是实测每节课费用；语音、TTS、主机和其他费用单列为未包含。

## 本地验证

```powershell
node --test test/npc-evaluation.test.mjs
```

测试注入本地服务或 fetch，验证 hash/seed、禁用隐式真实调用、trace 接口、超时、回退不算分、缺 usage、审核绑定和敏感字段处理。测试中的“live report fixture”只是手工构造的汇总逻辑输入，不是厂商实测；程序化 `mock` 运行永远标 `not-live`，不能产生真实验收通过结论。
