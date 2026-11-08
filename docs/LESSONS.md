# 可替换的课程包

`content/lessons/nev-l4.json` 保存第 4 课的完整教学内容与顺序；`nev-l5.json` 是同一运行器读取的能量回收试课。新增同类课程只需新建 JSON 并交给运行器，不需要增加 `stL5()` 或运行 JavaScript 字符串。

第 5 课是**待中文教师和专业教师审阅的自编样例**，不是经过核对的教材第 5 课，也没有声称教材页码或真实语料。其三个生词是“制动、动能、能量回收”，一个目标句式是“把……转化成……”。专业词和通用等级分开标注，不能把 `level.default: 2` 解读为所有词和语法均已通过 HSK 2 审核。

## 第 4 课迁移范围

| 站 | 完整保留的过程 |
|---|---|
| `intro` 入门 | 王明自我介绍、身份确认、说明课题、插电快照对比 |
| `a` X 光透视台 | 发动机/驱动电机/动力电池各跟读；插电式跟读；插电与保持未插电两条路径；搭配货架；混合动力跟读；三个辨认题；三个说词驱动部件题；整车名称与有证据的简称 |
| `b` 并联接头 | 先示范两个相同情况，再辨认“也”的位置；教材的四道插槽/整句题；按错误类型反馈，答对才启动两路动力 |
| `d` 教小龙 | 修改主语前错位的课堂改写句；解释混合动力；辨认相同的“电”；说新词；延伸到后续教材搭配 |
| `c` 质检台 | 两个确认热身；四个车辆事实判断；四个“对吗/呢”辨认；学员提出两个新问题，王明按车辆事实回答 |
| `end` 出厂 | 出厂台词、车辆离场、结算 |

站序是 `intro,a,b,d,c,end`；其中 **d 教小龙、c 质检**，与旧实现一致。JSON 有 39 个 `ask` 定义，其中 4 道题的插电/未插电选项分别定义。正常从未插电状态开始完整走 35 题；已插电进入则跳过开关题，共 34 题。题池按固定顺序执行，便于复现。

原包 `DICT`、40 条 `EV`、`CARD`、HSK 资料与字词链均随第 4 课迁入。数据是交付包中记录的 2026-11-07/08 检索快照，本次开发未重新实查这些检索。`hits:null` 表示条目记录了多组计数或搭配频次，不能强行补成单一总命中数。

货架也属于课程内容：`assets.shelf` 保存 `{bay,w,note,ev?,on?,grey?}`，`assets.shelfBayNames` 为三个分区标签。第 4 课完整保留原 12 项（6 项课本搭配、6 项语料扩展），第 5 课只有三个自编生词，不带证据或次数。运行器校验分区 0–2、每区最多五项以及证据引用，应用层从课程数据构建标签。

“插电”表示启用交付包的语料扩展，与联网开关独立。不开启扩展时，课堂仍保留已经修正的练习，不故意加入未经证实的错句。二选一的错误句是依据 `ln-ye-1` 主语前错位做的场景改写，并非学习者逐字原文。没有重新加入句尾“也”作为新生成的常见错误干扰项；原教材插槽及学员主动提交的句尾错误仍能诊断，反馈说明给定快照中其频率为零。

## 浏览器与 Node 接口

按顺序加载数据、`logic.js`、`lesson.js`。浏览器全局为 `CDG_LESSON`，Node 可 `require('./src/lesson.js')`。课程词典在加载 `logic.js` 前安装；判题的 `word` 检查读取课程词典，支持新增生词的拼音。字幕、词卡和服务端等级判断另用共享 `lexicon.js` 与完整2025词汇表，不再借识字表判词汇等级。

可选 `professionalWords` 是显式的场景专业词数组，最多200项，每项必须是 `dict` 已有词，不能重复。分词优先保留这些整词，但它们仍会按词汇表显示等级或“未收录”，不会因专业词身份获得超纲豁免。`vocabulary` 是本课目标词，包含普通词和语法，因此不能直接等同专业词名单。未设置此字段的旧课程仍可读取；新增课程应明确列出其必要专业词。

