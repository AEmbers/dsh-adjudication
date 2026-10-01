---
name: motion-and-reduced-motion
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

动效未尊重减弱动效偏好：存在大幅位移动画或自动播放动效，但没有 prefers-reduced-motion 降级。
取证义务：给出该动效的位移/时长与缺失的降级分支。
不算：纯淡入淡出且时长 < 200ms 的过渡。
