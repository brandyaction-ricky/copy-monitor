const $b = (id) => document.getElementById(id);
const money = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const numberText = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
const escapeBtc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
const directionLabel = (value) => value === "LONG" ? "상승" : value === "SHORT" ? "하락" : "혼조";
const statusLabel = (value) => ({
  ENTRY_READY: "실행 후보",
  WAIT_STRUCTURE: "구조 변화 대기",
  WAIT_RETEST: "첫 리테스트 대기",
  NO_CHASE: "추격 금지",
  RISK_TOO_WIDE: "손절 폭 과다",
  INVALID: "셋업 무효",
}[value] || "조건 확인 중");
let bitcoinData = null;
let selectedPlan = "long";
let selectedStrategy = "shortTerm";
let selectedChartTimeframe = "5m";
let selectedContract = "BTC_USDT";
const FAVORITES_KEY = "tooja.trading.favoriteContracts.v1";
const CHART_HEIGHT_KEY = "tooja.trading.chartHeight.v1";
const CHART_HEIGHT_MIN = 360;
const CHART_HEIGHT_MAX = 900;
const CHART_HEIGHT_DEFAULT = 520;

const chartTimeframeLabels = { "5m": "5분봉", "15m": "15분봉", "1h": "1시간봉", "4h": "4시간봉" };
const chartLayerState = { liquidity: true, structure: true, ob: true, fvg: true, plan: true };
const tradingChartRuntime = {
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  markerApi: null,
  levelSeries: [],
  currentData: [],
  lastTimeframe: null,
  resizeObserver: null,
  socket: null,
  socketTimeframe: null,
  socketContract: null,
  socketGeneration: 0,
  socketReconnectTimer: null,
  socketPingTimer: null,
  socketAckTimer: null,
  socketRetryCount: 0,
  liveCandles: {},
};

const chartKstFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function chartTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function chartKstParts(value) {
  const timestamp = chartTimestamp(value);
  if (!timestamp) return null;
  return Object.fromEntries(chartKstFormatter.formatToParts(new Date(timestamp * 1000)).map((part) => [part.type, part.value]));
}

function formatChartTickKst(value, tickMarkType) {
  const parts = chartKstParts(value);
  if (!parts) return "";
  return Number(tickMarkType) <= 2 ? `${parts.month}/${parts.day}` : `${parts.hour}:${parts.minute}`;
}

function formatChartTimeKst(value) {
  const parts = chartKstParts(value);
  return parts ? `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute} KST` : "—";
}