```js
const result = await CDG_LESSON.run(lesson, adapter, {
  get plugged() { return ST.plugged; },
  level: ST.level,
  startStation: 'intro' // 也接受从 0 开始的站索引
});
// { lesson: 'nev-l4', finished: true, plugged: boolean, level: 2 }
```

`plugged` 可为普通布尔值，运行器在 `plug` 动作成功后更新自己的状态；如界面允许随时切换，使用上述 getter，每次命令与判题前重新读取。`level` 必须在课程声明范围内。非法入口站、等级或课程在调用 adapter 前拒绝。

Adapter 的五个方法均可返回 Promise：

| 方法 | 合同 |
|---|---|
| `station(id,name)` | 进入课程中的站；更新导航、完成上一站与记录站事件。跳转取消由应用层负责。 |
| `say(who,line,options)` | `line:{zh,en?,teacher?}`；`options:{seal?,reply?,compare?}`。未插电会移除 `seal`。 |
| `ask(cfg)` | 使用同步 `cfg.check(text,chip)` 判题，错误时保持该题；成功后**原样**返回 `{text,r}`，其中 `r` 是最近一次成功检查得到的对象。 |
| `action(name,args)` | 执行下表中有限的 3D/UI 动作。异常必须拒绝 Promise，不吞掉错误。 |
| `finish()` | 展示当前课程结算、发出完成记录。只在课程最后执行一次。 |

`ask` 的 `cfg.step` 是课程声明的 ASCII 题目 ID。其他字段沿用应用层：`stage/task/options/optEn/examples/answer/hints/noInput/noAnswerChip/plugAction/speechTarget`。跟读“✓ 我读了”是自报完成；运行器只接受课程明确声明的这个选项，不把任意 chip 当作正确，也不把它计为发音已检测。

```js
async function ask(cfg) {
  // 实际界面中，用户可能提交多次；以下为一次成功提交的形状。
  const text = '驱动电机';
  const r = cfg.check(text, false);
  if (!r.ok) { /* 保持题目，显示 r.msg 与 r.fix */ }
  return { text, r };
}
```

每次判题的 `attempt` 动作按顺序排队；错误也可以产生插槽标记、火花与提示。运行器等待这些动作完成才进入下一题。Adapter 应对摄像机、动作延时以及旧流程取消统一做检查。运行器没有创建 DOM、音频或网络连接。

## Action 合同

| name | args 与效果 |
|---|---|
| `scene` | 可选 `{xray,labels,wang:'lift'|'show',dragon:false|'enter'|'show',stamp}`；`enter` 走入，`show` 放在展车区域；xray 应覆盖当前演示车辆。 |
| `camera` | `{view,seconds,part?}`；view 为 overview/car/charger/shelf/show/board/dragon/inspect/end/part；part 模式指定零件；end 为出厂初始机位。 |
| `focus` | `{part:'engine'|'motor'|'battery'|'port'|null,car?}`；无 car 时主车，car 为 ice/bev/phev 时展车。 |
| `compare` | `{word}` 从当前课程卡生成对照，或 `{value:{title,off,on}}` 显示指定对照。无对应真实语料时保持空数据/来源说明。 |
| `point` | `{value:boolean}` 王明指向动作。 |
| `pulse` | `{car:'ice'|'bev'|'phev'|null}` 单车强调；清理前一辆的材质。 |
| `flow` | `{car:'main'|'ice'|'bev'|'phev',fuel,elec,duration?,wheels?}`；duration 毫秒，到时关闭流动；用于第 4 课两路驱动示意。 |
| `board` | `{mode:'show',item,index,total}`、`{mode:'mark',item,result}` 或 `{mode:'hide'}`；item 是 `parts/cats/ok/en` 的“也”插槽题。 |
| `plug` | `{value:boolean}`，等待切换完成；不自动改变联网状态。 |
| `animate` | `{part}` 对应零件响应。 |
| `sparks` | `{dragon?:true}` 接错提示，可带小龙疑问动作。 |
| `toast` / `teacher` | `{text}` 简短学生提示 / 教师说明。 |
| `wait` | `{ms}`，范围 0–30000；应用层同时做取消检查。 |
| `departure` | `{car:'phev'}` 展车离场；应用层负责恢复位置、清理动作。 |

