import { describe, expect, it } from 'vitest';
import { assertParameterised } from '../db.js';

describe('assertParameterised', () => {
  it('accepts a parameterised query whose placeholders match its values', () => {
    expect(() => assertParameterised('SELECT * FROM tasks WHERE id = $1', ['abc'])).not.toThrow();
  });

  it('accepts a query with no placeholders and no values', () => {
    expect(() => assertParameterised('SELECT 1', [])).not.toThrow();
  });

  it('accepts multiple placeholders in any textual order', () => {
    expect(() =>
      assertParameterised('UPDATE tasks SET title = $2 WHERE id = $1', ['id', 'title']),
    ).not.toThrow();
  });

  it('rejects values supplied against SQL that has no placeholders (concatenation smell)', () => {
    // This is the shape a developer produces when they build the SQL by hand:
    // `WHERE title = '${userInput}'` leaves no $n but still "needs" a value.
    expect(() => assertParameterised("SELECT * FROM tasks WHERE title = 'x'", ['x'])).toThrow();
  });

  it('rejects a placeholder/value count mismatch', () => {
    expect(() => assertParameterised('SELECT * FROM tasks WHERE id = $1', [])).toThrow();
    expect(() => assertParameterised('SELECT * FROM tasks WHERE id = $1', ['a', 'b'])).toThrow();
  });

  it('rejects a non-array values argument', () => {
    // @ts-expect-error values must be an array; a string would be interpolated SQL
    expect(() => assertParameterised('SELECT $1', 'oops')).toThrow();
  });

  it('rejects empty query text', () => {
    expect(() => assertParameterised('', [])).toThrow();
    expect(() => assertParameterised('   ', [])).toThrow();
  });
});
