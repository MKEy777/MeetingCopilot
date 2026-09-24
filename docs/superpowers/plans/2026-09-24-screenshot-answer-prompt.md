# 截图回答提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新截图视觉提示词，使面试截图先内部区分编程题和问答题，并按 ACM、牛客、题型和语言规则输出可直接使用的结果。

**Architecture:** 保持现有 `buildVisionMessages` 的单次多模态请求和流式响应链路，只替换系统消息中的行为规则。简历参考资料仍由同一函数拼接到系统消息末尾，截图和用户问题仍作为同一条多模态用户消息发送。

**Tech Stack:** TypeScript、Electron 主进程 LLM prompt builder、OpenAI 兼容视觉模型消息格式。

## Global Constraints

- 只修改 `electron/llm/prompts.ts` 中 `buildVisionMessages` 的系统提示词。
- 保留现有视觉模型调用、流式输出、截图消息结构和第二简历优先规则。
- 编程题只使用 C++ 或 Python；算法题使用 C++，Agent 实现题使用 Python。
- ACM 输出完整程序；牛客只输出题目要求的函数或类实现。
- 编程题只输出代码，凝练注释和时间/空间复杂度写在代码内。
- 问答题只输出可直接使用的答案或正确选项。
- 不添加或运行自动化测试；使用静态差异检查确认范围和语法字符串完整性。

---

### Task 1: Replace the screenshot system prompt

**Files:**
- Modify: `electron/llm/prompts.ts:258-262` (`buildVisionMessages` system prompt construction)
- Test: none; this is a prompt-only behavior change and the user did not request automated tests

**Interfaces:**
- Consumes: `question`, screenshot `imageDataUrl`, optional `resume` and `secondResume` arguments already accepted by `buildVisionMessages`.
- Produces: the same `ChatMessage[]` shape, with an expanded Chinese system instruction and the existing optional reference block.

- [x] **Step 1: Preserve the existing reference assembly**

Keep the `references` array and its `第二简历`/`简历` labels unchanged. The new system instruction must remain concatenated with the existing `===== 面试参考资料 =====` block so the model still receives background material.

- [x] **Step 2: Replace only the base instruction text**

Use a single system string with this decision order:

```text
你是面试截图答题助手。请先在内部判断截图内容属于编程题还是问答题，禁止把分类过程、推理过程或客套话输出给用户。只返回用户可以直接使用的结果。

如果是编程题：
1. 根据题面、输入输出说明、代码模板和函数签名判断是 ACM 格式还是牛客格式。
2. 语言只能在 C++ 和 Python 中选择：算法题使用 C++；实现 Agent 相关功能使用 Python。语言和题型以截图内容为准。
3. ACM 格式输出可直接提交的完整程序，包含必要的输入输出处理。
4. 牛客格式只输出截图要求的函数或类实现，不自行补充完整 main 模板。
5. 只输出代码（可以放在一个代码块中），不要在代码块外写解释。代码内用凝练注释说明关键步骤，并在代码注释中写明时间复杂度和空间复杂度。

如果是问答题：
1. 直接输出简洁、准确、可以照着回答的答案。
2. 如果是选择题，只输出正确选项或选项内容。
3. 不输出分类结果、长篇分析、推理过程或“答案如下”等前缀。

回答优先采用第二简历。两份资料冲突时以第二简历为准；不得把参考资料中的示例说成用户亲身经历。与截图问题无关的参考资料不要加入答案。
```

- [x] **Step 3: Keep the multimodal user message compatible**

Leave the image item and the `question.trim()` fallback unchanged. The fallback remains `解读这页内容的要点，并给出我应该怎么回应的建议。`, and the system instruction applies the same classification rules when no custom question is supplied.

- [x] **Step 4: Inspect the focused diff**

Run:

```powershell
git diff --check -- electron/llm/prompts.ts
git diff -- electron/llm/prompts.ts
```

Expected: no whitespace errors; only the base screenshot system instruction changes, while reference concatenation and the user image/text message remain intact.

- [x] **Step 5: Preserve pre-existing working-tree changes**

`electron/llm/prompts.ts` already contained unrelated uncommitted changes before this task. Leave the focused prompt change in the working tree instead of staging the whole file, which would commit those unrelated changes as well.
