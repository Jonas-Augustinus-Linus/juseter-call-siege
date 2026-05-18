/**
 * EU연합 통합시스템 - Google Apps Script Backend
 *
 * 두 가지 방식 모두 지원:
 *  A) 바인딩 스크립트 (권장):
 *     - 구글 시트 → 확장 프로그램 → Apps Script 로 열어 사용
 *     - SPREADSHEET_ID 설정 불필요
 *  B) 독립 스크립트:
 *     - script.google.com 에서 새 프로젝트로 시작
 *     - 아래 SPREADSHEET_ID 를 본인 시트 ID 로 교체
 *
 * 공통 배포:
 *  1. 메뉴 → 배포 → 새 배포 → 유형: 웹 앱
 *     - 다음 사용자로 실행: 나
 *     - 액세스 권한: "모든 사용자"
 *     - 배포 → 권한 승인
 *  2. 발급된 웹앱 URL (...exec) 을 웹페이지 "엔드포인트 설정" 에 붙여넣기
 *
 * 최초 1회 관리자 초기화 (필수!):
 *  - Apps Script 편집기에서 setupInitialAdmin() 한 번 실행 → 초기 admin 계정 생성
 *  - 또는 Script Properties 에 ADMIN_ACCOUNTS JSON 직접 입력
 *  - 기본 admin/1234 폴백은 보안상 제거됨. 초기화 안 하면 모든 admin 액션이 실패.
 */

const SPREADSHEET_ID = ''; // 바인딩 스크립트는 빈 문자열로 두세요
const SHEET_NAME = '점수신청';
const HEADERS = ['성', '닉네임', '점수', '시간(KST)', '비고', '갱신여부', '정예참전', '문파'];

const MEMBER_SHEET = '문파원';
const MEMBER_HEADERS = ['닉네임', '문파', '계', '비고/직책', '추가일(KST)'];

const CASTLE_HISTORY_SHEET = '성주이력';
const CASTLE_HISTORY_HEADERS = ['변경일(KST)', '성', '문파', '변경한관리자'];

const SEASON_ARCHIVE_SHEET = '시즌명전';
const SEASON_ARCHIVE_HEADERS = ['시즌', '스코프', '순위', '이름', '문파/계', '가중치점수', '원점수', '인원', '박제일(KST)'];

// ========================================
// 보안 헬퍼
// ========================================

/**
 * 시트 셀 값 sanitize — 수식 주입(=, +, -, @ 시작) 차단.
 * Excel/Sheets 가 자동 평가하지 않도록 앞에 ' 를 붙임.
 */
function safeCell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/**
 * 에러 메시지 sanitize — 스택트레이스/내부 경로 노출 방지.
 * 콘솔에는 상세 기록, 사용자에겐 일반화된 메시지만.
 */
function safeErr_(err) {
  try { console.log(err && (err.stack || err.message) || err); } catch (_) {}
  return '서버 처리 중 오류가 발생했습니다';
}

/**
 * 간단한 rate limit (CacheService 기반).
 * key 별로 limitN 회 / windowSec 초 초과 시 차단.
 */
function rateLimit_(key, limitN, windowSec) {
  try {
    const cache = CacheService.getScriptCache();
    const cur = parseInt(cache.get(key) || '0', 10);
    if (cur >= limitN) return false;
    cache.put(key, String(cur + 1), windowSec);
    return true;
  } catch (_) { return true; } // 캐시 실패 시 통과 (가용성 우선)
}

// ========================================
// Discord Webhook (선택적, Script Property 'DISCORD_WEBHOOK_URL' 설정 시만 활성)
// ========================================

/**
 * 디스코드 webhook 비활성 (기본). 활성화는 setupDiscordWebhook('https://discord.com/api/webhooks/...') 호출.
 * 빈 문자열 전달하면 비활성화.
 */
function setupDiscordWebhook(url) {
  const props = PropertiesService.getScriptProperties();
  if (!url) {
    props.deleteProperty('DISCORD_WEBHOOK_URL');
    return 'Discord webhook 비활성화됨';
  }
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return 'Webhook URL 형식 오류 (discord.com/api/webhooks/... 만 허용)';
  }
  props.setProperty('DISCORD_WEBHOOK_URL', url);
  return 'Discord webhook 활성화 완료: ' + url.slice(0, 60) + '...';
}

function getDiscordWebhook_() {
  return PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL') || '';
}

/**
 * Discord 에 메시지 전송. webhook 미설정 시 노옵 (정상 반환).
 * embeds 는 Discord embed object 배열.
 */
function notifyDiscord_(content, embeds) {
  const url = getDiscordWebhook_();
  if (!url) return false;
  try {
    const payload = {};
    if (content) payload.content = content;
    if (embeds && embeds.length) payload.embeds = embeds;
    if (!payload.content && !payload.embeds) return false;
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    return true;
  } catch (e) {
    console.log('discord webhook 실패: ' + (e && e.message || e));
    return false;
  }
}

