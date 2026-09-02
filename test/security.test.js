import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('public RPC exposes only position market fields', async () => {
  const sql = await readFile('supabase/202609020004_public_master_positions.sql', 'utf8');
  for (const forbidden of ['api_key', 'secret_key', 'gate_uid', 'email', 'full_name', 'copy_ratio', 'order_intents']) {
    assert.equal(sql.includes(`'${forbidden}'`), false, `${forbidden} must not be exposed`);
  }
  assert.match(sql, /grant execute[^;]+to anon/i);
});

test('monitor contains no trading or member-management actions', async () => {
  const [html, js] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('src/main.js', 'utf8'),
  ]);
  const source = `${html}\n${js}`;
  for (const forbidden of ['placeOrder', 'submitOrder', 'copy_ratio', 'memberId', 'service_role']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not exist in the monitor`);
  }
});
