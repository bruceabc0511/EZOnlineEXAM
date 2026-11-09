/**
 * 線上筆試測驗系統 - 核心邏輯 (app.js) — 雲端多人連線與歷史場次版 (方案 B)
 * 功能包含：
 * 1. 雲端多人同步 (Google Apps Script + GitHub Pages)：跨網路多人同時連線應試、QR Code 專屬應試連結、即時同步題庫與交卷紀錄
 * 2. 考生端 (#007979 主題)：僅在考官「開始測驗」開放試卷期間顯示內容（試卷關閉時完全不顯示任何內容）、姓名/學號/Email 登入、防重複應試、亂數題目、防作弊監控
 * 3. 考官端 (#750000 主題)：PIN碼驗證 (0000119)、開始/結束測驗開關控制、Excel 範本匯入（支援空白題庫）、考後寄送考生成績單 Email、每次測驗獨立歸檔為歷史紀錄、錯題分析
 */

// 若有固定部署的預設 Google Apps Script 網址可填於此處；系統亦支援填入一次後自動透過雲端 KV 跨裝置永久綁定
const DEFAULT_GAS_URL = '';
const CLOUD_BIND_KV_APP_KEY = 'i1y48rk0';
const CLOUD_BIND_KV_FIELD = 'hd_exam_gas_id';
const CLOUD_BIND_NTFY_TOPIC = 'hd_online_exam_gas_bind_bruceabc0511';

const STORAGE_KEYS = {
  EXAM_DATA: 'online_exam_bank_v1',
  SUBMISSIONS: 'online_exam_submissions_v1',
  HISTORY_SESSIONS: 'online_exam_history_v1',
  GAS_URL: 'online_exam_gas_url_v1'
};

const EXAMINER_PIN = '0000119';

// 預設題庫 (支援空白題庫與預設關閉試卷狀態)
const DEFAULT_EXAM_DATA = {
  title: '未命名測驗',
  durationMinutes: 60,
  examDate: '',
  isExamOpen: false,
  questions: []
};

// 系統狀態
let examData = loadExamData();
let submissions = loadSubmissions();
let historySessions = loadHistorySessions();
let isExaminerAuthenticated = false;
let currentViewingHistoryId = null;
let cloudPollTimer = null;
let lastExamDataSaveAt = 0;

// 當前考試進行中狀態
let activeSession = {
  isActive: false,
  studentName: '',
  studentId: '',
  studentEmail: '',
  startTime: null,
  remainingSeconds: 0,
  timerInterval: null,
  shuffledQuestions: [],
  answers: {}, // { originalQuestionId: 'A' }
  warningCount: 0,
  lastCheatTriggerAt: 0
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  await initCloudUrlFromQueryOrDefault();
  updateCloudStatusUI();
  renderStudentLoginMeta();
  setupExamMetaAutoSync();
  setupDragAndDrop();
  setupAntiCheatListeners();

  // 若已綁定雲端網址，啟動時自動從雲端拉取最新題庫、開放狀態與成績紀錄
  if (getActiveGasUrl()) {
    await syncStateFromCloud(true);
    startCloudPolling();
  }
});

// ==================== 雲端多人連線與同步 ====================
function getActiveGasUrl() {
  return (localStorage.getItem(STORAGE_KEYS.GAS_URL) || DEFAULT_GAS_URL || '').trim();
}

function buildFullGasUrl(depIdOrUrl) {
  const clean = String(depIdOrUrl || '').trim();
  if (!clean || clean === 'NONE') return '';
  return clean.startsWith('http')
    ? clean
    : `https://script.google.com/macros/s/${clean}/exec`;
}

async function saveGlobalBoundGasUrl(gasUrl) {
  const depId = extractGasDeploymentId(gasUrl) || 'NONE';
  try {
    await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${CLOUD_BIND_KV_APP_KEY}/${CLOUD_BIND_KV_FIELD}/${encodeURIComponent(depId)}`,
      { method: 'POST' }
    );
  } catch (e) {
    console.warn('Global KV bind update failed:', e);
  }
  try {
    await fetch(`https://ntfy.sh/${CLOUD_BIND_NTFY_TOPIC}`, {
      method: 'POST',
      body: JSON.stringify({ depId })
    });
  } catch (e) { }
}

async function fetchGlobalBoundGasUrl() {
  // 1. 優先向永久保存的 KeyValue 雲端設定庫讀取已綁定的 GAS 部署 ID
  try {
    const res = await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${CLOUD_BIND_KV_APP_KEY}/${CLOUD_BIND_KV_FIELD}?_t=${Date.now()}`
    );
    if (res.ok) {
      const val = await res.json();
      if (val && val !== 'NONE') {
        return buildFullGasUrl(val);
      }
      if (val === 'NONE') {
        return '';
      }
    }
  } catch (e) {
    console.warn('Global KV bind fetch failed:', e);
  }

  // 2. 備援：向 ntfy 頻道讀取最近一次綁定紀錄
  try {
    const res2 = await fetch(`https://ntfy.sh/${CLOUD_BIND_NTFY_TOPIC}/json?poll=1&since=all`);
    if (res2.ok) {
      const text = await res2.text();
      const lines = text.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const lastEvt = JSON.parse(lines[lines.length - 1]);
        const payload = JSON.parse(lastEvt.message || '{}');
        if (payload.depId && payload.depId !== 'NONE') {
          return buildFullGasUrl(payload.depId);
        }
      }
    }
  } catch (e) { }

  return '';
}

async function initCloudUrlFromQueryOrDefault() {
  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get('api');
  if (apiParam) {
    const fullUrl = buildFullGasUrl(apiParam);
    if (fullUrl) {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, fullUrl);
      saveGlobalBoundGasUrl(fullUrl);
      return;
    }
  }

  if (DEFAULT_GAS_URL && !localStorage.getItem(STORAGE_KEYS.GAS_URL)) {
    localStorage.setItem(STORAGE_KEYS.GAS_URL, DEFAULT_GAS_URL);
  }

  const localUrl = getActiveGasUrl();
  const remoteBoundUrl = await fetchGlobalBoundGasUrl();

  if (remoteBoundUrl) {
    // 若雲端已有綁定網址，所有新裝置開啟網頁時直接自動套用綁定
    if (!localUrl || localUrl !== remoteBoundUrl) {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, remoteBoundUrl);
    }
  } else if (localUrl) {
    // 若本機已填過網址但雲端尚未記錄，自動將本機網址上傳為跨裝置全域綁定
    await saveGlobalBoundGasUrl(localUrl);
  }
}

function extractGasDeploymentId(url) {
  const match = String(url || '').match(/\/macros\/s\/([^/]+)\/exec/);
  return match ? match[1] : '';
}

function buildStudentShareUrl() {
  const baseUrl = window.location.origin + window.location.pathname;
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) return baseUrl;
  const depId = extractGasDeploymentId(gasUrl);
  const params = new URLSearchParams();
  params.set('api', depId || gasUrl);
  return `${baseUrl}?${params.toString()}`;
}