// 점수 등록 이벤트 알림 (embed 사용)
function notifyDiscordSubmit_(opts) {
  if (!getDiscordWebhook_()) return;
  const castle = opts.castle || '';
  const colorMap = { '주작성': 0xff5147, '현무성': 0x58a6ff, '청룡성': 0x2ea043, '백호성': 0xc9d1d9 };
  const embed = {
    title: `⚔️ ${castle} 점수 ${opts.updated ? '갱신' : '등록'}`,
    color: colorMap[castle] || 0x003399,
    fields: [
      { name: '닉네임', value: String(opts.nickname || '-'), inline: true },
      { name: '문파', value: String(opts.guild || '-'), inline: true },
      { name: '점수', value: String(opts.score || '-'), inline: true },
      { name: '정예', value: String(opts.elite || '-'), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템' },
  };
  if (opts.note) embed.fields.push({ name: '비고', value: String(opts.note).slice(0, 200), inline: false });
  notifyDiscord_(null, [embed]);
}

// 성주 변경 알림
function notifyDiscordCastleChange_(castle, guild) {
  if (!getDiscordWebhook_()) return;
  const embed = {
    title: `👑 ${castle} 성주 변경`,
    description: guild ? `새 성주 문파: **${guild}**` : '미점령 처리됨',
    color: 0xFFCC00,
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템' },
  };
  notifyDiscord_(null, [embed]);
}

/**
 * 마감 1시간 전 (월~목 22:30) 자동 알림 — Apps Script Trigger 로 호출.
 *
 * 트리거 설정 안내:
 *   편집기 → ⏰ 트리거 → 함수: notifyDeadlineWarning
 *     + 이벤트: 시간 기반 + 매일 22:00~23:00 (중 한 시간대)
 *   요일 가드는 함수 안에 있으니 매일 트리거 잡아도 월~목만 동작.
 *   같은 날 중복 발송 방지 가드 포함.
 */
function notifyDeadlineWarning() {
  if (!getDiscordWebhook_()) {
    console.log('notifyDeadlineWarning: Discord webhook 미설정 → skip');
    return;
  }
  const now = kstNow_();
  const day = now.getUTCDay(); // 0=일, 1=월, ..., 4=목
  if (day < 1 || day > 4) {
    console.log('notifyDeadlineWarning: 월~목 외 → skip (요일=' + day + ')');
    return;
  }

  // 같은 날 중복 발송 방지
  const today = kstDateStr_(now);
  const sentKey = 'DEADLINE_WARN_SENT';
  const lastSent = PropertiesService.getScriptProperties().getProperty(sentKey);
  if (lastSent === today) {
    console.log('notifyDeadlineWarning: 오늘 이미 발송됨 → skip');
    return;
  }

  // 이번주(월~일) 등록 안 한 문원 = 미신청자
  const range = thisWeekRange_();
  const allEntries = listEntries_();
  const inRange = entriesInRange_(allEntries, range.start, range.end);
  const submitted = new Set();
  inRange.forEach((e) => submitted.add((e.nickname || '').trim().toLowerCase()));

  const members = listMembers_();
  const missing = members.filter((m) => !submitted.has((m.nickname || '').trim().toLowerCase()));

  const castleMap = { 1: '주작성', 2: '현무성', 3: '청룡성', 4: '백호성' };
  const castle = castleMap[day] || '오늘';

  // 미신청자 닉네임 (최대 30명, 그 이상은 +N명 표시)
  const missingNames = missing.slice(0, 30).map((m) => `\`${m.nickname}\``).join(' · ');
  const moreCount = Math.max(0, missing.length - 30);
  const missingLine = missingNames + (moreCount > 0 ? `\n…외 ${moreCount}명` : '');

  const embed = {
    title: `⏰ ${castle} 공성 신청 1시간 전!`,
    description: '오늘 신청 마감: **23:30 (KST)**\n\n' + (missing.length
      ? `**미신청자 ${missing.length}명**\n${missingLine}`
      : '✅ 모든 문원이 신청 완료! 수고하셨습니다.'),
    color: 0xff5147,
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템 · 마감 알림' },
  };

  const sent = notifyDiscord_(missing.length ? '@everyone 공성 신청 마감 1시간 전' : null, [embed]);
  if (sent) {
    PropertiesService.getScriptProperties().setProperty(sentKey, today);
    console.log('notifyDeadlineWarning: 발송 완료 (미신청 ' + missing.length + '명)');
  }
}

/**
 * 주간 결과 요약 — 일요일 밤 등 Apps Script Trigger 로 호출.
 * 트리거 설정 안내: 편집기 → 트리거 → 함수 postWeeklyDiscordSummary + 시간 기반 + 매주 일요일 23:00.
 */
function postWeeklyDiscordSummary() {
  if (!getDiscordWebhook_()) return;
  const range = thisWeekRange_();
  const entries = entriesInRange_(listEntries_(), range.start, range.end);
  if (!entries.length) {
    notifyDiscord_('📊 이번 주 등록 내역이 없습니다.', null);
    return;
  }
  const members = listMembers_();
  const memberMap = new Map();
  members.forEach((m) => memberMap.set(m.nickname.toLowerCase(), m));
  const best = bestPerNick_(entries);

  // 개인 TOP5 (가중치 점수)
  const personal = [];
  best.forEach((e, nickKey) => {
    const w = weightedScore_(e, entries, members);
    personal.push({ nickname: e.nickname, guild: e.guild || (memberMap.get(nickKey) && memberMap.get(nickKey).guild) || '-', score: w });
  });
  personal.sort((a, b) => b.score - a.score);
  const top5 = personal.slice(0, 5).map((p, i) => `${i+1}. **${p.nickname}** (${p.guild}) · ${p.score.toFixed(2)}`).join('\n');

  // 문파 합산 TOP3
  const guildSum = new Map();
  personal.forEach((p) => guildSum.set(p.guild, (guildSum.get(p.guild) || 0) + p.score));
  const top3Guild = Array.from(guildSum.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map((x, i) => `${i+1}. **${x[0]}** · ${x[1].toFixed(2)}`).join('\n');

  const embed = {
    title: `📊 ${range.start} ~ ${range.end} 주간 결과`,
    color: 0x003399,
    fields: [
      { name: '🥇 개인 TOP 5 (가중치)', value: top5 || '-', inline: false },
      { name: '🏰 문파 합산 TOP 3', value: top3Guild || '-', inline: false },
      { name: '총 등록 인원', value: String(personal.length) + '명', inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템 · 주간 요약' },
  };
  notifyDiscord_(null, [embed]);
}

// ========================================
// 다중 관리자 계정 (전체 관리자 + 문파별 관리자)
// 저장 형식 (PropertiesService 'ADMIN_ACCOUNTS'): { username: { password, scope } }
//   - scope: 'all' (전체) 또는 계 이름 (예: '쿠데타계')
//   - 기본 admin/1234 폴백은 제거됨 — setupInitialAdmin() 1회 실행 필요.
// ========================================

function getAccounts_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ADMIN_ACCOUNTS');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function saveAccounts_(accts) {
  PropertiesService.getScriptProperties().setProperty('ADMIN_ACCOUNTS', JSON.stringify(accts));
}

/**
 * Apps Script 편집기에서 1회 수동 실행해서 초기 admin 생성.
 * 실행 시점에 비번 입력 다이얼로그 → 12자 이상 + 영숫자 조합 권장.
 * 실행 후 즉시 admin.html 에 로그인하고 비번 한번 더 변경 권장.
 */
function setupInitialAdmin() {
  const accts = getAccounts_();
  if (accts.admin) {
    return 'admin 계정이 이미 존재합니다. 변경하려면 관리자 페이지에서 비밀번호 변경.';
  }
  // 임시 강력 비밀번호 자동 생성
  const tmp = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  accts.admin = { password: tmp, scope: 'all' };
  saveAccounts_(accts);
  return '초기 admin 계정 생성됨. 비밀번호: ' + tmp + ' — 즉시 로그인 후 변경하세요!';
}

// body 안의 {username, password} 를 검증하여 {ok, scope, username} 반환
function authenticate_(body) {
  const u = ((body && body.username) || '').toString().trim();
  const pw = ((body && body.password) || '').toString();
  if (!u || !pw) return { ok: false };
  if (u.length > 64 || pw.length > 128) return { ok: false };
  const accts = getAccounts_();
  for (const name in accts) {
    if (name.toLowerCase() === u.toLowerCase()) {
      const info = accts[name];
      if (info && info.password === pw) return { ok: true, scope: info.scope || '', username: name };
      return { ok: false };
    }
  }
  return { ok: false };
}

function isSuperAdmin_(body) {
  const a = authenticate_(body);
  return a.ok && a.scope === 'all';
}

// 연합 트리 (Apps Script 내 캐시) — 프론트와 동일
const ALLIANCE_TREE_ = {
  '쿠데타계':       ['쿠데타', '혁명', '반란', '난'],
  '주술사연합회계':  ['주술사연합회', '주스터콜', '주연', '주술사연맹', '주토피아', '주막왈숙네'],
  '로켓단계':       ['로켓단'],
  '매화계':         ['매화'],
  '신화계':         ['신화', '시'],
  '청룡계':         ['청룡'],
  '연가계':         ['월하', '연가', '연희'],
};

// 스코프에 해당하는 문파 목록 반환. 'all' → null (모든 문파), 계 이름 → 소속 문파 배열, 그 외 → [단일 문파]
function guildsForScope_(scope) {
  if (!scope || scope === 'all') return null;
  if (ALLIANCE_TREE_[scope]) return ALLIANCE_TREE_[scope];
  return [scope];
}

// 스코프가 특정 문파를 포함하는지
function scopeIncludes_(scope, guild) {
  const list = guildsForScope_(scope);
  if (list === null) return true;
  return list.indexOf(guild) >= 0;
}

// 권한 체크: 'all' 스코프이면 모든 권한, 아니면 해당 문파만
function authorize_(body, requiredGuild) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  if (a.scope === 'all') return { ok: true, auth: a };
  if (requiredGuild && a.scope !== requiredGuild) return { ok: false, error: '권한 없음' };
  return { ok: true, auth: a };
}

// checkAdmin_: 명시적 username/password 만 허용 (옛 password-only 폴백 제거 — 보안)
function checkAdmin_(body) {
  return authenticate_(body).ok;
}

// 비밀번호 변경 (자기 계정)
function changeAdminPassword_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const newPw = (body.newPassword || '').toString().trim();
  if (newPw.length < 3) return { ok: false, error: '비밀번호는 3자 이상이어야 합니다' };
  if (newPw.length > 64) return { ok: false, error: '64자 이하' };
  const accts = getAccounts_();
  accts[a.username] = { password: newPw, scope: a.scope };
  saveAccounts_(accts);
  return { ok: true };
}

// 계정 목록 (전체관리자 전용)
function listAccounts_(body) {
  if (!isSuperAdmin_(body)) return { ok: false, error: 'forbidden' };
  const accts = getAccounts_();
  const list = Object.keys(accts).map((u) => ({
    username: u,
    scope: accts[u].scope,
  }));
  return { ok: true, accounts: list };
}

// 계정 추가/수정 (전체관리자 전용)
function setAccount_(body) {
  if (!isSuperAdmin_(body)) return { ok: false, error: 'forbidden' };
  const target = (body.targetUsername || '').toString().trim();
  const pw = (body.newPassword || '').toString();
  const scope = (body.scope || '').toString();
  if (!target) return { ok: false, error: '아이디 누락' };
  if (target.toLowerCase() === 'admin' && scope !== 'all') {
    return { ok: false, error: 'admin 계정은 전체 스코프 고정' };
  }
  if (pw.length < 3) return { ok: false, error: '비밀번호 3자 이상' };
  const accts = getAccounts_();
  accts[target] = { password: pw, scope };
  saveAccounts_(accts);
  return { ok: true };
}

// 계정 삭제 (전체관리자 전용, admin 계정은 삭제 불가)
function removeAccount_(body) {
  if (!isSuperAdmin_(body)) return { ok: false, error: 'forbidden' };
  const target = (body.targetUsername || '').toString().trim();
  if (!target || target.toLowerCase() === 'admin') return { ok: false, error: 'admin 은 삭제 불가' };
  const accts = getAccounts_();
  if (!accts[target]) return { ok: false, error: '없음' };
  delete accts[target];
  saveAccounts_(accts);
  return { ok: true };
}

// ====================================================
// 성주 현황 (4성: 주작/현무/청룡/백호)
// ====================================================

function getCastleLords_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CASTLE_LORDS');
  const defaults = { '주작성': null, '현무성': null, '청룡성': null, '백호성': null };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    return Object.assign(defaults, parsed);
  } catch (_) {
    return defaults;
  }
}

function setCastleLord_(body) {
  if (!isSuperAdmin_(body)) return { ok: false, error: 'forbidden: 전체 관리자만' };
  const castle = (body.castle || '').toString();
  const guild = (body.guild || '').toString().trim();
  if (['주작성','현무성','청룡성','백호성'].indexOf(castle) < 0) {
    return { ok: false, error: '유효하지 않은 성' };
  }
  if (guild.length > 32) return { ok: false, error: '문파명 너무 김' };

  const lords = getCastleLords_();
  const prevGuild = (lords[castle] && lords[castle].guild) || '';
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  lords[castle] = guild ? { guild, updatedAt: now } : null;
  PropertiesService.getScriptProperties().setProperty('CASTLE_LORDS', JSON.stringify(lords));

  // 이력 시트에 변경 기록 (실제 값이 바뀐 경우만)
  if (prevGuild !== guild) {
    try {
      const a = authenticate_(body);
      appendCastleHistory_(castle, guild, (a && a.username) || '');
    } catch (e) { console.log('이력 기록 실패: ' + e); }
  }

  invalidateBootstrap_();
  notifyDiscordCastleChange_(castle, guild);
  return { ok: true };
}

// ====================================================
// 성주 이력 시트
// ====================================================

function getCastleHistorySheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트 연결 실패');
  let sh = ss.getSheetByName(CASTLE_HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CASTLE_HISTORY_SHEET);
    sh.appendRow(CASTLE_HISTORY_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, CASTLE_HISTORY_HEADERS.length).setFontWeight('bold');
  }
  const firstRow = sh.getRange(1, 1, 1, CASTLE_HISTORY_HEADERS.length).getValues()[0];
  if (firstRow.join('|') !== CASTLE_HISTORY_HEADERS.join('|')) {
    sh.getRange(1, 1, 1, CASTLE_HISTORY_HEADERS.length).setValues([CASTLE_HISTORY_HEADERS]);
    sh.setFrozenRows(1);
  }
  // A 컬럼(시간) 텍스트로 고정
  sh.getRange('A2:A').setNumberFormat('@');
  return sh;
}

