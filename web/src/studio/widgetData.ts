import { plainRows } from './data';

type WidgetDataResult = { results: { rows: unknown[] } };

function fieldsFor<T extends { key: string }>(schema: Array<{ id: string; fields: T[] }>, names: string[]): T[] {
  const fields = schema.find((table) => table.id === 'disputes')?.fields ?? [];
  return fields.filter((field) => names.includes(field.key.split('.').at(-1) ?? ''));
}

export function evidenceFields<T extends { key: string }>(schema: Array<{ id: string; fields: T[] }>): T[] {
  return fieldsFor(schema, ['id', 'status', 'has_payment', 'has_order', 'has_tracking', 'filed']);
}

export function deadlineFields<T extends { key: string }>(schema: Array<{ id: string; fields: T[] }>): T[] {
  return fieldsFor(schema, ['id', 'status', 'created', 'due']);
}

export function evidenceDataRows<T extends { key: string }>(
  fields: T[],
  result: WidgetDataResult,
): Array<Record<string, unknown>> {
  return plainRows(
    result.results.rows,
    fields.map((field) => field.key),
  );
}

export function deadlineDataRows<T extends { key: string }>(
  fields: T[],
  result: WidgetDataResult,
): Array<Record<string, unknown>> {
  return plainRows(
    result.results.rows,
    fields.map((field) => field.key),
  );
}
