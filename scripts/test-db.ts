/**
 * Runs the database tests against `<database>_test` on a local Postgres, never the database in DATABASE_URL.
 * The tests empty every table they touch.
 *
 * npm run test:db
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const TESTS = ['src/speech-to-text-comparison/speech-to-text-comparison.service.spec.ts'];

if (existsSync('.env')) process.loadEnvFile('.env');
const source = process.env.DATABASE_URL;
if (!source) throw new Error('Set DATABASE_URL before running the database tests.');

const url = new URL(source);
if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
  throw new Error(`Database tests only run against a local Postgres, not ${url.hostname}.`);
}
url.pathname = `${url.pathname}_test`;
const env = { ...process.env, DATABASE_URL: url.toString() };

try {
  execSync('npx prisma migrate deploy', { env, stdio: 'inherit' });
  execSync(`npx tsx --test ${TESTS.join(' ')}`, { env, stdio: 'inherit' });
} catch {
  process.exit(1);
}