function appendCastleHistory_(castle, guild, actor) {
  const sh = getCastleHistorySheet_();
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  sh.appendRow([
    safeCell_(now),
    safeCell_(castle),
    safeCell_(guild || '(미점령)'),
    safeCell_(actor || '?'),
  ]);
}

// 최근 N일 이력 반환 (기본 90일)
function listCastleHistory_(params) {
  const days = Math.max(1, Math.min(365, parseInt((params && params.days) || '90', 10) || 90));
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const cutoffStr = Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  const sh = getCastleHistorySheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, CASTLE_HISTORY_HEADERS.length).getValues();
  return vals
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      changedAt: formatDateValue_(r[0]),
      castle: String(r[1] || ''),
      guild: String(r[2] || ''),
      actor: String(r[3] || ''),
    }))
    .filter((x) => x.changedAt >= cutoffStr)
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

// ====================================================
// 연합 지침 (공지/안내문)
// ====================================================

function getGuidelines_() {
  return PropertiesService.getScriptProperties().getProperty('GUIDELINES') || '';
}

function setGuidelines_(body) {
  if (!isSuperAdmin_(body)) return { ok: false, error: 'forbidden: 전체 관리자만' };
  const text = (body.text || '').toString();
  if (text.length > 20000) return { ok: false, error: '20,000자 초과' };
  PropertiesService.getScriptProperties().setProperty('GUIDELINES', text);
  PropertiesService.getScriptProperties().setProperty('GUIDELINES_UPDATED_AT',
    Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
  );
  invalidateBootstrap_();
  return { ok: true };
}

// ====================================================
// 문파 모집/연락처 정보 (PropertiesService 'GUILDS_INFO' JSON)
// 형식: { "쿠데타": { recruiting, requirements, contact, discordInvite, description, updatedAt }, ... }
// ====================================================

function getGuildsInfo_() {
  const raw = PropertiesService.getScriptProperties().getProperty('GUILDS_INFO');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
}

function setGuildInfo_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const guild = (body.guild || '').toString().trim();
  if (!guild) return { ok: false, error: '문파명 누락' };
  if (guild.length > 32) return { ok: false, error: '문파명이 너무 깁니다' };

  // 권한 체크: super-admin 전체 가능. 계 관리자는 자기 계 내 문파만.
  const allowedGuilds = guildsForScope_(a.scope);
  if (allowedGuilds !== null && allowedGuilds.indexOf(guild) < 0) {
    return { ok: false, error: '권한 범위 외 문파' };
  }

  const all = getGuildsInfo_();
  // 입력 sanitize + 길이 제한
  const info = {
    recruiting: !!body.recruiting,
    requirements: (body.requirements || '').toString().slice(0, 500),
    contact: (body.contact || '').toString().slice(0, 200),
    discordInvite: (body.discordInvite || '').toString().slice(0, 200),
    description: (body.description || '').toString().slice(0, 1000),
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    updatedBy: a.username || '',
  };
  // 디스코드 초대 링크는 https://discord.gg/ 또는 https://discord.com/invite/ 만 허용
  if (info.discordInvite && !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(info.discordInvite)) {
    return { ok: false, error: '디스코드 초대 링크 형식 오류 (discord.gg/...)' };
  }
  all[guild] = info;
  PropertiesService.getScriptProperties().setProperty('GUILDS_INFO', JSON.stringify(all));
  invalidateBootstrap_();
  return { ok: true };
}

// ====================================================
// 공성 즉석 매칭 — 디스코드 webhook 핑
// 인증된 관리자만 호출 가능. 채널 자동 알림.
// ====================================================

function notifySiegeNeedHelp_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  if (!getDiscordWebhook_()) return { ok: false, error: 'Discord webhook 미설정' };

  const guild = (body.guild || '').toString().trim().slice(0, 32);
  const roleNeeded = (body.role || '').toString().trim().slice(0, 32);
  const count = Math.max(1, Math.min(20, parseInt(body.count || '1', 10) || 1));
  const note = (body.note || '').toString().slice(0, 200);
  const urgent = !!body.urgent;

  if (!guild) return { ok: false, error: '문파 누락' };
  if (!roleNeeded) return { ok: false, error: '필요 인원/직업 누락' };

  // 권한: 자기 계 관리자가 다른 계 문파로 알림 보내는 거 차단
  const allowedGuilds = guildsForScope_(a.scope);
  if (allowedGuilds !== null && allowedGuilds.indexOf(guild) < 0) {
    return { ok: false, error: '권한 범위 외 문파' };
  }

  const embed = {
    title: (urgent ? '🚨 ' : '📢 ') + guild + ' · 공성 보충 필요',
    description: `**${roleNeeded}** ${count}명 모집` + (note ? '\n\n' + note : ''),
    color: urgent ? 0xff5147 : 0xFFCC00,
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템 · 보충 요청 by ' + (a.username || '?') },
  };
  const sent = notifyDiscord_(urgent ? '@everyone 공성 보충 긴급!' : null, [embed]);
  return { ok: sent, sent };
}

function getSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트 연결 실패: 바인딩 스크립트로 열거나 SPREADSHEET_ID 설정 필요');
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  // ensure headers
  const firstRow = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (firstRow.join('|') !== HEADERS.join('|')) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  // 시간 컬럼이 Date 로 자동 변환되지 않게 텍스트로 고정
  sh.getRange('D2:D').setNumberFormat('@');
  return sh;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'list';
    if (action === 'list') return jsonOut_({ ok: true, entries: listEntries_() });
    if (action === 'members') return jsonOut_({ ok: true, members: listMembers_() });
    if (action === 'castleLords') return jsonOut_({ ok: true, lords: getCastleLords_() });
    if (action === 'guidelines') return jsonOut_({ ok: true, text: getGuidelines_() });
    if (action === 'bootstrap') return jsonOut_(getBootstrap_());
    if (action === 'hallOfFame') {
      return jsonOut_(getHallOfFame_({
        period: e.parameter.period,
        scope: e.parameter.scope,
        limit: e.parameter.limit,
      }));
    }
    if (action === 'castleLordHistory') {
      return jsonOut_({ ok: true, history: listCastleHistory_({ days: e.parameter.days }) });
    }
    if (action === 'seasonsList') {
      return jsonOut_({ ok: true, seasons: listArchivedSeasons_() });
    }
    if (action === 'seasonArchive') {
      return jsonOut_(getArchivedSeason_(e.parameter.season || '', e.parameter.scope || 'personal'));
    }
    if (action === 'scoreCalc') {
      return jsonOut_(proxyBarambookScore_(e.parameter.job_code || '', e.parameter.hp || '0', e.parameter.mp || '0'));
    }
    if (action === 'guildsInfo') {
      return jsonOut_({ ok: true, guilds: getGuildsInfo_() });
    }
    if (action === 'tradeMarket') {
      return jsonOut_(getTradeMarket_());
    }
    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: safeErr_(err) });
  }
}

// ====================================================
// Bootstrap: 랜딩/siege 가 필요로 하는 4종을 단일 호출로 묶음.
// CacheService 로 30초 캐시 → cold-start 영향 최소화.
// 변경 액션 (submit / members:* / castleLord:set / guidelines:set) 에서 invalidate.
// ====================================================

const BOOTSTRAP_CACHE_KEY = 'bootstrap_v1';
const BOOTSTRAP_CACHE_SEC = 30;

function getBootstrap_() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(BOOTSTRAP_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (_) {}
    }
    const out = {
      ok: true,
      entries: listEntries_(),
      members: listMembers_(),
      lords: getCastleLords_(),
      guidelines: getGuidelines_(),
      guilds: getGuildsInfo_(),
      serverTime: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'),
    };
    try { cache.put(BOOTSTRAP_CACHE_KEY, JSON.stringify(out), BOOTSTRAP_CACHE_SEC); } catch (_) {}
    return out;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function invalidateBootstrap_() {
  try { CacheService.getScriptCache().remove(BOOTSTRAP_CACHE_KEY); } catch (_) {}
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action || 'submit';

    // 익명 액션 (submit, ocr) 레이트 리밋 — 닉네임/이미지 길이로 단순 키 생성
    if (action === 'submit') {
      const key = 'rl:submit:' + (body.nickname || 'anon').toString().slice(0, 16);
      if (!rateLimit_(key, 6, 60)) return jsonOut_({ ok: false, error: '신청 빈도가 너무 잦습니다. 1분 후 다시 시도해 주세요.' });
      return jsonOut_(submitEntry_(body));
    }
    if (action === 'ocr') {
      const key = 'rl:ocr:' + (body.mime || 'x').toString().slice(0, 16);
      if (!rateLimit_(key, 30, 60)) return jsonOut_({ ok: false, error: 'OCR 빈도가 너무 잦습니다.' });
      return jsonOut_(ocrImage_(body));
    }

    if (action === 'members:list') return jsonOut_({ ok: true, members: listMembers_() });
    if (action === 'members:set') return jsonOut_(setMembers_(body));
    if (action === 'members:add') return jsonOut_(addMember_(body));
    if (action === 'members:remove') return jsonOut_(removeMember_(body));
    if (action === 'stats:weekly') return jsonOut_(getWeeklyStats_(body));
    if (action === 'stats:comparison') return jsonOut_(getComparison_(body));
    if (action === 'stats:monthly') return jsonOut_(getMonthlyGrowth_(body));
    if (action === 'admin:checkPw') return jsonOut_({ ok: checkAdmin_(body) });
    if (action === 'admin:login') {
      const a = authenticate_(body);
      return jsonOut_({ ok: a.ok, scope: a.scope || null, username: a.username || null });
    }
    if (action === 'admin:changePw') return jsonOut_(changeAdminPassword_(body));
    if (action === 'admin:accounts:list') return jsonOut_(listAccounts_(body));
    if (action === 'admin:accounts:set') return jsonOut_(setAccount_(body));
    if (action === 'admin:accounts:remove') return jsonOut_(removeAccount_(body));
    if (action === 'castleLord:set') return jsonOut_(setCastleLord_(body));
    if (action === 'guidelines:set') return jsonOut_(setGuidelines_(body));
    if (action === 'guildInfo:set') return jsonOut_(setGuildInfo_(body));
    if (action === 'siege:needHelp') return jsonOut_(notifySiegeNeedHelp_(body));
    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: safeErr_(err) });
  }
}

