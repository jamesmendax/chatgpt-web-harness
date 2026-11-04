import assert from "node:assert/strict";
import { routeSkills } from "../dist/lib/skill-routing.js";
import { shouldExposeTool } from "../dist/lib/tool-profile.js";

const HASH = "a".repeat(64);
const make = (id, description, { enabled = true, implicit = true } = {}) => ({
  id, name: id, description, enabled, shadowedBy: undefined, error: undefined,
  content_sha256: HASH, source: "installed", path: "/synthetic/" + id,
  dir: "/synthetic/" + id, aliases: [], layout: { references: [], workflows: [], scripts: [] },
  invocation_policy: { allow_implicit: implicit, allow_explicit: true },
});
const catalog = [
  make("ui-ux-pro-max", "UI/UX design intelligence for web, mobile, desktop. Designing, reviewing and fixing interfaces, pages, components, layout, typography and design systems."),
  make("refactoring-ui", "Design rulebook and diagnostic layer for web UI. Refining UI, visual hierarchy, layout and spacing, typography and finishing touches."),
  make("design-taste-frontend", "Anti-slop frontend skill, art direction for websites and app screens, including dashboard and settings, with visual inspection."),
  make("huashu-design", "花叔 Design 用 HTML 做高保真原型、幻灯片、SVG 动画和可视化。"),
  make("project-engineering", "Modify real codebases with engineering awareness: coding, debugging, tests, migration safety and preserving git state."),
  make("ds-blast-radius", "Traces callers, configuration, data formats and dependencies before risky changes."),
  make("visual-qa", "Testing and verification of visual web UI with real browser screenshots; visual-qa feedback loop."),
  make("ds-explain", "Explains how code, functions, modules and subsystems work using real source paths."),
  make("ds-pr", "Create PR and post comments on a remote repository, explicitly only.", { implicit: false }),
  make("disabled-prototype", "UI/UX design intelligence for web, mobile, desktop.", { enabled: false }),
  ...Array.from({ length: 65 }, (_, i) => make("unrelated-" + String(i).padStart(2, "0"), "Specialized archive record cataloguing")),
];

function route(task, phase = "auto", skills = catalog) {
  return routeSkills(skills, { task, phase, limit: 3 });
}
{
  const result = route("请把设置页新控件的 UI 风格和原来的 Aura 保持一致，修复对齐问题", "design");
  assert.equal(result.status, "matched");
  assert.equal(result.primary?.id, "ui-ux-pro-max");
  assert.ok(result.supporting.some(s => ["refactoring-ui", "design-taste-frontend"].includes(s.id)));
  assert.ok(!result.supporting.some(s => s.id === "huashu-design"), "do not pile unrelated prototype Skill onto UI refinements");
  assert.equal(result.primary?.invocation_mode, "implicit");
  assert.equal(result.primary?.content_sha256, HASH);
}
{
  const result = route("修复旧版账号迁移的密钥和 Skills 配置，保留原始数据和回滚能力", "migrate");
  assert.equal(result.primary?.id, "project-engineering");
  assert.ok(!result.supporting.some(s => s.id === "ds-pr"));
}
{
  const result = route("创建一个 SVG 动画高保真 HTML 原型", "design");
  assert.equal(result.primary?.id, "huashu-design");
}
{
  const design = route("修复设置页 UI，并测试其布局", "design");
  const testing = route("修复设置页 UI，并测试其布局", "test");
  assert.equal(design.primary?.id, "ui-ux-pro-max");
  assert.equal(testing.primary?.id, "visual-qa", "phase change must select a test specialist");
}
{
  const result = route("解释为什么源码里的函数不工作，先只读分析，不修改文件", "explain");
  assert.equal(result.primary?.id, "ds-explain");
}
{
  assert.equal(route("明天天气怎么样").status, "no_match");
  assert.equal(route("请列出我的账号名称").status, "no_match");
  assert.equal(route("不使用任何 Skill，解释这段代码").status, "suppressed");
  assert.equal(route("without skills, just explain a function").status, "suppressed");
}
{
  const result = route("请做 UI 设计", "design", [
    make("disabled-only", "UI/UX design intelligence", { enabled: false }),
    make("manual-only", "UI/UX design intelligence", { implicit: false }),
  ]);
  assert.equal(result.status, "no_match");
  assert.equal(result.considered, 0);
}
{
  const result = route("帮我执行 PR 发布", "implement");
  assert.ok(result.primary?.id !== "ds-pr");
  assert.ok(!result.supporting.some(s => s.id === "ds-pr"));
}
{
  assert.equal(shouldExposeTool("route_skills", "slim"), true);
  assert.equal(shouldExposeTool("route_skills", "full"), true);
  assert.ok(catalog.length > 70, "selection must inspect beyond an abbreviated alphabetical metadata page");
}
console.log("skill routing: 10 focused scenarios PASS; eligibility, phase change, no-match, policy and slim/full exposure");
for (const task of ["别用技能，帮我解释代码", "无需调用任何技能", "不要任何技能，帮我解释代码", "do not use any of the skills, explain how code works", "don't use skills, explain code", "avoid skills please", "不使用任何 Skill，解释这段代码"]) {
  assert.equal(route(task).status, "suppressed", task);
}
assert.equal(route("Translate this text into Chinese", "auto", [make("random", "Analyze text data and produce charts.")]).status, "no_match");
for (const task of ["制作财务 Excel 表格", "Create financial Excel spreadsheets"]) {
  assert.equal(route(task, "auto", [make("finance-sheet", "Create financial Excel spreadsheets and 财务表格 with audited formulas.")]).primary?.id, "finance-sheet");
}
console.log("skill routing: refusal variations, generic-token negative and unlisted-domain positive PASS");