function updateCloudStatusUI() {
  const gasUrl = getActiveGasUrl();
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const urlInput = document.getElementById('gasWebAppUrlInput');
  const shareInput = document.getElementById('studentShareUrlInput');
  const qrImg = document.getElementById('studentQrImage');
  const qrHint = document.getElementById('qrCodeHint');

  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = gasUrl;
  }

  if (gasUrl) {
    if (dot) dot.classList.remove('offline');
    if (text) text.textContent = '已連線';
    const shareUrl = buildStudentShareUrl();
    if (shareInput) shareInput.value = shareUrl;
    if (qrImg && qrHint) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`;
      qrImg.classList.remove('hidden');
      qrHint.innerHTML = '考生可使用手機相機掃描上方 QR Code 直接進入本次測驗<br><span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="openStandaloneQrPage()">🔍 點選 QR Code 可開啟獨立頁面單獨顯示</span>';
    }
  } else {
    if (dot) dot.classList.add('offline');
    if (text) text.textContent = '尚未連線';
    if (shareInput) shareInput.value = window.location.origin + window.location.pathname;
    if (qrImg && qrHint) {
      qrImg.classList.add('hidden');
      qrHint.textContent = '請先於上方填入 Google Apps Script 網址並儲存，即可產生跨裝置多人連線 QR Code';
    }
  }
}

function handleCloudPillClick() {
  if (activeSession.isActive) return;
  if (isExaminerAuthenticated) {
    switchRole('examiner');
    switchExaminerTab('tabCloud');
  } else {
    const gasUrl = getActiveGasUrl();
    if (gasUrl) {
      syncStateFromCloud(false);
    } else {
      showToast('💡 請切換至「考官端」➔「雲端多人連線與寄信設定」綁定 Google 雲端試算表');
    }
  }
}

function startCloudPolling() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    // 僅在非作答進行中且已設定雲端時背景靜默同步 (每 10 秒同步試卷開放狀態與最新成績)
    if (!activeSession.isActive && getActiveGasUrl()) {
      syncStateFromCloud(true);
    }
  }, 10000);
}

async function syncStateFromCloud(silent = true) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    if (!silent) {
      showToast('⚠️ 尚未設定 Google Apps Script 雲端網址，目前為本機儲存模式');
    }
    return false;
  }

  if (!silent) {
    showToast('🔄 正在從雲端資料庫同步最新試卷與考生成績...');
  }

  try {
    const res = await fetch(`${gasUrl}?action=getExamState&_t=${Date.now()}`);
    const json = await res.json();
    if (json && json.status === 'success') {
      // 當考官已登入後台或剛修改過試卷設定時，背景輪詢 (silent=true) 不覆蓋本機 examData，避免手動修改的「當前試卷資訊」跳回舊範本內容
      const shouldSyncExamData = !silent || (!isExaminerAuthenticated && (Date.now() - lastExamDataSaveAt > 15000));
      if (shouldSyncExamData && json.examData && Array.isArray(json.examData.questions)) {
        examData = {
          title: json.examData.title ?? '',
          durationMinutes: json.examData.durationMinutes === '' ? '' : (Number(json.examData.durationMinutes) || 60),
          examDate: normalizeDateForInput(json.examData.examDate ?? ''),
          isExamOpen: Boolean(json.examData.isExamOpen),
          questions: json.examData.questions
        };
        localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
      }
      if (Array.isArray(json.submissions)) {
        submissions = json.submissions;
        localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
      }
      if (Array.isArray(json.historySessions)) {
        historySessions = json.historySessions;
        localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));
      }

      if (!activeSession.isActive) {
        renderStudentLoginMeta();
      }
      if (isExaminerAuthenticated) {
        refreshExaminerAllViews();
      }
      updateCloudStatusUI();

      if (!silent) {
        const statusStr = examData.isExamOpen ? '開放中' : '已關閉';
        showToast(`✅ 雲端同步成功！試卷狀態：【${statusStr}】，共 ${examData.questions.length} 題，已交卷 ${submissions.length} 人。`);
      }
      return true;
    }
  } catch (err) {
    console.warn('Cloud sync error:', err);
    if (!silent) {
      showToast('❌ 雲端同步失敗，請確認網路或 Apps Script 部署權限設為「所有人」');
    }
  }
  return false;
}

async function postToCloud(payload) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) return null;

  try {
    // 使用 text/plain 避免觸發 CORS OPTIONS preflight，確保 Google Apps Script Web App 100% 正常接收
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error('Post to cloud error:', err);
    return null;
  }
}

async function saveGasUrlConfig() {
  const input = document.getElementById('gasWebAppUrlInput');
  const val = input ? input.value.trim() : '';

  if (!val) {
    localStorage.removeItem(STORAGE_KEYS.GAS_URL);
    await saveGlobalBoundGasUrl('');
    updateCloudStatusUI();
    showToast('⚪ 已解除綁定並切換回本機儲存模式');
    return;
  }

  if (!val.startsWith('https://script.google.com/macros/s/')) {
    alert('請輸入正確的 Google Apps Script 網頁應用程式網址（格式為 https://script.google.com/macros/s/.../exec）！');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.GAS_URL, val);
  await saveGlobalBoundGasUrl(val);
  updateCloudStatusUI();
  startCloudPolling();

  showToast('🔌 正在驗證並跨裝置綁定雲端資料庫...');
  const ok = await syncStateFromCloud(false);
  if (ok) {
    await postToCloud({
      action: 'saveExamData',
      examData: examData
    });
  }
}

async function testGasConnection() {
  const input = document.getElementById('gasWebAppUrlInput');
  const url = (input && input.value.trim()) ? input.value.trim() : getActiveGasUrl();
  if (!url) {
    alert('請先在輸入框貼上 Google Apps Script 網頁應用程式網址 (.../exec)！');
    return;
  }

  showToast('🔌 正在測試連線至 Google Apps Script...');
  try {
    const res = await fetch(`${url}?action=ping&_t=${Date.now()}`);
    const json = await res.json();
    if (json && json.status === 'success') {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, url);
      await saveGlobalBoundGasUrl(url);
      updateCloudStatusUI();
      showToast('✅ 連線成功並已完成跨裝置綁定！' + (json.message || '雲端資料庫與寄信服務運作正常'));
    } else {
      showToast('⚠️ 收到回應但狀態異常，請確認部署權限設為「所有人」');
    }
  } catch (err) {
    showToast('❌ 連線測試失敗：請確認網址為 /exec 結尾且誰可以存取設為「所有人 (Anyone)」');
  }
}

async function pushAllLocalDataToCloud() {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    alert('請先設定並儲存 Google Apps Script 網址！');
    return;
  }
  showToast('⬆️ 正在將本機題庫、當前成績與歷史紀錄完整推送至雲端...');
  await postToCloud({ action: 'saveExamData', examData });
  await postToCloud({ action: 'syncSubmissions', examData, submissions });
  const res = await postToCloud({ action: 'syncHistory', historySessions });
  if (res && res.status === 'success') {
    showToast('✅ 已將本機所有題庫、成績與歷史紀錄同步至 Google 試算表！');
  } else {
    showToast('⚠️ 推送完成，若部分資料未更新請檢查網路連線');
  }
}

function copyStudentShareUrl() {
  const shareInput = document.getElementById('studentShareUrlInput');
  if (!shareInput) return;
  const url = buildStudentShareUrl();
  shareInput.value = url;
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 已複製考生專屬應試連結！可直接貼至 LINE 群組供多人連線應試。');
  }).catch(() => {
    shareInput.select();
    document.execCommand('copy');
    showToast('📋 已複製考生專屬應試連結！');
  });
}

function openStandaloneQrPage() {
  const shareUrl = buildStudentShareUrl();
  const baseDir = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
  const qrPageUrl = `${baseDir}qr.html?data=${encodeURIComponent(shareUrl)}`;
  window.open(qrPageUrl, '_blank', 'noopener,noreferrer');
}

// ==================== 本機與雲端雙向資料存取 ====================
function normalizeDateForInput(dateVal) {
  if (dateVal === null || dateVal === undefined || dateVal === '') return '';
  const str = String(dateVal).trim();
  if (!str) return '';
  // 若已符合 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // 處理 YYYY/M/D、YYYY-M-D、YYYY.M.D
  const match = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (match) {
    const y = match[1];
    const m = String(match[2]).padStart(2, '0');
    const d = String(match[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // 處理 Excel 日期序列值 (例如 46000)
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    const utcDays = serial - 25569;
    const dateObj = new Date(utcDays * 86400 * 1000);
    if (!isNaN(dateObj.getTime())) {
      const y = dateObj.getUTCFullYear();
      const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return '';
}

function loadExamData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EXAM_DATA);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.questions)) {
        return {
          title: parsed.title ?? '',
          durationMinutes: parsed.durationMinutes === '' ? '' : (Number(parsed.durationMinutes) || 60),
          examDate: normalizeDateForInput(parsed.examDate ?? ''),
          isExamOpen: Boolean(parsed.isExamOpen),
          questions: parsed.questions
        };
      }
    }
  } catch (e) {
    console.error('載入題庫失敗:', e);
  }
  localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(DEFAULT_EXAM_DATA));
  return JSON.parse(JSON.stringify(DEFAULT_EXAM_DATA));
}

function saveExamDataToStorage(syncCloud = true) {
  lastExamDataSaveAt = Date.now();
  localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  renderStudentLoginMeta();
  if (isExaminerAuthenticated) {
    renderExamControlBanner();
  }
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'saveExamData',
      examData: examData
    });
  }
}

function loadSubmissions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SUBMISSIONS);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('載入成績紀錄失敗:', e);
  }
  return [];
}

function saveSubmissionsToStorage(syncCloud = true) {
  localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'syncSubmissions',
      examData: examData,
      submissions: submissions
    });
  }
}

function loadHistorySessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.HISTORY_SESSIONS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('載入歷次測驗紀錄失敗:', e);
  }
  return [];
}

function saveHistorySessionsToStorage(syncCloud = true) {
  localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'syncHistory',
      historySessions: historySessions
    });
  }
}

// 計算每題平均配分 (滿分100)
function getPointsPerQuestion(qCount) {
  if (!qCount || qCount <= 0) return 0;
  return Number((100 / qCount).toFixed(2));
}

// ==================== 角色切換 (考生端 #007979 / 考官端 #750000) ====================
function switchRole(role) {
  if (activeSession.isActive) {
    alert('測驗正在進行中，禁止切換介面！');
    return;
  }

  const btnStudent = document.getElementById('btnRoleStudent');
  const btnExaminer = document.getElementById('btnRoleExaminer');
  const studentSec = document.getElementById('studentSection');
  const examinerSec = document.getElementById('examinerSection');

  if (role === 'student') {
    document.body.classList.remove('examiner-mode');
    btnStudent.classList.add('active');
    btnExaminer.classList.remove('active');
    studentSec.classList.remove('hidden');
    examinerSec.classList.add('hidden');
    renderStudentLoginMeta();
  } else {
    document.body.classList.add('examiner-mode');
    btnExaminer.classList.add('active');
    btnStudent.classList.remove('active');
    studentSec.classList.add('hidden');
    examinerSec.classList.remove('hidden');

    if (isExaminerAuthenticated) {
      showExaminerDashboard();
    } else {
      document.getElementById('examinerPinView').classList.remove('hidden');
      document.getElementById('examinerDashboardView').classList.add('hidden');
      document.getElementById('examinerPinInput').value = '';
      document.getElementById('pinErrorMsg').classList.add('hidden');
      setTimeout(() => document.getElementById('examinerPinInput').focus(), 100);
    }
  }
}

// ==================== 考官端：開始與結束測驗控制 ====================
function renderExamControlBanner() {
  const banner = document.getElementById('examControlBanner');
  const badge = document.getElementById('examOpenStatusBadge');
  const desc = document.getElementById('examOpenStatusDesc');
  const btnStart = document.getElementById('btnStartExamSession');
  const btnStop = document.getElementById('btnStopExamSession');

  if (!banner || !badge || !desc || !btnStart || !btnStop) return;

  if (examData.isExamOpen) {
    banner.classList.add('is-open');
    badge.className = 'exam-status-indicator open';
    badge.textContent = '🟢 測驗開放中';
    desc.textContent = `目前試卷【${examData.title || '未命名測驗'}】（共 ${examData.questions.length} 題）已開放，考生連線至考生端即可作答。`;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
  } else {
    banner.classList.remove('is-open');
    badge.className = 'exam-status-indicator closed';
    badge.textContent = '🔴 測驗已關閉';
    desc.textContent = '目前試卷為關閉狀態，考生連線至考生端將不會看到任何內容。';
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
  }
}

function setExamOpenStatus(isOpen) {
  if (isOpen) {
    if (!examData.questions || examData.questions.length === 0) {
      alert('目前題庫中沒有任何題目（0 題），請先匯入考題範本或手動新增題目後再開始測驗！');
      return;
    }
    examData.isExamOpen = true;
    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    showToast('🟢 已開始測驗！試卷現已對考生端開放顯示。');
  } else {
    examData.isExamOpen = false;
    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    showToast('🔴 已結束測驗並關閉試卷！考生端目前已隱藏所有內容。');
  }
}

// ==================== 考生端流程 (試卷關閉時顯示「目前非測驗時間」) ====================
function renderStudentLoginMeta() {
  const closedView = document.getElementById('studentClosedView');
  const loginView = document.getElementById('studentLoginView');
  const quizView = document.getElementById('studentQuizView');
  const resultView = document.getElementById('studentResultView');

  const isInQuizOrResult =
    activeSession.isActive ||
    (quizView && !quizView.classList.contains('hidden')) ||
    (resultView && !resultView.classList.contains('hidden'));

  // 若測驗卷為關閉狀態，且考生並非正在作答或剛交卷檢視憑證，顯示「目前非測驗時間」畫面
  if (!examData.isExamOpen) {
    if (loginView) loginView.classList.add('hidden');
    if (closedView) {
      closedView.classList.toggle('hidden', isInQuizOrResult);
    }
    return;
  }

  // 當測驗卷為開放狀態，隱藏「目前非測驗時間」畫面，並在未作答/結果頁時顯示考生登入畫面
  if (closedView) closedView.classList.add('hidden');
  if (loginView && !isInQuizOrResult) {
    loginView.classList.remove('hidden');
  }

  const qCount = examData.questions.length;
  const pts = getPointsPerQuestion(qCount);

  document.getElementById('studentExamTitle').textContent = examData.title || '未命名測驗';
  document.getElementById('studentExamDate').textContent = examData.examDate || '-';
  document.getElementById('studentExamDuration').textContent = examData.durationMinutes || 60;
  document.getElementById('studentExamQCount').textContent = qCount;
  document.getElementById('studentPointsPerQ').textContent = pts;
}

async function handleStartExam(event) {
  event.preventDefault();

  const nameInput = document.getElementById('studentName').value.trim();
  const idInput = document.getElementById('studentId').value.trim();
  const emailInput = document.getElementById('studentEmail').value.trim();
  const startBtn = document.getElementById('btnStartExam');
  const errorBox = document.getElementById('studentLoginError');

  errorBox.classList.add('hidden');

  if (!nameInput || !idInput || !emailInput) {
    showLoginError('請完整填寫考生姓名、學號與電子郵件 (Email)！');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
    showLoginError('請輸入格式正確的電子郵件 (Email) 信箱！');
    return;
  }

  // 若已連線雲端，開考前先向雲端拉取最新題庫、開放狀態與已交卷名單
  if (getActiveGasUrl()) {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '正在同步雲端最新試卷...';
    }
    await syncStateFromCloud(true);
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = `進入全螢幕並開始作答 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
    }
  }

  // 若考官已關閉測驗，立即隱藏考生端畫面並阻擋作答
  if (!examData.isExamOpen) {
    renderStudentLoginMeta();
    return;
  }

  if (examData.questions.length === 0) {
    showLoginError('目前題庫中尚無有效題目，請先通知考官匯入考題！');
    return;
  }

  // 檢查當前場次同一學號是否已作答過 (不區分大小寫)
  const duplicated = submissions.find(
    s => String(s.studentId).toLowerCase() === idInput.toLowerCase()
  );
  if (duplicated) {
    showLoginError(`學號「${idInput}」已於本場次 (${duplicated.submittedAt}) 完成交卷，每位考生限作答一次！`);
    return;
  }

  // 嘗試請求全螢幕以提高防作弊保護
  try {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => { });
    }
  } catch (e) { }

  // 亂數排列試題 (Fisher-Yates Shuffle)
  const shuffled = [...examData.questions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 初始化考試 Session
  activeSession = {
    isActive: true,
    studentName: nameInput,
    studentId: idInput,
    studentEmail: emailInput,
    startTime: Date.now(),
    remainingSeconds: (Number(examData.durationMinutes) || 60) * 60,
    timerInterval: null,
    shuffledQuestions: shuffled,
    answers: {},
    warningCount: 0,
    lastCheatTriggerAt: Date.now() // 給予剛進入全螢幕時的緩衝
  };

  // 切換頂部導覽列為考試監控模式
  document.getElementById('roleSwitcher').classList.add('hidden');
  document.getElementById('examLiveBar').classList.remove('hidden');
  document.getElementById('liveStudentDisplay').textContent = `${nameInput} (${idInput})`;
  document.getElementById('liveWarnCount').textContent = '0';
  document.getElementById('liveWarningBadge').classList.remove('warned');
  document.getElementById('liveTimerBox').classList.remove('timer-urgent');

  // 切換畫面至作答區
  document.getElementById('studentLoginView').classList.add('hidden');
  document.getElementById('studentResultView').classList.add('hidden');
  document.getElementById('studentQuizView').classList.remove('hidden');

  renderQuizQuestions();
  startCountdownTimer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showLoginError(msg) {
  const errorBox = document.getElementById('studentLoginError');
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function renderQuizQuestions() {
  const container = document.getElementById('questionsContainer');
  const palette = document.getElementById('questionPalette');
  const total = activeSession.shuffledQuestions.length;
  const pts = getPointsPerQuestion(total);

  document.getElementById('totalQCount').textContent = total;
  document.getElementById('quizPointsPerQ').textContent = pts;

  container.innerHTML = '';
  palette.innerHTML = '';

  activeSession.shuffledQuestions.forEach((q, idx) => {
    const displayNum = idx + 1;

    // 建立題目卡片
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = `q-card-${q.id}`;

    const optionsHtml = q.options
      .map(opt => {
        return `
          <label class="option-item" id="opt-label-${q.id}-${opt.key}" onclick="selectAnswer(${q.id}, '${opt.key}')">
            <input type="radio" class="option-radio" name="q_${q.id}" value="${opt.key}">
            <span class="option-key">${opt.key}</span>
            <span class="option-label-text">${escapeHtml(opt.text)}</span>
          </label>
        `;
      })
      .join('');

    card.innerHTML = `
      <div class="q-header">
        <span class="q-badge">第 ${displayNum} 題</span>
        <div class="q-text">${escapeHtml(q.question)}</div>
      </div>
      <div class="options-grid">
        ${optionsHtml}
      </div>
    `;
    container.appendChild(card);

    // 建立右側題號導覽按鈕
    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'palette-btn';
    pBtn.id = `palette-btn-${q.id}`;
    pBtn.textContent = displayNum;
    pBtn.onclick = () => {
      document.getElementById(`q-card-${q.id}`).scrollIntoView({ behavior: 'smooth' });
    };
    palette.appendChild(pBtn);
  });

  updateQuizProgress();
}

function selectAnswer(questionId, optionKey) {
  if (!activeSession.isActive) return;

  activeSession.answers[questionId] = optionKey;

  // 更新該題選項樣式
  const qObj = activeSession.shuffledQuestions.find(q => q.id === questionId);
  if (qObj) {
    qObj.options.forEach(opt => {
      const labelEl = document.getElementById(`opt-label-${questionId}-${opt.key}`);
      if (labelEl) {
        const radio = labelEl.querySelector('input[type="radio"]');
        if (opt.key === optionKey) {
          labelEl.classList.add('selected');
          if (radio) radio.checked = true;
        } else {
          labelEl.classList.remove('selected');
          if (radio) radio.checked = false;
        }
      }
    });
  }

  // 更新卡片與導覽列狀態
  const cardEl = document.getElementById(`q-card-${questionId}`);
  if (cardEl) cardEl.classList.add('answered');

  const pBtn = document.getElementById(`palette-btn-${questionId}`);
  if (pBtn) pBtn.classList.add('answered');

  updateQuizProgress();
}

function updateQuizProgress() {
  const total = activeSession.shuffledQuestions.length;
  const answered = Object.keys(activeSession.answers).length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

  document.getElementById('answeredCount').textContent = answered;
  document.getElementById('quizProgressBar').style.width = `${pct}%`;
}

// ==================== 倒數計時器 ====================
function startCountdownTimer() {
  if (activeSession.timerInterval) {
    clearInterval(activeSession.timerInterval);
  }

  updateTimerDisplay();

  activeSession.timerInterval = setInterval(() => {
    if (!activeSession.isActive) {
      clearInterval(activeSession.timerInterval);
      return;
    }

    activeSession.remainingSeconds--;
    updateTimerDisplay();

    // 剩餘不到 5 分鐘時變紅字提醒
    if (activeSession.remainingSeconds <= 300) {
      document.getElementById('liveTimerBox').classList.add('timer-urgent');
    }

    if (activeSession.remainingSeconds <= 0) {
      clearInterval(activeSession.timerInterval);
      finalizeExamSubmission('時間到自動交卷');
    }
  }, 1000);
}

function updateTimerDisplay() {
  const sec = Math.max(0, activeSession.remainingSeconds);
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  document.getElementById('timerDisplay').textContent = formatted;
}

// ==================== 防作弊監控機制 ====================
function setupAntiCheatListeners() {
  // 1. 偵測分頁切換或最小化 (visibilitychange)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeSession.isActive) {
      handleAntiCheatViolation('切換瀏覽器分頁或最小化視窗');
    }
  });

  // 2. 偵測視窗失去焦點 (window blur，例如點選其他應用程式或快捷鍵切出)
  window.addEventListener('blur', () => {
    if (activeSession.isActive) {
      handleAntiCheatViolation('離開作答視窗焦點');
    }
  });

  // 3. 禁止作答期間按右鍵選單與複製題目
  document.addEventListener('contextmenu', e => {
    if (activeSession.isActive) {
      e.preventDefault();
    }
  });

  document.addEventListener('copy', e => {
    if (activeSession.isActive) {
      e.preventDefault();
    }
  });
}

