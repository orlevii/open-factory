import type { TemplateConfig, TemplateIssue } from "@open-factory/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { users } from "./auth.ts";

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

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind").notNull().$type<"oauth_token" | "api_key">(),
    valueEnc: bytea("value_enc").notNull(),
    lastVerifiedAt: ts("last_verified_at"),
    lastError: text("last_error"),
    rateLimitedUntil: ts("rate_limited_until"),
    rateLimitExact: boolean("rate_limit_exact").notNull().default(true),
    // Latest rate-limit status Claude reported for this credential; overwritten on each event (no history).
    rlStatus: text("rl_status").$type<"allowed" | "allowed_warning" | "rejected">(),
    rlType: text("rl_type"),
    rlUtilization: real("rl_utilization"),
    rlResetsAt: ts("rl_resets_at"),
    rlObservedAt: ts("rl_observed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("credentials_rl_status", sql`${t.rlStatus} IN ('allowed','allowed_warning','rejected')`),
  ],
);

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

/** Single row (id = 1, enforced by the CHECK below), inserted by the migration. */
export const factorySettings = pgTable(
  "factory_settings",
  {
    id: smallint("id").primaryKey(),
    maxRunningAgents: integer("max_running_agents").notNull().default(8),
    defaultWarmWindowMinutes: integer("default_warm_window_minutes").notNull().default(70),
    memberUpdateDebounceSeconds: integer("member_update_debounce_seconds").notNull().default(30),
    updatedAt: ts("updated_at"),
    updatedBy: text("updated_by").references(() => users.id),
  },
  (t) => [check("factory_settings_singleton", sql`${t.id} = 1`)],
);

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  usedBy: text("used_by")
    .unique()
    .references(() => users.id),
  revokedAt: ts("revoked_at"),
});
