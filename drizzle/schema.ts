import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("open_id", { length: 128 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("login_method", { length: 64 }),
  role: varchar("role", { length: 32 }).notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSignedIn: timestamp("last_signed_in", { withTimezone: true }).notNull().defaultNow(),
});

export const profiles = pgTable("profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  values: text("values").notNull().default(""),
  context: text("context").notNull().default(""),
  horizonYears: integer("horizon_years").notNull().default(5),
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  domain: varchar("domain", { length: 32 }).notNull(),
  title: text("title").notNull(),
  baseline: real("baseline").notNull().default(0),
  target: real("target").notNull().default(100),
  /** Committed hours per week. Drives the projection's effort factor. */
  weeklyHours: real("weekly_hours").notNull().default(4),
  targetDate: timestamp("target_date", { withTimezone: true }),
  /**
   * Structured goal detail: outcome, starting point, unit, cadence. Kept as
   * jsonb rather than more columns because the shape varies by domain and the
   * planner agent owns it. `notes` stays for free-form text.
   */
  details: jsonb("details").$type<GoalDetails>().notNull().default({}),
  notes: text("notes"),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const habits = pgTable("habits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  goalId: integer("goal_id").references(() => goals.id, { onDelete: "set null" }),
  domain: varchar("domain", { length: 32 }).notNull(),
  title: text("title").notNull(),
  weeklyFrequency: real("weekly_frequency").notNull().default(3),
  minutesPerSession: real("minutes_per_session").notNull().default(30),
  adherencePrior: real("adherence_prior").notNull().default(0.7),
  betaAlpha: real("beta_alpha").notNull().default(7),
  betaBeta: real("beta_beta").notNull().default(3),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  tags: text("tags"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const checkins = pgTable("checkins", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").notNull().references(() => habits.id, { onDelete: "cascade" }),
  checkinDate: timestamp("checkin_date", { withTimezone: true }).notNull(),
  completed: boolean("completed").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  habitDateUnique: uniqueIndex("checkins_habit_date_unique").on(table.habitId, table.checkinDate),
}));

export const scenarios = pgTable("scenarios", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  adherenceOverride: real("adherence_override"),
  assumptions: jsonb("assumptions").$type<Record<string, number | string | boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trajectorySnapshots = pgTable("trajectory_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scenarioId: integer("scenario_id").references(() => scenarios.id, { onDelete: "set null" }),
  modelVersion: varchar("model_version", { length: 32 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 16 }).notNull(),
  content: text("content").notNull(),
  /** Which agent produced this reply — shown in the UI as provenance. */
  agent: varchar("agent", { length: 32 }).notNull().default("coach"),
  /**
   * Grounding record: the model used, whether it fell back to deterministic
   * reasoning, and the fact ids the reply was built from. Kept so "the AI said
   * this" can always be traced to what it was actually looking at.
   */
  meta: jsonb("meta").$type<MessageMeta>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userCreatedIndex: index("chat_messages_user_created_index").on(table.userId, table.createdAt),
}));

/**
 * A generated weekly review. Stored rather than recomputed so the user can see
 * how the assessment changed as evidence accumulated.
 */
export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  goalId: integer("goal_id").references(() => goals.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  summary: text("summary").notNull(),
  /** Structured findings: what moved, what stalled, what to change. */
  findings: jsonb("findings").$type<ReviewFindings>().notNull().default({}),
  agent: varchar("agent", { length: 32 }).notNull().default("review"),
  model: varchar("model", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userPeriodIndex: index("reviews_user_period_index").on(table.userId, table.periodEnd),
}));

/** Themes and language patterns extracted from journal entries. */
export const insights = pgTable("insights", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceType: varchar("source_type", { length: 32 }).notNull().default("journal"),
  sourceId: integer("source_id"),
  themes: jsonb("themes").$type<string[]>().notNull().default([]),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userIndex: index("insights_user_index").on(table.userId, table.createdAt),
}));

export type GoalDetails = {
  outcome?: string;
  currentState?: string;
  /** Free-form deadline as the user wrote it, e.g. "December 2026". */
  deadlineText?: string;
  unit?: string;
  /** Version of the planner that produced the plan, for migration/debugging. */
  planVersion?: string;
  /** Which agent generated the plan. */
  plannedBy?: string;
};

export type MessageMeta = {
  model?: string;
  /** True when the deterministic fallback produced this reply. */
  fallback?: boolean;
  /** Fact ids from the fact pack the reply was grounded on. */
  groundedOn?: string[];
  latencyMs?: number;
};

export type ReviewFindings = {
  wins?: string[];
  stalls?: string[];
  changes?: string[];
  metrics?: Record<string, number | string>;
};

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type Habit = typeof habits.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type TrajectorySnapshot = typeof trajectorySnapshots.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Insight = typeof insights.$inferSelect;