function handleAntiCheatViolation(reason) {
  if (!activeSession.isActive) return;

  // 避免同一次切換同時觸發 visibilitychange 與 blur 造成重複計次 (設定 1.2 秒防抖)
  const now = Date.now();
  if (now - activeSession.lastCheatTriggerAt < 1200) {
    return;
  }
  activeSession.lastCheatTriggerAt = now;

  activeSession.warningCount += 1;

  // 更新頂部警告徽章
  document.getElementById('liveWarnCount').textContent = activeSession.warningCount;
  document.getElementById('liveWarningBadge').classList.add('warned');

  if (activeSession.warningCount === 1) {
    // 第 1 次離開：跳出嚴重警告 Modal
    document.getElementById('antiCheatModal').classList.remove('hidden');
  } else if (activeSession.warningCount >= 2) {
    // 第 2 次離開：立即關閉所有 Modal 並強制終止測驗
    document.getElementById('antiCheatModal').classList.add('hidden');
    document.getElementById('submitConfirmModal').classList.add('hidden');
    finalizeExamSubmission('防作弊強制終止 (離開畫面達2次)');
  }
}

function acknowledgeCheatWarning() {
  activeSession.lastCheatTriggerAt = Date.now();
  document.getElementById('antiCheatModal').classList.add('hidden');
}

