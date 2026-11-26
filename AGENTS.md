# 项目约定（每次会话自动生效）

## Git 工作流（必须遵守）
- 每次代码更改完成后，自动执行 `git add -A` → `git commit` → `git push origin main`，不需要等用户确认。
- Commit message 使用 Conventional Commits 风格（`fix:` / `feat:` / `chore:` 等），英文摘要即可。
- 若 push 失败（网络/认证问题），在回复中明确报告错误原因，不要静默忽略。
- 本文件（AGENTS.md）的修改同样要提交并推送。

## 长期约束
- 项目沿用 DECIDER 名称（页面标题与所有玩家可见界面文案使用 DECIDER / 英文）。
- 所有玩家可见界面文字使用英文（代码内部注释可用中文）。
- 不修改现有游戏玩法（规则/UI/操作/倾斜/摄像机/计分保持一致）。
- 手机端无方向按钮、无 CALIBRATE 按钮：滑动（上下）、倾斜（左右，JOIN/READY
  手势内自动请求授权并以首次读数自动校准）、双指点击（抢夺）；桌面保留 WASD/方向键调试。
- 赛制 = READY 准备机制：全员就绪自动 3 秒倒计时开赛（lobby → countdown → running），
  参与者名单开赛时锁定，中途加入者观战；下一局恢复 Not Ready。
- Object 为动态数量（2~13 个，按参与人数查表）+ Emoji 视觉，布局写入 shared.game.objects。
- 联机架构 = SharedRoom（MQTT）：js/vendor/mqtt.min.js + js/net.js，
  broker 为 wss://broker.emqx.io:8084/mqtt 与 wss://broker.hivemq.com:8884/mqtt
  （复用 DECIDER Phase2 旧项目 my-project-phase-2 的方案）。不要改回 p5-phone，不要更换服务器地址。
- sketch.js 内容有变更时，同步更新 index.html 中 sketch.js 的缓存版本号（?v=N，递增）。