// ====================================================
// 문파원 명단 관리
// ====================================================

function getMemberSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트 연결 실패');
  let sh = ss.getSheetByName(MEMBER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(MEMBER_SHEET);
    sh.appendRow(MEMBER_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, MEMBER_HEADERS.length).setFontWeight('bold');
  }
  const firstRow = sh.getRange(1, 1, 1, MEMBER_HEADERS.length).getValues()[0];
  if (firstRow.join('|') !== MEMBER_HEADERS.join('|')) {
    sh.getRange(1, 1, 1, MEMBER_HEADERS.length).setValues([MEMBER_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function listMembers_() {
  const sh = getMemberSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, MEMBER_HEADERS.length).getValues();
  return vals
    .filter((r) => String(r[0] || '').trim())
    .map((r) => ({
      nickname: String(r[0] || '').trim(),
      guild: String(r[1] || '').trim(),
      family: String(r[2] || '').trim(),
      role: String(r[3] || ''),
      addedAt: formatDateValue_(r[4]),
    }));
}

// body.members: Array<{nickname, guild, family, role}> or Array<string>
// body.replaceGuild (선택): 'all' 또는 특정 문파명. 해당 범위만 교체.
function setMembers_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const rawList = Array.isArray(body.members) ? body.members : [];
  if (rawList.length > 500) return { ok: false, error: '한 번에 최대 500명' };
  let replaceGuild = (body.replaceGuild || 'all').toString();
  const allowedGuilds = guildsForScope_(a.scope);
  if (allowedGuilds !== null) {
    rawList.forEach((raw) => {
      if (raw && typeof raw === 'object') {
        if (!raw.guild || allowedGuilds.indexOf(raw.guild) < 0) {
          raw.guild = allowedGuilds[0];
        }
      }
    });
    if (replaceGuild !== 'all' && allowedGuilds.indexOf(replaceGuild) < 0) {
      replaceGuild = 'all';
    }
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (_) { return { ok: false, error: '서버가 바쁩니다.' }; }
  try {
    const sh = getMemberSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      if (replaceGuild === 'all') {
        sh.getRange(2, 1, last - 1, MEMBER_HEADERS.length).clearContent();
      } else {
        const all = sh.getRange(2, 1, last - 1, MEMBER_HEADERS.length).getValues();
        for (let i = all.length - 1; i >= 0; i--) {
          if (String(all[i][1] || '').trim() === replaceGuild) {
            sh.deleteRow(i + 2);
          }
        }
      }
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    const seen = new Set();
    const rows = [];
    rawList.forEach((raw) => {
      const obj = typeof raw === 'string' ? { nickname: raw } : (raw || {});
      const nick = String(obj.nickname || '').trim().slice(0, 32);
      if (!nick) return;
      const key = nick.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([
        safeCell_(nick),
        safeCell_(String(obj.guild || '').trim().slice(0, 32)),
        safeCell_(String(obj.family || '').trim().slice(0, 32)),
        safeCell_(String(obj.role || '').trim().slice(0, 32)),
        now,
      ]);
    });
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, MEMBER_HEADERS.length).setValues(rows);
    }
    invalidateBootstrap_();
    return { ok: true, count: rows.length };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function addMember_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const nickname = (body.nickname || '').toString().trim();
  if (!nickname) return { ok: false, error: '닉네임 누락' };
  if (nickname.length > 32) return { ok: false, error: '닉네임이 너무 깁니다 (최대 32자)' };
  const allowedGuilds = guildsForScope_(a.scope);
  if (allowedGuilds !== null) {
    const g = (body.guild || '').toString().trim();
    if (!g || allowedGuilds.indexOf(g) < 0) {
      return { ok: false, error: '권한 범위 외 문파' };
    }
    body.family = a.scope;
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (_) { return { ok: false, error: '서버가 바쁩니다.' }; }
  try {
    const sh = getMemberSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const existing = sh.getRange(2, 1, last - 1, 1).getValues().flat()
        .map((s) => String(s || '').trim().toLowerCase());
      if (existing.includes(nickname.toLowerCase())) {
        return { ok: false, error: '이미 등록된 문원' };
      }
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    sh.appendRow([
      safeCell_(nickname),
      safeCell_(String(body.guild || '').trim().slice(0, 32)),
      safeCell_(String(body.family || '').trim().slice(0, 32)),
      safeCell_(String(body.role || '').trim().slice(0, 32)),
      now,
    ]);
    invalidateBootstrap_();
    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function removeMember_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const nickname = (body.nickname || '').toString().trim().toLowerCase();
  if (!nickname) return { ok: false, error: '닉네임 누락' };
  const sh = getMemberSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'not_found' };
  // 문파 관리자는 자기 문파 사람만 삭제 가능
  const vals = sh.getRange(2, 1, last - 1, MEMBER_HEADERS.length).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    const rowNick = String(vals[i][0] || '').trim().toLowerCase();
    const rowGuild = String(vals[i][1] || '').trim();
    if (rowNick === nickname) {
      const allowedGuilds = guildsForScope_(a.scope);
      if (allowedGuilds !== null && allowedGuilds.indexOf(rowGuild) < 0) {
        return { ok: false, error: '권한 없음 (다른 계 문원)' };
      }
      sh.deleteRow(i + 2);
      invalidateBootstrap_();
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

// ====================================================
// 통계
// ====================================================

function kstNow_() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function kstDateStr_(d) {
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
}

// 이번 주 월요일 ~ 일요일 (KST)
function thisWeekRange_() {
  const d = kstNow_();
  const dow = d.getUTCDay(); // 0=Sun
  const offset = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d.getTime());
  mon.setUTCDate(mon.getUTCDate() + offset);
  const sun = new Date(mon.getTime());
  sun.setUTCDate(sun.getUTCDate() + 6);
  return { start: kstDateStr_(mon), end: kstDateStr_(sun) };
}

function lastWeekRange_() {
  const t = thisWeekRange_();
  const ms = new Date(t.start + 'T00:00:00Z');
  ms.setUTCDate(ms.getUTCDate() - 7);
  const me = new Date(t.end + 'T00:00:00Z');
  me.setUTCDate(me.getUTCDate() - 7);
  return { start: kstDateStr_(ms), end: kstDateStr_(me) };
}

function entriesInRange_(entries, start, end) {
  return entries.filter((e) => {
    const d = (e.dateKst || '').slice(0, 10);
    return d >= start && d <= end;
  });
}

function bestPerNick_(entries) {
  // returns Map<nickLower, {score, ...entry}>
  const map = new Map();
  entries.forEach((e) => {
    const k = (e.nickname || '').trim().toLowerCase();
    if (!k) return;
    const s = parseFloat(e.score) || 0;
    const prev = map.get(k);
    if (!prev || s > parseFloat(prev.score)) {
      map.set(k, e);
    }
  });
  return map;
}

/**
 * 가중치 점수 = base × elite_mult × streak_mult
 *   elite: O = 1.30,  최대한 참여 = 1.15,  나머지 = 1.00
 *   streak: 같은 닉네임의 최근 N주 연속 등록 (각 주 최소 1건 베스트 점수 존재) →
 *           1.00 + 0.05 × (N-1), 최대 1.30 (7주 연속)
 *
 * @param entry  bestPerNick_ 결과 한 건 (또는 단일 entry)
 * @param allEntries  최근 8주 entries 풀 (streak 계산용)
 * @param members  (옵션) 무시
 */
function weightedScore_(entry, allEntries, members) {
  const base = parseFloat(entry && entry.score) || 0;
  if (base <= 0) return 0;
  const elite = (entry && entry.elite || '').toString().trim();
  let eliteMult = 1.0;
  if (elite === 'O') eliteMult = 1.30;
  else if (elite === '최대한 참여' || elite === '최대') eliteMult = 1.15;

  // 연속 출석: 이번 주 포함 최근 N주 연속, N >= 1
  const nick = (entry.nickname || '').trim().toLowerCase();
  let streakWeeks = 0;
  if (nick && allEntries && allEntries.length) {
    const week = thisWeekRange_();
    // 주별 시작일 7개 (이번 주 ~ 6주 전)
    for (let w = 0; w < 8; w++) {
      const startDate = new Date(week.start + 'T00:00:00Z');
      startDate.setUTCDate(startDate.getUTCDate() - 7 * w);
      const endDate = new Date(startDate.getTime());
      endDate.setUTCDate(endDate.getUTCDate() + 6);
      const wStart = kstDateStr_(startDate);
      const wEnd = kstDateStr_(endDate);
      const has = allEntries.some((e) =>
        (e.nickname || '').trim().toLowerCase() === nick &&
        (e.dateKst || '').slice(0, 10) >= wStart &&
        (e.dateKst || '').slice(0, 10) <= wEnd
      );
      if (has) streakWeeks++; else break;
    }
  }
  const streakMult = Math.min(1.30, 1.0 + 0.05 * Math.max(0, streakWeeks - 1));
  return base * eliteMult * streakMult;
}

// 시즌(분기) 범위 — 1-3월/4-6월/7-9월/10-12월
function seasonRange_() {
  const d = kstNow_();
  const month = d.getUTCMonth(); // 0-indexed
  const seasonStart = Math.floor(month / 3) * 3; // 0,3,6,9
  const start = new Date(Date.UTC(d.getUTCFullYear(), seasonStart, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), seasonStart + 3, 0));
  return { start: kstDateStr_(start), end: kstDateStr_(end) };
}

// 최근 N일 범위
function recentDaysRange_(days) {
  const end = kstNow_();
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: kstDateStr_(start), end: kstDateStr_(end) };
}

function getWeeklyStats_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  // 스코프로 1차 필터, 그 안에서 guildFilter (사용자 선택) 로 2차 필터
  const allowedGuilds = guildsForScope_(a.scope); // null = 전체
  const requested = (body.guildFilter || '').toString().trim();
  // 'all' 또는 빈 값이면 allowedGuilds 전부, 특정 문파면 그 문파만 (단, allowedGuilds 안에 있어야 함)
  let activeGuilds = allowedGuilds; // null 가능
  if (requested && requested !== 'all') {
    if (allowedGuilds && allowedGuilds.indexOf(requested) < 0) {
      return { ok: false, error: '권한 외 문파' };
    }
    activeGuilds = [requested];
  }
  const range = body.range === 'last' ? lastWeekRange_() : thisWeekRange_();
  const allEntries = listEntries_();
  let members = listMembers_();
  let inRange = entriesInRange_(allEntries, range.start, range.end);
  if (activeGuilds !== null) {
    members = members.filter((m) => activeGuilds.indexOf(m.guild || '') >= 0);
    inRange = inRange.filter((e) => activeGuilds.indexOf(e.guild || '') >= 0);
  }

  const bestMap = bestPerNick_(inRange);
  const memberMap = new Map();
  members.forEach((m) => memberMap.set(m.nickname.toLowerCase(), m.nickname));

  const memberStats = members.map((m) => {
    const k = m.nickname.toLowerCase();
    const e = bestMap.get(k);
    if (!e) return { nickname: m.nickname, submitted: false };
    return {
      nickname: m.nickname,
      submitted: true,
      score: e.score,
      castle: e.castle,
      dateKst: e.dateKst,
      elite: e.elite,
      note: e.note,
    };
  });

  // 비문원 신청자
  const nonMember = inRange.filter((e) => !memberMap.has((e.nickname || '').toLowerCase()));

  const totalMembers = members.length;
  const submittedCount = memberStats.filter((s) => s.submitted).length;
  const pct = totalMembers > 0 ? Math.round((submittedCount / totalMembers) * 1000) / 10 : 0;

  // Elite 통계
  const eliteCounts = { O: 0, X: 0, '최대한 참여': 0, '': 0 };
  memberStats.forEach((s) => {
    if (!s.submitted) return;
    const v = s.elite || '';
    if (eliteCounts.hasOwnProperty(v)) eliteCounts[v]++;
    else eliteCounts[''] = (eliteCounts[''] || 0) + 1;
  });

  return {
    ok: true,
    period: range,
    totalMembers,
    submittedCount,
    percentage: pct,
    members: memberStats,
    nonMemberEntries: nonMember,
    eliteCounts,
  };
}

