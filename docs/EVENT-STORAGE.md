# 匿名学习事件存储

实现：`server/event-store.mjs`。只管理配置目录内的 `learning-events.jsonl`，不读取录音、不管理语料缓存，不递归删除目录。

默认保留 **30 天**、文件容量 **64 MiB**。这两个数是当前工程默认值，不是学院已确认的数据政策。部署方应确定实际保留周期、访问权限和清理安排；修改配置需要让运行进程重新加载。

## 接口

```javascript
import { createEventStore, EventStoreError } from './server/event-store.mjs';

const store = createEventStore({
  dataDir,
  retentionDays: 30,
  maxBytes: 67108864,
  now: Date.now,
});

const result = await store.append(cleanedEvent);
await store.scan((event) => { /* 逐条累计班级统计，不返回个人事件 */ });
const state = await store.status();
```

- `append(cleanedEvent)`：必须传入服务端 `cleanEvent()` 的返回值。模块检查受控结构并在进入队列前复制快照，之后调用方修改原对象不会改变待写内容。成功返回 `{ok:true,stored:true,id}`。
- `scan(onEvent)`：先按配置清理过期记录，再流式回调有效保留事件。支持同步或异步回调，返回 `{ok:true,scanned,bytes,invalidRows,overlongRows,expiredRows}`。汇总方应等整个调用成功后再使用统计值；扫描中途失败的部分统计不能当完整结果。
- `status()`：串行、只读统计，不触发清理。包含 `enabled/retentionDays/maxBytes/bytes/validRows/retainedRows/expiredRows/invalidRows/overlongRows/capacityReached/prunedRows/lastPruneAt/cleanupWarning`，不包含文件路径、事件正文或会话 ID。

`prunedRows` 与 `lastPruneAt` 是该实例运行期间的清理计数，不是跨进程重启的历史审计。回调内不能等待同一存储路径的 `append/scan/status`，否则会形成队列死锁；模块会拒绝这种重入。

## 时间、容量与关闭

每次操作取一次服务器时钟，过期条件为：

```text
event.t < now - retentionDays × 86,400,000
```

恰好位于边界的事件保留。`t` 使用服务端清洗事件时生成的时间，不使用浏览器提供的时间。已过期的新事件返回 `{ok:true,stored:false,reason:'event_expired'}`。时钟向后调整时，时间在未来的有效记录继续保留；时钟向前跳跃则可能使记录提前到达清理条件，应维护可靠服务器时间。

`retentionDays=0` 表示不保存新事件，返回 `{ok:true,stored:false,reason:'storage_disabled'}`；**不会主动清理已有文件**，扫描仍可读取其有效旧事件。它不是“清空历史数据”按钮。空目录下的 status、scan 和关闭状态的 append 都不会创建数据目录。

追加前先清理能够确认过期的有效事件。若剩余字节加上新记录仍超过 `maxBytes`，抛出 `storage_full`；不删除近期事件或未知坏行来腾空间。恰好达到上限可以写入，下一次无法容纳的写入失败。`maxBytes=0` 不允许追加任何记录。已有文件超过新容量设置时，不做强制截断。

未知记录、坏 JSON、无效 UTF-8、未知类型/字段、空行和超长行都保留并计数，不回调给汇总逻辑。即使未知记录含有很旧的 `t`，也不能据此认定它属于可删除的现行 schema。它们继续占用容量，需要单独检查或明确的数据迁移；本模块不会猜测、修复或静默丢弃。

## 一致性与文件操作

同一 Node.js 进程内、相同规范化绝对路径的追加、清理、扫描和状态查询共用串行队列。扫描不会看到本模块写入到一半的记录；失败操作不会阻断后续队列。

读取块和可解析行各限制为 64 KiB。超过行上限后，以块为单位复制保留该行，不把整个坏行放进内存。扫描的回调逐条执行；回调自身若把所有事件积攒到数组中，仍可能占用大量内存，教师汇总应只累计所需指标。

清理先扫描确认存在过期有效事件，再在**同目录、独占新建**的唯一临时文件中写入保留内容。临时文件同步并关闭、原文件读取句柄关闭后，检查原文件未发生可检测变化，再执行 rename 替换。没有“先删原文件再改名”的步骤。失败时保留原文件，只尝试删除本次操作确实创建的临时文件；不会搜集和清除其他临时文件。

现有数据目录或事件文件若是符号链接、事件文件是硬链接或非普通文件，操作会被拒绝。Windows 使用 BigInt 文件标识避免大 inode 丢失精度，并兼容路径 stat 的设备号为 0、句柄 stat 返回实际设备号的差异；这不会放开符号链接检查。

追加发生已知部分写入后失败时，会核对文件身份和已写字节数，尝试将自己的未完成后缀回滚。Windows 使用独立的读写句柄回滚，因为 append-only 句柄可能不能 truncate。无法安全回滚时保留现状并设置 `cleanupWarning`，残缺行将在后续扫描中作为坏行保留。模块不会把失败的追加报告为成功。

## 错误代码

异常为 `EventStoreError`，只携带固定 `code`，不透出原始文件系统错误正文。

| code | 含义与主服务建议 |
| --- | --- |
| `storage_invalid_config` | 配置非法；启动时处理 |
| `storage_invalid_event` | 未经正确清洗或超出受控 schema；可映射 400 |
| `storage_full` | 配置容量不足，或操作系统报告磁盘空间不足；可映射 507 |
| `storage_unsafe_path` | 非安全的目录/文件类型或身份变化；可映射 503 |
| `storage_io_error` | 读写、关闭、替换或一致性检查失败；可映射 503 |
| `storage_invalid_clock` | 时钟未返回有效非负整数毫秒；可映射 503 |
| `storage_invalid_callback` | scan 参数不是函数；属于调用方错误 |
| `storage_scan_callback` | 汇总回调失败；不能采用部分统计 |
| `storage_reentrant` | 回调中重入同一路径的队列；不能等待该操作 |

旧 schema 如需支持，应明确扩展验证器；现有事件类型包含 `pronunciation_attempt`。存储层验证格式与受控字段，课程词汇、证据 ID 和业务允许范围仍由主服务的 `cleanEvent()` 负责，不能直接把浏览器请求交给存储层。

## 设计局限

- 仅支持单进程写入。多个进程、不同路径别名、外部编辑器或独立程序同时改文件不受队列保护；部署中应统一数据目录配置并保持单写者。实现会拒绝部分可检测的外部修改，但这不是跨进程锁。
- 清理按 append/scan 惰性触发，没有后台定时器。服务停止、长期无写入且无扫描时，过期记录可能仍在磁盘；status 只会显示它们，不删除。
- 该文件存储不是事务数据库。清理通过同步临时文件和同目录替换减少风险，但不承诺断电、磁盘损坏或文件系统故障下的数据库级持久性。进程崩溃可能留下自己的临时文件，重启后也不擅自删除它们。
- 文件权限以运行账号及所在文件系统为准；`0o600` 不能替代 Windows ACL 或部署访问控制。事件只有随机会话 ID 与受控学习字段，不等于对任何外部资料都不可关联的强匿名化。

## 验证

```powershell
node --test test/event-store.test.mjs
```

所有测试仅使用新建 temp 目录和合成记录，覆盖过期边界、零保留、容量满、未知/坏行、超长行、时钟变化、两个实例并发队列、关闭后替换、替换失败、外部变化检测和部分追加回滚。可选第二参数 `{fileSystem}` 仅用于注入本地文件系统失败测试；正常集成无需传入。
