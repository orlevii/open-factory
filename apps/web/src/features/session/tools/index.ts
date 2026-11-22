import type { ComponentType } from "react";
import type { ToolRow } from "../rows";
import { bashRenderer } from "./bash";
import { genericRenderer } from "./generic";

/** How one tool renders inside `ToolCallRow` (spec §9.2): `Summary` fills the collapsed line after
 *  the chevron; `Body` renders only while the row is expanded. Components, so they may use hooks. */
export type ToolRenderer = {
  Summary: ComponentType<{ row: ToolRow }>;
  Body: ComponentType<{ row: ToolRow }>;
};

/** Renderers by tool name; a module constant, so a row's renderer never changes identity. */
export const toolRenderers: Record<string, ToolRenderer> = {
  Bash: bashRenderer,
};

/** The renderer for a tool name; unknown names keep today's row. */
export const rendererFor = (name: string): ToolRenderer =>
  Object.hasOwn(toolRenderers, name) ? (toolRenderers[name] as ToolRenderer) : genericRenderer;
