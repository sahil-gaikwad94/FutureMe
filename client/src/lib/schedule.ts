/**
 * Scheduling.
 *
 * The previous UI listed all five plan steps every day with a "record evidence"
 * button on each, which turns a plan into a wall of guilt. A step is due when
 * its own cadence says so — a 1×/week step is not a daily obligation.
 */

const MS_PER_DAY = 86_400_000;

export type SchedulableStep = {
  id: number;
  title: string;
  weeklyFrequency: number;
  minutesPerSession: number;
  currentStreak?: number;
  adherencePrior?: number;
  lastCompletedAt?: Date | string | null;
};

export type SchedulableCheckin = {
  habitId: number;
  checkinDate: Date | string;
  completed: boolean;
};

const dayKey = (value: Date | string): string => {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
};

/**
 * Which steps are due today.
 *
 * A step is due when the sessions it has asked for since its last completion add
 * up to at least one, and it has not already been logged today. Steps that have
 * never been completed are due immediately — the plan has to start somewhere.
 */
export function dueToday(steps: SchedulableStep[], checkins: SchedulableCheckin[], now: Date = new Date()): SchedulableStep[] {
  const today = dayKey(now);
  const loggedToday = new Set(checkins.filter(item => dayKey(item.checkinDate) === today).map(item => item.habitId));

  const lastCompletedByStep = new Map<number, number>();
  for (const item of checkins) {
    if (!item.completed) continue;
    const time = new Date(item.checkinDate).getTime();
    const existing = lastCompletedByStep.get(item.habitId);
    if (existing === undefined || time > existing) lastCompletedByStep.set(item.habitId, time);
  }

  return steps.filter(step => {
    if (loggedToday.has(step.id)) return false;
    const last = lastCompletedByStep.get(step.id);
    if (last === undefined) return true;
    const daysSince = (now.getTime() - last) / MS_PER_DAY;
    const frequency = Math.max(0.25, Number(step.weeklyFrequency) || 1);
    return daysSince * (frequency / 7) >= 1;
  });
}

/** Steps that have gone quiet well past their own cadence. */
export function stalled(steps: SchedulableStep[], checkins: SchedulableCheckin[], now: Date = new Date()): SchedulableStep[] {
  const lastCompletedByStep = new Map<number, number>();
  for (const item of checkins) {
    if (!item.completed) continue;
    const time = new Date(item.checkinDate).getTime();
    const existing = lastCompletedByStep.get(item.habitId);
    if (existing === undefined || time > existing) lastCompletedByStep.set(item.habitId, time);
  }

  return steps.filter(step => {
    const last = lastCompletedByStep.get(step.id);
    if (last === undefined) return false;
    const daysSince = (now.getTime() - last) / MS_PER_DAY;
    const cadenceDays = 7 / Math.max(0.5, Number(step.weeklyFrequency) || 1);
    return daysSince > Math.max(7, cadenceDays * 2.5);
  });
}

/** Last 7 days as a completion grid, for the streak strip. */
export function weekGrid(stepId: number, checkins: SchedulableCheckin[], now: Date = new Date()): Array<{ key: string; label: string; completed: boolean | null }> {
  const byDay = new Map<string, boolean>();
  for (const item of checkins) {
    if (item.habitId !== stepId) continue;
    const key = dayKey(item.checkinDate);
    byDay.set(key, byDay.get(key) === true ? true : item.completed);
  }

  const days: Array<{ key: string; label: string; completed: boolean | null }> = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * MS_PER_DAY);
    const key = dayKey(date);
    days.push({
      key,
      label: date.toLocaleDateString(undefined, { weekday: "narrow" }),
      completed: byDay.has(key) ? byDay.get(key)! : offset === 0 ? null : false,
    });
  }
  return days;
}
