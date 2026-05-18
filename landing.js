// =================================================
// EU연합 통합시스템 - 랜딩 페이지 로직
// (ALLIANCE / escapeHtml / pad2 / nowKst / todayKstString / $ / $$ / getEndpoint /
//  readCache / writeCache 등은 shared.js 에서 제공)
// =================================================

const CASTLE_BY_DAY = {
  1: "주작성", 2: "현무성", 3: "청룡성", 4: "백호성",
};
const DAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

function getCastleContext() {
  const d = nowKst();
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const min = d.getUTCMinutes();
  const castle = CASTLE_BY_DAY[day];
  if (!castle) {
    return { dayLabel: DAY_LABEL[day], castle: null, isOpen: false };
  }
  const cur = hour * 60 + min;
  const isOpen = cur <= 23 * 60 + 30;
  return { dayLabel: DAY_LABEL[day], castle, isOpen };
}

function renderTodayBanner() {
  const ctx = getCastleContext();
  $("#todayLabel").textContent = `오늘은 ${ctx.dayLabel}요일`;
  const tag = $("#castleTag");
  if (ctx.castle) {
    tag.textContent = ctx.isOpen ? `${ctx.castle} 신청 가능` : `${ctx.castle} (마감)`;
    tag.classList.toggle("disabled", !ctx.isOpen);
  } else {
    tag.textContent = "신청 불가일";
    tag.classList.add("disabled");
  }
}

// ---- API (캐시는 shared.js 의 readCache/writeCache 사용) ----

async function apiList() {
  try {
    const res = await fetch(`${getEndpoint()}?action=list`);
    if (!res.ok) return [];
    const d = await res.json();
    const out = d.entries || [];
    writeCache("entries", out);
    return out;
  } catch { return []; }
}

async function apiMembers() {
  try {
    const res = await fetch(`${getEndpoint()}?action=members`);
    if (!res.ok) return [];
    const d = await res.json();
    const out = d.members || [];
    writeCache("members", out);
    return out;
  } catch { return []; }
}

async function apiCastleLords() {
  try {
    const res = await fetch(`${getEndpoint()}?action=castleLords`);
    if (!res.ok) return {};
    const d = await res.json();
    const out = d.lords || {};
    writeCache("lords", out);
    return out;
  } catch { return {}; }
}

async function apiGuidelines() {
  try {
    const res = await fetch(`${getEndpoint()}?action=guidelines`);
    if (!res.ok) return "";
    const d = await res.json();
    const out = d.text || "";
    writeCache("guidelines", out);
    return out;
  } catch { return ""; }
}

