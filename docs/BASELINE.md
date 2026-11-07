# 代码基线与迁移记录

核对日期：2026-11-07。只读核对，旧仓库没有被修改、提交或推送。

## 来源

| 项目 | 本机目录 | HEAD | 远端与版本 |
| --- | --- | --- | --- |
| 人生广场 | `../life-plaza` | `72d4482a50aeba64bce5fe5a25c3fb06c60c02f2` | `xiaojinyu868-w/life-learn`，本地 main 跟踪 origin/source/main；本次 ls-remote 确认 source/main 同 SHA |
| 学中文 | `../life-plaza-learn-chinese` | `c5821e3e9ec255743cf3145b5d96614aee16b3b6` | `xiaojinyu868-w/life-plaza-learn-chinese`；本地 main 与已记录的 origin/main 一致，本次未单独在线复核远端 tip |

`life-learn` 的远端 main 本次读到 `c46403b4e1dd9a40c07dbed3776f8cbe12f7f0c9`，不能用它代替本机开发源码。人生广场工作区仍有 `deploy/meetmind.conf` 的未提交修改，不搬运、不覆盖。

## 已确认的结构

人生广场有原生 ESM + Three.js/Vite 前端源码（`src/`）、原生 Node HTTP 服务端（`server/`）、场景及素材、测试和产品研究文档。根目录没有 README/AGENTS。

学中文的后端包含 `server/learn/`；学习层为独立的 `www/life-learn/learn/learn.js` 与 CSS。其 `www/life-learn/assets/` 是已构建后再排版的前端，不是理想的长期源码基线。`inject/` 还包含场景台词补丁，需要逐项映射到源模块。

## 现有能力与缺口

| 能力 | 代码证据 | 当前性质 |
| --- | --- | --- |
| HSK 查表、分词、拼音、等级规则 | `server/learn/hsk.mjs`、`rules.mjs` | 本地 HSK 3.0 数据与规则 |
| 拼音字幕、词卡、纠错 | 学习层、`server/learn/api.mjs` | 已有实现，未在本次重新运行验证 |
| 易混词、搭配、偏误、语料 | `graphOf()` | 默认由模型生成，JSON 标 `source: "mock"`；旧代码注释说明页面未展示该标记 |
| 词汇链 | `chainOf()` | 共用汉字并按等级排序，不是真实图谱或先修关系 |
| 语音与人物对话 | `server/lib/`、`server/spaces/` | 可复用，模型调用仍需运行配置 |
| 窗户动作与教学台词 | `docs/LEARNING.md`、场景补丁 | 有现成参考，尚非“说话即控制动作”的完整闭环 |
| 小龙学习伙伴、跨场景掌握记录 | 本次材料提出 | 尚未完成代码接续或实现审计，不能声称现有版本已有 |

## 启动核对发现

- 人生广场 `package.json` 中 `dev` 指向 `scripts/dev.mjs`，但本机该文件不存在。不能照抄 `npm run dev` 作为已验证的一键启动。
- 人生广场 `vite.config.js` 默认前端 5188、API 8790；`dev:web` 脚本另写了 5180，历史文档也有其他端口。新项目需统一明确配置。
- 学中文 `scripts/dev.mjs` 默认前端 8080、API 8794，`npm start` 读取 `.env`。本次没有启动或调用模型。

## 建议迁移顺序

1. 保留新的独立 Git 历史与唯一新远端，不复制旧 `.git`、运行数据、密钥、部署环境或个人媒体。
2. 迁入人生广场的可维护源代码与运行必需资源，记录来源 SHA；检查 GitHub 单文件大小和已有资产署名。
3. 迁入学中文 `server/learn/`、HSK 数据与独立学习层；逐项比对其对 `server/index.mjs`、LLM、语音、引路人与场景的改动，不能覆盖新旧差异。
4. 把构建产物补丁转成源码改动。保留学中文 LICENSE、NOTICE 与 HSK 数据署名；不要擅自为全部继承资产重新声明许可证。
5. 修正新项目启动入口和端口后，验证学习接口、场景、语音失败处理与构建，再接真实数据。

这里是迁移计划，不是完成记录。新仓库当前尚无应用源码。
