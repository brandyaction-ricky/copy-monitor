const REFRESH_INTERVAL_MS = 10_000;
const STALE_AFTER_MS = 60_000;

const state = { positions: [], filter: 'ALL', loading: false, lastUpdated: null };
const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;',
  })[character]);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value, maximumFractionDigits = 2) {
  const amount = number(value);
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits })}`;
}

function formatPrice(value) {
  const amount = number(value);
  if (!amount) return '—';
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: amount >= 100 ? 2 : 6 })}`;
}

function formatCompact(value) {
  const amount = Math.abs(number(value));
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(2)}`;
}

function formatTime(value) {
  if (!value) return '동기화 기록 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '동기화 기록 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function coinSymbol(contract) {
  return String(contract || '').replace(/_USDT.*$/i, '').replace(/USDT.*$/i, '').slice(0, 5) || '?';
}

function coinClass(contract) {
  const symbol = coinSymbol(contract).toLowerCase();
  return ['btc', 'eth', 'sol', 'xrp'].includes(symbol) ? symbol : 'other';
}

function positionCard(position) {
  const side = position.side === 'SHORT' || number(position.size) < 0 ? 'SHORT' : 'LONG';
  const pnl = number(position.unrealised_pnl);
  const roe = number(position.roe);
  const symbol = coinSymbol(position.contract);
  return `<article class="position-card ${side.toLowerCase()}">
    <div class="card-head">
      <div class="identity"><span class="coin ${coinClass(position.contract)}">${escapeHtml(symbol.slice(0, 1))}</span><div><b>${escapeHtml(position.contract)}</b><small>USDT 무기한 선물</small></div></div>
      <span class="side ${side.toLowerCase()}">${side} <i>${number(position.leverage) || '—'}x</i></span>
    </div>
    <div class="pnl-row"><div><span>미실현 손익</span><strong class="${pnl >= 0 ? 'positive' : 'negative'}">${formatUsd(pnl)}</strong></div><b class="roe ${roe >= 0 ? 'positive' : 'negative'}">${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%</b></div>
    <div class="metrics">
      <div><span>진입가</span><b>${formatPrice(position.entry_price)}</b></div>
      <div><span>현재가</span><b>${formatPrice(position.mark_price)}</b></div>
      <div><span>포지션 규모</span><b>${formatCompact(position.notional)}</b></div>
      <div><span>계약 수량</span><b>${Math.abs(number(position.size)).toLocaleString('en-US')}</b></div>
    </div>
    <div class="card-foot"><span><i></i>OPEN</span><time>${formatTime(position.observed_at)}</time></div>
  </article>`;
}

function render() {
  const positions = state.positions;
  const filtered = positions.filter((position) => state.filter === 'ALL' || position.side === state.filter);
  const longs = positions.filter((position) => position.side === 'LONG').length;
  const shorts = positions.length - longs;
  const pnl = positions.reduce((sum, position) => sum + number(position.unrealised_pnl), 0);
  const latest = positions.reduce((timestamp, position) => Math.max(timestamp, new Date(position.observed_at || 0).getTime()), 0);
  const age = latest ? Date.now() - latest : Infinity;

  byId('positionCount').textContent = String(positions.length);
  byId('positionBadge').textContent = String(positions.length);
  byId('directionCount').textContent = positions.length ? `${longs} / ${shorts}` : '0 / 0';
  byId('directionDetail').textContent = `Long ${longs} · Short ${shorts}`;
  byId('totalPnl').textContent = formatUsd(pnl);
  byId('totalPnl').className = pnl >= 0 ? 'positive' : 'negative';
  byId('lastObserved').textContent = latest ? formatTime(latest) : '동기화 기록 없음';
  byId('freshness').textContent = age <= STALE_AFTER_MS ? '정상' : latest ? '지연' : '대기';
  byId('freshness').className = age <= STALE_AFTER_MS ? 'positive' : 'warning';
  byId('freshnessDetail').textContent = age <= STALE_AFTER_MS ? '최신 데이터 수신' : latest ? '1분 이상 업데이트 없음' : '첫 데이터 대기 중';
  byId('connectionLabel').textContent = age <= STALE_AFTER_MS ? '실시간 연결됨' : '동기화 확인 중';
  byId('liveDot').classList.toggle('stale', age > STALE_AFTER_MS);

  byId('positionGrid').innerHTML = filtered.length
    ? filtered.map(positionCard).join('')
    : `<div class="state-card"><span class="empty-icon">◇</span><b>${state.filter === 'ALL' ? '현재 열린 포지션이 없습니다' : `${state.filter} 포지션이 없습니다`}</b><small>새 포지션이 확인되면 자동으로 표시됩니다.</small></div>`;
}

function renderError(message) {
  byId('connectionLabel').textContent = '연결 확인 필요';
  byId('liveDot').classList.add('stale');
  byId('freshness').textContent = '오류';
  byId('freshness').className = 'negative';
  byId('freshnessDetail').textContent = '데이터를 불러오지 못함';
  if (!state.positions.length) {
    byId('positionGrid').innerHTML = `<div class="state-card error-state"><span class="empty-icon">!</span><b>포지션을 불러오지 못했습니다</b><small>${escapeHtml(message)}</small><button type="button" data-retry>다시 시도</button></div>`;
  }
}

async function loadPositions() {
  if (state.loading) return;
  state.loading = true;
  byId('refreshButton').classList.add('spinning');
  try {
    const response = await fetch('/api/positions', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || '잠시 후 다시 시도해 주세요.');
    state.positions = Array.isArray(payload.positions) ? payload.positions.map((position) => ({
      ...position,
      side: position.side === 'SHORT' || number(position.size) < 0 ? 'SHORT' : 'LONG',
    })) : [];
    state.lastUpdated = new Date();
    render();
  } catch (error) {
    renderError(error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.');
  } finally {
    state.loading = false;
    byId('refreshButton').classList.remove('spinning');
  }
}

document.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((button) => button.classList.toggle('active', button === filter));
    render();
  }
  if (event.target.closest('#refreshButton') || event.target.closest('[data-retry]')) loadPositions();
});

loadPositions();
setInterval(loadPositions, REFRESH_INTERVAL_MS);