// ==================== 交卷與計分處理 ====================
function requestSubmitExam() {
  if (!activeSession.isActive) return;

  const total = activeSession.shuffledQuestions.length;
  const answered = Object.keys(activeSession.answers).length;
  const unanswered = total - answered;

  const confirmText = document.getElementById('submitConfirmText');
  if (unanswered > 0) {
    confirmText.innerHTML = `您目前已完成 <strong>${answered} / ${total}</strong> 題，尚有 <strong style="color: var(--danger);">${unanswered} 題未作答</strong>！<br>確定要現在交卷嗎？`;
  } else {
    confirmText.innerHTML = `您已全數完成 <strong>${total} / ${total}</strong> 題作答。<br>交卷後無法再修改答案，確定提交嗎？`;
  }

  document.getElementById('submitConfirmModal').classList.remove('hidden');
}

function closeSubmitModal() {
  document.getElementById('submitConfirmModal').classList.add('hidden');
}

async function finalizeExamSubmission(statusReason) {
  if (!activeSession.isActive) return;
  activeSession.isActive = false;

  if (activeSession.timerInterval) {
    clearInterval(activeSession.timerInterval);
    activeSession.timerInterval = null;
  }

  document.getElementById('submitConfirmModal').classList.add('hidden');
  document.getElementById('antiCheatModal').classList.add('hidden');

  // 退回一般視窗模式
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
  } catch (e) { }

  // 計算成績 (滿分 100 分，依題數自動配分)
  const totalQ = examData.questions.length;
  let correctCount = 0;
  const answerDetails = {};

  examData.questions.forEach(q => {
    const selected = activeSession.answers[q.id] || '';
    const isCorrect = selected.toUpperCase() === q.answer.toUpperCase();
    if (isCorrect) correctCount++;
    answerDetails[q.id] = {
      selected: selected || '未作答',
      correctAnswer: q.answer,
      isCorrect
    };
  });

  const rawScore = totalQ > 0 ? (correctCount / totalQ) * 100 : 0;
  const finalScore = Number(rawScore.toFixed(1));

  const timeSpentSeconds = Math.max(
    1,
    Math.round((Date.now() - activeSession.startTime) / 1000)
  );
  const formattedTimeSpent = formatDuration(timeSpentSeconds);
  const submittedAt = formatDateTime(new Date());

  const record = {
    id: 'SUB_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    examTitle: examData.title,
    examDate: examData.examDate,
    studentName: activeSession.studentName,
    studentId: activeSession.studentId,
    studentEmail: activeSession.studentEmail,
    score: finalScore,
    correctCount,
    totalQuestions: totalQ,
    answeredCount: Object.keys(activeSession.answers).length,
    warningCount: activeSession.warningCount,
    status: statusReason,
    timeSpentSeconds,
    timeSpentFormatted: formattedTimeSpent,
    submittedAt,
    emailSentAt: '',
    answerDetails
  };

  submissions.unshift(record);
  localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));

  // 恢復頂部導覽列
  document.getElementById('examLiveBar').classList.add('hidden');
  document.getElementById('roleSwitcher').classList.remove('hidden');

  // 顯示交卷完成憑證畫面 (不顯示分數與標準答案)
  document.getElementById('studentQuizView').classList.add('hidden');
  document.getElementById('studentResultView').classList.remove('hidden');

  const iconWrap = document.getElementById('resultIconWrap');
  const titleEl = document.getElementById('resultTitle');
  const subEl = document.getElementById('resultSubtitle');

  if (statusReason.includes('強制終止')) {
    iconWrap.classList.add('forced');
    titleEl.textContent = '⚠️ 測驗已遭系統強制終止並自動交卷';
    subEl.textContent = '因系統偵測到您離開作答畫面達 2 次，已依防作弊規定立即終止測驗並鎖定目前已填寫之答案。考試結束後將寄送成績單至您的信箱。';
  } else {
    iconWrap.classList.remove('forced');
    titleEl.textContent = '已完成測驗交卷';
    subEl.textContent = '您的作答紀錄已成功儲存。為維護考試公平性，現場不公佈分數與標準答案，考官將於考試結束後寄送成績單至您的電子信箱。';
  }

  document.getElementById('receiptExamTitle').textContent = record.examTitle;
  document.getElementById('receiptName').textContent = record.studentName;
  document.getElementById('receiptStudentId').textContent = record.studentId;
  document.getElementById('receiptEmail').textContent = record.studentEmail || '-';
  document.getElementById('receiptAnswered').textContent = `${record.answeredCount} / ${record.totalQuestions} 題`;
  document.getElementById('receiptTimeSpent').textContent = record.timeSpentFormatted;
  document.getElementById('receiptStatus').textContent = record.status;
  document.getElementById('receiptTimestamp').textContent = record.submittedAt;

  const cloudStatusEl = document.getElementById('receiptCloudStatus');
  if (getActiveGasUrl()) {
    cloudStatusEl.textContent = '🔄 正在同步上傳...';
    const cloudRes = await postToCloud({
      action: 'submitExam',
      record: record
    });
    if (cloudRes && (cloudRes.status === 'success' || cloudRes.status === 'duplicate')) {
      cloudStatusEl.innerHTML = '<span style="color:var(--primary);">✅ 已成功上傳</span>';
    } else {
      cloudStatusEl.innerHTML = '<span style="color:var(--accent-dark);">⚠️ 已儲存於本機 (雲端連線逾時)</span>';
    }
  } else {
    cloudStatusEl.textContent = '已儲存於本機瀏覽器';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetToStudentHome() {
  document.getElementById('studentStartForm').reset();
  document.getElementById('studentLoginError').classList.add('hidden');
  document.getElementById('studentResultView').classList.add('hidden');
  renderStudentLoginMeta();
}

// ==================== 考官端驗證與管理後台 ====================
function handlePinLogin(event) {
  event.preventDefault();
  const pinInput = document.getElementById('examinerPinInput').value.trim();
  const errBox = document.getElementById('pinErrorMsg');

  if (pinInput === EXAMINER_PIN) {
    isExaminerAuthenticated = true;
    errBox.classList.add('hidden');
    showExaminerDashboard();
    if (getActiveGasUrl()) {
      syncStateFromCloud(true);
    }
  } else {
    errBox.classList.remove('hidden');
    document.getElementById('examinerPinInput').select();
  }
}

function logoutExaminer() {
  isExaminerAuthenticated = false;
  document.getElementById('examinerDashboardView').classList.add('hidden');
  document.getElementById('examinerPinView').classList.remove('hidden');
  document.getElementById('examinerPinInput').value = '';
}

function showExaminerDashboard() {
  document.getElementById('examinerPinView').classList.add('hidden');
  document.getElementById('examinerDashboardView').classList.remove('hidden');
  refreshExaminerAllViews();
}

function switchExaminerTab(tabId) {
  document.querySelectorAll('.dashboard-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  ['tabQuestions', 'tabScores', 'tabAnalytics', 'tabHistory', 'tabCloud'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== tabId);
  });

  refreshExaminerAllViews();
}

function refreshExaminerAllViews() {
  renderExamControlBanner();
  renderExaminerQuestionTab();
  renderExaminerScoresTab();
  renderExaminerAnalyticsTab();
  renderExaminerHistoryTab();
  updateCloudStatusUI();
}

// ==================== 考官端頁籤 1：考題管理與 Excel 範本匯入 (支援完全空白題庫) ====================
function setupExamMetaAutoSync() {
  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');

  const syncMetaFromInputs = (pushCloud = false) => {
    if (titleInput) examData.title = titleInput.value;
    if (dateInput) examData.examDate = normalizeDateForInput(dateInput.value);
    if (durationInput) {
      const rawVal = durationInput.value.trim();
      examData.durationMinutes = rawVal === '' ? '' : Math.max(1, Number(rawVal) || 60);
    }
    saveExamDataToStorage(pushCloud);
  };

  [titleInput, dateInput, durationInput].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => syncMetaFromInputs(false));
    el.addEventListener('change', () => syncMetaFromInputs(true));
  });
}

