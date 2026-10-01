---
name: requirement-without-binding
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

需求节点没有绑定任何跨域锚点（无 ref）。失败模式：这条需求无法被追溯到它从哪来（哪句用户原话、哪次会议记录），也无法被反向验证。取证义务：给出节点 ID、type 与它在图上的两侧邻居；若它的上下游都非空，说明缺的是**绑定**而不是衔接。不算：ref 存在但形状无法识别（那是 opaque-ref）；节点本身是外部产物（在 idSpace 里声明）。
