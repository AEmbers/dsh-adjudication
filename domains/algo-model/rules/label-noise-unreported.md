---
name: label-noise-unreported
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

标签噪声未报告：训练数据存在标注冲突/错误，而结论把它当成信号。
失败模式：模型学到噪声，指标在干净测试集上被高估或低估。
取证义务：给出标注冲突的证据（重复样本、标注一致性统计）或明确声明未评估。
不算：无任何噪声证据时不算缺陷，只能要求补充度量。
