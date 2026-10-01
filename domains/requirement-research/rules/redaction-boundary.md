---
name: redaction-boundary
match:
  - sessions/**
needs-expert-review: true
title: 脱敏边界
severity: high
source: agent-drafted (t8); 尚无专家背书
---
脱敏句不得据以推断被脱敏的内容。

失败模式：「[金额] 太多了」被解读为具体金额量级。

取证义务：标注该句为脱敏材料，结论不得依赖它。

不算：脱敏位置之外的文字仍是有效材料。
