import { desc, eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { chatMessages, checkins, goals, habits, insights, journalEntries, profiles, reviews, scenarios, trajectorySnapshots, users, type InsertUser } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { MODEL_VERSION } from "./engine/projection";
import { loadWorkspace } from "./workspace";

let pool: Pool | null = null;
let database: any = null;
let injected: any = null;

/**
 * Test seam: bind an externally-constructed database (the in-memory harness in
 * server/test/db.ts) so integration tests exercise the real Drizzle query paths
 * without a live Postgres. Never called in production.
 */
export function setDbForTests(instance: any): void {
  injected = instance;
}

export async function getDb(): Promise<any> {
  if (injected) return injected;
  if (!database && ENV.databaseUrl) {
    pool = new Pool({ connectionString: ENV.databaseUrl, max: 5, ssl: ENV.isProduction ? { rejectUnauthorized: false } : undefined });
    database = drizzle(pool);
  }
  return database;
}

export async function closeDb() { await pool?.end(); pool = null; database = null; injected = null; }

export async function upsertUser(user: InsertUser): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const values = { ...user, updatedAt: new Date(), lastSignedIn: user.lastSignedIn || new Date() };
  await db.insert(users).values(values).onConflictDoUpdate({ target: users.openId, set: { name: values.name, email: values.email, loginMethod: values.loginMethod, lastSignedIn: values.lastSignedIn, updatedAt: new Date() } });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getWorkspace(userId: number) {
  const db = await getDb();
  if (!db) return null;
  return loadWorkspace(db, tables, userId);
}

export async function saveProfile(userId: number, values: { values: string; context: string; horizonYears: number; onboardingComplete?: boolean }) {
  const db = await getDb();
  if (!db) return null;
  const existing = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (existing[0]) return (await db.update(profiles).set({ ...values, updatedAt: new Date() }).where(eq(profiles.userId, userId)).returning())[0];
  return (await db.insert(profiles).values({ userId, ...values }).returning())[0];
}

export async function saveSnapshot(userId: number, payload: Record<string, unknown>, options: { scenarioId?: number; modelVersion?: string } = {}) {
  const db = await getDb();
  if (!db) return null;
  return (await db
    .insert(trajectorySnapshots)
    .values({ userId, scenarioId: options.scenarioId, modelVersion: options.modelVersion ?? MODEL_VERSION, payload })
    .returning())[0];
}

export async function getHabitForUser(userId: number, habitId: number) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(habits).where(and(eq(habits.userId, userId), eq(habits.id, habitId))).limit(1))[0];
}

/** Table bundle for the workspace loader, so it never imports db.ts directly. */
export const tables = {
  profiles,
  goals,
  habits,
  checkins,
  journalEntries,
  scenarios,
  trajectorySnapshots,
  chatMessages,
  reviews,
  insights,
  users,
};

export { chatMessages, checkins, goals, habits, insights, journalEntries, profiles, reviews, scenarios, trajectorySnapshots, users };
