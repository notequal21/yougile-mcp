type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj =>
  typeof value === 'object' && value !== null ? (value as Obj) : {};

function withIso(source: Obj, target: Obj, key: string): void {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value))
    target[`${key}Iso`] = new Date(value).toISOString();
}

export function taskSummary(task: unknown): Record<string, unknown> {
  const t = asObj(task);
  const deadline = asObj(t.deadline);
  const summary: Obj = {};
  for (const key of [
    'id',
    'title',
    'idTaskProject',
    'columnId',
    'completed',
    'archived',
    'deleted',
    'assigned',
    'color',
    'timestamp',
  ]) {
    if (t[key] !== undefined) summary[key] = t[key];
  }
  if (deadline.deadline !== undefined) summary.deadline = deadline.deadline;
  withIso(t, summary, 'timestamp');
  withIso(deadline, summary, 'deadline');
  if (typeof t.completedTimestamp === 'number') withIso(t, summary, 'completedTimestamp');
  return summary;
}

export function taskDetail(task: unknown): Record<string, unknown> {
  const t = { ...asObj(task) };
  withIso(t, t, 'timestamp');
  withIso(t, t, 'completedTimestamp');
  const deadline = asObj(t.deadline);
  if (Object.keys(deadline).length) {
    t.deadline = { ...deadline };
    withIso(deadline, t.deadline as Obj, 'deadline');
    withIso(deadline, t.deadline as Obj, 'startDate');
  }
  return t;
}