function getComparison_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const allowedGuilds = guildsForScope_(a.scope);
  const requested = (body.guildFilter || '').toString().trim();
  let activeGuilds = allowedGuilds;
  if (requested && requested !== 'all') {
    if (allowedGuilds && allowedGuilds.indexOf(requested) < 0) return { ok: false, error: '권한 외 문파' };
    activeGuilds = [requested];
  }
  const thisR = thisWeekRange_();
  const lastR = lastWeekRange_();
  const entries = listEntries_();
  let members = listMembers_();
  if (activeGuilds !== null) members = members.filter((m) => activeGuilds.indexOf(m.guild || '') >= 0);

  const thisBest = bestPerNick_(entriesInRange_(entries, thisR.start, thisR.end));
  const lastBest = bestPerNick_(entriesInRange_(entries, lastR.start, lastR.end));

  const rows = members.map((m) => {
    const k = m.nickname.toLowerCase();
    const t = thisBest.get(k);
    const l = lastBest.get(k);
    const tScore = t ? parseFloat(t.score) || 0 : null;
    const lScore = l ? parseFloat(l.score) || 0 : null;
    const diff = (tScore !== null && lScore !== null) ? Math.round((tScore - lScore) * 100) / 100 : null;
    return { nickname: m.nickname, thisScore: tScore, lastScore: lScore, diff };
  });

  return { ok: true, thisRange: thisR, lastRange: lastR, rows };
}

function getMonthlyGrowth_(body) {
  const a = authenticate_(body);
  if (!a.ok) return { ok: false, error: 'unauthorized' };
  const allowedGuilds = guildsForScope_(a.scope);
  const requested = (body.guildFilter || '').toString().trim();
  let activeGuilds = allowedGuilds;
  if (requested && requested !== 'all') {
    if (allowedGuilds && allowedGuilds.indexOf(requested) < 0) return { ok: false, error: '권한 외 문파' };
    activeGuilds = [requested];
  }
  const end = kstNow_();
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - 28);
  const range = { start: kstDateStr_(start), end: kstDateStr_(end) };

  const entries = listEntries_();
  let members = listMembers_();
  let inRange = entriesInRange_(entries, range.start, range.end);
  if (activeGuilds !== null) {
    members = members.filter((m) => activeGuilds.indexOf(m.guild || '') >= 0);
    inRange = inRange.filter((e) => activeGuilds.indexOf(e.guild || '') >= 0);
  }

  const rows = members.map((m) => {
    const k = m.nickname.toLowerCase();
    const userEntries = inRange
      .filter((e) => (e.nickname || '').trim().toLowerCase() === k)
      .sort((a, b) => (a.dateKst || '').localeCompare(b.dateKst || ''));
    if (userEntries.length < 1) return { nickname: m.nickname, count: 0, firstScore: null, lastScore: null, diff: null };
    const scores = userEntries.map((e) => parseFloat(e.score) || 0);
    const first = scores[0];
    const last = Math.max(...scores);
    return {
      nickname: m.nickname,
      count: userEntries.length,
      firstScore: first,
      lastScore: last,
      diff: Math.round((last - first) * 100) / 100,
    };
  });

  rows.sort((a, b) => {
    if (a.diff === null && b.diff === null) return 0;
    if (a.diff === null) return 1;
    if (b.diff === null) return -1;
    return b.diff - a.diff;
  });

  return { ok: true, range, rows };
}

// ====================================================
// 명예의 전당 (Hall of Fame)
//
// 가중치 점수 = base × elite_mult × streak_mult
//   - elite: O = 1.30, 최대한 참여 = 1.15, 그 외 1.00
//   - streak: 최근 N주 연속 등록 시 1.0 + 0.05×(N-1), 최대 1.30
//
// 스코프: 'personal' (개인 TOP10), 'guild' (문파 합산 TOP10), 'family' (계 평균 TOP10)
// 기간: 'week' (이번주), 'month' (최근 28일), 'season' (분기)
// 인증 불필요 (랜딩에서 누구나 조회 가능).
// ====================================================

function getHallOfFame_(params) {
  const period = (params && params.period) || 'week';
  const scope = (params && params.scope) || 'personal';
  const limit = Math.max(1, Math.min(50, parseInt((params && params.limit) || '10', 10) || 10));

  let range;
  if (period === 'month') range = recentDaysRange_(28);
  else if (period === 'season') range = seasonRange_();
  else range = thisWeekRange_();

  const allEntries = listEntries_();
  const members = listMembers_();
  const inRange = entriesInRange_(allEntries, range.start, range.end);
  // streak 계산은 최근 8주 풀 필요
  const streakWindow = recentDaysRange_(8 * 7);
  const streakPool = entriesInRange_(allEntries, streakWindow.start, streakWindow.end);

  // 닉네임 → 가중치 점수
  const best = bestPerNick_(inRange);
  const personalRows = [];
  const memberMap = new Map();
  members.forEach((m) => memberMap.set(m.nickname.toLowerCase(), m));

  best.forEach((e, nickKey) => {
    const mem = memberMap.get(nickKey);
    const guild = (e.guild && e.guild.trim()) || (mem && mem.guild) || '';
    const family = (mem && mem.family) || guildToFamilyServer_(guild) || '';
    const w = weightedScore_(e, streakPool, members);
    personalRows.push({
      nickname: e.nickname,
      guild, family,
      baseScore: parseFloat(e.score) || 0,
      weightedScore: Math.round(w * 100) / 100,
      elite: e.elite || '',
    });
  });

  if (scope === 'personal') {
    personalRows.sort((a, b) => b.weightedScore - a.weightedScore);
    return { ok: true, period, scope, range, rows: personalRows.slice(0, limit) };
  }

  if (scope === 'guild') {
    const map = new Map();
    personalRows.forEach((p) => {
      const g = p.guild || '(미지정)';
      if (!map.has(g)) map.set(g, { guild: g, family: p.family || '', totalScore: 0, members: 0 });
      const o = map.get(g);
      o.totalScore += p.weightedScore;
      o.members++;
    });
    const out = Array.from(map.values()).map((o) => ({
      guild: o.guild,
      family: o.family,
      totalScore: Math.round(o.totalScore * 100) / 100,
      members: o.members,
      avgScore: o.members ? Math.round((o.totalScore / o.members) * 100) / 100 : 0,
    }));
    out.sort((a, b) => b.totalScore - a.totalScore);
    return { ok: true, period, scope, range, rows: out.slice(0, limit) };
  }

  if (scope === 'family') {
    const map = new Map();
    personalRows.forEach((p) => {
      const f = p.family || '(미지정)';
      if (!map.has(f)) map.set(f, { family: f, totalScore: 0, members: 0 });
      const o = map.get(f);
      o.totalScore += p.weightedScore;
      o.members++;
    });
    const out = Array.from(map.values()).map((o) => ({
      family: o.family,
      totalScore: Math.round(o.totalScore * 100) / 100,
      members: o.members,
      avgScore: o.members ? Math.round((o.totalScore / o.members) * 100) / 100 : 0,
    }));
    // 평균으로 정렬 — 큰 계가 무조건 유리하지 않게
    out.sort((a, b) => b.avgScore - a.avgScore);
    return { ok: true, period, scope, range, rows: out.slice(0, limit) };
  }

  return { ok: false, error: 'unknown scope: ' + scope };
}