function normalizedChartCandles(timeframe = selectedChartTimeframe) {
  const rows = bitcoinData?.chart?.timeframes?.[timeframe]?.candles;
  if (!Array.isArray(rows)) return [];
  const unique = new Map();
  rows.forEach((row) => {
    const candle = {
      time: chartTimestamp(row.t ?? row.time),
      open: Number(row.o ?? row.open),
      high: Number(row.h ?? row.high),
      low: Number(row.l ?? row.low),
      close: Number(row.c ?? row.close),
      volume: Number(row.v ?? row.volume ?? 0),
    };
    if (candle.time == null || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return;
    unique.set(candle.time, candle);
  });
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

function mergedChartCandles(timeframe, closedCandles) {
  const latestClosedTime = closedCandles.at(-1)?.time || 0;
  const liveMap = tradingChartRuntime.liveCandles[timeframe];
  if (!liveMap) return closedCandles;
  const live = [...liveMap.values()].filter((candle) => candle.time > latestClosedTime).sort((a, b) => a.time - b.time).slice(-3);
  return [...closedCandles, ...live];
}

function chartCandleTimeText(time, prefix = "") {
  if (!time) return "—";
  const value = new Date(Number(time) * 1000).toLocaleString("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul",
  });
  return `${prefix}${value} KST`;
}

function updateChartQuote(candle, live = false) {
  if (!candle) return;
  $b("btcChartPrice").textContent = money(candle.close);
  $b("btcChartOhlc").textContent = `O ${numberText(candle.open)} · H ${numberText(candle.high)} · L ${numberText(candle.low)} · C ${numberText(candle.close)}`;
  $b("btcChartHoverTime").textContent = chartCandleTimeText(candle.time, live ? "LIVE · " : "확정 · ");
}

function setChartStreamStatus(state, label) {
  const target = $b("btcChartStream");
  if (!target) return;
  if (target.dataset.state === state && target.dataset.label === label) return;
  target.dataset.state = state;
  target.dataset.label = label;
  target.className = state;
  target.innerHTML = `<i></i>${escapeBtc(label)}`;
}

function currentChartPlanExecutable() {
  const engine = currentDecisionPlan();
  const plan = currentStrategy()?.plans?.[selectedPlan];
  return Boolean(
    bitcoinData?.decisionEngine?.executionEnabled
    && engine?.hardFilterPassed
    && engine?.state?.state === "ENTRY_READY"
    && engine?.decision === plan?.direction
    && engine?.tradePlan
  );
}

function syncChartControls() {
  document.querySelectorAll("[data-chart-tf]").forEach((button) => {
    const active = button.dataset.chartTf === selectedChartTimeframe;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-chart-layer]").forEach((button) => {
    const active = Boolean(chartLayerState[button.dataset.chartLayer]);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $b("btcChartTimeframeLabel").textContent = chartTimeframeLabels[selectedChartTimeframe] || selectedChartTimeframe;
  const change = Number(bitcoinData?.change24h);
  $b("btcChartChange").textContent = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${numberText(change, 2)}%` : "—";
  $b("btcChartChange").className = change >= 0 ? "positive" : "negative";
  const lifecycle = bitcoinData?.decisionEngine?.lifecycle || (bitcoinData?.decisionEngine?.executionEnabled ? "ACTIVE" : "SHADOW");
  const engine = currentDecisionPlan();
  const executionTimeframe = engine?.executionTimeframe || (selectedStrategy === "swing" ? "1h" : "5m");
  const planState = $b("btcChartPlanState");
  if (executionTimeframe !== selectedChartTimeframe) {
    planState.textContent = `컨텍스트 뷰 · 실행 오버레이 ${chartTimeframeLabels[executionTimeframe] || executionTimeframe}`;
    planState.className = "context";
  } else if (currentChartPlanExecutable()) {
    planState.textContent = `ACTIVE · ${engine.decision} 실행 가격 표시`;
    planState.className = engine.decision === "LONG" ? "long" : "short";
  } else if (engine?.candidatePlan) {
    planState.textContent = `${lifecycle} · 분석 후보 · 주문 비활성`;
    planState.className = "candidate";
  } else {
    planState.textContent = `${lifecycle} · 분석 후보 없음 · 주문 비활성`;
    planState.className = "locked";
  }
}

function showChartFallback(title, detail) {
  const fallback = $b("btcChartFallback");
  if (!fallback) return;
  fallback.hidden = false;
  fallback.innerHTML = `<strong>${escapeBtc(title)}</strong><span>${escapeBtc(detail)}</span>`;
}

function hideChartFallback() {
  const fallback = $b("btcChartFallback");
  if (fallback) fallback.hidden = true;
}

function addTradingChartSeries(chart, definition, options, legacyMethod) {
  if (typeof chart.addSeries === "function" && definition) return chart.addSeries(definition, options);
  if (typeof chart[legacyMethod] === "function") return chart[legacyMethod](options);
  throw new Error("지원되는 차트 시리즈 API를 찾지 못했습니다.");
}

function ensureTradingChart() {
  if (tradingChartRuntime.chart) return true;
  const library = window.LightweightCharts;
  const container = $b("btcTradingChart");
  if (!library || !container) {
    showChartFallback("차트 모듈을 불러오지 못했습니다.", "분석 데이터는 계속 갱신됩니다. 잠시 후 새로고침해 주세요.");
    setChartStreamStatus("error", "차트 모듈 오류");
    return false;
  }
  try {
    const chart = library.createChart(container, {
      width: Math.max(1, Math.floor(container.clientWidth)),
      height: Math.max(container.clientHeight, 360),
      autoSize: false,
      layout: { background: { type: "solid", color: "#090d11" }, textColor: "#788590", fontFamily: "Inter, Pretendard, sans-serif", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: "rgba(40, 49, 57, .45)" }, horzLines: { color: "rgba(40, 49, 57, .45)" } },
      rightPriceScale: { borderColor: "#253039", minimumWidth: 70, scaleMargins: { top: .08, bottom: .22 } },
      timeScale: { borderColor: "#253039", timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 7, minBarSpacing: 2, fixLeftEdge: false, tickMarkFormatter: formatChartTickKst },
      crosshair: {
        mode: library.CrosshairMode?.Normal ?? 0,
        vertLine: { color: "rgba(181, 195, 205, .34)", labelBackgroundColor: "#26323a" },
        horzLine: { color: "rgba(181, 195, 205, .34)", labelBackgroundColor: "#26323a" },
      },
      localization: { locale: "ko-KR", timeFormatter: formatChartTimeKst, priceFormatter: (price) => Number(price).toLocaleString("en-US", { maximumFractionDigits: 2 }) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: false, mouseWheel: true, pinch: true },
    });
    const candleSeries = addTradingChartSeries(chart, library.CandlestickSeries, {
      upColor: "#2fd6ad", downColor: "#f05c70", borderUpColor: "#2fd6ad", borderDownColor: "#f05c70", wickUpColor: "#70ddc2", wickDownColor: "#ed8190",
      priceLineVisible: true, priceLineColor: "#60717b", priceLineWidth: 1, lastValueVisible: true,
    }, "addCandlestickSeries");
    const volumeSeries = addTradingChartSeries(chart, library.HistogramSeries, {
      priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false,
    }, "addHistogramSeries");
    if (typeof volumeSeries.priceScale === "function") volumeSeries.priceScale().applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
    else chart.priceScale("").applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
    chart.subscribeCrosshairMove((parameter) => {
      const point = parameter?.seriesData?.get?.(candleSeries);
      if (point && parameter.time) {
        updateChartQuote({ ...point, time: chartTimestamp(parameter.time), volume: 0 }, false);
        $b("btcChartHoverTime").textContent = chartCandleTimeText(chartTimestamp(parameter.time));
        return;
      }
      const latest = tradingChartRuntime.currentData.at(-1);
      if (latest) updateChartQuote(latest, latest.time > (normalizedChartCandles().at(-1)?.time || 0));
    });
    tradingChartRuntime.chart = chart;
    tradingChartRuntime.candleSeries = candleSeries;
    tradingChartRuntime.volumeSeries = volumeSeries;
    if (window.ResizeObserver) {
      tradingChartRuntime.resizeObserver = new ResizeObserver(() => {
        chart.applyOptions({ width: Math.max(1, Math.floor(container.clientWidth)), height: Math.max(container.clientHeight, 360) });
      });
      tradingChartRuntime.resizeObserver.observe(container);
    }
    hideChartFallback();
    return true;
  } catch (error) {
    showChartFallback("차트를 초기화하지 못했습니다.", error.message || "브라우저에서 차트 렌더링을 지원하지 않습니다.");
    setChartStreamStatus("error", "차트 초기화 오류");
    return false;
  }
}

function clearChartLevelSeries() {
  const chart = tradingChartRuntime.chart;
  if (!chart) return;
  tradingChartRuntime.levelSeries.forEach((series) => {
    try { chart.removeSeries(series); } catch (_) { /* 이미 제거된 보조 시리즈는 무시 */ }
  });
  tradingChartRuntime.levelSeries = [];
}

function sourceBarTime(value, candles) {
  const target = chartTimestamp(value);
  if (!target || !candles.length) return null;
  const spacing = candles.length > 1 ? Math.max(1, candles.at(-1).time - candles.at(-2).time) : 300;
  if (target < candles[0].time - spacing || target > candles.at(-1).time + spacing * 2) return null;
  let result = null;
  for (const candle of candles) {
    // 엔진 feature 시각은 확정 캔들의 close time이므로 같은 시각에 열린
    // 다음 캔들이 아니라 바로 직전(신호) 캔들에 마커를 붙인다.
    if (candle.time >= target) break;
    result = candle.time;
  }
  return result ?? candles[0].time;
}

function availabilityBarTime(value, candles) {
  const target = chartTimestamp(value);
  if (!target || !candles.length) return null;
  const spacing = candles.length > 1 ? Math.max(1, candles.at(-1).time - candles.at(-2).time) : 300;
  if (target <= candles[0].time) return candles[0].time;
  for (const candle of candles) {
    if (candle.time >= target) return candle.time;
  }
  return target <= candles.at(-1).time + spacing ? target : null;
}

function chartSegmentEnd(candles) {
  if (!candles.length) return null;
  const configured = Number(bitcoinData?.chart?.timeframes?.[selectedChartTimeframe]?.intervalSeconds);
  const observed = candles.length > 1 ? candles.at(-1).time - candles.at(-2).time : 0;
  return candles.at(-1).time + Math.max(1, configured || observed || 300);
}

function addBoundedLevelSeries({ price, startTime, candles, color, lineWidth = 1, lineStyle, title = "", axisLabelVisible = false }) {
  const chart = tradingChartRuntime.chart;
  const library = window.LightweightCharts;
  const numericPrice = Number(price);
  const endTime = chartSegmentEnd(candles);
  if (!chart || !library || !Number.isFinite(numericPrice) || !startTime || !endTime || startTime > endTime) return null;
  const intervalSeconds = Math.max(1, Number(bitcoinData?.chart?.timeframes?.[selectedChartTimeframe]?.intervalSeconds) || 300);
  const visibleEndTime = startTime === endTime ? endTime + intervalSeconds : endTime;
  try {
    const series = addTradingChartSeries(chart, library.LineSeries, {
      color,
      lineWidth,
      lineStyle,
      title,
      lastValueVisible: axisLabelVisible,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    }, "addLineSeries");
    series.setData([{ time: startTime, value: numericPrice }, { time: visibleEndTime, value: numericPrice }]);
    tradingChartRuntime.levelSeries.push(series);
    return series;
  } catch (_) {
    return null;
  }
}

function setChartMarkers(markers) {
  const library = window.LightweightCharts;
  const series = tradingChartRuntime.candleSeries;
  if (!series) return;
  const sorted = markers.filter((marker) => marker.time != null).sort((a, b) => Number(a.time) - Number(b.time));
  try {
    if (tradingChartRuntime.markerApi?.setMarkers) {
      tradingChartRuntime.markerApi.setMarkers(sorted);
    } else if (typeof library?.createSeriesMarkers === "function") {
      tradingChartRuntime.markerApi = library.createSeriesMarkers(series, sorted);
    } else if (typeof series.setMarkers === "function") {
      series.setMarkers(sorted);
    }
  } catch (_) { /* 마커 플러그인 실패 시 캔들 렌더링은 유지 */ }
}

function markerForFeature(feature, candles, { text, color, direction, time }) {
  if (!feature) return null;
  const markerTime = sourceBarTime(feature[time] || feature.confirmedAt || feature.detectedAt, candles);
  if (!markerTime) return null;
  const long = direction === "LONG";
  return {
    time: markerTime,
    position: long ? "belowBar" : "aboveBar",
    color,
    shape: long ? "arrowUp" : "arrowDown",
    text,
    size: 1,
  };
}

function applyChartAnnotations(candles) {
  clearChartLevelSeries();
  const engine = currentDecisionPlan();
  const library = window.LightweightCharts;
  const dashed = library?.LineStyle?.Dashed ?? 2;
  const dotted = library?.LineStyle?.Dotted ?? 1;
  const solid = library?.LineStyle?.Solid ?? 0;
  const direction = engine?.direction || selectedPlan.toUpperCase();
  const latestPrice = candles.at(-1)?.close || Number(bitcoinData?.price) || 0;
  const executionTimeframe = engine?.executionTimeframe || (selectedStrategy === "swing" ? "1h" : "5m");
  const overlayAligned = Boolean(engine && (
    engine?.executionTimeframe === selectedChartTimeframe
    || (!engine.executionTimeframe && executionTimeframe === selectedChartTimeframe)
  ));
  const markers = [];

  if (overlayAligned && chartLayerState.liquidity && engine?.liquidity?.levels?.length) {
    [...engine.liquidity.levels]
      .filter((level) => Number.isFinite(Number(level.price)))
      .sort((a, b) => Math.abs(Number(a.price) - latestPrice) - Math.abs(Number(b.price) - latestPrice))
      .slice(0, 3)
      .forEach((level) => {
        const availableAt = level.confirmedAt || level.detectedAt || level.formedAt;
        const startTime = availableAt ? availabilityBarTime(availableAt, candles) : candles.at(-1)?.time;
        addBoundedLevelSeries({
          price: level.price,
          startTime,
          candles,
          color: level.side === "BUY_SIDE" ? "rgba(240, 92, 112, .62)" : "rgba(47, 214, 173, .62)",
          lineWidth: 1,
          lineStyle: dashed,
          axisLabelVisible: true,
          title: `유동성 · ${String(level.liquidityType || level.label || level.side || "LIQ").replaceAll("_", " ")}`,
        });
      });
  }

  if (overlayAligned && chartLayerState.structure && engine) {
    const featureMarkers = [
      markerForFeature(engine.sweep, candles, { text: "Sweep", color: "#f5b342", direction, time: "raidAt" }),
      markerForFeature(engine.cisd, candles, { text: "CISD", color: "#56b6ff", direction, time: "confirmedAt" }),
      markerForFeature(engine.displacement, candles, { text: "Displacement", color: "#b98cff", direction, time: "confirmedAt" }),
      markerForFeature(engine.internalBreak, candles, { text: "Internal Break", color: "#42ddbb", direction, time: "confirmedAt" }),
      markerForFeature(engine.mss, candles, { text: "MSS", color: "#ff7f96", direction, time: "confirmedAt" }),
    ];
    markers.push(...featureMarkers.filter(Boolean));
  }

  if (overlayAligned && chartLayerState.ob && engine?.orderBlock && !engine.orderBlock.invalidated) {
    const ob = engine.orderBlock;
    const obColor = direction === "LONG" ? "rgba(245, 179, 66, .72)" : "rgba(255, 127, 150, .72)";
    const startTime = availabilityBarTime(ob.time, candles);
    addBoundedLevelSeries({ price: ob.low, startTime, candles, color: obColor, lineWidth: 1, lineStyle: dotted, title: `OB 하단 · ${ob.state}`, axisLabelVisible: false });
    addBoundedLevelSeries({ price: ob.high, startTime, candles, color: obColor, lineWidth: 1, lineStyle: dotted, title: `OB 상단 · ${ob.state}`, axisLabelVisible: false });
    addBoundedLevelSeries({ price: ob.midpoint, startTime, candles, color: obColor, lineWidth: 1, lineStyle: dashed, title: `OB 50% · ${ob.breakType}`, axisLabelVisible: true });
  }

  if (overlayAligned && chartLayerState.fvg && engine?.fvg) {
    const fvg = engine.fvg;
    const zoneColor = direction === "LONG" ? "rgba(47, 214, 173, .65)" : "rgba(240, 92, 112, .65)";
    const startTime = availabilityBarTime(fvg.confirmedAt, candles);
    addBoundedLevelSeries({ price: fvg.low, startTime, candles, color: zoneColor, lineWidth: 1, lineStyle: dotted, title: "FVG 하단", axisLabelVisible: false });
    addBoundedLevelSeries({ price: fvg.high, startTime, candles, color: zoneColor, lineWidth: 1, lineStyle: dotted, title: "FVG 상단", axisLabelVisible: false });
    addBoundedLevelSeries({ price: fvg.consequentEncroachment, startTime, candles, color: zoneColor, lineWidth: 1, lineStyle: dashed, title: "FVG CE · 근거", axisLabelVisible: false });
    const fvgMarker = markerForFeature(fvg, candles, { text: "FVG", color: zoneColor, direction, time: "confirmedAt" });
    if (fvgMarker) markers.push({ ...fvgMarker, shape: "circle" });
  }

  const executable = overlayAligned && currentChartPlanExecutable();
  const visiblePlan = executable ? engine?.tradePlan : engine?.candidatePlan;
  if (overlayAligned && chartLayerState.plan && visiblePlan) {
    const candidate = !executable;
    const prefix = candidate ? "후보" : "ACTIVE";
    const planStyle = candidate ? dotted : solid;
    const planColor = direction === "LONG" ? "#2fd6ad" : "#f05c70";
    const startTime = availabilityBarTime(visiblePlan.validFrom || engine.generatedAt, candles);
    addBoundedLevelSeries({ price: visiblePlan.entry, startTime, candles, color: planColor, lineWidth: candidate ? 1 : 2, lineStyle: planStyle, axisLabelVisible: true, title: `${prefix} 진입${candidate ? " · 주문 불가" : ""}` });
    addBoundedLevelSeries({ price: visiblePlan.stop, startTime, candles, color: "#ff5e73", lineWidth: candidate ? 1 : 2, lineStyle: planStyle, axisLabelVisible: true, title: `${prefix} SL${candidate ? " · 주문 불가" : ""}` });
    (visiblePlan.targets || []).slice(0, 3).forEach((target, index) => addBoundedLevelSeries({
      price: target.price,
      startTime,
      candles,
      color: "#4ee5b8",
      lineWidth: candidate || index ? 1 : 2,
      lineStyle: candidate ? dotted : index ? dashed : solid,
      axisLabelVisible: true,
      title: `${prefix} TP${index + 1} · ${numberText(target.rr, 1)}R${candidate ? " · 주문 불가" : ""}`,
    }));
  }

  setChartMarkers(markers);
  const annotationStatus = $b("btcChartAnnotationStatus");
  if (!engine) {
    annotationStatus.textContent = "현재 방향의 엔진 근거 없음";
  } else if (!overlayAligned) {
    annotationStatus.textContent = `컨텍스트 뷰 · 실행 오버레이는 ${chartTimeframeLabels[executionTimeframe] || executionTimeframe}에서 표시`;
  } else if (executable) {
    annotationStatus.textContent = `${direction} · ACTIVE 실행 플랜 표시`;
  } else if (engine.candidatePlan) {
    annotationStatus.textContent = `${direction} · SHADOW 분석 후보(점선) · 주문 비활성`;
  } else {
    annotationStatus.textContent = `${direction} · SHADOW 근거만 표시 · 분석 후보 없음`;
  }
}

function disconnectTradingChartSocket() {
  tradingChartRuntime.socketGeneration += 1;
  clearTimeout(tradingChartRuntime.socketReconnectTimer);
  clearInterval(tradingChartRuntime.socketPingTimer);
  clearTimeout(tradingChartRuntime.socketAckTimer);
  tradingChartRuntime.socketReconnectTimer = null;
  tradingChartRuntime.socketPingTimer = null;
  tradingChartRuntime.socketAckTimer = null;
  const socket = tradingChartRuntime.socket;
  tradingChartRuntime.socket = null;
  tradingChartRuntime.socketTimeframe = null;
  tradingChartRuntime.socketContract = null;
  if (socket && socket.readyState < 2) {
    try { socket.close(1000, "timeframe changed"); } catch (_) { /* 종료 중인 소켓은 무시 */ }
  }
}

function updateLiveChartCandle(row, timeframe) {
  const candle = {
    time: chartTimestamp(row.t),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v ?? 0),
  };
  if (candle.time == null || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return;
  const closedCandles = normalizedChartCandles(timeframe);
  const latestClosed = closedCandles.at(-1)?.time || 0;
  if (candle.time <= latestClosed) return;
  if (!tradingChartRuntime.liveCandles[timeframe]) tradingChartRuntime.liveCandles[timeframe] = new Map();
  const liveMap = tradingChartRuntime.liveCandles[timeframe];
  const isNewLiveBar = !liveMap.has(candle.time);
  liveMap.set(candle.time, candle);
  [...liveMap.keys()].filter((time) => time <= latestClosed).forEach((time) => liveMap.delete(time));
  while (liveMap.size > 3) liveMap.delete([...liveMap.keys()].sort((a, b) => a - b)[0]);
  if (timeframe !== selectedChartTimeframe || !tradingChartRuntime.candleSeries) return;
  tradingChartRuntime.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
  tradingChartRuntime.volumeSeries.update({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(47, 214, 173, .32)" : "rgba(240, 92, 112, .32)" });
  tradingChartRuntime.currentData = mergedChartCandles(timeframe, closedCandles);
  updateChartQuote(candle, true);
  if (isNewLiveBar) applyChartAnnotations(tradingChartRuntime.currentData);
  setChartStreamStatus("live", "LIVE · 실시간 캔들");
}

function connectTradingChartSocket() {
  if (document.hidden) return;
  if (!bitcoinData?.chart?.timeframes?.[selectedChartTimeframe]) return;
  if (typeof window.WebSocket !== "function") {
    setChartStreamStatus("rest", "REST · 30초 갱신");
    return;
  }
  if (tradingChartRuntime.socket && tradingChartRuntime.socketTimeframe === selectedChartTimeframe && tradingChartRuntime.socketContract === selectedContract && tradingChartRuntime.socket.readyState < 2) return;
  disconnectTradingChartSocket();
  const timeframe = selectedChartTimeframe;
  const generation = ++tradingChartRuntime.socketGeneration;
  setChartStreamStatus("connecting", "LIVE 연결 중");
  try {
    const socket = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt");
    let acknowledged = false;
    let subscriptionRejected = false;
    const closeToRest = ({ retry }) => {
      if (generation !== tradingChartRuntime.socketGeneration) return;
      subscriptionRejected = !retry;
      clearTimeout(tradingChartRuntime.socketAckTimer);
      tradingChartRuntime.socketAckTimer = null;
      setChartStreamStatus("rest", "REST · 30초 갱신");
      if (socket.readyState < 2) {
        try { socket.close(1000, "subscribe failed"); } catch (_) { /* 폴백 상태 유지 */ }
      }
    };
    const rejectToRest = () => closeToRest({ retry: false });
    const timeoutToRest = () => closeToRest({ retry: true });
    tradingChartRuntime.socket = socket;
    tradingChartRuntime.socketTimeframe = timeframe;
    tradingChartRuntime.socketContract = selectedContract;
    socket.addEventListener("open", () => {
      if (generation !== tradingChartRuntime.socketGeneration) return;
      socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.candlesticks", event: "subscribe", payload: [timeframe, selectedContract] }));
      setChartStreamStatus("connecting", "LIVE 구독 확인 중");
      tradingChartRuntime.socketAckTimer = setTimeout(timeoutToRest, 8_000);
      tradingChartRuntime.socketPingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.ping" }));
      }, 20_000);
    });
    socket.addEventListener("message", (event) => {
      if (generation !== tradingChartRuntime.socketGeneration) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.error) {
        rejectToRest();
        return;
      }
      if (message.channel === "futures.candlesticks" && message.event === "subscribe") {
        const status = String(message.result?.status || "success").toLowerCase();
        if (!["success", "ok"].includes(status)) {
          rejectToRest();
          return;
        }
        acknowledged = true;
        tradingChartRuntime.socketRetryCount = 0;
        clearTimeout(tradingChartRuntime.socketAckTimer);
        tradingChartRuntime.socketAckTimer = null;
        setChartStreamStatus("live", "LIVE · 연결됨");
        return;
      }
      if (!acknowledged || message.channel !== "futures.candlesticks" || message.event !== "update") return;
      const rows = Array.isArray(message.result) ? message.result : [message.result].filter(Boolean);
      rows.forEach((row) => {
        if (row.n && !String(row.n).startsWith(`${timeframe}_`)) return;
        updateLiveChartCandle(row, timeframe);
      });
    });
    socket.addEventListener("error", () => {
      if (generation === tradingChartRuntime.socketGeneration) setChartStreamStatus("rest", "REST · 30초 갱신");
    });
    socket.addEventListener("close", () => {
      if (generation !== tradingChartRuntime.socketGeneration) return;
      clearInterval(tradingChartRuntime.socketPingTimer);
      clearTimeout(tradingChartRuntime.socketAckTimer);
      tradingChartRuntime.socketPingTimer = null;
      tradingChartRuntime.socketAckTimer = null;
      tradingChartRuntime.socket = null;
      tradingChartRuntime.socketTimeframe = null;
      setChartStreamStatus("rest", "REST · 30초 갱신");
      if (!document.hidden && !subscriptionRejected) {
        const retryDelay = Math.min(30_000, 1_000 * (2 ** Math.min(tradingChartRuntime.socketRetryCount, 5)));
        tradingChartRuntime.socketRetryCount += 1;
        tradingChartRuntime.socketReconnectTimer = setTimeout(connectTradingChartSocket, retryDelay);
      }
    });
  } catch (_) {
    setChartStreamStatus("rest", "REST · 30초 갱신");
  }
}

function renderTradingChart({ fit = false } = {}) {
  syncChartControls();
  const source = bitcoinData?.chart?.timeframes?.[selectedChartTimeframe];
  const closedCandles = normalizedChartCandles();
  if (!source || !closedCandles.length) {
    showChartFallback("차트 데이터를 불러오는 중입니다.", "Gate.io 확정 캔들 데이터가 준비되면 자동으로 표시됩니다.");
    setChartStreamStatus("rest", "REST · 데이터 대기");
    return;
  }
  if (!ensureTradingChart()) return;
  hideChartFallback();
  const timeframeChanged = tradingChartRuntime.lastTimeframe !== selectedChartTimeframe;
  const candles = mergedChartCandles(selectedChartTimeframe, closedCandles);
  tradingChartRuntime.currentData = candles;
  tradingChartRuntime.candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  tradingChartRuntime.volumeSeries.setData(candles.map((candle) => ({
    time: candle.time,
    value: candle.volume,
    color: candle.close >= candle.open ? "rgba(47, 214, 173, .30)" : "rgba(240, 92, 112, .30)",
  })));
  tradingChartRuntime.lastTimeframe = selectedChartTimeframe;
  updateChartQuote(candles.at(-1), candles.at(-1).time > closedCandles.at(-1).time);
  applyChartAnnotations(candles);
  if (fit || timeframeChanged) tradingChartRuntime.chart.timeScale().fitContent();
  connectTradingChartSocket();
}

function strategies() {
  if (bitcoinData?.strategies) return bitcoinData.strategies;
  return {
    shortTerm: {
      label: "단기",
      timeframe: "15분 구조 · 5분 실행",
      holdingPeriod: "수분~1일",
      direction: bitcoinData.direction,
      status: bitcoinData.status,
      scores: bitcoinData.scores,
      plans: bitcoinData.plans,
      primaryPlan: bitcoinData.primaryPlan,
      checklist: bitcoinData.checklist,
      checklistScore: bitcoinData.checklistScore,
      executionRule: bitcoinData.executionRule,
    },
  };
}

function currentStrategy() {
  return strategies()[selectedStrategy] || strategies().shortTerm;
}

function currentDecisionPlan() {
  const scope = bitcoinData?.decisionEngine?.[selectedStrategy];
  return scope?.timeframes?.[selectedChartTimeframe]?.plans?.[selectedPlan]
    || scope?.plans?.[selectedPlan]
    || currentStrategy()?.decisionEngine
    || null;
}

function timeText(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false, timeZone:"Asia/Seoul" });
}

function toast(message) {
  const target = $b("toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(window.bitcoinToastTimer);
  window.bitcoinToastTimer = setTimeout(() => target.classList.remove("show"), 2600);
}

function storedFavorites() {
  try {
    const rows = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(rows) ? rows.filter((item) => /^[A-Z0-9]{2,20}_USDT$/.test(item)).slice(0, 20) : [];
  } catch (_) { return []; }
}

function saveFavorites(rows) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(rows.slice(0, 20))); } catch (_) { /* 저장 불가 환경 */ }
}

function renderFavoriteSymbols() {
  const rows = storedFavorites();
  const active = rows.includes(selectedContract);
  const toggle = $b("btcFavoriteToggle");
  toggle.textContent = active ? "★" : "☆";
  toggle.classList.toggle("active", active);
  toggle.setAttribute("aria-pressed", String(active));
  toggle.title = active ? "현재 종목 즐겨찾기 해제" : "현재 종목 즐겨찾기";
  $b("btcFavoriteSymbols").innerHTML = rows.length
    ? `<span>즐겨찾기</span>${rows.map((contract) => `<button type="button" data-favorite-contract="${contract}" class="${contract === selectedContract ? "active" : ""}">★ ${contract.replace(/_USDT$/, "")}</button>`).join("")}`
    : `<small>☆ 자주 보는 종목을 즐겨찾기에 추가해 보세요.</small>`;
}

function storedChartHeight() {
  try { return clampNumber(Number(localStorage.getItem(CHART_HEIGHT_KEY)) || CHART_HEIGHT_DEFAULT, CHART_HEIGHT_MIN, CHART_HEIGHT_MAX); }
  catch (_) { return CHART_HEIGHT_DEFAULT; }
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function setChartHeight(height, persist = true) {
  const next = clampNumber(height, CHART_HEIGHT_MIN, CHART_HEIGHT_MAX);
  $b("btcChartStage").style.height = `${next}px`;
  if (persist) {
    try { localStorage.setItem(CHART_HEIGHT_KEY, String(next)); } catch (_) { /* 저장 불가 환경 */ }
  }
  tradingChartRuntime.chart?.applyOptions({ height: next });
}

function renderTimeframes() {
  const labels = [
    ["week", "1W", "큰 방향"], ["day", "1D", "중기 방향"], ["fourHour", "4H", "스윙 구조"],
    ["oneHour", "1H", "단기 추세"], ["fifteenMinute", "15m", "실행 구조"], ["fiveMinute", "5m", "진입 트리거"],
  ];
  $b("btcTimeframes").innerHTML = labels.map(([key, label, role]) => {
    const frame = bitcoinData.timeframes[key];
    const tone = frame.direction === "LONG" ? "long" : frame.direction === "SHORT" ? "short" : "wait";
    const focusFrames = selectedStrategy === "swing" ? ["week", "day", "fourHour", "oneHour"] : ["oneHour", "fifteenMinute", "fiveMinute"];
    const focus = focusFrames.includes(key) ? "focus" : "context";
    return `<article class="btc-timeframe ${tone} ${focus}"><small>${label} · ${role}</small><strong>${directionLabel(frame.direction)}</strong><div><span>RSI ${numberText(frame.rsi, 1)}</span><span>EMA20 ${money(frame.ema20)}</span></div></article>`;
  }).join("");
  const engine = currentDecisionPlan();
  const visiblePlan = engine?.tradePlan || engine?.candidatePlan;
  const bonusLabels = {
    "HTF Context": "상위 시간대 방향",
    "Premium/Discount Location": "프리미엄/디스카운트 위치",
    "Liquidity Pool": "유동성 풀",
    "Liquidity Sweep": "유동성 스윕",
    CISD: "CISD",
    Displacement: "변위",
    "Internal Structure Break": "내부 구조 돌파",
    MSS: "MSS",
    "FVG Entry Array": "FVG 진입 구간",
  };
  $b("btcTimeframeSetupScore").textContent = `${engine?.score ?? 0}/100 · ${engine?.scoreBand?.grade || "—"}`;
  $b("btcTimeframeBonus").innerHTML = engine?.bonusMissing?.length
    ? engine.bonusMissing.map((item) => `<span>${escapeBtc(bonusLabels[item] || item)}</span>`).join("")
    : `<span class="complete">모든 가산점 충족</span>`;
  $b("btcTimeframeTargets").innerHTML = visiblePlan?.targets?.length
    ? visiblePlan.targets.slice(0, 3).map((target, index) => `<article><small>TP${index + 1} · ${escapeBtc(target.source || "LIQ")}</small><strong>${money(target.price)}</strong><b>R:R ${numberText(target.rr, 2)}</b></article>`).join("")
    : `<p>현재 ${chartTimeframeLabels[selectedChartTimeframe]} ${selectedPlan.toUpperCase()} 방향에서 1.2R 이상 유동성 목표가 없습니다.</p>`;
}

function verdictTone(direction) {
  return direction === "LONG" ? "long" : direction === "SHORT" ? "short" : direction === "NO_TRADE" ? "blocked" : "wait";
}

function renderStrategyOverview() {
  const map = strategies();
  const bind = (key, prefix) => {
    const strategy = map[key];
    if (!strategy) return;
    const badge = $b(`${prefix}Badge`);
    const decision = strategy.decision || strategy.direction;
    badge.textContent = decision === "WAIT" ? "관망" : decision === "NO_TRADE" ? "거래 제외" : decision;
    badge.className = verdictTone(decision);
    $b(`${prefix}Status`).textContent = strategy.status;
    $b(`${prefix}Meta`).textContent = `보유 ${strategy.holdingPeriod} · 셋업 품질 ${strategy.setupQuality ?? 0}/100 · 승률 아님`;
  };
  bind("shortTerm", "btcShortTerm");
  bind("swing", "btcSwing");
  document.querySelectorAll("[data-strategy]").forEach((button) => {
    const active = button.dataset.strategy === selectedStrategy;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderDecisionEngine() {
  const engine = currentDecisionPlan();
  if (!engine) return;
  const decisionTone = engine.decision === "LONG" ? "long" : engine.decision === "SHORT" ? "short" : engine.decision === "NO_TRADE" ? "blocked" : "wait";
  $b("btcEngineModel").textContent = engine.model || "MODEL_1_SWEEP_REVERSAL";
  const executionEnabled = Boolean(bitcoinData?.decisionEngine?.executionEnabled);
  const lifecycle = bitcoinData?.decisionEngine?.lifecycle || (executionEnabled ? "ACTIVE" : "SHADOW");
  $b("btcEngineLifecycle").textContent = `V2 ${lifecycle}`;
  $b("btcEngineMode").textContent = `${engine.mode || "BALANCED"} · ${lifecycle}`;
  $b("btcEngineDecision").textContent = engine.decision;
  $b("btcEngineDecision").className = decisionTone;
  $b("btcEngineState").textContent = engine.state?.stateLabel || engine.state?.state || "—";
  $b("btcEngineNext").textContent = engine.state?.nextCondition || "—";
  const band = engine.scoreBand || { grade: "—", label: "평가 중" };
  $b("btcEngineEdge").textContent = `${engine.score ?? 0}/100 · ${band.grade} · ${band.label}`;
  $b("btcEnginePipeline").innerHTML = (engine.pipeline || []).map((item, index) => `
    <article class="${String(item.status || "WAIT").toLowerCase()}">
      <i>${item.status === "PASS" ? "✓" : item.status === "FAIL" ? "×" : item.status === "OPTIONAL" ? "·" : index + 1}</i>
      <div><small>${escapeBtc(item.label)}</small><strong>${escapeBtc(item.detail)}</strong></div>
    </article>`).join("");
  const sweep = engine.sweep;
  const cisd = engine.cisd;
  const displacement = engine.displacement;
  const structure = engine.internalBreak;
  const fvg = engine.fvg;
  const missing = engine.missingConditions?.length ? engine.missingConditions.join(" · ") : "없음";
  const bonusMissing = engine.bonusMissing?.length ? engine.bonusMissing.join(" · ") : "모든 가산점 충족";
  $b("btcEngineEvidence").innerHTML = `
    <div><span>HTF / Location</span><strong>${escapeBtc(engine.htf?.bias || "N/A")} · ${escapeBtc(engine.location?.zone || "N/A")}</strong></div>
    <div><span>Sweep</span><strong>${sweep ? `${escapeBtc(sweep.levelType)} · ${escapeBtc(sweep.state)} · ${numberText(sweep.penetrationAtr, 3)} ATR` : "N/A"}</strong></div>
    <div><span>CISD</span><strong>${cisd ? `${cisd.sweepId ? "Sweep 연결" : "독립 감지"} · ${numberText(cisd.closeBeyondAnchorAtr, 3)} ATR` : "N/A"}</strong></div>
    <div><span>Displacement</span><strong>${displacement ? `${displacement.intrinsicScore}/100 · Range ${numberText(displacement.rangeAtr, 2)} ATR` : "N/A"}</strong></div>
    <div><span>Structure / MSS</span><strong>${structure ? escapeBtc(structure.eventType) : "N/A"} / ${engine.mss ? escapeBtc(engine.mss.eventType) : "N/A"}</strong></div>
    <div><span>Entry FVG</span><strong>${fvg ? `${money(fvg.low)}–${money(fvg.high)} · CE ${money(fvg.consequentEncroachment)}` : "N/A"}</strong></div>
    <div class="wide"><span>필수 안전조건</span><strong>${escapeBtc(missing === "없음" ? "통과 · 구조 손절 + R:R 1.2" : missing)}</strong></div>
    <div class="wide"><span>미충족 가산점</span><strong>${escapeBtc(bonusMissing)}</strong></div>
    <div class="wide version"><span>검증 버전</span><strong>${escapeBtc(engine.engineVersion)} · ${escapeBtc(engine.parameterSetVersion)} · 점수는 승률 아님</strong></div>`;
}

function renderPlan() {
  if (!$b("btcPlanCard")) {
    renderExecutionStrip();
    return;
  }
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const engine = currentDecisionPlan();
  const tone = plan.direction === "LONG" ? "long" : "short";
  const executionEnabled = Boolean(bitcoinData?.decisionEngine?.executionEnabled);
  const executable = Boolean(executionEnabled && engine?.hardFilterPassed && engine?.state?.state === "ENTRY_READY" && engine?.decision === plan.direction && engine?.tradePlan);
  const candidate = !executable && engine?.shareEligible && engine?.candidatePlan;
  if (candidate) {
    const modelPlan = engine.candidatePlan;
    const targetRows = modelPlan.targets.map((target) => `<article><div><small>${escapeBtc(target.label)} · ${escapeBtc(target.source)}</small><strong>${money(target.price)}</strong></div><b>R:R ${numberText(target.rr, 2)}</b><p>기존 유동성 기준 분석 목표</p></article>`).join("");
    const band = engine.scoreBand || { grade: "—", label: "평가 중" };
    $b("btcPlanCard").className = `panel btc-plan-card ${tone} candidate`;
    $b("btcPlanCard").innerHTML = `
      <div class="btc-plan-hero">
        <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>분석 후보 · 주문 비활성</span></div><h3>${engine.state?.state === "NO_CHASE" ? "추격 금지 타점" : "조건부 타점 포착"}</h3><p>타점 점수 ${engine.score}/100 · ${escapeBtc(band.grade)} · ${escapeBtc(band.label)} · 승률 아님</p></div>
        <strong>${money(modelPlan.entryZone.low)}<i>—</i>${money(modelPlan.entryZone.high)}</strong>
      </div>
      <div class="btc-plan-level-grid">
        <article><small>후보 진입 · FVG CE</small><strong>${money(modelPlan.entry)}</strong></article>
        <article><small>현재 상태</small><strong>${escapeBtc(engine.state?.stateLabel || "관찰")}</strong></article>
        <article><small>구조 손절</small><strong class="negative">${money(modelPlan.stop)}</strong></article>
        <article><small>1차 목표 · R:R ${numberText(modelPlan.targets[0]?.rr, 2)}</small><strong>${money(modelPlan.targets[0]?.price)}</strong></article>
      </div>
      <div class="btc-plan-lock"><b>분석 후보 · 실제 주문 연결 없음</b><p>R:R 1.2 이상과 구조 손절은 충족했습니다. 점수가 낮을수록 포지션 축소 또는 추가 확인이 필요하며, NO_CHASE에서는 진입하지 않습니다.</p></div>
      <section class="btc-plan-basis"><h4>미충족 가산점</h4><div>${(engine.bonusMissing?.length ? engine.bonusMissing : ["없음"]).map((item) => `<span>${escapeBtc(item)}</span>`).join("")}</div></section>
      <section class="btc-targets"><h4>분할 익절 후보</h4><div>${targetRows}</div></section>`;
    renderExecutionStrip();
    return;
  }
  if (!executable) {
    const missing = !executionEnabled
      ? "SHADOW 검증 중 · Walk-forward 통과 전 운영 실행 비활성"
      : engine?.missingConditions?.length ? engine.missingConditions.join(" · ") : engine?.state?.nextCondition || "검증 조건 대기";
    $b("btcPlanCard").className = `panel btc-plan-card ${tone} locked`;
    $b("btcPlanCard").innerHTML = `
      <div class="btc-plan-hero">
        <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>${escapeBtc(strategy.label)} · MODEL 1 후보</span></div><h3>실행 잠금</h3><p>현재 ${escapeBtc(engine?.decision || "WAIT")} · ${escapeBtc(engine?.state?.stateLabel || "조건 확인 중")} · Setup Score ${engine?.score ?? 0}/100</p></div>
        <strong class="btc-locked-value">조건 충족 전 비활성</strong>
      </div>
      <div class="btc-plan-lock"><b>실행 가격 잠금 · 차트 점선은 주문 불가 후보</b><p>차트의 점선 진입·SL·TP는 분석용 candidatePlan입니다. 구조 손절과 기존 유동성 목표 R:R 1.2 이상만 필수이며, HTF·Location·Sweep·CISD·Displacement·구조·FVG는 100점 가산점으로 평가합니다.</p></div>
      <section class="btc-confirm-section"><h4>다음 확인 조건</h4><p>${escapeBtc(engine?.state?.nextCondition || "새 셋업 대기")}</p></section>
      <section class="btc-plan-basis"><h4>미충족 Hard Filter</h4><div>${escapeBtc(missing).split(" · ").map((item) => `<span>${item}</span>`).join("")}</div></section>
      <div class="btc-invalidation"><div><small>Historical Edge</small><p>N/A · 표본 0 · Walk-forward 미보정</p></div><div><small>실행 정책</small><p>확정 신호 이후 다음 캔들 시가 또는 확인 후 지정가</p></div></div>`;
    renderExecutionStrip();
    return;
  }
  const modelPlan = engine.tradePlan;
  const targetRows = modelPlan.targets.map((target) => `<article><div><small>${escapeBtc(target.label)} · ${escapeBtc(target.source)}</small><strong>${money(target.price)}</strong></div><b>R:R ${numberText(target.rr, 2)}</b><p>이미 존재하고 확인 가능한 유동성 레벨</p></article>`).join("");
  $b("btcPlanCard").className = `panel btc-plan-card ${tone}`;
  $b("btcPlanCard").innerHTML = `
    <div class="btc-plan-hero">
      <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>${escapeBtc(strategy.label)} · ${escapeBtc(engine.mode)}</span></div><h3>진입 조건 충족</h3><p>Setup Confluence ${engine.score}/100 · Hard Filter 통과 · 승률 아님</p></div>
      <strong>${money(modelPlan.entryZone.low)}<i>—</i>${money(modelPlan.entryZone.high)}</strong>
    </div>
    <div class="btc-plan-level-grid">
      <article><small>FVG CE 지정가</small><strong>${money(modelPlan.entry)}</strong></article>
      <article><small>신호 확정</small><strong>${timeText(engine.generatedAt)}</strong></article>
      <article><small>구조 하드 스탑</small><strong class="negative">${money(modelPlan.stop)}</strong></article>
      <article><small>1차 유동성 목표 · R:R ${numberText(modelPlan.targets[0]?.rr, 2)}</small><strong>${money(modelPlan.targets[0]?.price)}</strong></article>
    </div>
    <section class="btc-confirm-section"><h4>진입 확인 순서</h4><ol>${engine.pipeline.filter((item) => item.status === "PASS").map((item) => `<li>${escapeBtc(item.label)} · ${escapeBtc(item.detail)}</li>`).join("")}</ol></section>
    <section class="btc-plan-basis"><h4>진입 구간 산출 근거</h4><div><span>FVG CE</span><span>Sweep-linked CISD</span><span>Intrinsic Displacement</span><span>기존 유동성 TP</span></div></section>
    <section class="btc-targets"><h4>분할 익절 계획</h4><div>${targetRows}</div></section>
    <div class="btc-invalidation"><div><small>Entry Invalidation</small><p>${money(modelPlan.entryInvalidation)}</p></div><div><small>Model Invalidation</small><p>${money(modelPlan.modelInvalidation)} · 하드 스탑 ${money(modelPlan.stop)}</p></div></div>`;
  renderExecutionStrip();
}

function renderChecklist() {
  const engine = currentDecisionPlan();
  const rows = engine?.pipeline || [];
  const passed = rows.filter((item) => item.status === "PASS").length;
  $b("btcChecklistScore").textContent = `${passed}/${rows.length}`;
  $b("btcChecklist").innerHTML = rows.map((item) => `<div class="${item.status === "PASS" ? "pass" : "fail"}"><i>${item.status === "PASS" ? "✓" : item.status === "FAIL" ? "×" : "—"}</i><span>${escapeBtc(item.label)} · ${escapeBtc(item.detail)}</span></div>`).join("");
}

function renderExecutionStrip() {
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const engine = currentDecisionPlan();
  const executable = Boolean(bitcoinData?.decisionEngine?.executionEnabled && engine?.hardFilterPassed && engine?.state?.state === "ENTRY_READY" && engine?.decision === plan.direction && engine?.tradePlan);
  const candidate = !executable && engine?.shareEligible && engine?.candidatePlan;
  const visiblePlan = executable ? engine.tradePlan : candidate ? engine.candidatePlan : null;
  const tone = verdictTone(engine?.decision);
  const direction = executable
    ? `${engine.decision} · 실행 조건 충족`
    : candidate
      ? `${plan.direction} 후보 · ${engine.score}/100 · ${engine.state?.state === "NO_CHASE" ? "추격 금지" : "주문 비활성"}`
      : `${engine?.decision || "WAIT"} · 후보 대기`;
  $b("btcFlowStrategy").textContent = `${strategy.label} · ${plan.direction}`;
  $b("btcFlowDirection").textContent = direction;
  $b("btcFlowDirection").className = tone;
  $b("btcFlowEntry").textContent = visiblePlan ? `${candidate ? "후보 " : ""}${money(visiblePlan.entryZone.low)} – ${money(visiblePlan.entryZone.high)}` : "— · 후보 대기";
  $b("btcFlowStop").textContent = visiblePlan ? `${candidate ? "후보 " : ""}${money(visiblePlan.stop)}` : "— · 후보 대기";
  $b("btcFlowStop").className = "negative";
  $b("btcFlowTarget").textContent = visiblePlan ? `${candidate ? "후보 " : ""}${money(visiblePlan.targets[0]?.price)}` : "— · 후보 대기";
  $b("btcFlowTarget").className = "positive";
}

function renderMarketData() {
  const structure = bitcoinData.marketStructure;
  const session = structure.session || {};
  const sessionText = { ASIA: "아시아", LONDON: "런던", NEW_YORK: "뉴욕", OFF_HOURS: "비주요 시간" }[session.session] || "N/A";
  if (selectedStrategy === "swing") {
    const frame4h = bitcoinData.timeframes.fourHour;
    const frame1d = bitcoinData.timeframes.day;
    const fvg = structure.fvg4h?.[selectedPlan];
    const orderBlock = structure.orderBlocks?.swing?.[selectedPlan];
    const range = structure.swingRange;
    const structureEvent = structure.structure1h?.latestEvent;
    const channel = structure.channels?.swing;
    $b("btcMicroData").innerHTML = `
      <div><span>HTF 바이어스</span><strong>${escapeBtc(structure.swingBias || "WAIT")}</strong></div>
      <div><span>4시간 레인지 위치</span><strong>${escapeBtc(range?.zone || "N/A")} · ${numberText(range?.positionPercent, 1)}%</strong></div>
      <div><span>1시간 구조</span><strong>${structureEvent ? `${escapeBtc(structureEvent.type)} ${escapeBtc(structureEvent.direction)}` : "확정 구조 없음"}</strong></div>
      <div><span>PWH / PWL</span><strong>${money(session.previousWeekHigh)} / ${money(session.previousWeekLow)}</strong></div>
      <div><span>4시간 RSI</span><strong>${numberText(frame4h.rsi, 1)}</strong></div>
      <div><span>펀딩</span><strong>${bitcoinData.fundingRate >= 0 ? "+" : ""}${numberText(bitcoinData.fundingRate, 4)}%</strong></div>
      <div><span>${selectedPlan.toUpperCase()} 4H OB</span><strong>${orderBlock ? `${money(orderBlock.low)}–${money(orderBlock.high)} · ${escapeBtc(orderBlock.state)}` : "N/A"}</strong></div>
      <div><span>${selectedPlan.toUpperCase()} 4H FVG</span><strong>${fvg ? `${money(fvg.low)}–${money(fvg.high)} · ${escapeBtc(fvg.state)}` : "N/A"}</strong></div>
      <div><span>4시간 채널</span><strong>${channel?.valid ? `${escapeBtc(channel.direction)} · 상하단 3회+ 터치` : "약함/N/A"}</strong></div>
      <div><span>SMT</span><strong>N/A · 비교 자산 미연결</strong></div>`;
    return;
  }
  const sweep = structure.sweep ? `${structure.sweep.label || (structure.sweep.direction === "LONG" ? "하단" : "상단")} 스윕 · ${money(structure.sweep.level)} · ${structure.sweep.confirmed ? "반전 확인" : "후속 확인 대기"}` : "최근 유동성 스윕 없음";
  const fvg5Long = structure.fvg5.long ? `${money(structure.fvg5.long.low)}–${money(structure.fvg5.long.high)}` : "없음";
  const fvg5Short = structure.fvg5.short ? `${money(structure.fvg5.short.low)}–${money(structure.fvg5.short.high)}` : "없음";
  const range = structure.executionRange;
  const orderBlock = structure.orderBlocks?.shortTerm?.[selectedPlan];
  const structureEvent = structure.structure5?.latestEvent;
  const channel = structure.channels?.shortTerm;
  $b("btcMicroData").innerHTML = `
    <div><span>세션 · HTF</span><strong>${sessionText} · ${escapeBtc(structure.shortTermBias || "WAIT")}</strong></div>
    <div><span>PDH / PDL</span><strong>${money(session.previousDayHigh)} / ${money(session.previousDayLow)}</strong></div>
    <div><span>Asia High / Low</span><strong>${money(session.asiaHigh)} / ${money(session.asiaLow)}</strong></div>
    <div><span>Daily Open</span><strong>${money(session.dailyOpen)}</strong></div>
    <div><span>15분 레인지 위치</span><strong>${escapeBtc(range?.zone || "N/A")} · ${numberText(range?.positionPercent, 1)}%</strong></div>
    <div><span>5분 구조</span><strong>${structureEvent ? `${escapeBtc(structureEvent.type)} ${escapeBtc(structureEvent.direction)}` : "확정 구조 없음"}</strong></div>
    <div><span>${selectedPlan.toUpperCase()} 5m OB</span><strong>${orderBlock ? `${money(orderBlock.low)}–${money(orderBlock.high)} · ${escapeBtc(orderBlock.state)}` : "N/A"}</strong></div>
    <div><span>${selectedPlan.toUpperCase()} 5m FVG</span><strong>${selectedPlan === "long" ? fvg5Long : fvg5Short}</strong></div>
    <div><span>5분 거래량 / 펀딩</span><strong>${numberText(structure.volume5m.ratio, 2)}× · ${bitcoinData.fundingRate >= 0 ? "+" : ""}${numberText(bitcoinData.fundingRate, 4)}%</strong></div>
    <div><span>호가 불균형 · 보조</span><strong class="${structure.orderBook.imbalance >= 0 ? "positive" : "negative"}">${structure.orderBook.imbalance >= 0 ? "+" : ""}${numberText(structure.orderBook.imbalance, 1)}%</strong></div>
    <div><span>15분 채널</span><strong>${channel?.valid ? `${escapeBtc(channel.direction)} · 상하단 3회+ 터치` : "약함/N/A"}</strong></div>
    <div><span>SMT</span><strong>N/A · 비교 자산 미연결</strong></div>
    <div class="wide"><span>유동성 스윕</span><strong>${escapeBtc(sweep)}</strong></div>`;
}

function renderSelectedStrategy() {
  const strategy = currentStrategy();
  $b("btcTimeframeGuide").textContent = selectedStrategy === "swing"
    ? "스윙은 주봉·일봉·4시간 정렬을 우선하고 1시간봉으로 진입을 확인합니다."
    : "단기는 1시간·15분·5분 정렬을 우선하고 5분봉으로 진입을 확인합니다.";
  $b("btcChecklistHeading").textContent = selectedStrategy === "swing" ? "스윙 의사결정 단계" : "단기 의사결정 단계";
  $b("btcChecklistGuide").textContent = "PASS 단계만 순서대로 인정";
  $b("btcDataGuide").textContent = selectedStrategy === "swing" ? "4시간·일봉·펀딩" : "5분봉·호가·펀딩";
  $b("btcExecutionPrinciple").textContent = selectedStrategy === "swing"
    ? "4H Context와 1H 실행을 분리합니다. 구조 손절과 기존 유동성 목표 R:R 1.2 이상은 필수이며, 나머지 ICT 근거는 100점 가산점으로 품질을 구분합니다."
    : "1H Context와 5m 실행을 분리합니다. 구조 손절과 기존 유동성 목표 R:R 1.2 이상은 필수이며, 나머지 ICT 근거는 100점 가산점으로 품질을 구분합니다.";
  renderStrategyOverview();
  renderTimeframes();
  renderDecisionEngine();
  renderPlan();
  renderChecklist();
  renderMarketData();
  renderTradingChart();
}

function renderBitcoin() {
  selectedContract = bitcoinData.contract || selectedContract;
  const asset = selectedContract.replace(/_USDT$/, "");
  $b("tradingHeroSymbol").textContent = `${asset}/USDT · DECISION & EXECUTION`;
  $b("tradingHeroAsset").textContent = asset;
  $b("btcChartSymbol").textContent = `GATE.IO · ${selectedContract} PERPETUAL`;
  $b("btcSymbolInput").value = asset;
  renderFavoriteSymbols();
  $b("btcMarketStatus").textContent = `${bitcoinData.source} · LIVE`;
  $b("btcCandleTime").textContent = `최근 확정 5분봉 ${timeText(bitcoinData.candleClosedAt)} KST`;
  selectedPlan = currentStrategy().primaryPlan === "SHORT" ? "short" : "long";
  document.querySelectorAll("[data-plan]").forEach((button) => {
    const active = button.dataset.plan === selectedPlan;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderSelectedStrategy();
}

async function loadBitcoin(showToast = false) {
  const button = $b("bitcoinRefresh");
  button.disabled = true;
  try {
    const response = await fetch(`/api/bitcoin?symbol=${encodeURIComponent(selectedContract)}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "선물 종목 분석 조회 실패");
    bitcoinData = await response.json();
    renderBitcoin();
    if (showToast) toast(`${selectedContract.replace(/_USDT$/, "")} 데이터를 갱신했습니다.`);
  } catch (error) {
    $b("btcMarketStatus").textContent = "연결 오류";
    $b("btcMarketStatus").textContent = error.message;
    showChartFallback("차트 데이터를 불러오지 못했습니다.", "시장 데이터 연결을 확인한 뒤 새로고침해 주세요.");
    setChartStreamStatus("error", "시장 데이터 연결 오류");
    toast("데이터 연결에 실패했습니다. 새로고침으로 다시 시도해 주세요.");
  } finally {
    button.disabled = false;
  }
}

