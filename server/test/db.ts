/**
 * In-memory Postgres test harness.
 *
 * The sandbox has no Postgres and no network access to install one, so the
 * integration tests run against `pg-mem` — an in-memory Postgres implementation.
 * It executes the project's *real* Drizzle migration SQL, so the schema under
 * test is the schema that ships, not a hand-built approximation.
 *
 * Two compatibility gaps between pg-mem and the `pg` client are papered over
 * here rather than worked around in application code:
 *
 *   1. pg-mem rejects the `types` parser that Drizzle attaches to every query.
 *   2. pg-mem does not implement `rowMode: 'array'`, which Drizzle uses to read
 *      results positionally. Results are converted here using the field order
 *      pg-mem reports back.
 *
 * Neither affects the SQL, the query builder or the schema.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { newDb, type IMemoryDb } from "pg-mem";
import fs from "node:fs";
import path from "node:path";
import * as schema from "../../drizzle/schema";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith(".sql"))
    .sort();
}

export type TestDb = {
  /** Drizzle instance bound to the in-memory database. */
  db: any;
  /** The raw pg-mem database, for assertions that need to bypass Drizzle. */
  raw: IMemoryDb;
  tables: typeof schema;
};

/**
 * Create a fresh database with the real migrations applied.
 * Every test file gets its own instance so nothing leaks between tests.
 */
export function createTestDb(): TestDb {
  const memory = newDb({ autoCreateForeignKeyIndices: true });

  const statements = migrationFiles()
    .flatMap(file => fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint"))
    .map(statement => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    memory.public.none(statement);
  }

  const { Pool } = memory.adapters.createPg();
  const pool: any = new Pool();
  const rawQuery = pool.query.bind(pool);

  pool.query = (config: any, ...rest: any[]) => {
    const isObjectConfig = config && typeof config === "object" && config.text !== undefined;
    if (!isObjectConfig) return rawQuery(config, ...rest);

    const wantsArrayRows = config.rowMode === "array";
    const cleaned: Record<string, unknown> = { text: config.text, values: config.values };
    if (config.name) cleaned.name = config.name;

    const result = rawQuery(cleaned, ...rest);

    return (async () => {
      const resolved = await result;
      // pg-mem reports no field metadata, so positional order is taken from the
      // row object itself. Every query in this project selects from a single
      // table, so column names are unique within a result set.
      const rows: any[] = resolved.rows ?? [];
      const fieldNames: string[] = (resolved.fields ?? []).length
        ? resolved.fields.map((field: any) => field.name)
        : rows.length > 0
          ? Object.keys(rows[0])
          : [];

      // Real `pg` returns timestamptz columns as Date objects; pg-mem returns
      // ISO strings. Normalise so code under test sees production behaviour.
      const normalized = rows.map(row => normalizeDates(row));

      return {
        ...resolved,
        rows: wantsArrayRows ? normalized.map(row => fieldNames.map(name => row[name])) : normalized,
      };
    })();
  };

  return { db: drizzle(pool), raw: memory, tables: schema };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function normalizeDates(row: any): any {
  if (row === null || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "string" && ISO_TIMESTAMP.test(value) ? new Date(value) : value;
  }
  return out;
}

/** Insert a user and return the row. Every protected route needs one. */
export async function seedUser(db: any, overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const openId = overrides.openId ?? `google:test-${Math.random().toString(36).slice(2, 10)}`;
  const rows = await db
    .insert(schema.users)
    .values({ openId, name: overrides.name ?? "Test User", email: overrides.email ?? "test@example.com", loginMethod: "google", ...overrides })
    .returning();
  return rows[0];
}

/**
 * Seed a goal with the shape the planner writes, so tests exercise the same
 * columns production uses.
 */
export async function seedGoal(db: any, userId: number, overrides: Partial<typeof schema.goals.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.goals)
    .values({
      userId,
      domain: "career",
      title: "Get a backend engineering role",
      baseline: 30,
      target: 90,
      weeklyHours: 6,
      details: { outcome: "Three final-round interviews", currentState: "Self-taught, no professional experience", deadlineText: "June 2027" },
      ...overrides,
    })
    .returning();
  return rows[0];
}

export async function seedStep(
  db: any,
  userId: number,
  goalId: number,
  overrides: Partial<typeof schema.habits.$inferInsert> = {},
) {
  const rows = await db
    .insert(schema.habits)
    .values({
      userId,
      goalId,
      domain: "career",
      title: "Ship one small piece of the project",
      weeklyFrequency: 3,
      minutesPerSession: 60,
      adherencePrior: 0.5,
      betaAlpha: 5,
      betaBeta: 5,
      ...overrides,
    })
    .returning();
  return rows[0];
}