// 서버측 문파→계 매핑 (ALLIANCE_TREE_ 기반)
function guildToFamilyServer_(guild) {
  const g = (guild || '').trim();
  if (!g) return '';
  for (const fam in ALLIANCE_TREE_) {
    if (ALLIANCE_TREE_[fam].indexOf(g) >= 0) return fam;
  }
  return '';
}

// ====================================================
// 시즌 명전 자동 박제
// 분기(Q1=1-3, Q2=4-6, Q3=7-9, Q4=10-12) 종료 시점 명전 상위 결과를 시트에 저장.
// Apps Script Trigger 로 분기 첫날 새벽 호출 권장: archivePreviousSeason()
// 시즌 키 형식: "2026-Q1"
// ====================================================

function getSeasonArchiveSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트 연결 실패');
  let sh = ss.getSheetByName(SEASON_ARCHIVE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SEASON_ARCHIVE_SHEET);
    sh.appendRow(SEASON_ARCHIVE_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SEASON_ARCHIVE_HEADERS.length).setFontWeight('bold');
  }
  const firstRow = sh.getRange(1, 1, 1, SEASON_ARCHIVE_HEADERS.length).getValues()[0];
  if (firstRow.join('|') !== SEASON_ARCHIVE_HEADERS.join('|')) {
    sh.getRange(1, 1, 1, SEASON_ARCHIVE_HEADERS.length).setValues([SEASON_ARCHIVE_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function seasonKey_(date) {
  const d = date || kstNow_();
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return y + '-Q' + q;
}

// 특정 시즌(seasonKey)의 명전 TOP 결과 생성 — 시즌 범위 점수만 사용
function buildSeasonHallOfFame_(year, q, limit) {
  limit = Math.max(1, Math.min(50, parseInt(limit || '10', 10) || 10));
  // 분기 시작/종료 계산
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  const range = { start: kstDateStr_(start), end: kstDateStr_(end) };

  const allEntries = listEntries_();
  const members = listMembers_();
  const inRange = entriesInRange_(allEntries, range.start, range.end);
  const streakWindow = recentDaysRange_(8 * 7);
  const streakPool = entriesInRange_(allEntries, streakWindow.start, streakWindow.end);

  const best = bestPerNick_(inRange);
  const memberMap = new Map();
  members.forEach((m) => memberMap.set(m.nickname.toLowerCase(), m));
  const personalRows = [];
  best.forEach((e, nickKey) => {
    const mem = memberMap.get(nickKey);
    const guild = (e.guild && e.guild.trim()) || (mem && mem.guild) || '';
    const family = (mem && mem.family) || guildToFamilyServer_(guild) || '';
    const w = weightedScore_(e, streakPool, members);
    personalRows.push({
      nickname: e.nickname, guild, family,
      baseScore: parseFloat(e.score) || 0,
      weightedScore: Math.round(w * 100) / 100,
    });
  });

  personalRows.sort((a, b) => b.weightedScore - a.weightedScore);
  const personal = personalRows.slice(0, limit);

  const guildMap = new Map();
  personalRows.forEach((p) => {
    const g = p.guild || '(미지정)';
    if (!guildMap.has(g)) guildMap.set(g, { guild: g, family: p.family || '', totalScore: 0, members: 0 });
    const o = guildMap.get(g);
    o.totalScore += p.weightedScore;
    o.members++;
  });
  const guild = Array.from(guildMap.values()).map((o) => ({
    guild: o.guild, family: o.family,
    totalScore: Math.round(o.totalScore * 100) / 100,
    members: o.members,
    avgScore: o.members ? Math.round((o.totalScore / o.members) * 100) / 100 : 0,
  })).sort((a, b) => b.totalScore - a.totalScore).slice(0, limit);

  const famMap = new Map();
  personalRows.forEach((p) => {
    const f = p.family || '(미지정)';
    if (!famMap.has(f)) famMap.set(f, { family: f, totalScore: 0, members: 0 });
    const o = famMap.get(f);
    o.totalScore += p.weightedScore;
    o.members++;
  });
  const family = Array.from(famMap.values()).map((o) => ({
    family: o.family,
    totalScore: Math.round(o.totalScore * 100) / 100,
    members: o.members,
    avgScore: o.members ? Math.round((o.totalScore / o.members) * 100) / 100 : 0,
  })).sort((a, b) => b.avgScore - a.avgScore).slice(0, limit);

  return {
    season: year + '-Q' + q,
    range,
    personal, guild, family,
    totalEntries: personalRows.length,
  };
}

/**
 * 직전 분기 명전을 박제. 분기 첫날 새벽 Trigger 호출 권장.
 *   편집기 → 트리거 → 함수 archivePreviousSeason + 시간 기반 + 매월 1일 03:00
 *   (분기 첫달=1,4,7,10 1일에만 실제 동작, 나머지 달 1일은 noop)
 */
function archivePreviousSeason() {
  const now = kstNow_();
  // 이번 분기의 첫 달 1일이 아니면 noop (트리거를 매월 깔아둬도 분기 첫달만 동작)
  const month = now.getUTCMonth();
  if (month % 3 !== 0 || now.getUTCDate() !== 1) {
    console.log('archivePreviousSeason: 분기 첫달 1일이 아님, skip (' + kstDateStr_(now) + ')');
    return;
  }
  // 직전 분기 = (now - 3개월) 의 분기
  const prev = new Date(now.getTime());
  prev.setUTCDate(15); // 안전하게 중순으로 이동 (월말 corner case 회피)
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevQ = Math.floor(prev.getUTCMonth() / 3) + 1;
  const prevY = prev.getUTCFullYear();

  const key = prevY + '-Q' + prevQ;
  if (isSeasonArchived_(key)) {
    console.log('archivePreviousSeason: 이미 박제됨 (' + key + ')');
    return;
  }

  const data = buildSeasonHallOfFame_(prevY, prevQ, 10);
  if (!data.totalEntries) {
    console.log('archivePreviousSeason: 시즌 ' + key + ' 데이터 없음');
    return;
  }
  saveSeasonArchive_(data);
  // 디스코드 박제 알림
  notifyDiscord_(null, [{
    title: `🏆 ${key} 시즌 명예의 전당 박제`,
    description: `직전 시즌 명전이 영구 저장되었습니다.\n총 ${data.totalEntries}명 참가.`,
    color: 0xFFCC00,
    fields: [
      { name: '🥇 개인 1위', value: data.personal[0] ? `**${data.personal[0].nickname}** (${data.personal[0].guild}) · ${data.personal[0].weightedScore}` : '-', inline: false },
      { name: '🏰 문파 1위', value: data.guild[0] ? `**${data.guild[0].guild}** · ${data.guild[0].totalScore}` : '-', inline: true },
      { name: '👥 계 1위', value: data.family[0] ? `**${data.family[0].family}** · 평균 ${data.family[0].avgScore}` : '-', inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'EU연합 통합시스템 · 시즌 박제' },
  }]);
}

function isSeasonArchived_(key) {
  const sh = getSeasonArchiveSheet_();
  const last = sh.getLastRow();
  if (last < 2) return false;
  const vals = sh.getRange(2, 1, last - 1, 1).getValues();
  return vals.some((r) => String(r[0] || '') === key);
}

function saveSeasonArchive_(data) {
  const sh = getSeasonArchiveSheet_();
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  const rows = [];
  data.personal.forEach((p, i) => rows.push([
    data.season, 'personal', i + 1, p.nickname, p.guild || '-',
    p.weightedScore, p.baseScore, 1, now,
  ]));
  data.guild.forEach((g, i) => rows.push([
    data.season, 'guild', i + 1, g.guild, g.family || '-',
    g.totalScore, '', g.members, now,
  ]));
  data.family.forEach((f, i) => rows.push([
    data.season, 'family', i + 1, f.family, '-',
    f.totalScore, '', f.members, now,
  ]));
  if (!rows.length) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, SEASON_ARCHIVE_HEADERS.length)
    .setValues(rows.map((r) => r.map(safeCell_)));
}

// 박제된 시즌 목록 + 특정 시즌 데이터 조회
function listArchivedSeasons_() {
  const sh = getSeasonArchiveSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, 1).getValues();
  const set = new Set();
  vals.forEach((r) => { const k = String(r[0] || ''); if (k) set.add(k); });
  return Array.from(set).sort().reverse();
}

function getArchivedSeason_(season, scope) {
  const sh = getSeasonArchiveSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, season, scope, rows: [] };
  const vals = sh.getRange(2, 1, last - 1, SEASON_ARCHIVE_HEADERS.length).getValues();
  const rows = vals
    .filter((r) => String(r[0] || '') === season && String(r[1] || '') === (scope || 'personal'))
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((r) => ({
      rank: Number(r[2]) || 0,
      name: String(r[3] || ''),
      guildOrFamily: String(r[4] || ''),
      weightedScore: Number(r[5]) || 0,
      baseScore: Number(r[6]) || 0,
      members: Number(r[7]) || 0,
    }));
  return { ok: true, season, scope: scope || 'personal', rows };
}

/**
 * 수동 박제 (편집기에서 한 번 실행). 인자 없이 호출하면 직전 분기 박제 (날짜 가드 우회).
 *   archiveSeasonManual()           — 직전 분기 박제
 *   archiveSeasonManual(2026, 1)    — 2026-Q1 박제
 */
// ====================================================
// 공성 점수 계산 — barambook.com/api/score 프록시
// CORS 우회용. 1분 캐시 + 입력 검증.
// 직업 코드: Warrior(전사), Sheif(도적), Magic(주술사), Hill(도사)
// ====================================================

// ====================================================
// 거래소 시세 위젯 — classicbaram.gg /api/trades 스크래핑
// 1시간 캐시. 최근 500건 거래 집계 → TOP 10 활발 아이템.
// ====================================================

function getTradeMarket_() {
  const cacheKey = 'trade_market_v1';
  try {
    const cache = CacheService.getScriptCache();
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (_) {}

  try {
    const res = UrlFetchApp.fetch('https://classicbaram.gg/api/trades?limit=500', {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: 'upstream ' + res.getResponseCode() };
    }
    const trades = JSON.parse(res.getContentText());
    if (!Array.isArray(trades)) return { ok: false, error: 'unexpected response' };

    // 아이템별 집계
    const agg = {};
    let oldest = '', newest = '';
    trades.forEach((t) => {
      const item = t && t.item || {};
      const name = (item.name || '').trim();
      const price = parseInt(t && t.price, 10) || 0;
      const ttype = t && t.tradeType; // 1=판매? 0=구매?
      const at = (t && t.createdAt || '').toString();
      if (at && (!oldest || at < oldest)) oldest = at;
      if (at && at > newest) newest = at;
      if (!name || !price) return;
      if (!agg[name]) {
        agg[name] = {
          name,
          iconUrl: item.iconUrl || '',
          itemId: item.id || 0,
          sellPrices: [],
          buyPrices: [],
        };
      }
      if (ttype === 1) agg[name].sellPrices.push(price);
      else agg[name].buyPrices.push(price);
    });

    // 정렬: 총 거래 수 desc
    const rows = Object.values(agg).map((o) => {
      const sellAvg = o.sellPrices.length ? Math.round(o.sellPrices.reduce((a,b)=>a+b,0) / o.sellPrices.length) : 0;
      const buyAvg = o.buyPrices.length ? Math.round(o.buyPrices.reduce((a,b)=>a+b,0) / o.buyPrices.length) : 0;
      const allPrices = o.sellPrices.concat(o.buyPrices);
      const minP = allPrices.length ? Math.min.apply(null, allPrices) : 0;
      const maxP = allPrices.length ? Math.max.apply(null, allPrices) : 0;
      return {
        name: o.name, iconUrl: o.iconUrl, itemId: o.itemId,
        count: o.sellPrices.length + o.buyPrices.length,
        sellCount: o.sellPrices.length, buyCount: o.buyPrices.length,
        sellAvg, buyAvg, minPrice: minP, maxPrice: maxP,
      };
    }).sort((a, b) => b.count - a.count).slice(0, 15);

    const out = {
      ok: true,
      total: trades.length,
      range: { oldest, newest },
      fetchedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
      items: rows,
      source: 'classicbaram.gg',
    };
    try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), 3600); } catch (_) {}
    return out;
  } catch (err) {
    return { ok: false, error: 'fetch fail: ' + (err && err.message || err) };
  }
}

