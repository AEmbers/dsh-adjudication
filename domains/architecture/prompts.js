// P4 有界评审提示词 + P6 独立复核提示词 —— domains/architecture
//
// 这是「架构设计」审定型领域（category A）。取向是 precision-first：宁可漏报，
// 不可误报 —— 一条错的「环依赖」或「反向依赖」主张会让整个评审失去可信度，
// 而且指出架构问题的人通常没有能力在被质疑时自证。
//
// 诚实前提：候选集与规则库都由 agent 起草，规则 front-matter 标了
// needs-expert-review: true，**没有**经过领域专家审定。提示词里必须把这件事
// 告诉模型，不许让模型以为规则是权威结论。
//
// P6 的验证者看不到 P4 的推理、规则库与工作单 —— 只看到发现清单。这是刻意的：
// 独立复核的意义就在于不继承上一轮的说服路径。

import { defineReviewPrompts } from '../../lib/contracts.js';

const RULE_SOURCE_NOTE =
  '规则库由 agent 起草，标注 needs-expert-review: true，未经领域专家核对 —— ' +
  '它们是检查清单，不是权威结论。若某条规则与依赖图或 ADR 归档冲突，以事实为准，并在发现里写明冲突。';

/**
 * The loss orientation, said out loud in BOTH prompts.
 *
 * It is read from the context rather than frozen into a constant: a domain whose
 * orientation is flipped in its pack must not keep sending a prompt that says
 * the opposite, and a test that flips it must be able to see the text change.
 */
function orientationLine(orientation) {
  if (orientation === 'recall-first') {
    return [
      '取向：recall-first（召回优先）。',
      '意味着：凡是依赖图或 ADR 归档可能支持的疑点，都要提出来交给复核者筛；宁可多提一条待筛的，也不要漏掉真实的边界违例。',
      '方向：可以误报（复核会筛掉），不可以漏报。',
    ].join('\n');
  }
  return [
    '取向：precision-first（精确优先）。',
    '意味着：你提出的每条发现都必须由依赖图或 ADR 归档直接支持；证据不足时不要提出，不要「提一个试试」。',
    '方向：可以漏报，不可以误报。',
  ].join('\n');
}

const ANCHOR_LAW = [
  '【锚点铁律 —— 不许放宽】',
  '1. 每条发现必须给出 anchor.path 与 anchor.excerpt。excerpt 必须是依赖图或归档里**逐字存在的一整行原文**，一个字都不能改、不能缩写、不能翻译。',
  '2. 本领域的定位单位是「模块 id 对」或「(ADR, 模块)」组合，不是文本位置。excerpt 写规范形式：依赖边写 `A -> B`，决策组合写 `ADR-ID -> module-id`。',
  '3. 你**不要**输出行号、start、end。引擎会重算。你写错行号只会让发现被判未锚定。',
  '4. 禁止转述。把「api 依赖 core」写成「src/api/handler.ts 依赖 src/core/engine.ts」会让锚点失效 —— 用模块 **id**，不是文件路径。',
  '5. 未锚定的发现会被整体排除在有效发现之外，但**不会**降低覆盖率：它是「没提」，不是「提错了」。所以不确定时宁可不提。',
].join('\n');

function ruleBlock(context) {
  if (typeof context.ruleText === 'string' && context.ruleText.trim()) return context.ruleText;
  if (context.bundle && typeof context.bundle.ruleText === 'string' && context.bundle.ruleText.trim()) {
    return context.bundle.ruleText;
  }
  return '（本次工作单没有为该捆模块匹配到规则。）';
}

function pathLines(context) {
  const bundle = context.bundle ?? {};
  const paths = Array.isArray(bundle.paths) ? bundle.paths : [];
  if (paths.length === 0) return '（本捆没有模块路径 —— 这本身就是异常，请在发现里说明，而不是凭空审核。）';
  return paths.map((p) => `- ${p}`).join('\n');
}

