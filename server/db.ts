import { desc, eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { chatMessages, checkins, goals, habits, journalEntries, profiles, scenarios, trajectorySnapshots, users, type InsertUser } from "../drizzle/schema";
import { ENV } from "./_core/env";

let pool: Pool | null = null;
let database: any = null;

export async function getDb(): Promise<any> {
  if (!database && ENV.databaseUrl) {
    pool = new Pool({ connectionString: ENV.databaseUrl, max: 5, ssl: ENV.isProduction ? { rejectUnauthorized: false } : undefined });
    database = drizzle(pool);
  }
  return database;
}

export async function closeDb() { await pool?.end(); pool = null; database = null; }

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
  const [profile, userGoals, userHabits, journal, recentCheckins, userScenarios, snapshots, messages] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1),
    db.select().from(goals).where(eq(goals.userId, userId)).orderBy(desc(goals.createdAt)),
    db.select().from(habits).where(eq(habits.userId, userId)).orderBy(desc(habits.createdAt)),
    db.select().from(journalEntries).where(eq(journalEntries.userId, userId)).orderBy(desc(journalEntries.createdAt)).limit(12),
    db.select().from(checkins).where(eq(checkins.userId, userId)).orderBy(desc(checkins.checkinDate)).limit(60),
    db.select().from(scenarios).where(eq(scenarios.userId, userId)).orderBy(desc(scenarios.updatedAt)),
    db.select().from(trajectorySnapshots).where(eq(trajectorySnapshots.userId, userId)).orderBy(desc(trajectorySnapshots.createdAt)).limit(12),
    db.select().from(chatMessages).where(eq(chatMessages.userId, userId)).orderBy(desc(chatMessages.createdAt)).limit(20),
  ]);
  return { profile: profile[0] || null, goals: userGoals, habits: userHabits, journal, checkins: recentCheckins, scenarios: userScenarios, snapshots, messages: messages.reverse() };
}

export async function saveProfile(userId: number, values: { values: string; context: string; horizonYears: number; onboardingComplete?: boolean }) {
  const db = await getDb();
  if (!db) return null;
  const existing = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (existing[0]) return (await db.update(profiles).set({ ...values, updatedAt: new Date() }).where(eq(profiles.userId, userId)).returning())[0];
  return (await db.insert(profiles).values({ userId, ...values }).returning())[0];
}

export async function saveSnapshot(userId: number, payload: Record<string, unknown>, scenarioId?: number) {
  const db = await getDb();
  if (!db) return null;
  return (await db.insert(trajectorySnapshots).values({ userId, scenarioId, modelVersion: "v1.0", payload }).returning())[0];
}

export async function getHabitForUser(userId: number, habitId: number) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(habits).where(and(eq(habits.userId, userId), eq(habits.id, habitId))).limit(1))[0];
}

export { chatMessages, checkins, goals, habits, journalEntries, profiles, scenarios, trajectorySnapshots, users };
