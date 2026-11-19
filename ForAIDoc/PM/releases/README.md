# 发布说明仓库

每个已发布版本一份：`v<version>.md`，与 GitHub Release 正文、应用内更新日志同源。

## 为什么放在这里

发布说明以前只写在被忽略的 `artifacts/` 里，清一次目录或换台机器就再也查不到“当时到底发了什么”。放进版本控制后，说明随代码一起评审、可以追溯，发布脚本也能直接读到。

## 格式

```markdown
# P4Deck 0.1.16

## 中文

- 第一条
- 第二条

## English

- First bullet
- Second bullet
```

要求：

- 标题必须是 `# P4Deck <version>`，与文件名一致。
- `## 中文` 与 `## English` 两节都必须存在且非空；中文段必须含中文字符，英文段不能含中文。
- 列表项写在一行内，应用内更新日志按行生成条目，不换行。

## 相关命令

```powershell
node scripts/validate-release-notes.mjs --version 0.1.16 ForAIDoc/PM/releases/v0.1.16.md
pnpm release:bump --version 0.1.16 --notes-file ForAIDoc/PM/releases/v0.1.16.md
node scripts/publish-update.mjs          # 未指定 --notes-file 时自动取本目录同名文件
pnpm release:verify --version 0.1.16     # 发布后核验，结果写到本目录
```

`verify-<version>.json` 是发布后匿名核验的证据文件，也建议随版本提交。

## 历史

- `v0.1.12`–`v0.1.14`：双语格式，从 `artifacts/` 迁入。
- `v0.1.11` 及更早：当版只有中文，保留原样，不再作为格式样板。