function renderExaminerQuestionTab() {
  const qCount = examData.questions.length;
  const pts = getPointsPerQuestion(qCount);

  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');

  if (titleInput && document.activeElement !== titleInput) {
    titleInput.value = examData.title ?? '';
  }
  if (dateInput && document.activeElement !== dateInput) {
    dateInput.value = normalizeDateForInput(examData.examDate ?? '');
  }
  if (durationInput && document.activeElement !== durationInput) {
    durationInput.value = examData.durationMinutes === '' ? '' : (examData.durationMinutes ?? 60);
  }

  document.getElementById('metaValidQCount').textContent = qCount;
  document.getElementById('metaPointsPerQ').textContent = pts;
  document.getElementById('questionTableCount').textContent = qCount;

  const tbody = document.getElementById('questionsTableBody');
  tbody.innerHTML = '';

  if (qCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 24px;">目前題庫為空白（0 題），可從上方匯入 Excel 範本或點擊「➕ 手動新增單選題」</td></tr>`;
    return;
  }

  examData.questions.forEach((q, idx) => {
    const tr = document.createElement('tr');
    const formattedOpts = q.options
      .map(o => `<span class="badge badge-teal" style="margin-right:4px;">${o.key}</span>${escapeHtml(o.text)}`)
      .join('<br>');

    tr.innerHTML = `
      <td><strong>#${idx + 1}</strong></td>
      <td>${escapeHtml(q.question)}</td>
      <td style="font-size: 0.86rem; line-height: 1.7;">${formattedOpts}</td>
      <td><span class="badge badge-amber" style="font-size:0.9rem;">${escapeHtml(q.answer)}</span></td>
      <td>${pts} 分</td>
      <td>
        <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteQuestion(${q.id})">刪除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveExamMetadata(event) {
  event.preventDefault();
  examData.title = document.getElementById('metaExamTitle').value.trim();
  examData.examDate = normalizeDateForInput(document.getElementById('metaExamDate').value.trim());
  const rawDuration = document.getElementById('metaExamDuration').value.trim();
  examData.durationMinutes = rawDuration === '' ? '' : Math.max(1, Number(rawDuration) || 60);

  saveExamDataToStorage(true);
  refreshExaminerAllViews();
  showImportAlert('已成功儲存試卷設定並同步至雲端！', 'success');
}

/**
 * 當考官更換新題庫且當前場次已有考生成績時，貼心詢問是否先將當前場次歸檔至「歷次測驗紀錄」
 */
function promptArchiveBeforeReplacingBank(newExamObj, successMsg) {
  // 保留當前是否開放的狀態（若新題庫為 0 題則自動關閉）
  newExamObj.isExamOpen = newExamObj.questions.length > 0 ? Boolean(examData.isExamOpen) : false;

  if (submissions.length > 0) {
    const shouldArchive = confirm(
      `偵測到目前場次【${examData.title || '未命名測驗'}】已有 ${submissions.length} 位考生的交卷成績！\n\n是否先將這 ${submissions.length} 筆成績自動封存為一筆獨立的「歷次測驗紀錄」，並清空當前場次名單以供新試卷應試？`
    );
    if (shouldArchive) {
      const prevCount = submissions.length;
      createAndSaveHistorySession(`${examData.title || '未命名測驗'} (${examData.examDate || '-'})`, true, newExamObj);
      showImportAlert(`${successMsg}（原場次 ${prevCount} 人成績已自動封存至「歷次測驗紀錄」）`, 'success');
      return;
    }
  }

  examData = newExamObj;
  saveExamDataToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(successMsg, 'success');
}

function deleteQuestion(qId) {
  examData.questions = examData.questions.filter(q => q.id !== qId);
  // 重新編號
  examData.questions.forEach((q, i) => {
    q.id = i + 1;
  });
  // 若題庫已刪空為 0 題，自動將測驗狀態設為關閉
  if (examData.questions.length === 0) {
    examData.isExamOpen = false;
  }
  saveExamDataToStorage(true);
  refreshExaminerAllViews();
}

function clearAllQuestions() {
  const hasQuestions = examData.questions.length > 0;
  const hasMeta = Boolean(examData.title || examData.examDate || examData.durationMinutes !== '');
  if (!hasQuestions && !hasMeta) return;
  if (!confirm('確定要清空目前題庫中的所有題目與上方「當前試卷資訊」嗎？')) return;

  examData.title = '';
  examData.examDate = '';
  examData.durationMinutes = '';
  examData.questions = [];
  examData.isExamOpen = false;

  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');
  if (titleInput) titleInput.value = '';
  if (dateInput) dateInput.value = '';
  if (durationInput) durationInput.value = '';

  saveExamDataToStorage(true);
  refreshExaminerAllViews();
  showImportAlert('已清空所有題目與上方當前試卷資訊（目前題庫為 0 題，測驗已自動設為關閉狀態）。', 'success');
}

function openAddQuestionModal() {
  document.getElementById('addQuestionForm').reset();
  document.getElementById('addQuestionModal').classList.remove('hidden');
}

function closeAddQuestionModal() {
  document.getElementById('addQuestionModal').classList.add('hidden');
}

function handleSaveNewQuestion(event) {
  event.preventDefault();
  const qText = document.getElementById('newQText').value.trim();
  const rawOpts = document.getElementById('newQOptions').value.trim();
  const ans = document.getElementById('newQAnswer').value.trim().toUpperCase();

  const parsedOptions = parseOptionsString(rawOpts);
  if (parsedOptions.length < 2) {
    alert('請輸入至少 2 個選項（每行一個選項）！');
    return;
  }

  const newId = examData.questions.length + 1;
  examData.questions.push({
    id: newId,
    question: qText,
    rawOptions: rawOpts,
    options: parsedOptions,
    answer: ans
  });

  saveExamDataToStorage(true);
  closeAddQuestionModal();
  refreshExaminerAllViews();
  showImportAlert(`已新增第 ${newId} 題，系統已自動重新平均配分並同步雲端！`, 'success');
}

// ==================== Excel 範本匯入與解析 ====================
function setupDragAndDrop() {
  const dropzone = document.getElementById('excelDropzone');
  if (!dropzone) return;

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processExcelFile(e.dataTransfer.files[0]);
    }
  });
}

function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (file) {
    processExcelFile(file);
  }
  event.target.value = '';
}

function processExcelFile(file) {
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: true });
      parseTemplateRows(rows, file.name);
    } catch (err) {
      console.error(err);
      showImportAlert('讀取 Excel 檔案失敗，請確認檔案格式是否為有效的 .xlsx, .xls 或 .csv！', 'danger');
    }
  };
  reader.readAsArrayBuffer(file);
}

function parseTemplateRows(rows, fileName) {
  if (!rows || rows.length === 0) {
    showImportAlert('檔案內容空白或格式不符！', 'danger');
    return;
  }

  const parsedQuestions = [];

  // 範本中第 1~5 列 (index 0~4) 為範例不需要讀取，第 6 列 (index 5) 為空白分隔列，題目從第 7 列 (index 6) 開始讀取
  // 試卷資訊（試卷名稱、考試日期、作答時間）不再讀取匯入檔案，完全保留考官手動輸入的值
  for (let r = 6; r < rows.length; r++) {
    const row = rows[r].map(cell => String(cell ?? '').trim());
    if (row[0] === '範例') continue;

    const qLabelIdx = row.findIndex(cell => cell === '題目');
    if (qLabelIdx !== -1) {
      const questionText = row[qLabelIdx + 1] || '';
      const ansLabelIdx = row.findIndex(cell => cell === '答案');

      let answerText = '';
      if (ansLabelIdx !== -1 && row[ansLabelIdx + 1]) {
        answerText = row[ansLabelIdx + 1];
      }

      const optionLines = [];
      let k = r + 1;
      for (; k < rows.length; k++) {
        const subRow = rows[k].map(cell => String(cell ?? '').trim());
        // 遇到下一題的「題目」列時停止
        if (subRow.includes('題目')) {
          break;
        }
        // 讀取選項文字（位於「題目/選項」標籤右側欄位）
        const optCell = subRow[qLabelIdx + 1] || '';
        if (optCell) {
          optionLines.push(optCell);
        }
        // 讀取答案文字（位於「答案」標籤正下方或右側欄位）
        if (!answerText && ansLabelIdx !== -1) {
          if (subRow[ansLabelIdx]) {
            answerText = subRow[ansLabelIdx];
          } else if (subRow[ansLabelIdx + 1]) {
            answerText = subRow[ansLabelIdx + 1];
          }
        }
      }

      const rawOptionsText = optionLines.join('\n');
      if (questionText && rawOptionsText) {
        const optionsArr = parseOptionsString(rawOptionsText);
        const cleanAns = answerText.replace(/[^A-Za-z]/g, '').toUpperCase() || 'A';

        parsedQuestions.push({
          id: parsedQuestions.length + 1,
          question: questionText,
          rawOptions: rawOptionsText,
          options: optionsArr,
          answer: cleanAns
        });
      }

      r = k - 1;
    }
  }

  const newExamObj = {
    title: examData.title ?? '',
    durationMinutes: examData.durationMinutes === '' ? '' : (examData.durationMinutes ?? 60),
    examDate: normalizeDateForInput(examData.examDate ?? ''),
    isExamOpen: parsedQuestions.length > 0 ? Boolean(examData.isExamOpen) : false,
    questions: parsedQuestions
  };

  const pts = getPointsPerQuestion(parsedQuestions.length);
  const msg = parsedQuestions.length > 0
    ? `成功自「${fileName}」匯入題庫！共讀取 ${parsedQuestions.length} 題有效單選題，每題自動配分 ${pts} 分（試卷資訊請由右側手動設定）。`
    : `已自「${fileName}」讀取題庫（目前有效題目為 0 題）。`;

  promptArchiveBeforeReplacingBank(newExamObj, msg);
}

function parseOptionsString(rawStr) {
  const lines = String(rawStr)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
  const result = [];

  lines.forEach((line, idx) => {
    const match = line.match(/^[\(\[（]?([A-Fa-f])[\)\]）．.、\s]+(.*)$/);
    if (match) {
      result.push({
        key: match[1].toUpperCase(),
        text: match[2].trim()
      });
    } else {
      result.push({
        key: keys[idx] || String(idx + 1),
        text: line
      });
    }
  });

  return result;
}

function showImportAlert(msg, type) {
  const box = document.getElementById('importAlertBox');
  box.textContent = msg;
  box.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
  box.classList.remove('hidden');
}

function downloadSampleExcel() {
  const aoa = [
    ['範例', '題目', '下列何者心律會以「窄的QRS波型」為最常見？', '答案'],
    ['', '選項', '(A) Ventricular tachycardia', 'C'],
    ['', '', '(B) PSVT with aberrant conduction', ''],
    ['', '', '(C) Multifocal atrial tachycardia', ''],
    ['', '', '(D) Torsade de pointes', ''],
    ['', '', '', '']
  ];

  for (let i = 1; i <= 100; i++) {
    const existingQ = examData.questions[i - 1];
    if (existingQ) {
      const opts = existingQ.options || [];
      aoa.push([i, '題目', existingQ.question, '答案']);
      aoa.push(['', '選項', opts[0] ? `(${opts[0].key}) ${opts[0].text}` : '', existingQ.answer]);
      aoa.push(['', '', opts[1] ? `(${opts[1].key}) ${opts[1].text}` : '', '']);
      aoa.push(['', '', opts[2] ? `(${opts[2].key}) ${opts[2].text}` : '', '']);
      aoa.push(['', '', opts[3] ? `(${opts[3].key}) ${opts[3].text}` : '', '']);
    } else {
      aoa.push([i, '題目', '', '答案']);
      aoa.push(['', '選項', '', '']);
      aoa.push(['', '', '', '']);
      aoa.push(['', '', '', '']);
      aoa.push(['', '', '', '']);
    }
    if (i < 100) {
      aoa.push(['', '', '', '']);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 8 },
    { wch: 10 },
    { wch: 65 },
    { wch: 10 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '考題範本');
  XLSX.writeFile(wb, `${examData.title || '線上測驗'}_考題範本.xlsx`);
}

// ==================== 考官端頁籤 2：當前場次成績統計與寄送 Email ====================
function renderExaminerScoresTab() {
  document.getElementById('tabScoreCount').textContent = submissions.length;
  const tbody = document.getElementById('scoresTableBody');
  tbody.innerHTML = '';

  if (submissions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color: var(--text-muted); padding: 28px;">目前場次尚無考生交卷紀錄。</td></tr>`;
    return;
  }

  submissions.forEach(sub => {
    tbody.appendChild(buildSubmissionRowElement(sub, 'CURRENT'));
  });
}

function buildSubmissionRowElement(sub, sessionId) {
  const tr = document.createElement('tr');
  const isForced = String(sub.status || '').includes('強制終止');
  const statusBadge = isForced
    ? `<span class="badge badge-danger">${escapeHtml(sub.status)}</span>`
    : `<span class="badge badge-teal">${escapeHtml(sub.status)}</span>`;

  const warnBadge =
    sub.warningCount > 0
      ? `<span class="badge badge-danger">${sub.warningCount} 次</span>`
      : `<span class="text-muted">0 次</span>`;

  const scoreColor = sub.score >= 60 ? 'var(--primary-darker)' : 'var(--danger)';
  const emailDisplay = sub.studentEmail
    ? `<span style="font-size:0.86rem;">${escapeHtml(sub.studentEmail)}</span>`
    : `<span class="text-muted text-sm">未填寫</span>`;

  const emailStatusBadge = sub.emailSentAt
    ? `<span class="badge badge-teal" title="寄送時間：${escapeHtml(sub.emailSentAt)}">✅ 已寄送</span>`
    : `<span class="badge badge-amber">尚未寄送</span>`;

  tr.innerHTML = `
    <td style="white-space: nowrap;"><strong>${escapeHtml(sub.studentId)}</strong></td>
    <td style="white-space: nowrap; min-width: 90px;">${escapeHtml(sub.studentName)}</td>
    <td class="cell-wrap-email">${emailDisplay}</td>
    <td style="white-space: nowrap;"><strong style="font-size:1.05rem; color:${scoreColor};">${sub.score} 分</strong></td>
    <td style="white-space: nowrap;">${sub.correctCount} / ${sub.totalQuestions} 題</td>
    <td style="white-space: nowrap;">${escapeHtml(sub.timeSpentFormatted)}</td>
    <td style="white-space: nowrap;">${warnBadge}</td>
    <td style="white-space: nowrap;">${statusBadge}</td>
    <td class="cell-wrap-time">${escapeHtml(sub.submittedAt)}</td>
    <td style="white-space: nowrap;">${emailStatusBadge}</td>
    <td style="white-space: nowrap;">
      <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteSingleSubmission('${sub.id}', '${sessionId}')">刪除</button>
    </td>
  `;
  return tr;
}

function getSessionDataById(sessionId) {
  if (sessionId === 'CURRENT') {
    return {
      title: examData.title,
      examDate: examData.examDate,
      questions: examData.questions,
      submissions: submissions
    };
  }
  const hist = historySessions.find(h => h.id === sessionId);
  if (!hist) return null;
  return {
    title: hist.examTitle || hist.sessionTitle,
    examDate: hist.examDate,
    questions: hist.questionsSnapshot || [],
    submissions: hist.submissions || []
  };
}

function viewStudentDetail(sessionId, subId) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj) return;

  const sub = sessionObj.submissions.find(s => s.id === subId);
  if (!sub) return;

  document.getElementById('detailModalTitle').textContent = `${sub.studentName} (${sub.studentId}) - 作答明細 (${sub.score} 分)`;
  const body = document.getElementById('detailModalBody');

  let rowsHtml = '';
  sessionObj.questions.forEach((q, idx) => {
    const d = sub.answerDetails ? sub.answerDetails[q.id] : null;
    const picked = d ? d.selected : '未作答';
    const isCorrect = d ? d.isCorrect : false;
    const badge = isCorrect
      ? `<span class="badge badge-teal">✔ 答對</span>`
      : `<span class="badge badge-danger">✘ 答錯</span>`;

    rowsHtml += `
      <tr>
        <td>第 ${idx + 1} 題</td>
        <td>${escapeHtml(q.question)}</td>
        <td><strong>${escapeHtml(picked)}</strong></td>
        <td><strong style="color:var(--primary);">${escapeHtml(q.answer)}</strong></td>
        <td>${badge}</td>
      </tr>
    `;
  });

  body.innerHTML = `
    <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <span class="text-muted text-sm">電子信箱：<strong>${escapeHtml(sub.studentEmail || '未填寫')}</strong>｜交卷時間：${escapeHtml(sub.submittedAt)}</span>
      <button type="button" class="btn btn-primary btn-sm" onclick="sendSingleScoreEmail('${sessionId}', '${sub.id}')">📧 寄送此考生成績單 Email</button>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:80px;">題號</th>
          <th>題目</th>
          <th style="width:90px;">考生作答</th>
          <th style="width:90px;">標準答案</th>
          <th style="width:90px;">結果</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  document.getElementById('studentDetailModal').classList.remove('hidden');
}

function closeStudentDetailModal() {
  document.getElementById('studentDetailModal').classList.add('hidden');
}

function deleteSingleSubmission(subId, sessionId = 'CURRENT') {
  if (!confirm('確定要刪除此位考生的作答紀錄嗎？（刪除後該學號即可重新應試）')) return;
  if (sessionId === 'CURRENT') {
    submissions = submissions.filter(s => s.id !== subId);
    saveSubmissionsToStorage(true);
    refreshExaminerAllViews();
  } else {
    const hist = historySessions.find(h => h.id === sessionId);
    if (hist && Array.isArray(hist.submissions)) {
      hist.submissions = hist.submissions.filter(s => s.id !== subId);
      hist.stats = calculateStatsForList(hist.submissions);
      saveHistorySessionsToStorage(true);
      refreshExaminerAllViews();
      if (currentViewingHistoryId === sessionId) {
        viewHistorySessionDetail(sessionId);
      }
    }
  }
}

function clearAllSubmissions() {
  if (submissions.length === 0) return;
  if (!confirm('確定要清空「當前場次」所有考生的成績紀錄嗎？（若需保存紀錄，建議先點選「結束本場測驗並歸檔至歷史紀錄」）')) return;
  submissions = [];
  saveSubmissionsToStorage(true);
  refreshExaminerAllViews();
}

// ==================== 考後寄送成績單 Email 功能 (不含考題與作答明細) ====================
function buildPlainTextScoreEmail(sub, sessionObj) {
  const passText = Number(sub.score) >= 60 ? '及格' : '未達及格標準(60分)';
  const examDateStr = sub.examDate || sessionObj.examDate || '-';
  const lines = [
    `${sub.studentName} (${sub.studentId}) 您好：`,
    ``,
    `以下為您在【${sub.examTitle || sessionObj.title || '線上筆試測驗'}】的筆試測驗成績通知單：`,
    `----------------------------------------`,
    `• 考生姓名：${sub.studentName}`,
    `• 學號/座號：${sub.studentId}`,
    `• 考試日期：${examDateStr}`,
    `• 測驗總分：${sub.score} 分 (${passText})`,
    `• 答對題數：${sub.correctCount} / ${sub.totalQuestions} 題`,
    `• 作答耗時：${sub.timeSpentFormatted}`,
    `• 交卷狀態：${sub.status}`,
    `• 交卷時間：${sub.submittedAt}`,
    `----------------------------------------`,
    `（為維護題庫保密原則，本成績單不附載考題與作答明細）`,
    ``,
    `線上筆試測驗系統 敬上`
  ];
  return lines.join('\n');
}

async function sendSingleScoreEmail(sessionId, subId) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj) return;
  const sub = sessionObj.submissions.find(s => s.id === subId);
  if (!sub) return;

  if (!sub.studentEmail || !sub.studentEmail.includes('@')) {
    const manualEmail = prompt(`考生「${sub.studentName}」尚未填寫有效的 Email，請輸入要寄送的電子郵件信箱：`, '');
    if (!manualEmail || !manualEmail.includes('@')) return;
    sub.studentEmail = manualEmail.trim();
  }

  await dispatchScoreEmails(sessionId, [sub], sessionObj);
}

async function sendAllScoresEmail(sessionId, silentIfNone = false) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj || sessionObj.submissions.length === 0) {
    if (!silentIfNone) alert('目前沒有考生成績可供寄送！');
    return;
  }

  const validSubs = sessionObj.submissions.filter(s => s.studentEmail && s.studentEmail.includes('@'));
  if (validSubs.length === 0) {
    if (!silentIfNone) alert('本場次考生皆未填寫有效的電子郵件 (Email)！');
    return;
  }

  if (!silentIfNone) {
    if (!confirm(`確定要寄送成績通知信給本場次共 ${validSubs.length} 位考生嗎？\n（信件僅含個人測驗總分與作答統計摘要，不包含考題與作答明細）`)) {
      return;
    }
  }

  await dispatchScoreEmails(sessionId, validSubs, sessionObj);
}

async function dispatchScoreEmails(sessionId, recipients, sessionObj) {
  const gasUrl = getActiveGasUrl();
  const nowStr = formatDateTime(new Date());

  // 寄信資料僅傳遞成績摘要欄位，不傳遞考題與作答明細 (answerDetails)
  const sanitizedRecipients = recipients.map(r => ({
    id: r.id,
    examTitle: r.examTitle,
    examDate: r.examDate,
    studentName: r.studentName,
    studentId: r.studentId,
    studentEmail: r.studentEmail,
    score: r.score,
    correctCount: r.correctCount,
    totalQuestions: r.totalQuestions,
    timeSpentFormatted: r.timeSpentFormatted,
    status: r.status,
    submittedAt: r.submittedAt
  }));

  // 模式 1：若已綁定 Google Apps Script 雲端後端，直接透過 Google MailApp 雲端背景自動發送 HTML 成績信
  if (gasUrl) {
    showToast(`📧 正在透過 Google 雲端自動寄送 ${sanitizedRecipients.length} 封考生成績通知信...`);
    const res = await postToCloud({
      action: 'sendScoreEmails',
      sessionId: sessionId,
      recipients: sanitizedRecipients,
      examData: {
        title: sessionObj.title,
        examDate: sessionObj.examDate
      }
    });

    if (res && res.status === 'success') {
      const sentIds = res.sentIds || recipients.map(r => r.id);
      const sentTime = res.emailSentAt || nowStr;

      sessionObj.submissions.forEach(s => {
        if (sentIds.includes(s.id)) {
          s.emailSentAt = sentTime;
        }
      });

      if (sessionId === 'CURRENT') {
        saveSubmissionsToStorage(false);
      } else {
        saveHistorySessionsToStorage(false);
      }
      refreshExaminerAllViews();
      if (currentViewingHistoryId) {
        viewHistorySessionDetail(currentViewingHistoryId);
      }

      if (res.errors && res.errors.length > 0) {
        alert(`已寄出 ${res.sentCount} 封信，但有部分信箱發送失敗：\n${res.errors.join('\n')}`);
      } else {
        showToast(`✅ 成功寄出 ${res.sentCount} 封 HTML 考生成績單 Email！`);
      }
      return;
    } else {
      showToast('⚠️ 雲端寄信未回應，將切換為本機郵件發送模式');
    }
  }

  // 模式 2：本機未綁定雲端時，使用 mailto: 喚起系統郵件客戶端寄發完整成績單
  if (recipients.length === 1) {
    const sub = recipients[0];
    const subject = `【測驗成績通知】${sub.examTitle || sessionObj.title || '線上筆試測驗'} - ${sub.studentName} (${sub.studentId})`;
    const body = buildPlainTextScoreEmail(sub, sessionObj);
    sub.emailSentAt = nowStr;

    if (sessionId === 'CURRENT') {
      saveSubmissionsToStorage(false);
    } else {
      saveHistorySessionsToStorage(false);
    }
    refreshExaminerAllViews();
    if (currentViewingHistoryId) {
      viewHistorySessionDetail(currentViewingHistoryId);
    }

    window.location.href = `mailto:${encodeURIComponent(sub.studentEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    showToast(`✉️ 已開啟「${sub.studentName}」的成績通知信件視窗！`);
  } else {
    const bccList = recipients.map(r => r.studentEmail).join(',');
    const subject = `【測驗成績公佈】${sessionObj.title || '線上筆試測驗'} (${sessionObj.examDate || '-'}) 個人成績總表`;
    const summaryLines = [
      `各位考生您好，【${sessionObj.title || '線上筆試測驗'}】測驗已結束，成績摘要如下：`,
      `----------------------------------------`
    ];
    recipients.forEach(r => {
      summaryLines.push(`• ${r.studentName} (${r.studentId})：${r.score} 分 (答對 ${r.correctCount}/${r.totalQuestions} 題)`);
      r.emailSentAt = nowStr;
    });
    summaryLines.push(
      `----------------------------------------`,
      `💡 考官提示：若於「☁️ 雲端連線與寄信設定」綁定 Google Apps Script，系統即可自動為每位考生獨立寄發專屬 HTML 個人成績單！`
    );

    if (sessionId === 'CURRENT') {
      saveSubmissionsToStorage(false);
    } else {
      saveHistorySessionsToStorage(false);
    }
    refreshExaminerAllViews();
    if (currentViewingHistoryId) {
      viewHistorySessionDetail(currentViewingHistoryId);
    }

    window.location.href = `mailto:?bcc=${encodeURIComponent(bccList)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summaryLines.join('\n'))}`;
    showToast(`✉️ 已標記寄送狀態並開啟批次成績通知郵件（若綁定雲端即可全自動背景獨立發信）`);
  }
}