function contractFromSearch(value) {
  const symbol = String(value || "").trim().toUpperCase().replaceAll("/", "_").replaceAll("-", "_").replace(/\s+/g, "");
  const contract = symbol.endsWith("_USDT") ? symbol : symbol.endsWith("USDT") ? `${symbol.slice(0, -4)}_USDT` : `${symbol}_USDT`;
  return /^[A-Z0-9]{2,20}_USDT$/.test(contract) ? contract : null;
}

async function analyzeContract(contract) {
  selectedContract = contract;
  disconnectTradingChartSocket();
  tradingChartRuntime.liveCandles = {};
  tradingChartRuntime.lastTimeframe = null;
  renderFavoriteSymbols();
  $b("btcMarketStatus").textContent = `${contract.replace(/_USDT$/, "")} 분석 연결 중`;
  await loadBitcoin(true);
}

async function loadContractOptions() {
  try {
    const response = await fetch("/api/contracts", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    $b("btcSymbolOptions").innerHTML = (payload.contracts || []).slice(0, 180)
      .map((item) => `<option value="${escapeBtc(item.symbol)}">${escapeBtc(item.contract)} · ${money(item.price)}</option>`)
      .join("");
  } catch (_) { /* 직접 심볼 입력은 계속 지원 */ }
}

$b("btcSymbolSearch").addEventListener("submit", async (event) => {
  event.preventDefault();
  const contract = contractFromSearch($b("btcSymbolInput").value);
  if (!contract) {
    toast("Gate.io USDT 선물 심볼을 입력해 주세요. 예: ETH 또는 ETH_USDT");
    return;
  }
  if (contract === selectedContract && bitcoinData) {
    loadBitcoin(true);
    return;
  }
  await analyzeContract(contract);
});

$b("btcFavoriteToggle").addEventListener("click", () => {
  const rows = storedFavorites();
  const next = rows.includes(selectedContract) ? rows.filter((item) => item !== selectedContract) : [selectedContract, ...rows];
  saveFavorites(next);
  renderFavoriteSymbols();
  toast(rows.includes(selectedContract) ? "즐겨찾기에서 삭제했습니다." : `${selectedContract.replace(/_USDT$/, "")}를 즐겨찾기에 추가했습니다.`);
});

$b("btcFavoriteSymbols").addEventListener("click", (event) => {
  const button = event.target.closest("[data-favorite-contract]");
  if (!button || button.dataset.favoriteContract === selectedContract) return;
  analyzeContract(button.dataset.favoriteContract);
});

document.querySelectorAll("[data-chart-height]").forEach((button) => button.addEventListener("click", () => {
  const current = $b("btcChartStage").getBoundingClientRect().height || storedChartHeight();
  setChartHeight(button.dataset.chartHeight === "reset" ? CHART_HEIGHT_DEFAULT : current + Number(button.dataset.chartHeight));
}));

const chartResizeHandle = $b("btcChartResizeHandle");
chartResizeHandle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = $b("btcChartStage").getBoundingClientRect().height;
  chartResizeHandle.setPointerCapture?.(event.pointerId);
  chartResizeHandle.classList.add("dragging");
  const move = (moveEvent) => setChartHeight(startHeight + moveEvent.clientY - startY, false);
  const finish = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    chartResizeHandle.classList.remove("dragging");
    setChartHeight($b("btcChartStage").getBoundingClientRect().height, true);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
});

