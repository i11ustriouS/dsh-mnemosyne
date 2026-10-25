# 发布到 DSH 官方插件库（awesome-dsh-plugin）

## 官方机制

**不是 npm publish**，是往 GitHub 仓库提 PR：

```
仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
方式：新增一个 YAML 文件 data/plugins/<owner>__<repo>.yml
效果：README 与 https://awesome-dsh-plugin.com 自动重新生成
```

官方要求（摘自 contributing.md）：

- 一个插件一个文件，文件名 `<owner>__<repo>.yml`
- `url` 必须与仓库完全一致
- `name` 是列表里显示的链接文字，格式 `owner/repo`
- `description.en` 必填（中文可留空，维护者会补）
- **描述含 `: `（冒号+空格）必须加引号**，否则 YAML 解析失败
- README 由脚本生成，**不要手工编辑**
- 同时给仓库打上 `dsh-plugin` topic

## 前置条件（按依赖顺序）

| # | 条件 | 状态 |
|---|---|---|
| 1 | 插件代码可运行、自检通过 | ✅ 115/115 |
| 2 | 本地 git 仓库就绪 | ✅ 2 次提交 |
| 3 | **推送到 GitHub**（公开仓库） | ❌ **卡住：github.com 不可达 + 无凭据** |
| 4 | 仓库打 `dsh-plugin` topic | ❌ 需先有仓库 |
| 5 | 提 PR 到 awesome-dsh-plugin | ❌ 依赖 #3 |

## 卡点

```
github.com               → 不可达
api.github.com           → 不可达
raw.githubusercontent.com → 不可达
gh-proxy.com             → ✅ 可用（仅能读，不能推）
```

机器上配了代理 `127.0.0.1:7897`，但代理软件没运行。

## 投稿文件

已按官方格式写好：`publish/awesome-dsh-plugin.yml`

**提交前需替换 `<OWNER>`**（你的 GitHub 用户名，共 3 处）。

## 恢复网络后要做的

```bash
# 1) 配代理（假设代理端口 7897）
git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897

# 2) 推仓库（先建好空仓库，替换 <OWNER> 和 <TOKEN>）
git remote add origin https://<TOKEN>@github.com/<OWNER>/dsh-mnemosyne.git
git push -u origin main

# 3) 打 topic（网页操作，或 gh CLI）
#    Settings → Topics → 添加 dsh-plugin

# 4) Fork awesome-dsh-plugin，新增投稿文件，提 PR
#    data/plugins/<OWNER>__dsh-mnemosyne.yml

# 5) 验证收录
#    打开 https://awesome-dsh-plugin.com 搜索 dsh-mnemosyne
```

## 竞品现状（memory 类 292 个）

| 插件 | 特点 |
|---|---|
| `dsh-mnemon` | 三层记忆：Runtime Memory / 可检索 Documents / 受监督 Memory Spaces |
| `dsh-mneme` | SQLite + Markdown 镜像，后台自动巩固（去重/合并/冲突裁决），6 个记忆工具 |
| `dsh-memoria` | 向量+图后端，HNSW + FTS5 + 知识图谱 RRF 融合 |
| `dsh-memento` | 有界分层、带审批门、可审计，零依赖 SQLite |
| `hindsight` | 会学习的 Agent 长期记忆，按仓库隔离的记忆银行（53k stars） |

**Mnemosyne 的差异点**（投稿描述里要突出）：

- **分层注入**：框架常驻 + 索引按需 + 原文留库，不把整库塞进上下文（多数竞品是全量注入或只给工具）
- **人设框架自动生成**：模型从记忆里归纳「你是谁」，带三道防污染闸门（其他插件没有这个）
- **记忆固化**：合并重复 / 话题压摘要 / 归档低价值，全程可逆
- **存储压缩**：追加流重写，实测 4.7 MB → 355 KB
- **零第三方依赖**：只用 Node 内置模块