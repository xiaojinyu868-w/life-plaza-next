# 腾讯 SOE 中文句子朗读适配器

核对日期：2026-11-08。实现位于 `server/tencent-soe.mjs`，运行环境 Node.js 22+，使用原生 WebSocket 和 `node:crypto`。本次完成代码与本地模拟协议测试；没有发起腾讯计费请求，没有真人录音测评，不能据此声称账户已开通、网络已连通或教学效果已验收。

## 官方依据与实现范围

- [WebSocket 接口与鉴权](https://cloud.tencent.com/document/product/1774/107497)：参数按字典序拼接未编码的签名原文，以 HMAC-SHA1 和 Base64 生成签名；实际 URL 再编码。应用握手确认后发送音频，随后发送结束消息，收到最终标记后关闭连接。
- [中文句子评测](https://cloud.tencent.com/document/product/1774/107396)：本适配器采用句子模式的 30 汉字、60 秒上限，并开启官方的声调检测指令。`Tone.Valid` 为真仍需检查两个声调值；文档中的无效值不能转成轻声。
- [官方关联的数据结构](https://cloud.tencent.com/document/api/884/19320)：使用 `SuggestedScore`、`PronAccuracy`、`PronFluency`、`PronCompletion`、`Words`、`PhoneInfos`、`MatchTag` 和 `Tone` 的含义。逐词表属于评测对齐资料；没有独立转写字段可据此生成 ASR 文本。

官方 Python 示例的录音模式注释出现 300 秒，和当前产品句子模式文档不同；本实现采用当前句子模式的 60 秒边界。接入没有复制示例中打印签名 URL 的做法。[官方示例](https://github.com/TencentCloud/tencentcloud-speech-sdk-python/blob/master/examples/soe/soeexample.py)

适配器只接收中文普通文本朗读，不接受调用方注入厂商命令、自定义拼音、英文、数字文本或多分支语法。参考文本允许常见标点，但最多 30 个汉字、总长 120 个 UTF-16 单元。`open` 返回不支持，由主服务决定是否使用独立 ASR。

## 调用合同

```javascript
import { createTencentSoe } from './server/tencent-soe.mjs';

const assessor = createTencentSoe({
  appId,            // 字符串；由主服务从运行时环境传入
  secretId,
  secretKey,
  scoreCoeff: 1,   // 可配置 1..4；不代表已完成年龄/难度标定
  timeoutMs: 15000,
  handshakeTimeoutMs: 5000,
});

// 创建工厂不会调用网络；只有下方 assess 在凭据、输入均有效时才连接厂商。
const result = await assessor.assess({
  audio: wavBytes,  // Blob、Buffer、Uint8Array 或 ArrayBuffer
  referenceText: '驱动电机',
  mode: 'read',
  signal: abortController.signal,
});
```

返回的 `configured` 只表示工厂参数符合本地格式；不表示账号有效、服务可用或已经授权计费。模块不自行读取环境变量，不自动重试，不记录音频、凭据、签名 URL、原始供应商错误消息。

可注入的第二个参数用于协议测试：

```javascript
createTencentSoe(config, {
  WebSocketImpl,                  // 默认 globalThis.WebSocket
  webSocketFactory: url => ws,    // 可选；优先于 WebSocketImpl，必须同步返回 EventTarget 风格 socket
  now: () => Date.now(),          // 毫秒，签名时间与延迟记录
  nonce: () => positiveInteger,   // 1..9999999999，生产默认 crypto.randomInt
  voiceId: () => uniqueId,        // 1..128 位 ASCII 字母、数字、下划线或连字符；默认 randomUUID
});
```

导出辅助函数为 `parsePcm16Wav`、`validateReferenceText`、`normalizeTencentResult` 和 `SoeInputError`。辅助函数的输入错误仅包含固定代码，不包含用户音频、凭据或 URL。

## 固定请求与音频校验

| 项目 | 本实现 |
| --- | --- |
| 目标 | `wss://soe.cloud.tencent.com/soe/api/<appid>`，不接受任意目标地址 |
| 模型与评测 | `server_engine_type=16k_zh`、`eval_mode=1`、`text_mode=0` |
| 录音上传 | `rec_mode=1`；一次二进制 PCM 消息，再发 `{"type":"end"}` |
| 音频编码 | `voice_format=0`；先验证 WAV，再只发送 PCM 数据块 |
| 中间断句 | `sentence_info_enabled=0`；中间句不得替代最终综合结果 |
| 参考文本 | 服务端添加固定前缀 `{::cmd{F_TDET=true}}`；客户端不能添加其他命令 |
| 签名有效期 | 本实现设为签名时间后 300 秒，不在客户端保存或显示 |

WAV 必须为 RIFF/WAVE、未压缩 PCM、16 kHz、16 bit、单声道。检查 RIFF 总长、块边界和补齐、格式参数、字节率、帧大小、数据偶数长度、重复格式/数据块和时长。元数据总空间与块数量也有本地上限；不执行转码，不依据 MIME 声称音频合法。最大 PCM 为 1,920,000 字节。

总超时覆盖 Blob 读取、连接、握手、上传后的等待。另设握手超时；取消或完成会移除监听器并关闭 socket，迟到消息不修改结果。每条响应、累计响应和消息数量受限。只接受 JSON，供应商示例中无法解析的调试字符串不会被执行或猜测转换。

## 返回值与来源

公共字段始终包含 `ok`、`vendor:'tencent-soe'`、`mode`、`referenceText`、`transcript:''`、`transcriptSource:'none'`、`overall`、`words`、`seal:false`。本模块**始终不提供独立识别文本**；主服务只有在另外取得 `transcriptSource:'recognition'` 的 ASR 结果时，才能用它提交语义答案。

| 字段 | 映射与边界 |
| --- | --- |
| `overall` | 直接来自合法的 `SuggestedScore`，不重算、不补零；无效或拒识时为 null |
| `metrics` | 官方准确度、流利度、完整度，保持原量纲；非法值置 null |
| `words[].w` | `Words.Word`，标记 `wordSource:'assessment-alignment'`，不是 ASR 转写 |
| `referenceRange` | 按顺序与所给参考文本逐字匹配的码点范围 `[start,end)`；未知为 null，不证明实际说出了该词 |
| `matchTag` | 保留 0..4；缺少、未录入或未知标签不产生有效音频分数和声调 |
| `chars[]` | 仅厂商单汉字词项产生一个字符项；多字词的一个调不复制到每个字 |
| `chars[].tone` | 只有 `Valid===true`、两个调为整数 1..4、有实际词分数、标签合适且对齐到参考文本时返回 `{valid:true,ref,got,ok}`，其余为 null |
| `phones` | 有限保留官方音素与分数；不由拼音字典生成、不把音素拼接冒充拼音 |
| `capability` | 有可用单字调时为 `L2`；只有真实发音分数时为 `pronunciation`；失败为 `unavailable` |

负的准确度拒识、无人声及无有效语音返回明确原因，不能当成“零分”。有合法整体评测但没有有效声调时，仍可展示发音评测；不得生成声调纠正，也不得说已经获得 L2。新增词或无法对齐的词保留有限评测信息，但不生成参考声调纠正。

当前主服务选择只把有效声调结果交给 L2 面板；本适配器返回 `pronunciation` 而非 L2 时，主服务优先尝试独立 ASR。没有 ASR 则返回不可用，让课堂使用浏览器识别、打字或点选。因此适配器保留的总分不代表当前课堂一定会展示它，也不代表转写出答题文本。

## 验证与待验收

运行 `node --test test/tencent-soe.test.mjs`。测试使用合成 WAV、注入的 socket 和固定的测试凭据，验证协议及边界，不依赖任何真实服务。签名固定向量另用 .NET HMACSHA1 核对。

正式验收仍需独立完成：腾讯账户权限与费用确认、真实 WSS 联通、厂商返回样本兼容性、实际麦克风音频、说话人与噪声差异、声调纠正的教学有效性，以及独立 ASR 与朗读评测的联合体验。当前的 `configured` 与本地测试结果都不能替代这些验证。
