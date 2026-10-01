---
name: token-adherence
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

Token 一致性：颜色、间距、字号、圆角、阴影、透明度被写成了硬编码值，而 token 表里有（或应当有）对应的 token。
取证义务：给出图层 ID、属性名、当前值，以及应为的 token 名 —— 该 token 必须真的存在于 token 表。
不算：值恰好等于某个 token 但属性已声明 tokenRef（那是正确用法）；token 表里根本没有对应语义的 token（那是「需要新增 token」，不是「用错 token」）。
