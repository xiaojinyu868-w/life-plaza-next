# Marble 场景降采样与格式验证

核对日期：2026-11-08。真实新能源汽车车间文件尚未在交付包中提供。下面的厨房仅用于公开格式兼容性测试，没有放进课堂，也不能替代车间交付。

## 降采样

Node.js 22，无 npm 依赖：

```powershell
node scripts/splat-downsample.mjs '实际车间.spz' --points 100000 --output 'artifacts/worlds/workshop-100k.splat'
```

支持 SPZ 格式 v2/v3（gzip 或解压后的内容）、ASCII / binary little-endian PLY，以及 32 字节每点的 `.splat`。输出固定为本项目现有渲染器可读的 `.splat`；不要把扩展名改成 `.spz`。SPZ v4、big-endian PLY、顶点 list 属性等未支持格式会明确报错，不猜测解码。

`--points` 为 1–10000000 的整数。源点数不足时保留全部点，不复制点凑数。输入和解压后的数据限制为 512 MiB；文件已存在时拒绝覆盖，需要覆盖输出可显式加 `--force`，但仍禁止覆盖输入及其符号链接/硬链接。

采样方法：把空间位置归一化为 Morton 排序键，再按均匀秩分段取样，选出确定数量的原始 Gaussian。没有随机种子，同一输入和参数产生相同字节。它保留点密度的大致分布，不是重新训练、Gaussian 合并或画质最优的压缩器。

所选点的位置、线性尺度和 RGBA 保留。旋转归一化后按 `.splat` 规范量化为 8 位 wxyz，因此不是无损；高阶球谐不进入 `.splat`（当前课堂渲染器也没有使用这些系数）。需要比较细节、远景和透明边缘后决定 100k、250k 或 500k 档，不能仅按点数认定画质合格。

## 在课件中使用

先在场景面板载入输出文件，做自动对齐与各站构图检查，保存位置。验证后再内嵌：

```powershell
$env:MARBLE = (Resolve-Path 'artifacts/worlds/workshop-100k.splat').Path
$env:PLACE = '这里替换为场景面板复制的有效 JSON'
node build.js 'dist/插电工坊_车间验收版.html'
```

以上 PLACE 是说明占位符，不能直接执行。实际参数取自同一车间文件的场景面板。不要把旧药房位置或测试厨房参数带到车间。

## 已完成的验证

`node --test test/splat-downsample.test.mjs`：6 项测试通过，覆盖非均匀点簇、精确点数、确定性、属性往返、旋转误差、ASCII/CRLF/整数属性 PLY、坏文件、版本边界、覆盖与硬链接保护。