async function apiHallOfFame(scope, period) {
  try {
    const res = await fetch(`${getEndpoint()}?action=hallOfFame&scope=${encodeURIComponent(scope)}&period=${encodeURIComponent(period)}&limit=10`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    writeCache(`hof_${scope}_${period}`, d);
    return d;
  } catch { return null; }
}

async function apiSeasonsList() {
  try {
    const res = await fetch(`${getEndpoint()}?action=seasonsList`);
    if (!res.ok) return [];
    const d = await res.json();
    if (!d.ok) return [];
    return d.seasons || [];
  } catch { return []; }
}

async function apiSeasonArchive(season, scope) {
  try {
    const res = await fetch(`${getEndpoint()}?action=seasonArchive&season=${encodeURIComponent(season)}&scope=${encodeURIComponent(scope)}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    return d;
  } catch { return null; }
}

async function apiCastleHistory(days) {
  try {
    const res = await fetch(`${getEndpoint()}?action=castleLordHistory&days=${days || 90}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    writeCache("castle_history", d.history || []);
    return d.history || [];
  } catch { return null; }
}

async function apiGuildsInfo() {
  try {
    const res = await fetch(`${getEndpoint()}?action=guildsInfo`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    writeCache("guilds_info", d.guilds || {});
    return d.guilds || {};
  } catch { return null; }
}

async function apiTradeMarket() {
  try {
    const res = await fetch(`${getEndpoint()}?action=tradeMarket`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    writeCache("trade_market", d);
    return d;
  } catch { return null; }
}

function renderCastleLords(lords) {
  const castles = ["주작성", "현무성", "청룡성", "백호성"];
  castles.forEach((c) => {
    const cell = document.querySelector(`#lord-${c}`);
    if (!cell) return;
    const lord = lords[c];
    const guild = lord && lord.guild ? lord.guild : "";
    if (guild) {
      cell.classList.remove("empty");
      // 연합 내 문파인지 확인
      const inAlliance = ALLIANCE.families.some((f) => f.guilds.includes(guild));
      const family = ALLIANCE.families.find((f) => f.guilds.includes(guild));
      cell.innerHTML = `<span class="lord-guild ${inAlliance ? 'in-alliance' : 'outsider'}">${escapeHtml(guild)}</span>${family ? `<div class="cl-lord-family">${escapeHtml(family.name)}</div>` : ""}`;
    } else {
      cell.classList.add("empty");
      cell.textContent = "미점령";
    }
  });
}

function renderParticipating(guilds, guildStats) {
  const wrap = document.querySelector("#participatingList");
  if (!wrap) return;
  if (!guilds.length) {
    wrap.innerHTML = `<span class="hint">아직 이번주 신청 문파가 없습니다</span>`;
    return;
  }
  // 정렬: 신청률 높은 순
  const sorted = guilds.slice().sort((a, b) => {
    const sa = guildStats(a).pct;
    const sb = guildStats(b).pct;
    return sb - sa;
  });
  wrap.innerHTML = sorted.map((g) => {
    const s = guildStats(g);
    const fam = ALLIANCE.families.find((f) => f.guilds.includes(g));
    const famLabel = fam ? `<span class="participating-fam">${escapeHtml(fam.name)}</span>` : "";
    return `<a class="participating-pill" href="siege.html?guild=${encodeURIComponent(g)}">
      <span class="participating-guild">${escapeHtml(g)}</span>
      ${famLabel}
      ${s.total > 0 ? `<span class="participating-pct">${s.pct}%</span>` : ""}
    </a>`;
  }).join("");
}

// ---- 성주 이력 ----

function renderCastleHistory(history) {
  const body = $("#castleHistoryBody");
  if (!body) return;
  if (!history || !history.length) {
    body.innerHTML = `<div class="hint">최근 변동 기록이 없습니다.</div>`;
    return;
  }
  const icon = { "주작성": "🔴", "현무성": "🔵", "청룡성": "🟢", "백호성": "⚪" };
  // 성별 그룹
  const byCastle = new Map();
  ["주작성","현무성","청룡성","백호성"].forEach((c) => byCastle.set(c, []));
  history.forEach((h) => {
    if (byCastle.has(h.castle)) byCastle.get(h.castle).push(h);
  });
  body.innerHTML = `
    <div class="castle-history-grid">
      ${["주작성","현무성","청룡성","백호성"].map((c) => {
        const rows = byCastle.get(c).slice(0, 6);
        const list = rows.length
          ? rows.map((r, i) => `
              <li class="${i === 0 ? "current" : ""}">
                <span class="ch-date">${escapeHtml((r.changedAt || "").slice(5, 10))}</span>
                <span class="ch-guild">${escapeHtml(r.guild || "-")}</span>
              </li>`).join("")
          : `<li class="empty">기록 없음</li>`;
        return `<div class="ch-column">
          <div class="ch-castle-title">${icon[c]} ${c}</div>
          <ol class="ch-list">${list}</ol>
        </div>`;
      }).join("")}
    </div>`;
}

async function loadCastleHistory() {
  const cached = readCache("castle_history");
  if (cached) renderCastleHistory(cached);
  const fresh = await apiCastleHistory(180);
  if (fresh !== null) renderCastleHistory(fresh);
}

// 펼치는 순간 lazy 로드
function setupCastleHistory() {
  const wrap = $("#castleHistoryWrap");
  if (!wrap) return;
  let loaded = false;
  wrap.addEventListener("toggle", () => {
    if (wrap.open && !loaded) {
      loaded = true;
      loadCastleHistory();
    }
  });
}

// ---- 거래소 시세 위젯 ----

function fmtPrice(n) {
  if (!n) return "-";
  if (n >= 100000000) return (n / 100000000).toFixed(1) + "억";
  if (n >= 10000) return (n / 10000).toFixed(0) + "만";
  return n.toLocaleString();
}

function renderTradeMarket(data) {
  const body = $("#tmBody");
  const meta = $("#tmMeta");
  const cnt = $("#tmCount");
  if (!body) return;
  if (!data || !data.items || !data.items.length) {
    body.innerHTML = `<div class="hint">${data ? "거래 데이터 없음" : "불러오기 실패"}</div>`;
    if (meta) meta.textContent = "";
    return;
  }
  const top = data.items.slice(0, 10);
  if (cnt) cnt.textContent = top.length;
  if (meta) {
    const fetched = data.fetchedAt || "";
    const range = data.range || {};
    meta.innerHTML = `<span class="tm-fetched">갱신: ${escapeHtml(fetched)}</span>` +
                     `<span class="tm-source">출처: ${escapeHtml(data.source || "")}</span>`;
  }
  body.innerHTML = `
    <table class="tm-table">
      <thead><tr><th>아이템</th><th class="num">거래</th><th class="num">평균 판매</th><th class="num">평균 구매</th></tr></thead>
      <tbody>${top.map((it) => `
        <tr>
          <td class="tm-item">
            ${it.iconUrl ? `<img src="${escapeHtml(it.iconUrl)}" alt="" class="tm-icon" loading="lazy">` : ""}
            <strong>${escapeHtml(it.name)}</strong>
          </td>
          <td class="num muted">${it.count}<small>건</small></td>
          <td class="num sell">${fmtPrice(it.sellAvg)}</td>
          <td class="num buy">${fmtPrice(it.buyAvg)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

async function loadTradeMarket() {
  const cached = readCache("trade_market");
  if (cached) renderTradeMarket(cached);
  const fresh = await apiTradeMarket();
  if (fresh) renderTradeMarket(fresh);
}

function setupTradeMarket() {
  const wrap = $("#tradeMarketCard");
  if (!wrap) return;
  let loaded = false;
  wrap.addEventListener("toggle", () => {
    if (wrap.open && !loaded) {
      loaded = true;
      loadTradeMarket();
    }
  });
}

// ---- 문파 정보 모달 ----

let cachedGuildsInfo = {};

function openGuildInfoDialog(guild) {
  const dlg = $("#guildInfoDialog");
  if (!dlg) return;
  const info = cachedGuildsInfo[guild] || {};
  const hasInfo = info.requirements || info.contact || info.discordInvite || info.description;

  $("#gidTitle").textContent = guild;

  const statusEl = $("#gidStatus");
  if (info.recruiting) {
    statusEl.className = "gid-status open";
    statusEl.innerHTML = "✨ <strong>모집중</strong>";
  } else if (hasInfo) {
    statusEl.className = "gid-status closed";
    statusEl.innerHTML = "마감 (모집 안 함)";
  } else {
    statusEl.className = "gid-status";
    statusEl.innerHTML = "";
  }

  function setSection(secId, contentId, value, isLink) {
    const sec = $(secId);
    const content = $(contentId);
    if (!value) { sec.hidden = true; return; }
    sec.hidden = false;
    if (isLink) {
      $("#gidDiscord").href = value;
      return;
    }
    // 줄바꿈 보존, html escape
    content.innerHTML = escapeHtml(value).replace(/\n/g, "<br>");
  }
  setSection("#gidDescSec", "#gidDesc", info.description, false);
  setSection("#gidReqSec", "#gidReq", info.requirements, false);
  setSection("#gidContactSec", "#gidContact", info.contact, false);
  setSection("#gidDiscordSec", null, info.discordInvite, true);

  $("#gidEmpty").hidden = hasInfo || info.recruiting;
  $("#gidSiegeLink").href = `siege.html?guild=${encodeURIComponent(guild)}`;
  $("#gidUpdated").textContent = info.updatedAt ? `갱신: ${info.updatedAt}` : "";

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function setupGuildInfoDialog() {
  const dlg = $("#guildInfoDialog");
  if (!dlg) return;
  const closeBtn = $("#gidClose");
  if (closeBtn) closeBtn.addEventListener("click", () => dlg.close());
  // 배경 클릭 시 닫기
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });

  // grid 안의 info 버튼 위임
  const grid = $("#familyGrid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".guild-info-btn");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const guild = btn.dataset.infoGuild;
      if (guild) openGuildInfoDialog(guild);
    });
  }
}

async function loadGuildsInfo() {
  const cached = readCache("guilds_info");
  if (cached) cachedGuildsInfo = cached;
  const fresh = await apiGuildsInfo();
  if (fresh) {
    cachedGuildsInfo = fresh;
    // 그리드 재렌더 (배지 갱신용)
    if (typeof renderGrid === "function" && _lastRenderArgs) {
      renderGrid(..._lastRenderArgs);
    }
  }
}

// ---- 명예의 전당 ----

let hofScope = "personal";
let hofPeriod = "week";

function renderHallOfFame(data) {
  const body = $("#hofBody");
  const rangeEl = $("#hofRange");
  if (!body) return;
  if (!data || !data.rows || !data.rows.length) {
    body.innerHTML = `<div class="hint">${data ? "표시할 데이터가 없습니다" : "불러오기 실패"}</div>`;
    if (rangeEl) rangeEl.textContent = "";
    return;
  }
  if (rangeEl) rangeEl.textContent = `${data.range.start} ~ ${data.range.end}`;

  const medal = (i) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;

  if (data.scope === "personal") {
    body.innerHTML = `
      <table class="hof-table">
        <thead><tr><th>순위</th><th>닉네임</th><th>문파</th><th class="num">가중치</th><th class="num">원점수</th><th>정예</th></tr></thead>
        <tbody>${data.rows.map((r, i) => {
          const rankClass = i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
          const meClass = isMyNickname(r.nickname) ? "is-me" : "";
          return `
          <tr class="${rankClass} ${meClass}">
            <td class="rank">${medal(i)}</td>
            <td><strong>${escapeHtml(r.nickname)}</strong>${meClass ? ' <span class="me-tag">나</span>' : ''}</td>
            <td>${escapeHtml(r.guild || "-")}</td>
            <td class="num accent">${r.weightedScore.toFixed(2)}</td>
            <td class="num muted">${r.baseScore.toFixed(2)}</td>
            <td>${renderEliteMini(r.elite)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
    return;
  }
  if (data.scope === "guild") {
    body.innerHTML = `
      <table class="hof-table">
        <thead><tr><th>순위</th><th>문파</th><th>계</th><th class="num">합산</th><th class="num">평균</th><th class="num">인원</th></tr></thead>
        <tbody>${data.rows.map((r, i) => `
          <tr class="${i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : ""}">
            <td class="rank">${medal(i)}</td>
            <td><strong>${escapeHtml(r.guild)}</strong></td>
            <td class="muted">${escapeHtml(r.family || "-")}</td>
            <td class="num accent">${r.totalScore.toFixed(2)}</td>
            <td class="num">${r.avgScore.toFixed(2)}</td>
            <td class="num muted">${r.members}</td>
          </tr>`).join("")}</tbody>
      </table>`;
    return;
  }
  if (data.scope === "family") {
    body.innerHTML = `
      <table class="hof-table">
        <thead><tr><th>순위</th><th>계</th><th class="num">평균</th><th class="num">합산</th><th class="num">인원</th></tr></thead>
        <tbody>${data.rows.map((r, i) => `
          <tr class="${i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : ""}">
            <td class="rank">${medal(i)}</td>
            <td><strong>${escapeHtml(r.family)}</strong></td>
            <td class="num accent">${r.avgScore.toFixed(2)}</td>
            <td class="num">${r.totalScore.toFixed(2)}</td>
            <td class="num muted">${r.members}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  }
}

function renderEliteMini(v) {
  v = (v || "").trim();
  if (v === "O") return `<span class="elite-mini elite-O" title="정예 참전">⭕</span>`;
  if (v === "X") return `<span class="elite-mini elite-X" title="불참">❌</span>`;
  if (v === "최대한 참여" || v === "최대") return `<span class="elite-mini elite-MAX" title="최대한">⏳</span>`;
  return `<span class="muted">-</span>`;
}

let hofArchiveSeason = "";

function renderArchive(data) {
  const body = $("#hofBody");
  const rangeEl = $("#hofRange");
  if (!body) return;
  if (rangeEl) rangeEl.textContent = data && data.season ? `📜 ${data.season} 박제 결과` : "";
  if (!data || !data.rows || !data.rows.length) {
    body.innerHTML = `<div class="hint">박제된 결과가 없습니다.</div>`;
    return;
  }
  const medal = (i) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
  const scopeLabel = data.scope === "personal" ? "닉네임" : data.scope === "guild" ? "문파" : "계";
  body.innerHTML = `
    <table class="hof-table">
      <thead><tr><th>순위</th><th>${scopeLabel}</th><th>소속/-</th><th class="num">가중치/합산</th><th class="num">인원</th></tr></thead>
      <tbody>${data.rows.map((r, i) => `
        <tr class="${i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : ""}">
          <td class="rank">${medal(r.rank - 1)}</td>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td class="muted">${escapeHtml(r.guildOrFamily || "-")}</td>
          <td class="num accent">${r.weightedScore.toFixed(2)}</td>
          <td class="num muted">${r.members || "-"}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

async function loadArchive() {
  if (!hofArchiveSeason) {
    $("#hofBody").innerHTML = `<div class="hint">시즌을 선택해 주세요.</div>`;
    return;
  }
  $("#hofBody").innerHTML = `<div class="hint">로딩 중…</div>`;
  const data = await apiSeasonArchive(hofArchiveSeason, hofScope);
  if (data) renderArchive(data);
  else $("#hofBody").innerHTML = `<div class="hint error">불러오기 실패</div>`;
}

async function populateSeasonsList() {
  const sel = $("#hofSeasonPick");
  if (!sel) return;
  const seasons = await apiSeasonsList();
  if (!seasons.length) {
    sel.innerHTML = `<option value="">박제된 시즌 없음</option>`;
    hofArchiveSeason = "";
    return;
  }
  sel.innerHTML = seasons.map((s, i) => `<option value="${escapeHtml(s)}"${i === 0 ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
  hofArchiveSeason = seasons[0];
}

async function loadHallOfFame() {
  if (hofPeriod === "archive") {
    $("#hofArchiveSelect").hidden = false;
    if (!hofArchiveSeason) await populateSeasonsList();
    return loadArchive();
  }
  $("#hofArchiveSelect").hidden = true;
  const cached = readCache(`hof_${hofScope}_${hofPeriod}`);
  if (cached) renderHallOfFame(cached);
  else $("#hofBody").innerHTML = `<div class="hint">로딩 중…</div>`;
  const fresh = await apiHallOfFame(hofScope, hofPeriod);
  if (fresh) renderHallOfFame(fresh);
}

function setupHallOfFameTabs() {
  $$(".hof-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".hof-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      hofScope = btn.dataset.scope || "personal";
      loadHallOfFame();
    });
  });
  $$(".hof-period-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".hof-period-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      hofPeriod = btn.dataset.period || "week";
      loadHallOfFame();
    });
  });
  const sel = $("#hofSeasonPick");
  if (sel) {
    sel.addEventListener("change", () => {
      hofArchiveSeason = sel.value;
      loadArchive();
    });
  }
}

function renderGuidelines(text) {
  const c = document.querySelector("#guidelinesContent");
  if (!c) return;
  if (!text || !text.trim()) {
    c.innerHTML = `<p class="hint">지침이 아직 등록되지 않았습니다.</p>`;
    return;
  }
  c.innerHTML = `<div>${escapeHtml(text)}</div>`;
}

// ---- This week range (KST) ----

function thisWeekRange() {
  const d = nowKst();
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d.getTime());
  mon.setUTCDate(mon.getUTCDate() + offset);
  const sun = new Date(mon.getTime());
  sun.setUTCDate(sun.getUTCDate() + 6);
  const fmt = (x) => `${x.getUTCFullYear()}-${pad2(x.getUTCMonth()+1)}-${pad2(x.getUTCDate())}`;
  return { start: fmt(mon), end: fmt(sun) };
}

function inRange(dateStr, start, end) {
  const d = (dateStr || "").slice(0, 10);
  return d >= start && d <= end;
}

// ---- Family / guild grid ----

function bestPerNick(entries) {
  const map = new Map();
  entries.forEach((e) => {
    const k = (e.nickname || "").trim().toLowerCase();
    if (!k) return;
    const s = parseFloat(e.score) || 0;
    const prev = map.get(k);
    if (!prev || s > parseFloat(prev.score)) map.set(k, e);
  });
  return map;
}

// 어떤 성을 어떤 문파가 차지하고 있는지 매핑
function castlesByGuild(lords) {
  const map = new Map();
  Object.entries(lords || {}).forEach(([castle, info]) => {
    if (info && info.guild) {
      const g = info.guild;
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(castle);
    }
  });
  return map;
}

let _lastRenderArgs = null;

function renderGrid(members, entries, lords) {
  _lastRenderArgs = [members, entries, lords];
  const range = thisWeekRange();
  const weekEntries = entries.filter((e) => inRange(e.dateKst, range.start, range.end));
  const bestMap = bestPerNick(weekEntries);
  const castleMap = castlesByGuild(lords || {});

  // members 를 문파별로 그룹
  const byGuild = new Map();
  members.forEach((m) => {
    const g = (m.guild || "").trim();
    if (!g) return;
    if (!byGuild.has(g)) byGuild.set(g, []);
    byGuild.get(g).push(m);
  });

  // 문파별 통계
  function guildStats(guildName) {
    const list = byGuild.get(guildName) || [];
    if (!list.length) return { total: 0, submitted: 0, pct: 0 };
    const submitted = list.filter((m) =>
      bestMap.has((m.nickname || "").trim().toLowerCase())
    ).length;
    const pct = Math.round((submitted / list.length) * 100);
    return { total: list.length, submitted, pct };
  }

  // 이번주 참전 문파 목록 (1건이라도 신청한 문파)
  const participatingGuilds = new Set();
  weekEntries.forEach((e) => {
    if (e.guild) participatingGuilds.add(e.guild.trim());
  });
  // entries 에 guild 가 없을 수도 있으므로 (구 데이터), 닉네임 → 문파 매핑으로도 보완
  const nickToGuild = new Map();
  members.forEach((m) => {
    const k = (m.nickname || "").trim().toLowerCase();
    if (k && m.guild) nickToGuild.set(k, m.guild);
  });
  weekEntries.forEach((e) => {
    if (!e.guild) {
      const g = nickToGuild.get((e.nickname || "").trim().toLowerCase());
      if (g) participatingGuilds.add(g);
    }
  });
  renderParticipating(Array.from(participatingGuilds), guildStats);

  // 그리드
  const grid = $("#familyGrid");
  grid.innerHTML = ALLIANCE.families.map((fam) => {
    const isLeaderFam = fam.guilds.includes(ALLIANCE.leader.guild);
    const famTotal = fam.guilds.reduce((acc, g) => acc + (guildStats(g).total || 0), 0);
    const famSubmitted = fam.guilds.reduce((acc, g) => acc + (guildStats(g).submitted || 0), 0);
    const famPct = famTotal > 0 ? Math.round((famSubmitted / famTotal) * 100) : 0;

    // 이 계에 속한 문파가 차지한 성들
    const famCastles = [];
    fam.guilds.forEach((g) => {
      const cs = castleMap.get(g);
      if (cs) cs.forEach((c) => famCastles.push({ guild: g, castle: c }));
    });

    const guildCards = fam.guilds.map((g) => {
      const s = guildStats(g);
      const isLeader = g === ALLIANCE.leader.guild;
      const myCastles = castleMap.get(g) || [];
      const url = `siege.html?guild=${encodeURIComponent(g)}`;
      const info = (cachedGuildsInfo[g] || {});
      const isRecruiting = !!info.recruiting;
      const tagPills = [];
      if (isLeader) tagPills.push(`<span class="leader-badge">👑 연합장</span>`);
      if (isRecruiting) tagPills.push(`<span class="recruiting-badge" title="모집중">✨ 모집중</span>`);
      myCastles.forEach((c) => tagPills.push(`<span class="castle-lord-badge">🏰 ${escapeHtml(c).replace("성","")}</span>`));
      const castleBadges = tagPills.length
        ? `<div class="castle-tags">${tagPills.join("")}</div>`
        : "";
      // 원형 progress (SVG)
      const circ = 2 * Math.PI * 18;
      const offset = circ * (1 - s.pct / 100);
      const pctColor = s.pct >= 80 ? "#69d586" : s.pct >= 40 ? "#FFCC00" : s.pct > 0 ? "#ff8a82" : "#3a424e";
      const classes = ["guild-card"];
      if (isLeader) classes.push("is-leader");
      if (myCastles.length) classes.push("is-castle-lord");
      if (isRecruiting) classes.push("is-recruiting");
      return `<a href="${url}" class="${classes.join(" ")}" title="${escapeHtml(g)} 신청 페이지로">
        <button type="button" class="guild-info-btn" data-info-guild="${escapeHtml(g)}" aria-label="${escapeHtml(g)} 문파 정보" title="문파 정보">ℹ️</button>
        <div class="guild-name">${escapeHtml(g)}</div>
        <div class="ring-wrap">
          <svg class="guild-ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle class="ring-bg" cx="24" cy="24" r="18" />
            <circle class="ring-fg" cx="24" cy="24" r="18"
              style="stroke: ${pctColor}; stroke-dasharray: ${circ}; stroke-dashoffset: ${offset};" />
          </svg>
          <span class="ring-pct">${s.pct}<small>%</small></span>
        </div>
        <div class="guild-meta">총원 ${s.total}</div>
        ${castleBadges}
      </a>`;
    }).join("");

    const famPills = [];
    if (isLeaderFam) famPills.push(`<span class="family-leader-badge">👑 연합장 문파</span>`);
    famCastles.forEach((x) => famPills.push(`<span class="family-castle-badge">🏰 ${escapeHtml(x.castle)}주 (${escapeHtml(x.guild)})</span>`));
    const famBadgeLine = famPills.length ? `<div class="family-castle-line">${famPills.join(" ")}</div>` : "";

    return `
      <div class="family-card ${isLeaderFam ? "is-leader" : ""} ${famCastles.length ? "has-castle" : ""}" data-family="${escapeHtml(fam.name)}">
        <div class="family-header">
          <div class="family-title">
            <span class="family-name">${escapeHtml(fam.name)}</span>
            ${famBadgeLine}
          </div>
          <span class="family-stats">
            <span class="family-pct">${famPct}%</span>
            <span>${famSubmitted}/${famTotal || "-"}</span>
            <span class="family-arrow">▼</span>
          </span>
        </div>
        <div class="guild-list">${guildCards}</div>
      </div>
    `;
  }).join("");

  // 헤더 클릭 토글
  $$(".family-header").forEach((h) => {
    h.addEventListener("click", () => {
      const card = h.parentElement;
      card.classList.toggle("open");
    });
  });

  // 기본: 모든 family 펼치기 (초기 사용감 좋게)
  $$(".family-card").forEach((c) => c.classList.add("open"));
}

// ---- Init ----

async function apiBootstrap() {
  try {
    const res = await fetch(`${getEndpoint()}?action=bootstrap`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ok) return null;
    writeCache("members", d.members || []);
    writeCache("entries", d.entries || []);
    writeCache("lords", d.lords || {});
    writeCache("guidelines", d.guidelines || "");
    if (d.guilds) writeCache("guilds_info", d.guilds);
    return d;
  } catch { return null; }
}

async function init() {
  renderTodayBanner();
  setInterval(renderTodayBanner, 60 * 1000);

  setupHallOfFameTabs();
  loadHallOfFame();
  setupCastleHistory();
  setupGuildInfoDialog();
  setupTradeMarket();

  // 1) 캐시 즉시 표시 (있으면) — SW 는 shared.js 가 자동 등록
  const cMembers = readCache("members") || [];
  const cEntries = readCache("entries") || [];
  const cLords = readCache("lords") || {};
  const cGuidelines = readCache("guidelines");
  const cGuilds = readCache("guilds_info") || {};
  if (cGuilds) cachedGuildsInfo = cGuilds;
  const hasCache = cMembers.length || cEntries.length || Object.keys(cLords).length || cGuidelines;
  if (hasCache) {
    renderGrid(cMembers, cEntries, cLords);
    renderCastleLords(cLords);
    if (typeof cGuidelines === "string") renderGuidelines(cGuidelines);
  } else {
    renderGrid([], [], {});
  }

  // 2) 백그라운드로 최신 데이터 페치 → 다시 렌더
  // bootstrap (단일 호출) 우선 시도. 실패 시 개별 호출로 폴백.
  const boot = await apiBootstrap();
  if (boot) {
    if (boot.guilds) cachedGuildsInfo = boot.guilds;
    renderGrid(boot.members || [], boot.entries || [], boot.lords || {});
    renderCastleLords(boot.lords || {});
    renderGuidelines(boot.guidelines || "");
  } else {
    const [members, entries, lords, guidelines, guildsInfo] = await Promise.all([
      apiMembers(), apiList(), apiCastleLords(), apiGuidelines(), apiGuildsInfo(),
    ]);
    if (guildsInfo) cachedGuildsInfo = guildsInfo;
    renderGrid(members, entries, lords);
    renderCastleLords(lords);
    renderGuidelines(guidelines);
  }
}

document.addEventListener("DOMContentLoaded", init);
