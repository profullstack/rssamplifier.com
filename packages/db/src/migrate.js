import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, nowIso } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Split a .sql file into individual statements.
 *
 * libSQL executes one statement per call, and the schema contains CREATE
 * TRIGGER bodies with internal semicolons — so a naive split on ";" would cut
 * them in half. This tracks BEGIN…END nesting and only breaks outside it.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = [];
  let current = '';
  let depth = 0;

  for (const rawLine of withoutComments.split('\n')) {
    const line = rawLine;
    current += `${line}\n`;

    const upper = line.toUpperCase();
    // "BEGIN" only opens a block in a trigger body here; the schema has no
    // explicit transactions, so treating every BEGIN as a nesting marker is safe.
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper) && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        statements.push(current.trim());
        current = '';
        continue;
      }
    }

    if (depth === 0 && line.trim().endsWith(';')) {
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') statements.push(trimmed);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements.filter((s) => s.replace(/;/g, '').trim().length > 0);
}

/**
 * Apply every migration that has not run yet.
 *
 * Applied filenames are recorded in `_migrations`, so this is safe to run on
 * every boot — which is how it is wired, since there is no CI step that applies
 * schema for this project.
 *
 * @param {import('@libsql/client').Client} [client]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function migrate(client) {
  const db = client ?? connect();

  await db.execute(`
    create table if not exists _migrations (
      name       text primary key,
      applied_at text not null
    )
  `);

  const { rows } = await db.execute('select name from _migrations');
  const done = new Set(rows.map((r) => String(r.name)));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const applied = [];
  const skipped = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitStatements(sql)) {
      await db.execute(statement);
    }

    await db.execute({
      sql: 'insert into _migrations (name, applied_at) values (?, ?)',
      args: [file, nowIso()],
    });
    applied.push(file);
  }

  return { applied, skipped };
}

// `node src/migrate.js` applies migrations against TURSO_DATABASE_URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(({ applied, skipped }) => {
      console.log(`applied: ${applied.length ? applied.join(', ') : 'none'}`);
      console.log(`already up to date: ${skipped.length}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
