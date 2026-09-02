const ALLOWED_FIELDS = [
  'contract', 'side', 'size', 'entry_price', 'mark_price', 'leverage',
  'notional', 'unrealised_pnl', 'roe', 'observed_at',
];

function sanitizePosition(position) {
  return Object.fromEntries(ALLOWED_FIELDS.map((field) => [field, position?.[field] ?? null]));
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ message: 'GET 요청만 허용됩니다.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return response.status(503).json({ message: '데이터 연결 설정이 완료되지 않았습니다.' });
  }

  try {
    const upstream = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/get_public_master_positions`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload?.message || 'Supabase RPC request failed');
    const positions = Array.isArray(payload?.positions) ? payload.positions.map(sanitizePosition) : [];
    response.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
    return response.status(200).json({ positions, observed_at: payload?.observed_at ?? null });
  } catch (error) {
    console.error('public master position fetch failed', error);
    return response.status(502).json({ message: '현재 포지션 데이터를 불러오지 못했습니다.' });
  }
}

