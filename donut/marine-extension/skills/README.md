# Skills（品牌话术包）

每个品牌一个文件夹 `skills/<品牌>/`。**挂载** = 把文件夹放进来；**移除** = 删掉文件夹。
Scholay 运行时只加载 `skills/scholay/generated/` 下的编译资产：

| 文件 | 对应你说的 | 作用 |
|---|---|---|
| `generated/personas.json` | 人格要求 | 12 个虚构人格卡、硬边界和 9 维有效行为参数 |
| `generated/comment-exemplars.json` | 评论参考 | 360 条按人格、主题、平台和品牌模式索引的 style-only 样例 |
| `generated/generation-policy.json` | 生成/反馈规则 | 身份、亲历、事实、品牌次数、长度和发布边界 |
| `generated/manifest.json` | 数据血缘 | 源工作簿哈希、版本、范围、数量和资产哈希 |

根目录中的 `品牌.md`、`执行口径.md`、`母稿.md`、`母稿索引.json`、`风格参数.json`、
`评论口径.md` 和 `范文.md` 都是历史资料，运行时不加载。尤其不能再把母稿里的第一人称
投稿、录用或内部关系叙事当作人格事实。

编译命令（只读源工作簿）：

```bash
python3 scripts/compile_scholay_corpus.py
python3 scripts/compile_scholay_corpus.py --check
```

## 新增一个品牌
复制 `_模板/` → 改名为品牌名（如 `skills/你的品牌/`）→ 按各文件里的提示填写。

## AI 连接器怎么用
总流程与输出契约见项目根目录的 `AGENTS.md`。插件先按「字幕 → 评论 → 结构化正文」
选择唯一页面来源，再按 Profile 人格、页面主题和品牌模式检索最多 3 条同人格样例。服务端在
返回前执行结构、品牌、能力点、虚构亲历、攻击词和近期重复校验，失败时有限修复重试；只有
最终合格的 `done` 文本才会写入页面草稿。

默认只有页面同时出现 `Scholay` 产品上下文与受信能力词时才进入品牌必提模式；裸品牌、
裸能力词和通用审稿描述都不会触发。当前 360 条样例全部来自 Bilibili，因此知乎、小红书、
抖音等平台在没有同平台或通用样例时只使用人格与策略，不跨平台冒用 B 站范文。