第 5 课答对后只聚焦/反馈动力电池部件，**没有把电池→电机的驱动流动冒充反向能量回收**。真实能量回收动画、刹车动态和各车型的能量效率还没有实现。离场动画只是课程结尾车辆开走。

## JSON 命令与安全边界

仅接受 `say / action / ask / if / pool / finish`。`if` 条件限 `all/any/not` 与 `path + is/in/contains/startsWith/truthy`，引用只允许 `state.plugged/level/focus`、`input/normalized/chip/answer`、`result.*`。`{$ref:'result.part'}` 传递数据；字符串 `{{result.word}}` 只插入字符串值，不执行表达式。

`ask.check.type` 限以下八类：

| type | 调用/用途 |
|---|---|
| `word` | 现有 `L.heardWord`，支持 target/others/alts 与明确的 selfReport；新增课程的拼音从 `lesson.dict` 读取。 |
| `confirm` | `L.judgeConfirm`，声明 truth 与否定后所需 fixes。 |
| `yeItem` | `L.judgeYeItem`，点击插槽与自由整句均可；越界插槽不接受。 |
| `dragonFix` | `L.judgeDragonFix`，现有“也”改错目标。 |
| `whyHybrid` | `L.judgeWhyHybrid`，混合动力解释；仅说出两个部件会提示完整句。 |
| `dianWord` | `L.judgeDianWord`，字词迁移。 |
| `question` | `L.parseQuestion/answerQuestion`，解析三类车的已有谓语并按事实回应。 |
| `choice` | 确定答案集合的归一匹配，默认 exact；contains/prefix 只用于明确适用的操作文本。 |

`feedback` 是按条件匹配的列表，第一条命中后给 `msg/seal/suggest`；`attempt` 只可含 action 与 if；`after` 在正确作答后执行。纠错建议复用 `L.suggest`，动态建议类型必须显式列举 `kinds`。缺少任何被引用的证据 ID（包括卡、对照、建议）均拒绝整个课程，不用虚构来源补齐。

`pool` 引用固定题池，可选正整数 count，按原顺序取前 count 项；不运行随机生成题，也不隐式执行模型返回内容。禁止循环题池、可执行函数、未知字段/命令/题型、不安全引用、重复题目 ID 和提前 finish；限制文档深度、节点数、命令数与运行命令预算。

`content/lesson.schema.json` 是 Draft 2020-12 结构规范。加载时还需执行 `CDG_LESSON.validate(lesson)`：JSON Schema 本身不能完整检查跨条目的证据引用、顺序与递归关系。Schema 校验通过不等于教学内容专业正确。

## 验证与当前限制

```powershell
node --test test/lesson.test.js
```

当前 12 项测试覆盖两课的完整插电/未插电路径、已插电开局、按站恢复、错误动作与证据反馈、完整 L4 数据保留、UMD 浏览器环境加载、仅替换 JSON 的新课程、新词拼音、否定/反向能量转换拒绝、非法命令/缺证据预先拒绝与 adapter 失败传播。另用本机 `jsonschema` 验证过 schema 自身和两份课程。

这些是运行器与适配合同测试，不等于浏览器摄像机、交互按钮、语音服务或真实车间素材验收。浏览器整合与可见交互须由应用层另测。第 5 课的整句答案是有限的正确变体集合，无法像开放语义模型一样接受所有合理改述；当前 `question` 的车辆谓语与专门的“也”检查也受现有 `logic.js` 范围约束。扩展新语法时可先使用确定题型；若需要全新的开放式判题，需增加并测试新的有限检查器，不能把代码塞入 JSON。
