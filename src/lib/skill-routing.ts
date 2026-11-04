import type { SkillSummary } from "./skills-loader.js";

export type SkillRoutePhase = "auto" | "design" | "implement" | "review" | "test" | "migrate" | "explain";
export interface SkillRouteRequest {
  task: string;
  phase?: SkillRoutePhase;
  limit?: number;
}
export interface RoutedSkill {
  id: string;
  name: string;
  source: SkillSummary["source"];
  content_sha256: string;
  score: number;
  matched_capabilities: string[];
  invocation_mode: "implicit";
}
interface Capability {
  name: string;
  task: RegExp;
  skill: RegExp;
  weight: number;
  phases?: SkillRoutePhase[];
}

// Semantic facets, not a list of hard-coded Skill ids. Descriptions are
// untrusted metadata and never create permissions or instructions.
const CAPABILITIES: Capability[] = [
  { name: "interface", task: /(?:界面|前端|网页|页面|控件|组件|设置页|UI|UX|frontend|interface|dropdown|component|design system)/i,
    skill: /(?:ui\/ux|web ui|frontend|interfaces|app screens|websites|components|design systems|界面|前端|页面)/i, weight: 10, phases: ["design"] },
  { name: "visual-refinement", task: /(?:风格|对齐|间距|排版|配色|视觉|审美|美化|布局|不协调|层级|像素|polish|style|spacing|layout|typography|visual|design review)/i,
    skill: /(?:design rulebook|refining ui|visual hierarchy|design intelligence|anti-slop|art direction|typography|spacing|layout|设计审美|视觉)/i, weight: 8, phases: ["design", "review"] },
  { name: "prototype-animation", task: /(?:HTML|SVG|动画|动效|原型|高保真|幻灯片|PPT|GIF|animation|prototype|slide|motion)/i,
    skill: /(?:prototype|animation|web artifacts|svg|HTML|slides|ppt|motion|高保真|动画|幻灯片|原型)/i, weight: 9, phases: ["design"] },
  { name: "code-engineering", task: /(?:源码|代码|编程|仓库|项目开发|实现|开发|重构|TypeScript|JavaScript|Node\.js|调试|修复(?:代码|Bug|故障|缺陷|功能|迁移|接口|逻辑)|refactor|codebase|implement|debug|bugfix)/i,
    skill: /(?:modify real codebases|coding|debugging|engineering|repository|implementation|TDD|refactoring|代码|工程|开发|修复)/i, weight: 9, phases: ["implement"] },
  { name: "account-migration", task: /(?:账号迁移|账户迁移|导入旧|旧版本|旧版|配置迁移|密钥|备份恢复|回滚|migration|migrate|import account|credential|backward compatib)/i,
    skill: /(?:modify real codebases|engineering|data formats|dependencies|risk|migration|backward compatib|账户|账号|密钥|配置|兼容)/i, weight: 10, phases: ["migrate", "implement"] },
  { name: "runtime-testing", task: /(?:验收|测试|回归|单元测试|验证|运行检查|测试脚本|test|verify|validate|regression|QA|quality assurance)/i,
    skill: /(?:testing|verification|verify|regression|test|visual-qa|quality assurance|QA|测试|验证|验收)/i, weight: 8, phases: ["test", "review"] },
  { name: "browser-automation", task: /(?:浏览器操作|网页测试|截图验证|网页交互|浏览器自动化|browser automation|browser use|web app testing|browser test)/i,
    skill: /(?:browser-use|browser|web app testing|control.*browser|visual feedback)/i, weight: 10, phases: ["test", "implement"] },
  { name: "code-explanation", task: /(?:解释|讲解|为什么|说明代码|原理|只读分析|explain|how does.*work|read-only analysis)/i,
    skill: /(?:explains how code|code.*work|explain|分析|讲解|research)/i, weight: 10, phases: ["explain"] },
  { name: "skill-authoring", task: /(?:创建.{0,5}(?:技能|skill)|编写.{0,5}(?:技能|skill)|更新.{0,5}(?:技能|skill)|create a skill|build a skill)/i,
    skill: /(?:skill creation|creating.*skills|create.*skill|skill-creator|编写技能|创建技能)/i, weight: 11, phases: ["implement"] },
];
const STOP = new Set(["this", "that", "with", "from", "please", "into", "make", "using",
  "have", "more", "code", "task", "these", "those", "should", "about", "after",
  "text", "data", "file", "files", "create", "produce", "output", "help", "some", "just", "answer", "user", "request"]);
function englishTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])
    .filter((word) => !STOP.has(word)))].slice(0, 24);
}
function chineseTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const phrase of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= phrase.length; i++) tokens.add(phrase.slice(i, i + n));
  }
  return [...tokens].filter(token => !["请帮", "帮我", "使用", "一个", "进行", "需要", "创建", "制作"].includes(token)).slice(0, 80);
}
function eligible(skill: SkillSummary): boolean {
  return !!skill.enabled && !skill.shadowedBy && !skill.error &&
    skill.invocation_policy?.allow_implicit !== false &&
    typeof skill.content_sha256 === "string" && /^[a-f0-9]{64}$/.test(skill.content_sha256);
}

export function routeSkills(skills: readonly SkillSummary[], input: SkillRouteRequest): {
  status: "matched" | "no_match" | "suppressed";
  phase: SkillRoutePhase;
  considered: number;
  primary: RoutedSkill | null;
  supporting: RoutedSkill[];
} {
  const task = String(input.task || "").trim().slice(0, 1400);
  const phase = input.phase || "auto";
  const considered = skills.filter(eligible).length;
  const empty = (status: "no_match" | "suppressed") => ({ status, phase, considered,
    primary: null, supporting: [] as RoutedSkill[] });
  if (/(?:(?:不|别|勿|不要|不准|不允许)(?:再|要)?(?:使用|调用|用|启用).{0,16}(?:skills?|技能)|(?:不要|无需|不用).{0,16}(?:skills?|技能)|without.{0,32}skills?|(?:do not|don't|never|avoid|no)\s+(?:use\s+|using\s+|any\s+|of\s+|the\s+|calling\s+)*skills?)/i.test(task)) return empty("suppressed");
  if (task.length < 4) return empty("no_match");

  const words = englishTokens(task);
  const chinese = chineseTokens(task);
  const ranked: RoutedSkill[] = [];
  for (const skill of skills) {
    if (!eligible(skill)) continue;
    const description = String(skill.description || "").slice(0, 2400);
    const text = [skill.id, skill.name, ...(skill.aliases || []), description].join(" ").toLowerCase();
    let score = 0;
    const matched_capabilities: string[] = [];
    let phaseMatches = 0;
    for (const capability of CAPABILITIES) {
      if (!capability.task.test(task) || !capability.skill.test(text)) continue;
      matched_capabilities.push(capability.name);
      score += capability.weight;
      if (phase !== "auto" && capability.phases?.includes(phase)) {
        score += 6;
        phaseMatches++;
      }
    }
    // Do not keep using the first phase's design Skill during a later test
    // or migration phase merely because the prompt still mentions UI.
    if (phase !== "auto" && matched_capabilities.length && phaseMatches === 0) score -= 12;
    // Facets rank familiar domains; they are not an eligibility gate. A Skill
    // with matching metadata can cover a domain absent from CAPABILITIES.
    const lexical = words.filter((word) => new RegExp(`\\b${word.replace(/[-]/g, "\\-")}\\b`, "i").test(text));
    const chineseMatches = chinese.filter(token => text.includes(token));
    score += matched_capabilities.length ? Math.min(4, lexical.length * 2) : Math.min(21, lexical.length * 7);
    score += Math.min(12, chineseMatches.length * 2);
    if (!matched_capabilities.length && (lexical.length || chineseMatches.length)) matched_capabilities.push("metadata-overlap");
    if (matched_capabilities.includes("interface") && /ui\/ux design intelligence/i.test(description)) score += 3;
    if (matched_capabilities.includes("account-migration") && /modify real codebases/i.test(description)) score += 3;
    if (task.toLowerCase().includes(skill.id.toLowerCase()) ||
        (skill.name.length >= 7 && task.toLowerCase().includes(skill.name.toLowerCase()))) score += 8;
    if (/(?:collection|集合|unified entry|统一入口)/i.test(description)) score -= 4;
    if (score < (matched_capabilities.includes("metadata-overlap") ? 7 : 9)) continue;
    ranked.push({ id: skill.id, name: skill.name, source: skill.source,
      content_sha256: skill.content_sha256!, score, matched_capabilities, invocation_mode: "implicit" });
  }
  ranked.sort((a, b) => b.score - a.score ||
    b.matched_capabilities.length - a.matched_capabilities.length ||
    a.id.localeCompare(b.id, "en"));
  if (!ranked.length) return empty("no_match");
  const limit = Math.max(1, Math.min(input.limit || 3, 3));
  const primary = ranked[0]!;
  const supporting = ranked.slice(1).filter((candidate) => candidate.score >= primary.score * 0.63)
    .slice(0, limit - 1);
  return { status: "matched", phase, considered, primary, supporting };
}
