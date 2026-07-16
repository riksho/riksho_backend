import { supabaseAdmin } from './src/common/supabase.ts';

async function run() {
  console.log('Fixing...');
  const { data: users } = await supabaseAdmin.from('users').select('*');
  for (const u of users) {
    console.log('Fixing', u.phone);
    await supabaseAdmin.from('users').update({ role: 'driver' }).eq('id', u.id);
    await supabaseAdmin.from('drivers').upsert({ id: u.id, name: u.name || 'Driver', phone: u.phone, status: 'offline', updated_at: new Date().toISOString() });
  }
  console.log('Done!');
}
run();