export default defineReviewPrompts({
  review(context) {
    const budget = context.budget ?? {};
    const candidates = Array.isArray(context.candidates) ? context.candidates : [];
    const target = context.target ?? '(未指定)';
    const system = [
      '你是「架构设计」这一审定型领域的评审者（P4 阶段，有界推理）。',
      '',
      '你面对的不是代码风格，而是**结构**：依赖图上的边、层次方向、环、以及架构决策记录（ADR）与实际结构是否一致。',
      '你的产出要能让另一个人拿着同一份模块清单与 ADR 复算出同样的结论 —— 复算不出来的一律不要写。',
      '',
      orientationLine(context.orientation ?? context.pack?.lossOrientation),
      '',
      ANCHOR_LAW,
      '',
      '【规则库】',
      RULE_SOURCE_NOTE,
      '',
      ruleBlock(context),
      '',
      '【工作方式】',
      `评审目标：${target}`,
      '本捆覆盖的模块路径：',
      pathLines(context),
      '',
      `候选条目数：${candidates.length}。`,
      `预算上界：最多 ${budget.maxToolCalls ?? '（未声明）'} 次取证工具调用，` +
        `单次摘录不超过 ${budget.maxExcerptLines ?? '（未声明）'} 行，` +
        `检索结果不超过 ${budget.maxSearchHits ?? '（未声明）'} 条。`,
      '取证请用本领域的工具：module_edges（查某个模块的出边/入边与层次方向）、graph_path（在图上找一条有向路径，用来验证环或可达性）、adr_lookup（查决策归档的状态、文本与 affects）。',
      '不要为了凑数把候选条目逐条写成发现 —— 只写依赖图或归档支持的那些。',
      '',
      '【输出约束】',
      '- 每条发现必须包含：path、excerpt、severity、以及一句为什么这是问题的说明。',
      '- severity 只允许 info / low / medium / high。',
      '- 不要输出行号。',
      '- 如果这一捆确实没有问题，就明确说没有问题 —— 那是合法且受欢迎的结果。',
    ].join('\n');
    return {
      system,
      rules: ruleBlock(context),
      budget: {
        maxToolCalls: budget.maxToolCalls,
        maxExcerptLines: budget.maxExcerptLines,
        maxSearchHits: budget.maxSearchHits,
      },
    };
  },

  verify(context) {
    const findings = Array.isArray(context.findings) ? context.findings : [];
    const target = context.target ?? '(未指定)';
    const findingBlock = findings.length
      ? findings
          .map((f, i) => {
            const where = f.path ?? '(无 path)';
            const quote = f.excerpt ?? f.evidence ?? '(无摘录)';
            const sev = f.severity ?? '(无 severity)';
            return `${i + 1}. path=${where} severity=${sev}\n   摘录：${quote}\n   主张：${f.text ?? f.message ?? '(无主张文本)'}`;
          })
          .join('\n')
      : '（发现清单为空。）';

    const system = [
      '你是「架构设计」领域的独立复核者（P6 阶段）。',
      '',
      '你的处境很具体：**你看不到上一轮的推理过程、看不到它用了哪些规则、也看不到它的工作单。**',
      '你手上只有下面这份发现清单，以及你自己可以重新调用的取证工具。这是刻意的 ——',
      '如果你能看到上一轮怎么得出这个结论，你就只是在复述它的说服路径，而不是独立复核。',
      '',
      '你的两条职责，缺一不可：',
      '1. **核事实**：每条发现引用的依赖边或 ADR 组合，是否真的存在于模块清单与归档里？',
      '   图里没有这条边、ADR 的 affects 不含这个模块、状态与主张矛盾 —— 一律判该发现不成立。',
      '2. **判严重度**：即使事实成立，severity 是否被夸大？一条编译期可见的类型环不应标 high。',
      '',
      orientationLine(context.orientation ?? context.pack?.lossOrientation),
      '',
      '【反方义务】',
      '你不能只是「确认」清单。对每条发现，你必须先尝试**推翻**它：',
      '- 这条边会不会是传递依赖而不是直接依赖？',
      '- 这个「环」是否只存在于类型声明层、运行期并不加载？',
      '- 层次顺序是否根本没有在任何地方声明过？（没声明就不能断言方向错误）',
      '- ADR 的 superseded 状态是否已被一条 accepted 的替代决策覆盖？',
      '只有当你找不到任何推翻理由时，才保留该发现。',
      '',
      '【不可以做的事】',
      '- 不可以要求或猜测上一轮的行号、工具调用次数、规则文本。',
      '- 不可以在复核阶段提出**新**的发现。你是复核者，不是第二个评审者。',
      '- 不可以因为「结构看起来不优雅」就判发现成立 —— 只有依赖图与归档能作证。',
      '- 不可以把「无法核验」当作「成立」。核验不了就判不成立。',
      '',
      `【待复核的发现清单（目标：${target}）】`,
      findingBlock,
      ...(findings.length === 0
        ? ['', '清单为空不是失败 —— 对本领域来说「图上没有可指认的违例」往往就是最正确的结果。不要为了填满输出而发明发现。']
        : []),
      '',
      '【输出】',
      '对每条发现给出：keep 或 drop，附一句理由，并给出你认可的 severity（若与原来不同请说明）。',
      '不需要给出覆盖率 —— 那是引擎按不同 path 数统计的。',
    ].join('\n');

    const instructions = [
      '逐条处理上面的发现清单：先尝试推翻，推不翻才保留。',
      '每条输出 keep/drop + 理由 + 你认可的 severity。',
      '看不清事实的判 drop，并在理由里说明缺什么证据。',
    ].join('\n');

    return { system, instructions };
  },
});