// ==================== 將每一次測驗結果獨立成一筆歷史紀錄 (頁籤 4) ====================
function openArchiveSessionModal() {
  if (submissions.length === 0) {
    alert('目前場次尚無任何考生交卷紀錄，請待考生交卷後再進行結算歸檔！');
    return;
  }

  document.getElementById('archiveStudentCount').textContent = submissions.length;
  const defaultTitle = `${examData.title || '線上筆試測驗'} (${examData.examDate || formatDateTime(new Date()).slice(0, 10)})`;
  document.getElementById('archiveSessionTitle').value = defaultTitle;
  document.getElementById('archiveClearCurrent').checked = true;
  document.getElementById('archiveSessionModal').classList.remove('hidden');
}

function closeArchiveSessionModal() {
  document.getElementById('archiveSessionModal').classList.add('hidden');
}

async function confirmArchiveCurrentSession(event) {
  event.preventDefault();
  const customTitle = document.getElementById('archiveSessionTitle').value.trim() || examData.title || '未命名測驗';
  const clearCurrent = document.getElementById('archiveClearCurrent').checked;

  closeArchiveSessionModal();

  // 歸檔時一併關閉當前測驗開放狀態
  examData.isExamOpen = false;
  saveExamDataToStorage(true);

  const newHist = createAndSaveHistorySession(customTitle, clearCurrent, null);
  switchExaminerTab('tabHistory');
  viewHistorySessionDetail(newHist.id);
  showToast(`🗂️ 已結束測驗並將「${customTitle}」獨立封存至歷次測驗紀錄！`);
}

