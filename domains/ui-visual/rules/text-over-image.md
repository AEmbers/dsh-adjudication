---
name: text-over-image
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

图上文字可读性：文字叠加在图片上，但没有遮罩、描边或独立底色，且最坏情况下的对比度不达标。
取证义务：给出该文字颜色、图片的可能背景范围与**最坏情况下的计算比值**。
不算：文字位于图片的稳定纯色区域内，并以该区域实测值给出的比值达标。