chartResizeHandle.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
  event.preventDefault();
  const current = $b("btcChartStage").getBoundingClientRect().height || storedChartHeight();
  setChartHeight(event.key === "Home" ? CHART_HEIGHT_DEFAULT : current + (event.key === "ArrowUp" ? 50 : -50));
});

document.querySelectorAll("[data-plan]").forEach((button) => button.addEventListener("click", () => {
  selectedPlan = button.dataset.plan;
  document.querySelectorAll("[data-plan]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  renderDecisionEngine();
  renderTimeframes();
  renderPlan();
  renderChecklist();
  renderMarketData();
  renderTradingChart();
}));
document.querySelectorAll("[data-strategy]").forEach((button) => button.addEventListener("click", () => {
  if (!bitcoinData || !strategies()[button.dataset.strategy]) return;
  selectedStrategy = button.dataset.strategy;
  selectedChartTimeframe = selectedStrategy === "swing" ? "1h" : "5m";
  selectedPlan = currentStrategy().primaryPlan === "SHORT" ? "short" : "long";
  document.querySelectorAll("[data-plan]").forEach((item) => {
    const active = item.dataset.plan === selectedPlan;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  renderSelectedStrategy();
}));
document.querySelectorAll("[data-chart-tf]").forEach((button) => button.addEventListener("click", () => {
  const timeframe = button.dataset.chartTf;
  if (!bitcoinData?.chart?.timeframes?.[timeframe] || timeframe === selectedChartTimeframe) return;
  selectedChartTimeframe = timeframe;
  renderTimeframes();
  renderTradingChart({ fit: true });
}));
document.querySelectorAll("[data-chart-layer]").forEach((button) => button.addEventListener("click", () => {
  if (!bitcoinData) return;
  const layer = button.dataset.chartLayer;
  chartLayerState[layer] = !chartLayerState[layer];
  syncChartControls();
  if (tradingChartRuntime.currentData.length) applyChartAnnotations(tradingChartRuntime.currentData);
}));
$b("bitcoinRefresh").addEventListener("click", () => loadBitcoin(true));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnectTradingChartSocket();
  else if (bitcoinData) {
    loadBitcoin(false);
    connectTradingChartSocket();
  }
});
window.addEventListener("beforeunload", () => {
  disconnectTradingChartSocket();
  tradingChartRuntime.resizeObserver?.disconnect();
  tradingChartRuntime.chart?.remove();
});
setInterval(() => {
  $b("bitcoinClock").textContent = new Date().toLocaleString("ko-KR", { hour12:false, timeZone:"Asia/Seoul" }) + " KST";
}, 1000);
loadContractOptions();
setChartHeight(storedChartHeight(), false);
renderFavoriteSymbols();
loadBitcoin();
setInterval(() => {
  if (!document.hidden) loadBitcoin(false);
}, 30_000);
