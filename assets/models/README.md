# 小龙模型来源与课堂版本

2026-11-09，按用户参考图 7 和图 8 使用 Tripo 国内 v3 图生模型接口生成。图片是用户提供的造型参考，不随本目录复制；不为参考图或全部生成内容重新声明公共许可证。

| 形象 | 已采用的任务 ID | 原始 GLB | 课堂 GLB | 三角形 |
| --- | --- | --- | --- | --- |
| 幼年小龙 | `c3f58877-f573-49d1-8a68-fd7bb4c1b229` | `xiaolong-child/model_url.glb` | `xiaolong-child/model.runtime.glb` | 37,676 |
| 青少年小龙 | `aee736df-09e6-43f7-9230-093025e56e05` | `xiaolong-youth-preserve/model_url.glb` | `xiaolong-youth-preserve/model.runtime.glb` | 38,256 |

每个目录的 `generation.json` 记录输入图片哈希、任务、参数、消耗和原始结果哈希；`model.runtime.optimization.json` 记录纹理处理及几何校验。`rendered_image_url.png` 是供应商预览，课堂实际加载 GLB。

两版使用 `v3.1-20260211`、详细几何与贴图、PBR、40,000 面上限、原图颜色对齐。幼年版开启自动修图；青少年最终版关闭自动修图，保留参考图中的成对鹿角。青少年首个任务 `da1b5690-05d5-47ab-a61b-e64d93bd64f8` 虽生成成功，但缺少双角，未进入课堂；原件保存在本机忽略目录 `.local/rejected-assets/xiaolong-youth-initial/`。三个任务各 60 积分，总计 180。

原始模型各有三张 4096×4096 贴图，合计 50,331,648 像素，超过课堂加载预算。`scripts/prepare-character.cjs` 将最大边长缩至 2048，合计 12,582,912 像素；几何 bufferView 逐字节不变，UV、索引、变换和材质引用不变。JPEG 重编码有损，原件始终保留。

`content/characters.json` 指向课堂版本，编译时校验哈希、来源和路径后内嵌单文件 HTML。默认朝向为 +X，与课堂角色一致；身高分别归一化为 1.35 和 1.8 场景单位，底部落到地面。镜头和位置按实际模型调整，数值不表示角色真实身高。

当前模型为静态姿态，只有课堂的整体移动和待机起伏。未生成骨骼、走路动作、口型或肢体动画。角色加载先验证并上传 GPU 资源，成功后替换；失败保留当前角色，课堂继续。

接口依据：[Tripo 国内介绍](https://developers.tripo3d.com/zh/docs/introduction)、[图生模型 H 系列](https://developers.tripo3d.com/zh/docs/generation-image-to-model/standard)。凭据只在运行时使用，模型和清单中不保存 Key 或签名下载地址。
