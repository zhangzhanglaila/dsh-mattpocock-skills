# Changelog

## [0.1.0] - 2026-11-09

首个版本。把 [mattpocock/skills](https://github.com/mattpocock/skills) 以插件
形式搬进 DeepSeek Harness，**内容逐字节保持一致**。

同步基线：上游 `1.3.2`，commit `4ae2317`（`v1.3.2` 之后 2 个提交）。

### Added

- Cordis 插件 `lib/index.js`：在 `ctx.skills` 的 **host 层**注册一个 skill
  provider（provider 名 `dsh-mattpocock-skills`，`rank` 350，`source`
  `bundled-mattpocock`），`list()` 惰性发现、`get()` 按需读取正文，
  `resourceBase` 指向技能目录，使 `PHASE-BOUNDARIES.md` 等相对引用可解析。
- **27 个技能**原文（= 上游 `.claude-plugin/plugin.json` 发布清单）：
  20 个 engineering + 7 个 productivity，含上游新增的 `implement-spec`、`pr`、
  `retro`。每个技能的 `SKILL.md` 与全部引用文件、`agents/openai.yaml` 一并携带。
- `catalog.json`：同步期解析出的 frontmatter（name / description / whenToUse /
  metadata）、调用策略、正文哈希，以及**每个文件的 SHA-256**。
- `scripts/sync-upstream.mjs`：按上游发布清单整目录同步，严格解析 YAML 子集
  （折叠标量、列表、锚点等一律报错而非猜测），重写 `catalog.json`，并清理上游
  已删除的技能目录。
- `scripts/verify.mjs`：三重校验 —— 文件字节与清单一致、正文切片哈希一致、
  provider 契约（`provider` 自洽、`rank` 有限、`source` 为字符串、kebab-case
  名称、`resourceBase` 为目录、abort 后返回空）；可选 `--upstream` 与上游
  clone 逐字节比对；并断言运行时零外部依赖。
- `cordis.patch.yml` / `dsh.plugin.json`：bundle 层插入与插件清单。

### 与"简单搬运"的差别

- 不改名：`GLOSSARY.md` / `GLOSSARY-MAP.md` 保持上游用词，不回退到旧
  `CONTEXT.md`。
- 不删步骤：`implement` 保留"先抓 ticket 并报标题"以及"call the Skill tool
  with `tdd` / `code-review`"这些上游刻意补上的链条。
- 不擅自改路径：不存在 `docs/agentstriage-labels.md` 这类因批量替换而少一个
  斜杠的错误。
- rank 350：压过 `~/.dsh/skills`(400) 与 `~/.agents/skills`(500) 的旧副本，
  同时仍可被项目级 `.dsh/skills`(100) / `.agents/skills`(200) 覆盖。

### Notes

- 无 UI、无运行时依赖、无网络访问；技能正文只在 `get()` 时读一次。
- 不随包分发 Claude Code 的 `.claude-plugin/`：DSH 用 `dsh.plugin.json` 与
  `cordis.patch.yml` 表达同一件事。