function createAndSaveHistorySession(sessionTitle, clearCurrent = true, newExamData = null) {
  const stats = calculateStatsForList(submissions);
  const archivedRecord = {
    id: 'HIST_' + Date.now(),
    sessionTitle: sessionTitle || examData.title || '未命名測驗',
    examTitle: examData.title || '未命名測驗',
    examDate: examData.examDate || '-',
    durationMinutes: examData.durationMinutes,
    archivedAt: formatDateTime(new Date()),
    questionsSnapshot: JSON.parse(JSON.stringify(examData.questions)),
    submissions: JSON.parse(JSON.stringify(submissions)),
    stats: stats
  };

  historySessions.unshift(archivedRecord);
  localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));

  if (clearCurrent) {
    submissions = [];
    localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
  }

  if (newExamData) {
    examData = newExamData;
    localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  }

  if (getActiveGasUrl()) {
    postToCloud({
      action: 'archiveSession',
      historyRecord: archivedRecord,
      clearCurrent: clearCurrent,
      newExamData: newExamData || examData
    });
  }

  refreshExaminerAllViews();
  return archivedRecord;
}

function renderExaminerHistoryTab() {
  const countEl = document.getElementById('tabHistoryCount');
  if (countEl) countEl.textContent = historySessions.length;

  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (historySessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color: var(--text-muted); padding: 28px;">目前尚無封存的歷次測驗紀錄。於每次考試結束後點擊「📌 結束本場測驗並歸檔至歷史紀錄」，即可將每一次測驗結果獨立保存於此！</td></tr>`;
    return;
  }

  historySessions.forEach((hist, idx) => {
    const st = hist.stats || calculateStatsForList(hist.submissions || []);
    const qLen = hist.questionsSnapshot ? hist.questionsSnapshot.length : 0;
    const subLen = hist.submissions ? hist.submissions.length : 0;

    const tr = document.createElement('tr');
    if (currentViewingHistoryId === hist.id) {
      tr.style.background = 'var(--primary-tint)';
    }

    tr.innerHTML = `
      <td>
        <strong>#${historySessions.length - idx}</strong>
        <div class="text-muted text-sm">${escapeHtml(hist.archivedAt)}</div>
      </td>
      <td><strong>${escapeHtml(hist.sessionTitle || hist.examTitle)}</strong></td>
      <td>${escapeHtml(hist.examDate || '-')}</td>
      <td>${qLen} 題</td>
      <td><strong>${subLen} 人</strong></td>
      <td><strong style="color:var(--primary);">${st.mean} 分</strong></td>
      <td><strong style="color:var(--accent-dark);">${st.median} 分</strong></td>
      <td>${st.stdDev}</td>
      <td><span class="badge ${st.passRate >= 60 ? 'badge-teal' : 'badge-danger'}">${st.passRate}%</span></td>
      <td>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-sm" onclick="viewHistorySessionDetail('${hist.id}')">🔍 檢視明細與分析</button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="exportScoresToExcel('${hist.id}')">📥 匯出 Excel</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="sendAllScoresEmail('${hist.id}')">📧 寄送成績信</button>
          <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteHistorySession('${hist.id}')">刪除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function viewHistorySessionDetail(histId) {
  const hist = historySessions.find(h => h.id === histId);
  if (!hist) return;

  currentViewingHistoryId = histId;
  renderExaminerHistoryTab();

  const detailCard = document.getElementById('historySessionDetailCard');
  detailCard.classList.remove('hidden');

  const subs = hist.submissions || [];
  const questions = hist.questionsSnapshot || [];
  const st = calculateStatsForList(subs);

  document.getElementById('histDetailTitle').textContent = hist.sessionTitle || hist.examTitle;
  document.getElementById('histDetailMeta').textContent = `考試日期：${hist.examDate || '-'} ｜ 歸檔時間：${hist.archivedAt} ｜ 題數：${questions.length} 題`;

  document.getElementById('btnHistSendAllEmail').onclick = () => sendAllScoresEmail(hist.id);
  document.getElementById('btnHistExportExcel').onclick = () => exportScoresToExcel(hist.id);

  document.getElementById('histStatTotal').textContent = `${subs.length} 人`;
  document.getElementById('histStatForced').textContent = `強制終止：${st.forcedCount} 人`;
  document.getElementById('histStatMean').textContent = `${st.mean} 分`;
  document.getElementById('histStatStdDev').textContent = `標準差：${st.stdDev}`;
  document.getElementById('histStatMedian').textContent = `${st.median} 分`;
  document.getElementById('histStatPassRate').textContent = `及格率 (≥60分)：${st.passRate}%`;
  document.getElementById('histStatMaxMin').textContent = subs.length > 0 ? `${st.max} / ${st.min}` : '- / -';

  renderErrorRankingIntoContainer(
    document.getElementById('histErrorRankingList'),
    questions,
    subs
  );
  renderDistributionIntoContainer(
    document.getElementById('histDistributionChart'),
    subs
  );

  const tbody = document.getElementById('histScoresTableBody');
  tbody.innerHTML = '';
  subs.forEach(sub => {
    tbody.appendChild(buildSubmissionRowElement(sub, hist.id));
  });

  detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeHistorySessionDetail() {
  currentViewingHistoryId = null;
  document.getElementById('historySessionDetailCard').classList.add('hidden');
  renderExaminerHistoryTab();
}

function deleteHistorySession(histId) {
  if (!confirm('確定要永久刪除此筆歷史測驗紀錄嗎？此操作無法復原！')) return;
  historySessions = historySessions.filter(h => h.id !== histId);
  if (currentViewingHistoryId === histId) {
    closeHistorySessionDetail();
  }
  saveHistorySessionsToStorage(true);
  refreshExaminerAllViews();
}

// ==================== 匯出考試成績與錯題統計成 Excel (.xlsx) ====================
function exportScoresToExcel(sessionId = 'CURRENT') {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj || sessionObj.submissions.length === 0) {
    alert('尚無考生成績可供匯出！');
    return;
  }

  const targetSubs = sessionObj.submissions;
  const targetQuestions = sessionObj.questions;

  const headers = [
    '學號',
    '考生姓名',
    '電子郵件 (Email)',
    '總分',
    '答對題數',
    '總題數',
    '作答耗時',
    '防作弊警告次數',
    '交卷狀態',
    '交卷時間',
    '成績信狀態'
  ];
  targetQuestions.forEach((q, idx) => {
    headers.push(`第${idx + 1}題(正解:${q.answer})`);
  });

  const scoreRows = [headers];
  targetSubs.forEach(sub => {
    const row = [
      sub.studentId,
      sub.studentName,
      sub.studentEmail || '',
      sub.score,
      sub.correctCount,
      sub.totalQuestions,
      sub.timeSpentFormatted,
      sub.warningCount,
      sub.status,
      sub.submittedAt,
      sub.emailSentAt ? `已寄送 (${sub.emailSentAt})` : '尚未寄送'
    ];
    targetQuestions.forEach(q => {
      const d = sub.answerDetails ? sub.answerDetails[q.id] : null;
      row.push(d ? d.selected : '未作答');
    });
    scoreRows.push(row);
  });

  const stats = calculateStatsForList(targetSubs);
  scoreRows.push([]);
  scoreRows.push(['【統計摘要】', '應試人數', targetSubs.length, '平均分數', stats.mean, '中位數', stats.median, '標準差', stats.stdDev, '及格率', `${stats.passRate}%`]);

  const wsScores = XLSX.utils.aoa_to_sheet(scoreRows);

  const qAnalysisHeaders = ['題號', '題目內容', '標準答案', '總作答人數', '答錯人數', '答錯率(%)', '最常誤選選項'];
  const qAnalysisRows = [qAnalysisHeaders];
  const itemStats = calculateQuestionErrorStatsForList(targetQuestions, targetSubs);

  itemStats.forEach(item => {
    qAnalysisRows.push([
      `第 ${item.index} 題`,
      item.question,
      item.answerDisplay || item.answer,
      item.totalAttempts,
      item.wrongCount,
      `${item.errorRate}%`,
      item.topWrongOption || '無'
    ]);
  });

  const wsAnalysis = XLSX.utils.aoa_to_sheet(qAnalysisRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsScores, '考生成績總表');
  XLSX.utils.book_append_sheet(wb, wsAnalysis, '題目答錯率分析');

  XLSX.writeFile(wb, `${sessionObj.title || '線上測驗'}_成績統計報表.xlsx`);
}

// ==================== 考官端頁籤 3：測驗結果分析功能 ====================
function calculateStatsForList(targetSubmissions) {
  const count = targetSubmissions.length;
  if (count === 0) {
    return { mean: 0, median: 0, stdDev: 0, max: 0, min: 0, passRate: 0, forcedCount: 0 };
  }

  const scores = targetSubmissions.map(s => Number(s.score)).sort((a, b) => a - b);
  const sum = scores.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / count).toFixed(1));

  let median = 0;
  const mid = Math.floor(count / 2);
  if (count % 2 === 0) {
    median = Number(((scores[mid - 1] + scores[mid]) / 2).toFixed(1));
  } else {
    median = Number(scores[mid].toFixed(1));
  }

  const variance = scores.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count;
  const stdDev = Number(Math.sqrt(variance).toFixed(1));

  const max = scores[scores.length - 1];
  const min = scores[0];
  const passCount = scores.filter(s => s >= 60).length;
  const passRate = Math.round((passCount / count) * 100);
  const forcedCount = targetSubmissions.filter(s => String(s.status || '').includes('強制終止')).length;

  return { mean, median, stdDev, max, min, passRate, forcedCount };
}

function calculateQuestionErrorStatsForList(questionsList, targetSubmissions) {
  const totalStudents = targetSubmissions.length;
  const list = (questionsList || []).map((q, idx) => {
    let wrongCount = 0;
    const wrongOptionTally = {};

    targetSubmissions.forEach(sub => {
      const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
      const picked = detail ? detail.selected : '未作答';
      const isCorrect = detail ? detail.isCorrect : false;

      if (!isCorrect) {
        wrongCount++;
        wrongOptionTally[picked] = (wrongOptionTally[picked] || 0) + 1;
      }
    });

    let topWrongOption = '';
    let topWrongOptionCount = 0;
    Object.entries(wrongOptionTally).forEach(([optKey, cnt]) => {
      if (cnt > topWrongOptionCount) {
        topWrongOptionCount = cnt;
        topWrongOption = `${optKey} (${cnt}人)`;
      }
    });

    const errorRate = totalStudents > 0 ? Number(((wrongCount / totalStudents) * 100).toFixed(1)) : 0;
    const matchedOpt = (q.options || []).find(
      o => String(o.key).toUpperCase() === String(q.answer).toUpperCase()
    );
    const answerDisplay = matchedOpt && matchedOpt.text
      ? `(${q.answer}) ${matchedOpt.text}`
      : q.answer;

    return {
      id: q.id,
      index: idx + 1,
      question: q.question,
      answer: q.answer,
      answerDisplay,
      totalAttempts: totalStudents,
      wrongCount,
      errorRate,
      topWrongOption
    };
  });

  return list.sort((a, b) => b.errorRate - a.errorRate);
}

function renderErrorRankingIntoContainer(container, questionsList, targetSubmissions) {
  if (!container) return;
  container.innerHTML = '';

  if (targetSubmissions.length === 0 || !questionsList || questionsList.length === 0) {
    container.innerHTML = `<p class="text-muted" style="padding:16px 0;">尚無考生作答數據可供分析。</p>`;
    return;
  }

  const itemStats = calculateQuestionErrorStatsForList(questionsList, targetSubmissions);
  itemStats.forEach((item, rankIdx) => {
    const badgeClass =
      item.errorRate >= 50 ? 'badge-danger' : item.errorRate >= 25 ? 'badge-amber' : 'badge-teal';

    const div = document.createElement('div');
    div.className = 'rank-item';
    div.innerHTML = `
      <div class="rank-item-top">
        <div class="rank-q-title">
          <span class="badge badge-teal" style="margin-right:6px;">排名 #${rankIdx + 1}</span>
          <strong>第 ${item.index} 題：</strong>${escapeHtml(item.question)}
        </div>
        <span class="rank-err-badge ${badgeClass}">答錯率 ${item.errorRate}%</span>
      </div>
      <div class="bar-bg">
        <div class="bar-fill-danger" style="width: ${item.errorRate}%"></div>
      </div>
      <div class="rank-meta">
        <span>正確答案：<strong>${escapeHtml(item.answerDisplay || item.answer)}</strong></span>
        <span>答錯人數：<strong>${item.wrongCount} / ${item.totalAttempts} 人</strong></span>
        <span>最常誤選：<strong>${escapeHtml(item.topWrongOption || '無')}</strong></span>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderDistributionIntoContainer(container, targetSubmissions) {
  if (!container) return;
  const buckets = [
    { label: '90 - 100 分', min: 90, max: 100, count: 0 },
    { label: '80 - 89 分', min: 80, max: 89.99, count: 0 },
    { label: '70 - 79 分', min: 70, max: 79.99, count: 0 },
    { label: '60 - 69 分', min: 60, max: 69.99, count: 0 },
    { label: '未滿 60 分', min: 0, max: 59.99, count: 0 }
  ];

  targetSubmissions.forEach(s => {
    const sc = Number(s.score);
    const b = buckets.find(bk => sc >= bk.min && sc <= bk.max);
    if (b) b.count++;
  });

  container.innerHTML = buckets
    .map(b => {
      const pct = targetSubmissions.length > 0 ? Math.round((b.count / targetSubmissions.length) * 100) : 0;
      return `
        <div class="dist-row">
          <strong>${b.label}</strong>
          <div class="dist-bar-wrap">
            <div class="dist-bar-fill" style="width: ${pct}%"></div>
          </div>
          <span style="text-align:right;">${b.count} 人 (${pct}%)</span>
        </div>
      `;
    })
    .join('');
}

function renderExaminerAnalyticsTab() {
  const stats = calculateStatsForList(submissions);

  document.getElementById('statTotalStudents').innerHTML = `${submissions.length} <small>人</small>`;
  document.getElementById('statForcedCount').textContent = `防作弊強制終止：${stats.forcedCount} 人`;
  document.getElementById('statAverageScore').innerHTML = `${stats.mean} <small>分</small>`;
  document.getElementById('statStdDev').textContent = `標準差：${stats.stdDev}`;
  document.getElementById('statMedianScore').innerHTML = `${stats.median} <small>分</small>`;
  document.getElementById('statPassRate').textContent = `及格率 (≥60分)：${stats.passRate}%`;
  document.getElementById('statMaxMinScore').textContent =
    submissions.length > 0 ? `${stats.max} / ${stats.min}` : '- / -';

  renderErrorRankingIntoContainer(
    document.getElementById('errorRateRankingList'),
    examData.questions,
    submissions
  );

  renderDistributionIntoContainer(
    document.getElementById('scoreDistributionChart'),
    submissions
  );
}

// ==================== 一鍵複製 Google Apps Script 後端程式碼 (Code.gs) ====================
async function copyGasBackendCode() {
  try {
    const res = await fetch('gas/Code.gs');
    if (res.ok) {
      const code = await res.text();
      await navigator.clipboard.writeText(code);
      showToast('✅ 已複製 Google Apps Script (Code.gs) 完整程式碼！請貼至 Google 試算表的 Apps Script 編輯器。');
      return;
    }
  } catch (e) { }
  alert('請開啟專案目錄下的 gas/Code.gs 檔案複製內容。');
}

// ==================== 工具函式 ====================
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m} 分 ${s} 秒`;
}

function formatDateTime(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const mm = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
