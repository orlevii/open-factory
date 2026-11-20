import type { TemplateConfig, TemplateIssue } from "@open-factory/shared";
import { customType, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const templates = pgTable("templates", {
  name: text("name").primaryKey(),
  path: text("path").notNull(),
  config: jsonb("config").$type<TemplateConfig>(),
  issues: jsonb("issues").$type<TemplateIssue[]>().notNull().default([]),
  contentHash: text("content_hash").notNull(),
  scannedAt: ts("scanned_at").notNull(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  hostPath: text("host_path").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().$type<"oauth_token" | "api_key">(),
  valueEnc: bytea("value_enc").notNull(),
  lastVerifiedAt: ts("last_verified_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  valueEnc: bytea("value_enc").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const agentProjectGrants = pgTable(
  "agent_project_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.projectId] })],
);

export type TemplateRow = typeof templates.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
