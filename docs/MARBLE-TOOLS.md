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

## 尚待实物验收

- 用户提供的新能源汽车实训车间 world，并确认中间及右侧能容纳全部交互网格。
- 实际车间在各站的相机位置，尤其展示区与质检台，不能仅依赖布局算术测试。
- 真实浏览器的首屏 ≤ 5 秒与中端核显 ≥ 30 fps。格式解码和采样速度不能代替这些指标。
- 多分辨率自动加载/切换尚未实现，本工具提供可制作不同点数版本的离线步骤。

当前保留原渲染器。工具的 PLY 读取额外正确处理 CRLF、ASCII 与整数属性；原浏览器 PLY 读取器未在本任务中改动。因此遇到这种 PLY 可先用本工具转换成 `.splat` 再载入。
