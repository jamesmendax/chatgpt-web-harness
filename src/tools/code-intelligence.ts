import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { validatePath } from "../lib/path-security.js";
import {
  codeDefinition,
  codeDiagnostics,
  codeFind,
  codeImplementations,
  codeOutline,
  codeReferences,
  codeRenameApply,
  codeRenameLocations,
} from "../lib/code-intelligence.js";
import { lspSpecForFile, probeConfiguredLsp, queryConfiguredLsp } from "../lib/lsp-adapter.js";
import { getRuntimeScope } from "../lib/runtime-scope.js";

const actionSchema = z.enum(["outline", "find", "definition", "references", "implementations", "diagnostics", "rename_locations", "rename_apply", "backend_status"]);
const backendSchema = z.enum(["auto", "typescript", "lsp"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function isTypeScriptFamily(file: string | undefined): boolean {
  if (!file) return false;
  const lower = file.toLowerCase();
  for (const extension of TS_EXTENSIONS) if (lower.endsWith(extension)) return true;
  return false;
}

export function registerCodeIntelligenceTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "code_intelligence",
    {
      title: "Code Intelligence",
      description: "Bounded semantic code intelligence. TypeScript/JavaScript uses the built-in LanguageService; definition/references/implementations/diagnostics may use an optional configured stdio LSP for other languages. LSP is fail-soft in auto mode and never required by Goal/stream recovery. rename_apply remains checkpointed TypeScript/JavaScript only.",
      inputSchema: {
        action: actionSchema,
        backend: backendSchema.optional().default("auto").describe("auto keeps the built-in TS/JS backend and uses a configured LSP for other languages; lsp requires a configured server"),
        root: z.string().optional().describe("Project root for cross-file actions; defaults to WORKSPACE_PATH"),
        file: z.string().optional().describe("Specific source file for diagnostics/LSP queries or to disambiguate a symbol"),
        query: z.string().min(1).max(300).optional().describe("Symbol name; search text for find"),
        new_name: z.string().min(1).max(300).optional().describe("New JavaScript/TypeScript identifier for rename_apply"),
        max_files: z.number().int().min(1).max(800).optional().default(200),
        max_results: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, backend, root, file, query, new_name, max_files, max_results }) => {
      const runtimeScope = getRuntimeScope();
      const projectRoot = await validatePath(root?.trim() || workspaceRoot);
      const validFile = file?.trim() ? await validatePath(file) : undefined;
      if (action === "backend_status") {
        if (!validFile) throw new Error("code_intelligence backend_status requires file");
        const spec = await lspSpecForFile(projectRoot, validFile);
        if (!spec) {
          return toolResult("code_intelligence", {
            file: validFile,
            built_in_typescript: isTypeScriptFamily(validFile),
            lsp_configured: false,
            selected_backend: isTypeScriptFamily(validFile) ? "typescript-language-service" : null,
          }, { summary: `semantic backend status ${validFile}` });
        }
        const probed = await probeConfiguredLsp(projectRoot, validFile, runtimeScope?.signal);
        return toolResult("code_intelligence", {
          file: validFile,
          built_in_typescript: isTypeScriptFamily(validFile),
          lsp_configured: true,
          selected_backend: backend === "typescript" && isTypeScriptFamily(validFile) ? "typescript-language-service" : "lsp",
          lsp: probed,
        }, { summary: `semantic backend status ${validFile}` });
      }

      const lspCapableAction = action === "definition" || action === "references" || action === "implementations" || action === "diagnostics";
      const preferBuiltInTs = backend !== "lsp" && isTypeScriptFamily(validFile);
      if (backend === "typescript" && validFile && !isTypeScriptFamily(validFile)) {
        throw new Error("code_intelligence backend=typescript only supports JavaScript/TypeScript family files");
      }
      if (lspCapableAction && validFile && !preferBuiltInTs && backend !== "typescript") {
        const spec = await lspSpecForFile(projectRoot, validFile);
        if (spec) {
          const lsp = await queryConfiguredLsp({
            root: projectRoot,
            file: validFile,
            action,
            query: query?.trim(),
            maxResults: max_results,
            signal: runtimeScope?.signal,
          });
          if (lsp) return toolResult("code_intelligence", lsp, { summary: `${action} ${query?.trim() || validFile} via ${spec.id}` });
        }
        if (backend === "lsp" || !isTypeScriptFamily(validFile)) {
          throw new Error(`LSP_BACKEND_UNAVAILABLE: no configured LSP server for ${validFile}`);
        }
      }
      if (action === "outline") {
        if (!validFile) throw new Error("code_intelligence outline requires file");
        return toolResult("code_intelligence", await codeOutline(validFile, max_results), { summary: `outline ${validFile}` });
      }
      if (action === "diagnostics") {
        if (!validFile) throw new Error("code_intelligence diagnostics requires file");
        return toolResult("code_intelligence", await codeDiagnostics(validFile, max_results), { summary: `diagnostics ${validFile}` });
      }
      if (!query?.trim()) throw new Error(`code_intelligence ${action} requires query`);
      if (action === "find") {
        return toolResult("code_intelligence", await codeFind(projectRoot, query.trim(), max_files, max_results), { summary: `symbols matching ${query.trim()}` });
      }
      if (action === "definition") {
        return toolResult("code_intelligence", await codeDefinition(projectRoot, query.trim(), validFile, max_files, max_results), { summary: `definition ${query.trim()}` });
      }
      if (action === "references") {
        return toolResult("code_intelligence", await codeReferences(projectRoot, query.trim(), validFile, max_files, max_results), { summary: `references ${query.trim()}` });
      }
      if (action === "implementations") {
        return toolResult("code_intelligence", await codeImplementations(projectRoot, query.trim(), validFile, max_files, max_results), { summary: `implementations ${query.trim()}` });
      }
      if (action === "rename_apply") {
        if (!new_name?.trim()) throw new Error("code_intelligence rename_apply requires new_name");
        return toolResult(
          "code_intelligence",
          await codeRenameApply(projectRoot, query.trim(), new_name.trim(), validFile, max_files, max_results),
          { summary: `semantic rename ${query.trim()} -> ${new_name.trim()}` }
        );
      }
      return toolResult("code_intelligence", await codeRenameLocations(projectRoot, query.trim(), validFile, max_files, max_results), { summary: `rename locations ${query.trim()}` });
    }
  );
}
