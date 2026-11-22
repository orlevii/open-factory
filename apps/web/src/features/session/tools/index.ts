import type { ComponentType } from "react";
import type { ToolRow } from "../rows";
import { bashRenderer } from "./bash";
import { diffRenderer } from "./diff";
import { FACTORY_TOOL_NAMES, factoryRenderer } from "./factory";
import { genericRenderer } from "./generic";
import { mcpRenderer } from "./mcp";
import { readRenderer } from "./read";
import { searchRenderer } from "./search";
import { todoRenderer } from "./todo";
import { webRenderer } from "./web";

/** How one tool renders inside `ToolCallRow` (spec §9.2): `Summary` fills the collapsed line after
 *  the chevron; `Body` renders only while the row is expanded. Components, so they may use hooks. */
export type ToolRenderer = {
  Summary: ComponentType<{ row: ToolRow }>;
  Body: ComponentType<{ row: ToolRow }>;
};

/** Renderers by tool name; a module constant, so a row's renderer never changes identity. */
export const toolRenderers: Record<string, ToolRenderer> = {
  Bash: bashRenderer,
  Edit: diffRenderer,
  MultiEdit: diffRenderer,
  Write: diffRenderer,
  Read: readRenderer,
  Grep: searchRenderer,
  Glob: searchRenderer,
  WebFetch: webRenderer,
  WebSearch: webRenderer,
  TodoWrite: todoRenderer,
  ...Object.fromEntries(FACTORY_TOOL_NAMES.map((n) => [n, factoryRenderer])),
};

/** The renderer for a tool name: any other MCP tool gets the MCP renderer; unknown names keep
 *  today's row. */
export function rendererFor(name: string): ToolRenderer {
  if (Object.hasOwn(toolRenderers, name)) return toolRenderers[name] as ToolRenderer;
  return name.startsWith("mcp__") ? mcpRenderer : genericRenderer;
}
