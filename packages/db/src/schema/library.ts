import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * I5 spec §5.1. One row per registered skill source (a host folder or a GitHub subpath). Host skills and
 * template-local skills are discovered live and never stored. `state` is "adding" while a GitHub add
 * re-fetches (§10.4); boot finishes or removes it. `deletedAt` is the soft delete behind Undo (§9.4).
 */
export const skillSources = pgTable(
  "skill_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<"folder" | "github">(),
    /** folder: the realpath from `resolveHostFolder`. */
    path: text("path"),
    /** github: "owner/repo", lower-cased. */
    repo: text("repo"),
    /** github: "" is the repo root; normalised, no leading slash, no "." or ".." segments. */
    subpath: text("subpath"),
    /** github: the branch name, resolved at add; the default branch is recorded by name, never null. */
    branch: text("branch"),
    /** github: the 40-hex pin. */
    commit: text("commit"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    subject: text("subject"),
    /** github: `{ [skill]: treeSha }` at the pin, for "changed" (§6.3). */
    trees: jsonb("trees").$type<Record<string, string>>(),
    updateCommit: text("update_commit"),
    updateAt: timestamp("update_at", { withTimezone: true }),
    updateSubject: text("update_subject"),
    /** The last Check for updates; `checkError` is the mapped one-line message. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkError: text("check_error"),
    /** The picked skill folder names (Q17, Q19), sorted, at least one. */
    skills: jsonb("skills").$type<string[]>().notNull(),
    state: text("state").notNull().$type<"adding" | "ready">(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("skill_sources_kind_check", sql`${t.kind} IN ('folder','github')`),
    check("skill_sources_state_check", sql`${t.state} IN ('adding','ready')`),
    check(
      "skill_sources_kind_fields_check",
      sql`(${t.kind} = 'folder' AND ${t.path} IS NOT NULL)
        OR (${t.kind} = 'github' AND ${t.repo} IS NOT NULL AND ${t.subpath} IS NOT NULL
          AND ${t.branch} IS NOT NULL AND ${t.commit} IS NOT NULL)`,
    ),
    check("skill_sources_skills_check", sql`jsonb_array_length(${t.skills}) >= 1`),
  ],
);
export type SkillSourceRow = typeof skillSources.$inferSelect;