function proxyBarambookScore_(jobCode, hp, mp) {
  const validJobs = ['Warrior', 'Sheif', 'Magic', 'Hill'];
  if (validJobs.indexOf(jobCode) < 0) return { ok: false, error: 'invalid job_code: ' + jobCode };
  const hpN = parseInt(hp, 10);
  const mpN = parseInt(mp, 10);
  if (!isFinite(hpN) || !isFinite(mpN) || hpN < 0 || mpN < 0 || hpN > 5000000 || mpN > 5000000) {
    return { ok: false, error: 'invalid hp/mp range: ' + hp + '/' + mp };
  }
  // 캐시 (같은 입력 1분 이내 재호출 방지)
  const cacheKey = 'score:' + jobCode + ':' + hpN + ':' + mpN;
  try {
    const cache = CacheService.getScriptCache();
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (_) {}
  const url = 'https://barambook.com/api/score?job_code=' + encodeURIComponent(jobCode) +
              '&hp=' + hpN + '&mp=' + mpN;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });
    const code = res.getResponseCode();
    const body = res.getContentText() || '';
    if (code !== 200) {
      return { ok: false, error: 'upstream HTTP ' + code + ': ' + body.slice(0, 120) };
    }
    let data;
    try { data = JSON.parse(body); }
    catch (e) {
      return { ok: false, error: 'JSON parse fail: ' + body.slice(0, 120) };
    }
    if (!data || (data.ok === false)) {
      return { ok: false, error: 'upstream ok=false: ' + body.slice(0, 120) };
    }
    if (!data.score) {
      return { ok: false, error: 'no score field: ' + body.slice(0, 120) };
    }
    const out = { ok: true, score: data.score, jobCode, hp: hpN, mp: mpN };
    try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), 60); } catch (_) {}
    return out;
  } catch (err) {
    // safeErr_ 대신 실제 메시지 노출 (디버그용)
    return { ok: false, error: 'fetch exception: ' + (err && err.message || err) };
  }
}

function archiveSeasonManual(year, q) {
  let y = year, qq = q;
  if (!y || !qq) {
    const now = kstNow_();
    const prev = new Date(now.getTime());
    prev.setUTCDate(15);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    qq = Math.floor(prev.getUTCMonth() / 3) + 1;
    y = prev.getUTCFullYear();
  }
  const key = y + '-Q' + qq;
  if (isSeasonArchived_(key)) return key + ' 이미 박제됨';
  const data = buildSeasonHallOfFame_(y, qq, 10);
  if (!data.totalEntries) return key + ' 시즌 데이터 없음';
  saveSeasonArchive_(data);
  return key + ' 박제 완료 (개인 ' + data.personal.length + '명 + 문파 ' + data.guild.length + '개 + 계 ' + data.family.length + '개)';
}

/**
 * 1회 권한 부여 트리거:
 *   편집기에서 이 함수 한 번 실행 → Google 이 Drive 권한 다이얼로그 표시 → 승인.
 *   승인 후엔 ocrImage_ 가 정상 동작합니다.
 *   (서비스 추가만으로는 OAuth 스코프가 확장 안되므로 이 단계 필요)
 */
function setupOcrPermissions() {
  const blob = Utilities.newBlob('setup', 'text/plain', 'setup.txt');
  const f = Drive.Files.insert({title: 'setup-' + Date.now(), mimeType: 'text/plain'}, blob, {convert: false});
  DriveApp.getFileById(f.id).setTrashed(true);
  return 'OK';
}

/**
 * OCR 디스패처.
 * 1) VISION_API_KEY 스크립트 속성이 있으면 Google Cloud Vision API 사용 (권장, 인식률 최고).
 * 2) 없으면 Drive API v2 의 OCR 기능 폴백 (rate limit 있음).
 *
 * Vision API 설정 (1회만):
 *   1) console.cloud.google.com 접속 → Apps Script 와 같은 프로젝트 선택
 *   2) "API 및 서비스 → 라이브러리" → "Cloud Vision API" 사용 설정
 *   3) "사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키" 생성
 *   4) 키 제한: "API 제한사항" → "키 제한" → Cloud Vision API 만 허용 (권장)
 *   5) Apps Script 편집기 → 프로젝트 설정 (⚙️) → 스크립트 속성 → 속성 추가
 *      이름: VISION_API_KEY  값: AIza... (위에서 받은 키)
 *   6) 「배포 관리」 → ✏️ → 새 버전 → 배포
 *
 *   * 무료 한도: 월 1,000 호출. 초과 시 $1.50 / 1,000건.
 */
// 이미지 base64 최대 크기 (~7MB base64 = ~5MB raw). Apps Script payload 한도 + Vision API 안전 마진.
const OCR_MAX_B64_BYTES = 7 * 1024 * 1024;

/**
 * OCR 디스패처. 우선순위:
 *   1) Gemini 2.5 Flash (GEMINI_API_KEY + schemaType 있으면) — 구조화 JSON 반환
 *   2) Vision API (VISION_API_KEY 있으면) — 원본 텍스트
 *   3) Drive OCR (Apps Script Drive 서비스 활성화 시) — 원본 텍스트
 *
 * body.schemaType: 'siege' (점수 추출) 또는 'admin' (문원 리스트 추출).
 *   없으면 LLM 스킵 → 텍스트 OCR 만.
 *
 * 반환 형태:
 *   { ok: true, structured?: {...}, text?: '...', engine: 'gemini|vision|drive' }
 *   클라이언트는 structured 있으면 우선 사용, 없으면 text 정규식 폴백.
 */
function ocrImage_(body) {
  // 입력 크기 검증
  const raw = ((body && body.image) || '').toString();
  if (!raw) return { ok: false, error: '이미지 없음' };
  if (raw.length > OCR_MAX_B64_BYTES) {
    return { ok: false, error: '이미지가 너무 큽니다 (최대 5MB). 압축 후 다시 시도해 주세요.' };
  }
  const geminiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const schemaType = (body && body.schemaType || '').toString();
  if (geminiKey && schemaType) {
    const out = geminiOcr_(body, geminiKey, schemaType);
    if (out.ok) return out;
    // Gemini 실패 시 Vision/Drive 폴백 (text 만이라도 반환)
  }
  const visionKey = PropertiesService.getScriptProperties().getProperty('VISION_API_KEY');
  if (visionKey) return visionOcr_(body, visionKey);
  return driveOcr_(body);
}

// ====================================================
// Gemini 2.5 Flash OCR + 구조화 출력
// 무료 티어: 10 RPM / 250 RPD (2026-05 기준).
// 1회 설정: setupGeminiKey('AIza...') 편집기에서 실행.
// 키는 aistudio.google.com 에서 무료 발급.
// ====================================================

