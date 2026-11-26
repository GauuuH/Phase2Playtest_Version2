# 项目约定（每次会话自动生效）

## Git 工作流（必须遵守）
- 每次代码更改完成后，自动执行 `git add -A` → `git commit` → `git push origin main`，不需要等用户确认。
- Commit message 使用 Conventional Commits 风格（`fix:` / `feat:` / `chore:` 等），英文摘要即可。
- 若 push 失败（网络/认证问题），在回复中明确报告错误原因，不要静默忽略。
- 本文件（AGENTS.md）的修改同样要提交并推送。

## 长期约束
- 不修改现有游戏玩法；不更换服务器（SHARE_CONFIG）；不迁移 SharedRoom。
- sketch.js 内容有变更时，同步更新 index.html 中 sketch.js 的缓存版本号（?v=N，递增）。