真实样例来自 [World Labs 官方导出规格页](https://docs.worldlabs.ai/marble/export/specs) 的 [Rustic kitchen 500k SPZ](https://wlt-ai-cdn.art/example_exports/rustic_kitchen_with_natural_light/rustic_kitchen_with_natural_light_500k.spz)。本次读取文件头确认：500000 点，SPZ v2，7582907 字节，SHA-256 为 `351f5f2ceb6ee9095a4b4100f864db9780a21cc6bdb8a70c6f88117cbb1d5fe0`。

真实 500k → 100k 采样输出 3200000 字节，SHA-256 为 `7d765be583f8d2e8b92845b3b0f1efddb24943014c8d68983d11b0289ad03f02`。本机采样及输出阶段约 209ms，不含下载和解码；这个数字不是核显帧率或首屏加载时间。

### SPZ v3 互操作验证

五个 World Labs 500k 官方下载样例以及 Niantic 的两个仓库样例，本次读到的格式头都是 v2。库的发布版本号不等于文件格式版本号。

为实测 v3，本次使用 [Niantic 官方在线工具](https://nianticlabs.github.io/spz/) 提供的官方 WASM 编解码模块，把上述真实 500k 场景重新编码为格式 v3，然后分别由官方解码器和课堂现有 `src/splat.js` 解码，逐点比较所有位置、尺度、旋转和 RGBA。

| 结果 | 实测值 |
| --- | --- |
| 比较点数 | 500000 |
| 位置最大误差 | 0 |
| 尺度最大相对误差 | 5.11e-8 |
| 四元数分量最大误差 | 1.79e-7 |
| RGBA 最大字节差 | 0 |
| v3 文件大小 | 8209312 字节 |
| v3 SHA-256 | `07ce1f1fd0472c4cf2285b7ff2c4d3841940900fd7a56d346a045f71322aa696` |
| 继续减为 100k 并用课堂解码器读回 | 通过 |

官方模块源地址为 `https://nianticlabs.github.io/spz/spz.js`，本次模块 SHA-256 为 `238f0a666478d64f2610246e01d2d0bab80f74e74c2a41e037be207440a06872`。未改动官方模块的编码逻辑。本地完整报告在 `artifacts/splat-check/official-v3/verification.json`。

这是**真实场景经官方编码器产生的 v3 互操作测试**，不是手写二进制假样例；也不是用户车间的原生导出验证或浏览器画面验收。真实车间到位后仍要重新验证其版本、坐标、对齐、构图与表现。

复现命令（先从上述官方地址下载模块到忽略目录并核对哈希）：

```powershell
node scripts/splat-verify-official.mjs --module .local/spz-official/spz.mjs --input .local/spz-official/rustic_kitchen_500k.spz --out artifacts/splat-check/official-v3
```

外部官方模块与样例只存 `.local/`，验证大文件只存 `artifacts/`，均未提交仓库。互操作脚本只接受明确传入的本地模块，不自动联网；普通单测不加载外部代码。

## 浏览器渲染器的点预算与 LOD

`src/splat.js` 现在内置 `hierarchical-grid-prefix-v1`，不需要另加脚本依赖。完整源点云及位置/尺度/颜色/四元数保留不改；只建立一份源索引排列，每个预算取排列前 N 个，再为这 N 个点计算变换后的纹理与深度排序。**没有截取深度排序前 N 点**，相机转动不会改变入选点，降低预算也不会只剩近处或远处的一层。

空间选择按点云包围盒分成 32³ 个格子。先覆盖非空的 8 个大区域，再逐层覆盖 4³、8³、16³、32³ 区域；每格的代表优先选该格最高 alpha（并列按确定顺序），避免透明点代表可见邻点。覆盖全部非空格后，按格轮流追加其余点。原文件索引按位反转顺序分散，不依赖随机种子。低档严格是高档的前缀；切回高档可以恢复同一批点与同样的打包属性。

“覆盖”元数据只表示源空间中的非空格/大区域有代表点，不表示画面没有孔洞或每个区域都在屏幕内。它不是视角自适应误差度量，也没有合并高斯或自动补偿被删点的透明度。低预算仍会降低密度；具体画面要用目标车间检验。

### 应用挂载

```js
const world = new CDG_SPLAT.SplatWorld(gl, {
  pointBudget: 100000,       // 默认 10 万
  maxActivePoints: 500000,   // 默认绘制上限 50 万
  maxSourcePoints: 2000000,  // 默认完整源点云上限 200 万
  onMetadata: meta => updatePointCount(meta.activePoints, meta.sourcePoints)
});

// 原有 decode + setData 调用保持可用。
const decoded = await CDG_SPLAT.decode(arrayBuffer, file.name);
world.setData(decoded, { pointBudget: 100000 });

// 或把分阶段载入交给 renderer；返回 metadata，不是 decoded cloud。
const meta = await world.load(arrayBuffer, file.name, {
  pointBudget: 100000,
  onProgress: event => updateLoadingPhase(event.phase)
});
// 完整只读源数据在 world.src；world.n 是实际绘制点数。

world.setPointBudget(50000); // 可逆，原数据未改
world.setPointBudget(100000);
const selectedSourceIndices = world.getSelection(); // 防御性复制
const status = world.getMetadata();
// 切换/退出整个 renderer 时释放纹理、缓冲区、程序及源数据引用。
world.dispose();
```

`load(ArrayBuffer,name,options)` 会在重阶段之间让出一次事件循环，使界面有机会显示进度；解码、选点和打包本身仍在调用线程执行，尚未使用 Worker。它拒绝被较新载入/`setData` 替换的旧请求；释放后也不再继续上传。失败不伪装为完成。

进度顺序为 `loading → decode → [decompress → decode] → decoded → select → pack → ready`，解压阶段只用于 SPZ。loading 保证 `phase,inputBytes`；decode/decompress 保证 `phase,inputBytes,elapsedMs`；decoded 另带 `sourcePoints,format,decodedBytes,decodeMs`。select/pack/ready 为 `getMetadata()` 的形状；select 时旧源可能仍显示，只有 ready 表示新的数据可用。UI 可先只显示阶段文本，再用 ready 的计数。

`getMetadata()` 提供：

- `sourcePoints/activePoints/requestedBudget/maxActivePoints/allocatedPointCapacity`，用于区分原数量、绘制数和申请预算。
- `selection.algorithm/grid/occupiedCells/coveredCells/occupiedOctants/coveredOctants/bounds`，用于说明空间选点范围。
- `inputBytes/decodedBytes/decodeMs/selectionMs/packMs/loadMs`，区分载入和选点阶段；这些是调用端时间，不等于 GPU 完成时间或首个可用画面时间。
- `memory.sourceBytes/indexBytes/selectionBuildPeakBytes/cpuWorkingBytes/gpuTextureBytes/gpuIndexBytes`，为显式 typed array 和纹理/索引尺寸估算；不包括浏览器、驱动内部副本和调用方仍持有的输入文件。
- `autoLOD` 配置、最近窗口平均帧间隔和剩余冷却帧；`lastBudgetReason` 区分 load/manual/sustained-frame-time。

房间对齐的 `stats()` 使用固定的源空间样本（最多 4 万），与当前绘制预算无关。切换点数不会移动推断出来的地面和网格位置。保留原网格先画并写深度、泼溅深度测试且不写深度的分层方式。

### 可选慢帧降级

```js
world.setAutoLOD({ enabled: true, targetMs: 1000 / 30, minPoints: 25000 });
// 在应用 requestAnimationFrame 循环中：
const changed = world.observeFrame(frameDeltaMs);
```

渲染器 API 默认关闭自动降级，应用可以显式开启。默认每 45 帧取均值，连续两个窗口超过目标间隔的 1.2 倍时，将当前点数乘 0.75；随后冷却 180 帧，最低 25000 点。超过 250ms 的暂停帧、无效值和隐藏场景不参与统计。不会自动升档；手动 `setPointBudget` 可恢复高档并重置冷却。

降级后的值可能为 75000、56250 等，界面固定预设列表应补一个“当前自动预算”选项或另外显示实际值。`observeFrame` 观察整个应用的帧间隔，**不能证明瓶颈来自 GPU 或点云**；它是可关闭的负载保护，不是核显性能认证。

### 受控内存

默认输入文件与解压后字节数上限各 128 MiB，`decode/load` 可用 `maxInputBytes/maxDecodedBytes` 显式改到最高 512 MiB。gzip 逐块累计，越限取消；SPZ/PLY/splat 的声明点数在大属性数组分配前检查。超过默认 200 万点的场景应先用降采样工具制作浏览器版，或明确调整源点上限。

源属性占 44 字节/点，渐进索引固定 4 字节/点。构造时还需要临时分组索引（4 字节/点）及约 0.5 MiB 格子数组，完成后释放引用。渲染器只打包当前档位；排序键、世界坐标、深度与上传缓冲重复利用，没有每帧新建 N 个排序键。CPU 工作区增长到曾用过的最高档后保留用于复用，最多受 `maxActivePoints` 限制；降档减少绘制和 GPU 纹理尺寸，不立即释放 CPU 已分配容量。需要立即回收旧工作区时 dispose 并重建。

### LOD 验证结果与边界

```powershell
node --test test/splat-lod.test.js test/splat-downsample.test.mjs
```

共 15 项通过：9 项 LOD/载入测试及原 6 项离线降采样测试。包括密集近区与稀疏远区的空间覆盖、层级/平面/重合点、确定性、精确数量、嵌套子集、源属性不变、所选源点与位置/RGBA/旋转协方差逐项对应、切档后的房间统计不变、深度分层命令、降级滞回与手动恢复、加载取消、边界与释放。

已有的真实官方编码 v3 文件参与了 500000 点读取和 1000/8000 点往返切档；先核对文件 SHA-256，再确认完整源属性 hash 不变。它的 32³ 非空格为 1459，8000 点预算覆盖全部这些格及 8 个大区域。本机某次 Node 运行选点约 84ms，**只作算法记录，不能用于宣称 GPU 帧率**。此测试用 GL 命令记录器核对打包与调用，不是浏览器 WebGL 驱动测试。缺少本地真实文件时这一项显式 skip，基础单测不下载素材。

新增 LOD 后又运行官方 WASM 编解码回归：真实 500k 场景重编码 v3，和现有解析器全量比较的位置、尺度、四元数、RGBA 误差仍与上表一致；100k `.splat` 往返仍通过。

## 本机真实浏览器补充验证（2026-11-08）

`node scripts/browser-splat-check.cjs` 使用同一个本地 500k 官方编码 v3 样本，在 Edge headless、1440×900、ANGLE / NVIDIA RTX 4060 Laptop / D3D11 上加载。某次从选择文件到载入状态为 407ms；25k→250k→100k 切档恢复成功，原始点数仍为 500k，网格对象保留，问师傅可用，换回代码车间成功，GL 错误为 0、HTTP 请求为 0。50 帧短观察的中位间隔约 6.1ms、p95约6.2ms。

这些数值仅是当前开发机的加载与渲染检查，含操作系统缓存和短采样；不是冷启动首帧、核显性能或真实车间构图验收。样本是厨房，尺寸与车间不匹配，界面也提示放不下；没有将此素材放入发布构建。质量切换的进度状态会恢复 ready，应用默认开启可关闭的慢帧降档。证据在忽略目录 `artifacts/splat-browser/`。

## 尚待实物验收

- 用户提供的新能源汽车实训车间 world，并确认中间及右侧能容纳全部交互网格。
- 实际车间在各站的相机位置，尤其展示区与质检台，不能仅依赖布局算术测试。
- 真实浏览器的首屏 ≤ 5 秒与中端核显 ≥ 30 fps。格式解码和采样速度不能代替这些指标。
- 按网络下载多份独立分辨率文件的流式加载尚未实现；当前 LOD 在同一份已解码点云中切换子集。

SPZ v2/v3 的核心属性解析与原高斯着色路径保持不变。工具的 PLY 读取额外正确处理 CRLF、ASCII 与整数属性；浏览器 PLY 读取器未在本任务中改动。因此遇到这种 PLY 可先用本工具转换成 `.splat` 再载入。