function setupGeminiKey(key) {
  if (!key) {
    PropertiesService.getScriptProperties().deleteProperty('GEMINI_API_KEY');
    return 'Gemini API 비활성화됨';
  }
  if (!/^AIza[\w-]{30,}$/.test(key)) {
    return '키 형식 오류 (AIza... 로 시작하는 Google API 키)';
  }
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return 'Gemini API 활성화 완료 (key ...' + key.slice(-6) + ')';
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

// schemaType 별 prompt + responseSchema 정의
const GEMINI_SCHEMAS_ = {
  siege: {
    prompt: '이 바람의나라 클래식 게임 스크린샷에서 본인 캐릭터의 공성 점수를 추출하세요.\n' +
            '점수는 보통 "등록한 공성전 참가점수: XXXX.XX" 또는 "참가점수 XXXX.XX" 같은 라벨 뒤에 표시됩니다.\n' +
            '소수점 포함 숫자만 score 필드에 넣고, 닉네임이 함께 보이면 nickname 에 넣으세요.\n' +
            '여러 점수가 보이면 가장 명확한 "참가점수" 라벨 뒤의 값을 우선으로 합니다.',
    schema: {
      type: 'object',
      properties: {
        score: { type: 'number', description: '공성 참가 점수 (예: 2818.23)' },
        nickname: { type: 'string', description: '닉네임 (있으면)' },
      },
      required: ['score'],
    },
  },
  admin: {
    prompt: '이 바람의나라 클래식 문파원 목록 스크린샷에서 모든 닉네임과 역할을 추출하세요.\n' +
            '역할(role) 은 정확히 다음 중 하나: "문파장", "부문파장", "문파원", 또는 명시되지 않은 경우 "" (빈 문자열).\n' +
            '닉네임은 한글 1~6자 또는 영숫자가 일반적이며, 직책 텍스트("문파장" 등)는 role 에만 넣고 nickname 에는 캐릭터 ID 만 넣으세요.\n' +
            '레벨/직업/상태 같은 부가 정보는 무시하세요.',
    schema: {
      type: 'object',
      properties: {
        members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nickname: { type: 'string', description: '캐릭터 닉네임' },
              role: { type: 'string', enum: ['문파장', '부문파장', '문파원', ''], description: '직책 (없으면 빈 문자열)' },
            },
            required: ['nickname', 'role'],
          },
        },
      },
      required: ['members'],
    },
  },
};

function geminiOcr_(body, apiKey, schemaType) {
  const cfg = GEMINI_SCHEMAS_[schemaType];
  if (!cfg) return { ok: false, error: 'unknown schemaType: ' + schemaType };
  const raw = (body.image || '').toString();
  const b64 = raw.replace(/^data:[^,]+,/, '');
  if (!b64) return { ok: false, error: '이미지 없음' };
  const mime = (body.mime || 'image/jpeg').toString();

  const reqBody = {
    contents: [{
      parts: [
        { text: cfg.prompt },
        { inline_data: { mime_type: mime, data: b64 } },
      ],
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: cfg.schema,
      temperature: 0.1,
    },
  };

  try {
    const res = UrlFetchApp.fetch(GEMINI_ENDPOINT + '?key=' + encodeURIComponent(apiKey), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(reqBody),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText() || '';
    if (code !== 200) {
      return { ok: false, error: 'Gemini HTTP ' + code + ': ' + text.slice(0, 200) };
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      return { ok: false, error: 'Gemini JSON parse fail' };
    }
    const cand = parsed && parsed.candidates && parsed.candidates[0];
    const partsArr = cand && cand.content && cand.content.parts;
    const jsonStr = partsArr && partsArr[0] && partsArr[0].text;
    if (!jsonStr) {
      // safetyBlocked / no candidate 등
      const reason = (cand && cand.finishReason) || (parsed.promptFeedback && parsed.promptFeedback.blockReason) || 'no-content';
      return { ok: false, error: 'Gemini no content: ' + reason };
    }
    let structured;
    try { structured = JSON.parse(jsonStr); } catch (e) {
      return { ok: false, error: 'Gemini schema JSON parse fail: ' + jsonStr.slice(0, 200) };
    }
    return { ok: true, structured: structured, engine: 'gemini', schemaType };
  } catch (err) {
    return { ok: false, error: 'Gemini fetch exception: ' + (err && err.message || err) };
  }
}

function visionOcr_(body, apiKey) {
  try {
    const raw = (body.image || '').toString();
    const b64 = raw.replace(/^data:[^,]+,/, '');
    if (!b64) return { ok: false, error: '이미지 없음' };
    const reqBody = {
      requests: [{
        image: { content: b64 },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
        imageContext: { languageHints: ['ko', 'en'] },
      }],
    };
    const res = UrlFetchApp.fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(reqBody),
        muteHttpExceptions: true,
      }
    );
    const code = res.getResponseCode();
    const raw_resp = res.getContentText();
    let data;
    try { data = JSON.parse(raw_resp); } catch (_) { data = {}; }
    if (code !== 200) {
      const errMsg = (data.error && data.error.message) || ('HTTP ' + code);
      return { ok: false, error: 'Vision API: ' + errMsg };
    }
    const ann = data.responses && data.responses[0];
    if (ann && ann.error) {
      return { ok: false, error: 'Vision API: ' + ann.error.message };
    }
    const text = ann && ann.fullTextAnnotation ? ann.fullTextAnnotation.text : '';
    return { ok: true, text: text, engine: 'vision' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function driveOcr_(body) {
  try {
    if (typeof Drive === 'undefined' || !Drive.Files) {
      return { ok: false, error: 'Drive API v2 서비스가 활성화되지 않았고 VISION_API_KEY 도 없습니다. 둘 중 하나를 설정하세요.' };
    }
    const raw = (body.image || '').toString();
    const b64 = raw.replace(/^data:[^,]+,/, '');
    if (!b64) return { ok: false, error: '이미지 없음' };
    const mime = (body.mime || 'image/png').toString();
    const bytes = Utilities.base64Decode(b64);
    const blob = Utilities.newBlob(bytes, mime, 'ocr-input');
    const resource = {
      title: 'ocr-temp-' + Date.now(),
      mimeType: mime,
    };
    const file = Drive.Files.insert(resource, blob, {
      convert: true,
      ocr: true,
      ocrLanguage: 'ko',
    });
    let text = '';
    try {
      const doc = DocumentApp.openById(file.id);
      text = doc.getBody().getText();
    } finally {
      try { DriveApp.getFileById(file.id).setTrashed(true); } catch (_) {}
    }
    return { ok: true, text: text, engine: 'drive' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function formatDateValue_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  }
  return String(v || '');
}

function listEntries_() {
  const sh = getSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values
    .filter((r) => r[1] || r[2])
    .map((r) => ({
      castle: String(r[0] || ''),
      nickname: String(r[1] || ''),
      score: String(r[2] || ''),
      dateKst: formatDateValue_(r[3]),
      note: String(r[4] || ''),
      updated: String(r[5] || '') === '갱신',
      elite: String(r[6] || ''),
      guild: String(r[7] || ''),
    }));
}

function submitEntry_(body) {
  const nickname = (body.nickname || '').toString().trim();
  const score = (body.score || '').toString().trim();
  const castle = (body.castle || '').toString().trim();
  const dateKst = (body.dateKst || '').toString().trim();
  let note = (body.note || '').toString().trim();
  const elite = (body.elite || '').toString().trim();
  const guild = (body.guild || '').toString().trim();
  const wantUpdate = !!body.update;

  // --- 입력 검증 (서버측 화이트리스트, 클라이언트 maxlength 로는 부족) ---
  if (!nickname) return { ok: false, error: '닉네임 누락' };
  if (nickname.length > 32) return { ok: false, error: '닉네임이 너무 깁니다 (최대 32자)' };
  if (!score) return { ok: false, error: '점수 누락' };
  if (!/^-?\d{1,5}(\.\d{1,3})?$/.test(score)) return { ok: false, error: '점수 형식 오류 (예: 2818.23)' };
  if (!castle) return { ok: false, error: '성 누락' };
  if (['주작성','현무성','청룡성','백호성'].indexOf(castle) < 0) return { ok: false, error: '유효하지 않은 성' };
  if (dateKst && !/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(dateKst)) return { ok: false, error: '시간 형식 오류' };
  if (elite && ['O','X','최대한 참여'].indexOf(elite) < 0) return { ok: false, error: '정예 값 오류' };
  if (guild.length > 32) return { ok: false, error: '문파명이 너무 깁니다' };
  if (note.length > 200) note = note.slice(0, 200);

  // --- 동시성 락 (중복 검색 ~ append 사이 race 차단) ---
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (_) {
    return { ok: false, error: '서버가 바쁩니다. 잠시 후 다시 시도해 주세요.' };
  }
  try {
    const sh = getSheet_();
    const last = sh.getLastRow();
    const todayPrefix = (dateKst || '').slice(0, 10);

    // 중복 검색: 같은 닉네임 + 성 + 같은 날(YYYY-MM-DD)
    let dupRow = -1;
    if (last >= 2 && todayPrefix) {
      const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
      for (let i = 0; i < values.length; i++) {
        const r = values[i];
        if (
          String(r[0] || '').trim() === castle &&
          String(r[1] || '').trim().toLowerCase() === nickname.toLowerCase() &&
          String(r[3] || '').slice(0, 10) === todayPrefix
        ) {
          dupRow = i + 2;
          break;
        }
      }
    }

    if (wantUpdate) {
      if (dupRow <= 0) return { ok: false, error: 'not_found', notFound: true };
      sh.getRange(dupRow, 1, 1, HEADERS.length).setValues([[
        safeCell_(castle), safeCell_(nickname), safeCell_(score), safeCell_(dateKst),
        safeCell_(note), '갱신', safeCell_(elite), safeCell_(guild),
      ]]);
      invalidateBootstrap_();
      notifyDiscordSubmit_({ castle, nickname, score, elite, guild, note, updated: true });
      return { ok: true, updated: true };
    }

    if (dupRow > 0) return { ok: false, error: 'duplicate', duplicate: true };

    sh.appendRow([
      safeCell_(castle), safeCell_(nickname), safeCell_(score), safeCell_(dateKst),
      safeCell_(note), '', safeCell_(elite), safeCell_(guild),
    ]);
    invalidateBootstrap_();
    notifyDiscordSubmit_({ castle, nickname, score, elite, guild, note, updated: false });
    return { ok: true, updated: false };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
