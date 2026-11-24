/**
 * 線上筆試測驗系統 - 核心邏輯 (app.js) — 雲端多人連線與歷史場次版 (方案 B)
 * 功能包含：
 * 1. 雲端多人同步 (Google Apps Script + GitHub Pages)：跨網路多人同時連線應試、QR Code 專屬應試連結、即時同步題庫與交卷紀錄
 * 2. 考生端 (#007979 主題)：僅在考官「開始測驗」開放試卷期間顯示內容（試卷關閉時完全不顯示任何內容）、姓名/編號/Email 登入、防重複應試、亂數題目、防作弊監控
 * 3. 考官端 (#750000 主題)：PIN 碼安全加密驗證、開始/結束測驗開關控制、Excel 範本匯入（支援空白題庫）、考後寄送考生成績單 Email、每次測驗獨立歸檔為歷史紀錄、錯題分析
 */

// 若有固定部署的預設 Google Apps Script 網址（格式為 https://script.google.com/macros/s/.../exec），請設定於此處：
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwNwyDJqY7p5YDcJL_84KTS2rf2WSUWlR6NSJDjvTX1KVMG9rpvp5pDPmShQcUYp2heGQ/exec';

// Cloudflare Turnstile (Verify Visitors Without CAPTCHA) 公開 Site Key
const TURNSTILE_SITE_KEY = '0x4AAAAAAGOOrfOOEWchQ394';

// 嚴格驗證 Google Apps Script 網頁應用程式網址白名單格式 (防範惡意第三方後端劫持)
const GAS_URL_REGEX = /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/;

const STORAGE_KEYS = {
  EXAM_DATA: 'online_exam_bank_v1',
  SUBMISSIONS: 'online_exam_submissions_v1',
  HISTORY_SESSIONS: 'online_exam_history_v1',
  GAS_URL: 'online_exam_gas_url_v1',
  EXAM_LIBRARY: 'online_exam_library_v1',
  EXAMINER_PIN_HASH: 'online_exam_pin_hash_v1',
  CLIENT_DEVICE_ID: 'online_exam_device_id_v1'
};

// 安全加固：前端不再存放任何公開預設 PIN 碼雜湊或靜態 Salt，考官驗證一律由後端 Script Properties 權威核驗
function getOrCreateClientDeviceId() {
  try {
    let cid = localStorage.getItem(STORAGE_KEYS.CLIENT_DEVICE_ID);
    if (cid && /^cid_[a-z0-9]{16,40}$/.test(cid)) return cid;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let rand = 'cid_';
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i++) rand += chars[bytes[i] % chars.length];
    } else {
      for (let i = 0; i < 24; i++) rand += chars[Math.floor(Math.random() * chars.length)];
    }
    localStorage.setItem(STORAGE_KEYS.CLIENT_DEVICE_ID, rand);
    return rand;
  } catch (e) {
    return 'cid_fallback_client';
  }
}

// 本地端產生 QR Code Data URL (不將含隨機測驗 Token 的網址傳送至任何外部第三方伺服器)
function generateLocalQrDataUrl(text, cellSize = 6, margin = 3) {
  if (!text || typeof window.qrcode !== 'function') return '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createDataURL(cellSize, margin);
  } catch (e) {
    console.warn('Local QR generation failed:', e);
    return '';
  }
}

// 預設題庫 (支援空白題庫與預設關閉試卷狀態)
const DEFAULT_EXAM_DATA = {
  id: 'exam_default',
  title: '未命名測驗',
  durationMinutes: 60,
  examDate: '',
  isExamOpen: false,
  openedAt: null,
  activeExamToken: null, // 模式 A：{ token: 'tk_xxx', createdAt: 0, expiresAt: 0, durationMinutes: 180 }
  questions: []
};

// 系統狀態
let examData = loadExamData();
let examLibrary = loadExamLibrary();
let currentSelectedExamId = (examData && examData.id && examLibrary.some(e => e.id === examData.id))
  ? examData.id
  : (examLibrary[0] ? examLibrary[0].id : 'exam_default');
let submissions = loadSubmissions();
let historySessions = loadHistorySessions();
let isExaminerAuthenticated = false;
let currentExaminerAuthToken = '';
let currentExaminerProfile = null; // { userId, username, displayName, organization, role, status }
let adminUsersCache = [];
let currentExaminerAuthMode = 'login'; // 'login' | 'register' | 'forgot'
let lastCloudUpdatedAt = '';
let lastCloudSyncExaminer = false;
let currentActiveExaminerTab = 'tabQuestions';
let cloudPollIntervalMs = 10000;
let currentViewingHistoryId = null;
let cloudPollTimer = null;
let examinerLiveTimerInterval = null;
let lastExamDataSaveAt = 0;
let lastExamLibrarySaveAt = 0;
let isGasUrlUnlockedBySecret = false;
let gasSecretClickCount = 0;
let gasSecretClickResetTimer = null;
let editingQuestionId = null;
let currentExamTokenStatus = 'unknown'; // 'valid' | 'expired' | 'invalid' | 'not_generated'
let examTokenCountdownTimer = null;

// 考官 PIN 碼登入防護狀態
let pinFailedAttempts = 0;
let pinLockoutRemaining = 0;
let pinLockoutTimer = null;
let isPinLoggingIn = false;
let turnstileWidgetId = null;
let currentTurnstileToken = '';
let turnstileLoadPollTimer = null;

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
let activeExamStatusTimer = null;
let isCheckingExamStatus = false;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  await initCloudUrlFromQueryOrDefault();
  updateCloudStatusUI();
  setupExamMetaAutoSync();
  setupDragAndDrop();
  setupAntiCheatListeners();
  startExamTokenCountdown();
  setupExaminerIdleDetector();

  // 解析 URL 是否含有隨機測驗 Token 參數或指定考生角色
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();
  const roleParam = (urlParams.get('role') || '').trim();

  if (urlToken || roleParam === 'student') {
    // 透過隨機測驗連結或指定考生端進入：進入考生端
    switchRole('student');
    if (urlToken) {
      await validateCurrentExamToken(urlToken);
    }
  } else {
    // 直連根網址 (預設畫面)：直接顯示考官端登入畫面 (PIN 碼驗證卡片)
    switchRole('examiner');
  }

  // 跨分頁即時同步考官試卷開關狀態 (當考官結束測驗時，作答中考生分頁毫秒級自動強制交卷)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.EXAM_DATA && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        const isNowOpen = Boolean(parsed.isExamOpen);
        examData.isExamOpen = isNowOpen;
        if (parsed.activeExamToken) {
          examData.activeExamToken = parsed.activeExamToken;
          updateExamLinkTabUI();
        }
        if (!isNowOpen) {
          if (activeSession && activeSession.isActive) {
            finalizeExamSubmission('測驗結束強制交卷');
          } else {
            renderStudentLoginMeta();
          }
        } else {
          if (!activeSession.isActive) {
            renderStudentLoginMeta();
          }
        }
      } catch (err) { }
    }
  });

  // 若已綁定雲端網址，啟動時自動從雲端拉取最新題庫、開放狀態與成績紀錄
  if (getActiveGasUrl()) {
    await syncStateFromCloud(true);
    startCloudPolling();
  }
});

// ==================== 雲端多人連線與同步 ====================
function isValidGasUrl(url) {
  return GAS_URL_REGEX.test(String(url || '').trim());
}

function getActiveGasUrl() {
  const stored = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
  if (isValidGasUrl(stored)) return stored;
  const def = (DEFAULT_GAS_URL || '').trim();
  if (isValidGasUrl(def)) return def;
  return '';
}

async function initCloudUrlFromQueryOrDefault() {
  // 僅允許套用程式碼中經過驗證的 DEFAULT_GAS_URL，不再接受 URL ?api= 參數或公開第三方 KV/ntfy 綁定，防範惡意後端劫持 (C2)
  const stored = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
  if (stored && !isValidGasUrl(stored)) {
    localStorage.removeItem(STORAGE_KEYS.GAS_URL);
  }
  if (DEFAULT_GAS_URL && isValidGasUrl(DEFAULT_GAS_URL) && !localStorage.getItem(STORAGE_KEYS.GAS_URL)) {
    localStorage.setItem(STORAGE_KEYS.GAS_URL, DEFAULT_GAS_URL.trim());
  }
}

function getUrlExamToken() {
  const urlParams = new URLSearchParams(window.location.search);
  return (urlParams.get('token') || '').trim();
}

function buildStudentShareUrl() {
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();

  // 將當前有效的隨機測驗 Token 帶入作答連結中（不再附加 ?api= 參數）
  if (examData && examData.activeExamToken && examData.activeExamToken.token) {
    params.set('token', examData.activeExamToken.token);
  } else {
    params.set('role', 'student');
  }

  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

function updateCloudStatusUI() {
  const gasUrl = getActiveGasUrl();
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const urlInput = document.getElementById('gasWebAppUrlInput');
  const btnSaveGasUrl = document.getElementById('btnSaveGasUrl');
  const lockBadge = document.getElementById('gasLockStatusBadge');
  const shareInput = document.getElementById('studentShareUrlInput');
  const qrImg = document.getElementById('studentQrImage');
  const qrHint = document.getElementById('qrCodeHint');

  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = gasUrl;
  }

  // Google 雲端資料庫設定已列為管理員專屬，無須再透過點擊 10 次雲朵解鎖，管理員可直接編輯與儲存
  if (urlInput) {
    urlInput.readOnly = false;
    urlInput.disabled = false;
    urlInput.classList.remove('input-locked');
  }
  if (btnSaveGasUrl) {
    btnSaveGasUrl.disabled = false;
  }
  if (lockBadge) {
    if (!gasUrl) {
      lockBadge.classList.add('hidden');
    } else {
      lockBadge.textContent = '✅ 已綁定';
      lockBadge.className = 'badge badge-teal';
      lockBadge.classList.remove('hidden');
    }
  }

  if (gasUrl) {
    if (dot) dot.classList.remove('offline');
    if (text) text.textContent = '已連線';
    const shareUrl = buildStudentShareUrl();
    if (shareInput) shareInput.value = shareUrl;
    if (qrImg && qrHint) {
      const qrDataUrl = generateLocalQrDataUrl(shareUrl);
      if (qrDataUrl) {
        qrImg.src = qrDataUrl;
        qrImg.classList.remove('hidden');
      }
      qrHint.innerHTML = '<span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="openStandaloneQrPage()">🔍 點選 QR Code 可開啟獨立頁面單獨顯示</span>';
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
  updateExamLinkTabUI();
}

function handleGasCloudIconClick() {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl || isGasUrlUnlockedBySecret) return;

  gasSecretClickCount += 1;
  if (gasSecretClickResetTimer) {
    clearTimeout(gasSecretClickResetTimer);
  }
  gasSecretClickResetTimer = setTimeout(() => {
    gasSecretClickCount = 0;
  }, 4000);

  if (gasSecretClickCount >= 10) {
    gasSecretClickCount = 0;
    isGasUrlUnlockedBySecret = true;
    updateCloudStatusUI();
    const urlInput = document.getElementById('gasWebAppUrlInput');
    if (urlInput) {
      urlInput.focus();
      urlInput.select();
    }
    showToast('🔓 已開啟 Google Apps Script 網址欄位編輯權限！');
  }
}

function handleCloudPillClick() {
  if (activeSession.isActive) return;
  if (isExaminerAuthenticated) {
    switchRole('examiner');
    switchExaminerTab('tabSettings');
  } else {
    const gasUrl = getActiveGasUrl();
    if (gasUrl) {
      syncStateFromCloud(false);
    } else {
      showToast('💡 請切換至「考官端」➔「系統設定」綁定 Google 雲端試算表');
    }
  }
}

function adjustCloudPollInterval(intervalMs) {
  if (cloudPollIntervalMs === intervalMs && cloudPollTimer) return;
  cloudPollIntervalMs = intervalMs;
  startCloudPolling();
}

function startCloudPolling() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    // 僅在非作答進行中且已設定雲端時背景靜默同步
    if (!activeSession.isActive && getActiveGasUrl()) {
      syncStateFromCloud(true);
    }
  }, cloudPollIntervalMs);
}

// 效能優化：分頁隱藏時降頻至 3 分鐘，切回前台時立即檢查並恢復 10 秒
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    adjustCloudPollInterval(180000);
  } else {
    // 若為考官已登入狀態，檢查是否已閒置超過 30 分鐘 (特別針對行動裝置喚醒/切換 App)
    checkExaminerIdleTimeout();
    adjustCloudPollInterval(10000);
    if (!activeSession.isActive && getActiveGasUrl()) {
      syncStateFromCloud(true);
    } else if (activeSession.isActive) {
      // 考生作答中切回前台時，立即檢查一次測驗是否已被考官結束作答
      if (!examData.isExamOpen) {
        finalizeExamSubmission('測驗結束強制交卷');
      } else {
        const gasUrl = getActiveGasUrl();
        if (gasUrl) {
          fetch(`${gasUrl}?action=checkState&_t=${Date.now()}`)
            .then(res => res.json())
            .then(json => {
              if (json && json.status === 'success' && json.isExamOpen === false) {
                examData.isExamOpen = false;
                if (activeSession.isActive) {
                  finalizeExamSubmission('測驗結束強制交卷');
                }
              }
            })
            .catch(() => { });
        }
      }
    }
  }
});

async function syncStateFromCloud(silent = true, force = false) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    if (!silent) {
      showToast('⚠️ 尚未設定 Google Apps Script 雲端網址，目前為本機儲存模式');
    }
    return false;
  }

  if (!silent) {
    showToast('🔄 正在從雲端資料庫同步最新試卷資訊...');
  }

  try {
    let json = null;
    if (isExaminerAuthenticated && currentExaminerAuthToken) {
      // 考官模式：一律走 POST 傳遞 Session Token，絕不將憑證放進 GET URL Query String (C3)
      json = await postToCloud({
        action: 'getExamState'
      });
      if (json && json.status === 'unauthorized') {
        logoutExaminer('session_expired');
        return false;
      }
    } else {
      // 考生模式：附帶 URL 上的隨機測驗 Token 向後端驗證並取得試卷
      const urlToken = getUrlExamToken();
      const examTokenParam = urlToken ? `&examToken=${encodeURIComponent(urlToken)}` : '';
      const res = await fetch(`${gasUrl}?action=getExamState${examTokenParam}&_t=${Date.now()}`);
      json = await res.json();
    }
    if (json && json.status === 'success') {
      // 效能優化：若背景靜默輪詢時雲端 updatedAt 毫無變更且考官授權身分未切換，直接跳過重繪以節省 CPU
      if (silent && !force && json.updatedAt && json.updatedAt === lastCloudUpdatedAt && lastCloudSyncExaminer === isExaminerAuthenticated) {
        updateCloudStatusUI();
        return true;
      }
      if (json.updatedAt) {
        lastCloudUpdatedAt = json.updatedAt;
      }
      const roleJustUpgraded = isExaminerAuthenticated && !lastCloudSyncExaminer;
      lastCloudSyncExaminer = isExaminerAuthenticated;
      if (json.userProfile && typeof json.userProfile === 'object') {
        currentExaminerProfile = json.userProfile;
      }

      // 讀取試卷庫：M6 考官僅顯示自己上傳的試卷 (管理員為全部)，允許空陣列覆寫舊快取
      const cloudLibrary = (json.isExaminer === true && Array.isArray(json.examLibrary))
        ? json.examLibrary
        : ((Array.isArray(json.examLibrary) && json.examLibrary.length > 0)
          ? json.examLibrary
          : (json.examData && Array.isArray(json.examData.examLibrary) && json.examData.examLibrary.length > 0
            ? json.examData.examLibrary
            : null));

      // 當考官已登入後台或剛異動過試卷庫時，背景靜默輪詢 (silent=true) 不覆蓋本機試卷庫，避免新匯入或手動編輯內容被雲端舊狀態覆蓋
      const shouldSyncExamLibrary = !silent || force || roleJustUpgraded || (!isExaminerAuthenticated && (Date.now() - lastExamLibrarySaveAt > 15000));
      if (shouldSyncExamLibrary && cloudLibrary) {
        examLibrary = cloudLibrary;
        localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(examLibrary));
        if (!currentSelectedExamId || !examLibrary.some(e => e.id === currentSelectedExamId)) {
          currentSelectedExamId = examLibrary[0] ? examLibrary[0].id : '';
        }
      }

      // 當考官已登入後台或剛修改過試卷設定時，背景輪詢 (silent=true) 不覆蓋本機 examData，避免手動修改的「當前試卷資訊」跳回舊範本內容
      const shouldSyncExamData = !silent || force || roleJustUpgraded || (!isExaminerAuthenticated && (Date.now() - lastExamDataSaveAt > 15000));
      if (shouldSyncExamData && json.examData && Array.isArray(json.examData.questions)) {
        const localAnswerMap = {};
        if (examData && Array.isArray(examData.questions)) {
          examData.questions.forEach(q => {
            if (q && q.id && q.answer !== undefined) localAnswerMap[q.id] = q.answer;
          });
        }
        const matchedLibExam = Array.isArray(examLibrary)
          ? examLibrary.find(e => e && e.id === (json.examData.id || 'exam_default'))
          : null;
        if (matchedLibExam && Array.isArray(matchedLibExam.questions)) {
          matchedLibExam.questions.forEach(q => {
            if (q && q.id && q.answer !== undefined && localAnswerMap[q.id] === undefined) {
              localAnswerMap[q.id] = q.answer;
            }
          });
        }

        const mergedQuestions = json.examData.questions.map(q => {
          if (q && q.answer === undefined && localAnswerMap[q.id] !== undefined) {
            return Object.assign({}, q, { answer: localAnswerMap[q.id] });
          }
          return q;
        });

        examData = {
          id: json.examData.id || 'exam_default',
          title: json.examData.title ?? '',
          durationMinutes: json.examData.durationMinutes === '' ? '' : (Number(json.examData.durationMinutes) || 60),
          examDate: normalizeDateForInput(json.examData.examDate ?? ''),
          isExamOpen: Boolean(json.examData.isExamOpen),
          openedAt: json.examData.openedAt ? Number(json.examData.openedAt) : (json.examData.isExamOpen ? (examData.openedAt || Date.now()) : null),
          ownerId: json.examData.ownerId || '',
          ownerName: json.examData.ownerName || '',
          startedByUserId: json.examData.startedByUserId || '',
          startedByName: json.examData.startedByName || '',
          activeExamToken: json.examData.activeExamToken || examData.activeExamToken || null,
          questions: mergedQuestions
        };
        // 若為考官授權同步，或題目含有完整答案，才寫入本機儲存，避免考生模式無答案資料覆蓋單機版題庫
        if (json.isExaminer !== false || mergedQuestions.every(q => q && q.answer !== undefined)) {
          localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
        }
      }
      if (json.isExaminer !== false && Array.isArray(json.submissions)) {
        submissions = json.submissions;
        localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
      }
      if (json.isExaminer !== false && Array.isArray(json.historySessions)) {
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

async function postToCloud(payload, maxRetries = 2) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) return null;

  // 自動附加考官伺服器端 Session Token，確保後端管理操作通過身分審查
  if (isExaminerAuthenticated && currentExaminerAuthToken && !payload.sessionToken) {
    payload.sessionToken = currentExaminerAuthToken;
  }

  // 併發退避重試機制：當後端鎖服務繁忙 (status: 'busy') 時自動延遲重試，防止交卷遺漏
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data && data.status === 'busy' && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        continue;
      }
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        continue;
      }
      console.error('Post to cloud error:', err);
      return null;
    }
  }
  return null;
}

async function saveGasUrlConfig() {
  const input = document.getElementById('gasWebAppUrlInput');
  const val = input ? input.value.trim() : '';

  if (!val) {
    localStorage.removeItem(STORAGE_KEYS.GAS_URL);
    isGasUrlUnlockedBySecret = false;
    gasSecretClickCount = 0;
    updateCloudStatusUI();
    showToast('⚪ 已解除綁定並切換回本機儲存模式');
    return;
  }

  if (!isValidGasUrl(val)) {
    alert('請輸入正確的 Google Apps Script 網頁應用程式網址（格式須符合 https://script.google.com/macros/s/<部署ID>/exec）！');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.GAS_URL, val);
  isGasUrlUnlockedBySecret = false;
  gasSecretClickCount = 0;
  updateCloudStatusUI();
  startCloudPolling();

  showToast('🔌 正在驗證並綁定雲端資料庫...');
  const ok = await syncStateFromCloud(false);
  if (ok && isExaminerAuthenticated) {
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
  if (!isValidGasUrl(url)) {
    alert('網址格式不正確！僅允許標準 Google Apps Script 網址（https://script.google.com/macros/s/<部署ID>/exec）。');
    return;
  }

  showToast('🔌 正在測試連線至 Google Apps Script...');
  try {
    const res = await fetch(`${url}?action=ping&_t=${Date.now()}`);
    const json = await res.json();
    if (json && json.status === 'success') {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, url);
      updateCloudStatusUI();

      if (json.hasExamLibrarySupport) {
        showToast('✅ 連線成功！雲端資料庫運作正常！');
      } else {
        alert(
          '✅ 連線成功！雲端資料庫運作正常。\n\n💡 系統偵測到試算表 Apps Script 目前處於舊版部署（已自動啟用狀態庫雙軌同步，試卷庫跨裝置切換不受影響）。\n若您希望在 Google 試算表中看到獨立的【試卷庫資料】工作表，請於 Apps Script「管理部署作業」編輯時選擇「建立新版本」重新部署。'
        );
      }
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
  showToast('⬆️ 正在將本機試卷庫、當前試卷、成績與歷史紀錄完整推送至雲端...');
  await postToCloud({ action: 'saveExamData', examData, examLibrary });
  await postToCloud({ action: 'saveExamLibrary', examLibrary });
  await postToCloud({ action: 'syncSubmissions', examData, submissions });
  const res = await postToCloud({ action: 'syncHistory', historySessions });
  if (res && res.status === 'success') {
    showToast('✅ 已將本機所有試卷庫、當前試卷、成績與歷史紀錄同步至雲端資料庫！');
  } else {
    showToast('⚠️ 推送完成，若部分資料未更新請檢查網路連線');
  }
}

// ==================== 隨機測驗連結 (作答時間+15分鐘有效，覆蓋即失效) ====================
function generateRandomExamToken() {
  if (!window.crypto || !window.crypto.getRandomValues) {
    throw new Error('瀏覽器不支援密碼學安全亂數產生器 (Web Crypto API)，無法生成安全的測驗連結！');
  }
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  // 產生 24 字元高熵密碼學隨機 Token (約 124 bits 熵值)
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) {
    rand += chars[bytes[i] % chars.length];
  }
  return 'tk_' + rand;
}

function isCurrentUserAdmin() {
  return Boolean(currentExaminerProfile && currentExaminerProfile.role === 'admin');
}

function getCurrentExaminerUserId() {
  return (currentExaminerProfile && currentExaminerProfile.userId) ? String(currentExaminerProfile.userId) : '';
}

function canCurrentUserModifyExam(exam) {
  if (!exam) return false;
  if (isCurrentUserAdmin()) return true;
  const myId = getCurrentExaminerUserId();
  if (!myId) return true;
  if (!exam.ownerId) return true;
  return exam.ownerId === myId;
}

function canCurrentUserManageActiveSession() {
  if (isCurrentUserAdmin()) return true;
  const myId = getCurrentExaminerUserId();
  if (!myId) return true;
  const activeOwner = (examData && (examData.startedByUserId || examData.ownerId)) || '';
  if (!activeOwner) return true;
  return activeOwner === myId;
}

function canCurrentUserManageActiveToken() {
  if (isCurrentUserAdmin()) return true;
  const myId = getCurrentExaminerUserId();
  if (!myId) return true;
  const tok = examData && examData.activeExamToken;
  if (!tok || !tok.token || !isExamTokenActive(tok)) return true;
  const creator = tok.createdByUserId || (examData && examData.ownerId) || '';
  if (!creator) return true;
  return creator === myId;
}

function isExamTokenActive(tokenObj) {
  if (!tokenObj || !tokenObj.token) return false;
  return Date.now() < Number(tokenObj.expiresAt || 0);
}

async function handleGenerateExamToken() {
  if (examData.isExamOpen) {
    alert('⛔ 測驗正在進行中！\n\n' + '若要重新生成連結，請先【結束當前的測驗】。');
    return;
  }

  // 限制 3：一般考官不可覆蓋他人產生的有效測驗連結
  if (examData.activeExamToken && isExamTokenActive(examData.activeExamToken)) {
    if (!canCurrentUserManageActiveToken()) {
      const creatorName = examData.activeExamToken.createdByName || examData.ownerName || '其他考官';
      alert(`⛔ 權限限制：目前的測驗連結是由考官【${creatorName}】所產生，且尚在有效期限內，您無法覆蓋或停用他人的測驗連結！`);
      return;
    }
    const confirmRegen = confirm(
      '⚠️ 目前已有使用中的隨機測驗連結！\n\n' +
      '若重新生成，先前發送給考生的舊連結將【立即失效作廢】。\n\n' +
      '確定要重新生成新的測驗連結嗎？'
    );
    if (!confirmRegen) return;
  }

  const now = Date.now();
  const token = generateRandomExamToken();
  // 將測驗連結有效時間為「該試卷作答時間 + 15 分鐘」，避免測驗端被長期佔用
  const examDurationMins = Math.max(1, Number(examData.durationMinutes) || 60);
  const durationMinutes = examDurationMins + 15;
  const durationMs = durationMinutes * 60 * 1000;

  examData.activeExamToken = {
    token: token,
    createdAt: now,
    expiresAt: now + durationMs,
    durationMinutes: durationMinutes,
    createdByUserId: getCurrentExaminerUserId() || 'SYSTEM_ADMIN',
    createdByName: (currentExaminerProfile && currentExaminerProfile.displayName) || '考官'
  };

  saveExamDataToStorage(true);
  updateExamLinkTabUI();
  showToast(`🎲 已成功生成隨機測驗連結（有效時間 ${durationMinutes} 分鐘！`);
}

async function handleRevokeExamToken() {
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 目前並無有效的測驗連結可停用！');
    return;
  }

  // 限制 3 & 4：一般考官不可停用他人產生的測驗連結，亦不可結束他人正在進行中的測驗
  if (!canCurrentUserManageActiveToken() || (examData.isExamOpen && !canCurrentUserManageActiveSession())) {
    const ownerLabel = (examData.activeExamToken && examData.activeExamToken.createdByName) || examData.startedByName || examData.ownerName || '其他考官';
    alert(`⛔ 權限限制：此測驗連結或進行中測驗是由考官【${ownerLabel}】建立，您無法停用他人的測驗連結或結束他人的測驗！`);
    return;
  }

  const isExamRunning = Boolean(examData.isExamOpen);
  const confirmMessage = isExamRunning
    ? '⚠️ 測驗正在進行中！\n\n' + '停用連結會【立即終止測驗】並強制收卷。\n\n' + '確定要停用測驗連結並結束作答嗎？'
    : '⚠️ 確定要立即停用當前的測驗連結嗎？\n\n' +
    '停用後，當前的測驗連結將【立即失效】！\n' +
    '考生將無法再透過該網址進入作答。\n\n' +
    '確定要執行停用嗎？';

  const confirmRevoke = confirm(confirmMessage);
  if (!confirmRevoke) return;

  examData.activeExamToken = null;
  if (isExamRunning) {
    examData.isExamOpen = false;
    examData.openedAt = null;
    stopExaminerLiveTimer();
  }

  saveExamDataToStorage(true);
  if (isExamRunning) {
    refreshExaminerAllViews();
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
    }
    showToast('🛑 已停用測驗連結並結束當前測驗！');
  } else {
    updateExamLinkTabUI();
    showToast('🛑 已停用所有測驗連結！');
  }
}

function updateExamLinkTabUI() {
  const tokenObj = examData.activeExamToken;
  const statusBadge = document.getElementById('tokenStatusBadge');
  const tokenMetaBox = document.getElementById('tokenMetaBox');
  const tokenCreatorNameEl = document.getElementById('tokenCreatorName');
  const tokenTimeRemainingEl = document.getElementById('tokenTimeRemaining');
  const tokenCreatedAtEl = document.getElementById('tokenCreatedAt');
  const tokenExpiresAtEl = document.getElementById('tokenExpiresAt');
  const tokenRuleDescEl = document.getElementById('tokenDurationRuleDesc');
  const btnGenToken = document.getElementById('btnGenerateExamToken');
  const btnRevokeToken = document.getElementById('btnRevokeExamToken');
  const shareInput = document.getElementById('studentShareUrlInput');
  const qrImg = document.getElementById('studentQrImage');
  const qrHint = document.getElementById('qrCodeHint');

  const examDurMins = Math.max(1, Number(examData.durationMinutes) || 60);
  const totalValidMins = examDurMins + 15;
  if (tokenRuleDescEl) {
    tokenRuleDescEl.innerHTML = `本次測驗可生成一組獨立作答網址，<strong>有效時間為 ${totalValidMins} 分鐘 (自生成起算)</strong>。如再次生成，先前連結將<strong>立即失效作廢</strong>！`;
  }

  const now = Date.now();
  const hasToken = tokenObj && tokenObj.token;
  const isExpired = hasToken && (now > Number(tokenObj.expiresAt || 0));
  const canManageToken = canCurrentUserManageActiveToken();

  if (tokenCreatorNameEl) {
    tokenCreatorNameEl.textContent = (tokenObj && tokenObj.createdByName) ? tokenObj.createdByName : (examData.ownerName || '考官');
  }

  if (!hasToken) {
    if (statusBadge) {
      statusBadge.className = 'badge badge-secondary';
      statusBadge.textContent = '⚪ 尚未生成';
    }
    if (tokenMetaBox) tokenMetaBox.classList.add('hidden');
    if (btnGenToken) {
      btnGenToken.innerHTML = `產生連結`;
      btnGenToken.className = 'btn btn-token-primary';
      btnGenToken.disabled = false;
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke hidden';
      btnRevokeToken.classList.add('hidden');
    }
    if (shareInput) shareInput.value = '';
    if (qrImg) qrImg.classList.add('hidden');
    if (qrHint) qrHint.textContent = '請先點擊上方按鈕生成隨機測驗連結，系統將自動產生專屬作答網址與 QR Code';
    return;
  }

  if (isExpired) {
    if (statusBadge) {
      statusBadge.className = 'badge badge-danger';
      statusBadge.textContent = '🔴 測驗連結已逾期失效';
    }
    if (tokenMetaBox) tokenMetaBox.classList.remove('hidden');
    if (tokenTimeRemainingEl) tokenTimeRemainingEl.innerHTML = '<span style="color:var(--danger); font-weight:700;">已逾期（已失效）</span>';
    if (btnGenToken) {
      btnGenToken.innerHTML = `重新生成測驗連結`;
      btnGenToken.className = 'btn btn-token-primary';
      btnGenToken.disabled = false;
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke hidden';
      btnRevokeToken.classList.add('hidden');
    }
  } else {
    const remSec = Math.max(0, Math.floor((tokenObj.expiresAt - now) / 1000));
    const h = Math.floor(remSec / 3600);
    const m = Math.floor((remSec % 3600) / 60);
    const s = remSec % 60;
    const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    if (statusBadge) {
      statusBadge.className = 'badge badge-teal';
      statusBadge.textContent = `🟢 連結已生成 (剩餘 ${h > 0 ? h + ' 小時 ' : ''}${m} 分鐘有效)`;
    }
    if (tokenMetaBox) tokenMetaBox.classList.remove('hidden');
    if (tokenTimeRemainingEl) tokenTimeRemainingEl.textContent = formatted;
    if (btnGenToken) {
      btnGenToken.innerHTML = canManageToken ? `重新生成測驗連結` : `🔒 他人連結使用中`;
      btnGenToken.className = 'btn btn-token-primary';
      btnGenToken.disabled = !canManageToken;
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke';
      btnRevokeToken.classList.toggle('hidden', !canManageToken);
      btnRevokeToken.disabled = !canManageToken;
    }
  }

  if (tokenCreatedAtEl && tokenObj.createdAt) {
    tokenCreatedAtEl.textContent = formatDateTime(new Date(tokenObj.createdAt));
  }
  if (tokenExpiresAtEl && tokenObj.expiresAt) {
    tokenExpiresAtEl.textContent = formatDateTime(new Date(tokenObj.expiresAt));
  }

  const shareUrl = buildStudentShareUrl();
  if (shareInput) shareInput.value = shareUrl;
  if (qrImg && qrHint) {
    const qrDataUrl = generateLocalQrDataUrl(shareUrl);
    if (qrDataUrl) {
      qrImg.src = qrDataUrl;
      qrImg.classList.remove('hidden');
    }
    qrHint.innerHTML = '<span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="openStandaloneQrPage()">🔍 點選 QR Code 可開啟獨立全螢幕頁面投放大螢幕</span>';
  }
}

function startExamTokenCountdown() {
  if (examTokenCountdownTimer) clearInterval(examTokenCountdownTimer);
  examTokenCountdownTimer = setInterval(() => {
    const tabEl = document.getElementById('tabExamLink');
    if (tabEl && !tabEl.classList.contains('hidden')) {
      updateExamLinkTabUI();
    }
  }, 1000);
}

function showTokenInvalidView(message) {
  currentExamTokenStatus = 'invalid';
  const invalidView = document.getElementById('studentTokenInvalidView');
  const invalidDesc = document.getElementById('studentTokenInvalidDesc');
  const loginView = document.getElementById('studentLoginView');
  const closedView = document.getElementById('studentClosedView');
  const quizView = document.getElementById('studentQuizView');

  if (invalidDesc && message) {
    invalidDesc.innerHTML = message;
  }
  if (invalidView) invalidView.classList.remove('hidden');
  if (loginView) loginView.classList.add('hidden');
  if (closedView) closedView.classList.add('hidden');
  if (quizView) quizView.classList.add('hidden');
}

function hideTokenInvalidView() {
  currentExamTokenStatus = 'valid';
  const invalidView = document.getElementById('studentTokenInvalidView');
  if (invalidView) invalidView.classList.add('hidden');
}

async function validateCurrentExamToken(urlToken) {
  if (!urlToken) {
    showTokenInvalidView('⚠️ 請使用考官提供之專屬測驗連結進入作答！');
    return false;
  }

  const gasUrl = getActiveGasUrl();

  // 1. 若已設定雲端網址，一律由 Google 伺服器進行權威校驗（Fail-Closed：雲端連線失敗時拒絕放行，且後端絕不回傳 Token 本體）
  if (gasUrl) {
    try {
      const res = await fetch(`${gasUrl}?action=checkState&token=${encodeURIComponent(urlToken)}&_t=${Date.now()}`);
      const json = await res.json();
      if (json && json.status === 'success') {
        examData.isExamOpen = Boolean(json.isExamOpen);

        if (json.tokenStatus === 'valid') {
          hideTokenInvalidView();
          renderStudentLoginMeta();
          return true;
        } else if (json.tokenStatus === 'invalid') {
          showTokenInvalidView('⚠️ 此測驗連結已失效！考官已重新生成新連結，先前連結已立即作廢。<br>請向考官索取最新測驗連結！');
          return false;
        } else if (json.tokenStatus === 'expired') {
          showTokenInvalidView('⚠️ 此測驗連結已逾期失效（已超過本場次「試卷作答時間 + 15 分鐘」有效期限）！');
          return false;
        } else {
          showTokenInvalidView('⚠️ 此測驗連結已失效或已遭考官停用！<br>目前無有效之測驗連結，請聯繫考官確認。');
          return false;
        }
      }
    } catch (e) {
      console.warn('雲端校驗 Token 網路失敗:', e);
    }
    showTokenInvalidView('⚠️ 無法連線至雲端測驗伺服器驗證測驗連結，請檢查網路連線並重新整理頁面！');
    return false;
  }

  // 2. 僅在純單機離線模式（未綁定任何 GAS 雲端網址）時，比對本機狀態
  const localToken = examData.activeExamToken;
  if (!localToken || !localToken.token) {
    showTokenInvalidView('⚠️ 此測驗連結已失效或已遭考官停用！<br>目前無有效之測驗連結，請聯繫考官確認。');
    return false;
  }
  if (localToken.token !== urlToken) {
    showTokenInvalidView('⚠️ 此測驗連結已失效！考官已重新生成新連結，先前連結已立即作廢。<br>請向考官索取最新測驗連結！');
    return false;
  }
  if (Date.now() > Number(localToken.expiresAt || 0)) {
    showTokenInvalidView('⚠️ 此測驗連結已逾期失效（已超過本場次「試卷作答時間 + 15 分鐘」有效期限）！');
    return false;
  }

  hideTokenInvalidView();
  renderStudentLoginMeta();
  return true;
}

function copyStudentShareUrl() {
  const shareInput = document.getElementById('studentShareUrlInput');
  if (!shareInput) return;
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 尚未生成測驗連結！請先點擊上方【生成隨機測驗連結】按鈕產生連結。');
    return;
  }
  const url = buildStudentShareUrl();
  shareInput.value = url;
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 已複製考生專屬測驗連結！');
  }).catch(() => {
    shareInput.select();
    document.execCommand('copy');
    showToast('📋 已複製考生專屬測驗連結！');
  });
}

function openStandaloneQrPage() {
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 尚未生成測驗連結！請先點擊上方按鈕生成。');
    return;
  }
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
          id: parsed.id || 'exam_default',
          title: parsed.title ?? '',
          durationMinutes: parsed.durationMinutes === '' ? '' : (Number(parsed.durationMinutes) || 60),
          examDate: normalizeDateForInput(parsed.examDate ?? ''),
          isExamOpen: Boolean(parsed.isExamOpen),
          openedAt: parsed.openedAt ? Number(parsed.openedAt) : (parsed.isExamOpen ? Date.now() : null),
          activeExamToken: parsed.activeExamToken || null,
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
  // 保持 examData 乾淨，不將試卷庫附加於當前測驗設定中
  if (examData && examData.examLibrary) {
    delete examData.examLibrary;
  }
  localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  renderStudentLoginMeta();
  if (isExaminerAuthenticated) {
    renderExamControlBanner();
  }
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'saveExamData',
      examData: examData,
      examLibrary: (typeof examLibrary !== 'undefined' ? examLibrary : [])
    });
  }
}

// ==================== 試卷庫 (Exam Library) 儲存與管理 ====================
function loadExamLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EXAM_LIBRARY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('載入試卷庫失敗:', e);
  }

  // 首次初始化遷移：以當前 examData 作為試卷庫第一份試卷
  const initialId = (typeof examData !== 'undefined' && examData && examData.id) ? examData.id : ('exam_' + Date.now());
  const initialExam = {
    id: initialId,
    title: (typeof examData !== 'undefined' && examData && examData.title) ? examData.title : '預設試卷',
    examDate: (typeof examData !== 'undefined' && examData && examData.examDate) ? examData.examDate : '',
    durationMinutes: (typeof examData !== 'undefined' && examData && examData.durationMinutes !== '') ? examData.durationMinutes : 60,
    questions: (typeof examData !== 'undefined' && examData && Array.isArray(examData.questions)) ? JSON.parse(JSON.stringify(examData.questions)) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const list = [initialExam];
  localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(list));
  return list;
}

function saveExamLibraryToStorage(syncCloud = true) {
  lastExamLibrarySaveAt = Date.now();
  localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(examLibrary));

  // 確保 examData 保持純淨，不存放試卷庫
  if (examData && examData.examLibrary) {
    delete examData.examLibrary;
    localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  }

  if (syncCloud && getActiveGasUrl()) {
    // 試卷庫資料專屬寫入雲端「試卷庫資料」工作表
    postToCloud({
      action: 'saveExamLibrary',
      examLibrary: examLibrary
    }).then(res => {
      if (res && res.status === 'success') {
        console.log('試卷庫已成功同步至「試卷庫資料」工作表');
      } else if (res && res.status === 'error' && String(res.message || '').includes('saveExamLibrary')) {
        // 雲端 Apps Script 網址仍在執行舊版程式碼，無法寫入「試卷庫資料」工作表
        if (!window.__examLibraryOldGasWarned) {
          window.__examLibraryOldGasWarned = true;
          alert(
            '⚠️ 試卷庫未能寫入 Google 試算表！\n\n' +
            '原因：目前綁定的 Apps Script 網址仍在執行「舊版」程式碼（不支援 saveExamLibrary）。\n\n' +
            '請至 Apps Script：部署 > 管理部署作業 > 編輯（鉛筆）> 版本選「建立新版本」> 部署。\n' +
            '（請勿使用「新增部署作業」，那會產生新網址，系統仍會連到舊網址）'
          );
        }
      } else if (!res) {
        console.warn('試卷庫同步至雲端失敗（無回應或網路錯誤）');
      }
    }).catch(err => {
      console.error('儲存試卷庫專屬工作表失敗:', err);
    });
  }
}

function getCurrentSelectedExam() {
  const pool = isCurrentUserAdmin()
    ? examLibrary
    : examLibrary.filter(e => canCurrentUserModifyExam(e));
  let exam = pool.find(e => e.id === currentSelectedExamId);
  if (!exam) {
    exam = pool[0] || null;
    if (exam) currentSelectedExamId = exam.id;
  }
  return exam;
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
    if (btnStudent) btnStudent.classList.add('active');
    if (btnExaminer) btnExaminer.classList.remove('active');
    if (studentSec) studentSec.classList.remove('hidden');
    if (examinerSec) examinerSec.classList.add('hidden');
    renderStudentLoginMeta();
  } else {
    document.body.classList.add('examiner-mode');
    if (btnExaminer) btnExaminer.classList.add('active');
    if (btnStudent) btnStudent.classList.remove('active');
    if (studentSec) studentSec.classList.add('hidden');
    if (examinerSec) examinerSec.classList.remove('hidden');

    if (isExaminerAuthenticated) {
      showExaminerDashboard();
    } else {
      const pinView = document.getElementById('examinerPinView');
      const dashView = document.getElementById('examinerDashboardView');
      const pinInput = document.getElementById('examinerPinInput');
      const pinErr = document.getElementById('pinErrorMsg');
      const pinLoading = document.getElementById('pinLoadingBar');
      const pinBtn = document.getElementById('pinSubmitBtn');
      if (pinView) pinView.classList.remove('hidden');
      if (dashView) dashView.classList.add('hidden');
      if (pinInput) {
        pinInput.value = '';
        if (pinLockoutRemaining <= 0) pinInput.disabled = false;
      }
      if (pinErr && !pinErr.classList.contains('alert-warning')) pinErr.classList.add('hidden');
      if (pinLoading) pinLoading.classList.add('hidden');
      if (pinBtn && pinLockoutRemaining <= 0) pinBtn.disabled = false;
      initOrResetExaminerTurnstile();
      if (pinInput && pinLockoutRemaining <= 0) setTimeout(() => pinInput.focus(), 100);
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

  const canManageSession = canCurrentUserManageActiveSession();
  const starterLabel = examData.startedByName || examData.ownerName || '考官';

  if (examData.isExamOpen) {
    banner.classList.add('is-open');
    badge.className = 'exam-status-indicator open';
    badge.textContent = '測驗中';
    desc.textContent = `試卷【${examData.title || '未命名測驗'}】已開放作答（開考考官：${starterLabel}）！`;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnStop.disabled = !canManageSession;
    btnStop.textContent = canManageSession ? '結束作答' : `🔒 ${starterLabel} 測驗中 (無法結束他人測驗)`;
    startExaminerLiveTimer();
  } else {
    banner.classList.remove('is-open');
    badge.className = 'exam-status-indicator closed';
    badge.textContent = '無正在進行中的測驗';
    desc.textContent = '目前試卷為關閉狀態，考生端將不會看到任何內容。';
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    btnStart.disabled = false;
    stopExaminerLiveTimer();
  }
}

// 考官端即時正數計時器 (開放作答即開始計時，距結束前5分鐘紅底提醒，超時不停止繼續計時，結束作答才歸零隱藏)
function startExaminerLiveTimer() {
  if (!examData.isExamOpen) {
    stopExaminerLiveTimer();
    return;
  }
  if (!examData.openedAt) {
    examData.openedAt = Date.now();
  }
  updateExaminerLiveTimerDisplay();
  if (!examinerLiveTimerInterval) {
    examinerLiveTimerInterval = setInterval(updateExaminerLiveTimerDisplay, 1000);
  }
}

function stopExaminerLiveTimer() {
  if (examinerLiveTimerInterval) {
    clearInterval(examinerLiveTimerInterval);
    examinerLiveTimerInterval = null;
  }
  const timerEl = document.getElementById('examinerLiveTimer');
  const displayEl = document.getElementById('examinerTimerDisplay');
  const overdueTag = document.getElementById('examinerTimerOverdueBadge');
  if (timerEl) {
    timerEl.classList.add('hidden');
    timerEl.classList.remove('timer-warning');
  }
  if (displayEl) {
    displayEl.textContent = '00:00';
  }
  if (overdueTag) {
    overdueTag.classList.add('hidden');
  }
}

function updateExaminerLiveTimerDisplay() {
  const timerEl = document.getElementById('examinerLiveTimer');
  const displayEl = document.getElementById('examinerTimerDisplay');
  const overdueTag = document.getElementById('examinerTimerOverdueBadge');
  if (!timerEl || !displayEl) return;

  if (!examData.isExamOpen || !examData.openedAt) {
    stopExaminerLiveTimer();
    return;
  }

  timerEl.classList.remove('hidden');

  const now = Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - Number(examData.openedAt)) / 1000));
  const hrs = Math.floor(elapsedSec / 3600);
  const mins = Math.floor((elapsedSec % 3600) / 60);
  const secs = elapsedSec % 60;

  const formatted = hrs > 0
    ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  displayEl.textContent = formatted;

  // 計算警示門檻 (設定作答時間前 5 分鐘)
  const durationMins = Number(examData.durationMinutes) || 60;
  const targetSec = durationMins * 60;
  const warningSec = Math.max(0, targetSec - 5 * 60);

  // 快到達作答時間前 5 分鐘改為紅色底色提醒；超時依然不停止計時 (紅底繼續跑)
  if (elapsedSec >= warningSec) {
    timerEl.classList.add('timer-warning');
  } else {
    timerEl.classList.remove('timer-warning');
  }

  // 超過設定作答時間時顯示「已逾時」標記
  if (overdueTag) {
    if (elapsedSec >= targetSec) {
      overdueTag.classList.remove('hidden');
    } else {
      overdueTag.classList.add('hidden');
    }
  }
}

function setExamOpenStatus(isOpen) {
  if (isOpen) {
    // 若已有他人正在進行測驗，阻擋開考
    if (examData.isExamOpen && !canCurrentUserManageActiveSession()) {
      const starterLabel = examData.startedByName || examData.ownerName || '其他考官';
      alert(`⛔ 測驗進行中：目前正由考官【${starterLabel}】進行測驗中，其餘人員無法開考！`);
      return;
    }

    const currentExam = getCurrentSelectedExam();
    const targetExam = currentExam || examData;
    if (!canCurrentUserModifyExam(targetExam)) {
      alert(`⛔ 權限限制：試卷【${targetExam.title || '未命名試卷'}】是由考官【${targetExam.ownerName || '其他考官'}】上傳，您僅能使用自己上傳的試卷開考！`);
      return;
    }

    if (!targetExam || !targetExam.questions || targetExam.questions.length === 0) {
      alert('目前試卷中沒有任何題目（0 題），請先匯入考題或手動新增題目後再開始測驗！');
      return;
    }

    const openNow = Date.now();
    const myId = getCurrentExaminerUserId() || 'SYSTEM_ADMIN';
    const myName = (currentExaminerProfile && currentExaminerProfile.displayName) || '考官';
    // 若當前選中的試卷與目前活動的 examData 不同，確認套用選中的試卷
    if (currentExam && examData.id !== currentExam.id) {
      const confirmSwitch = confirm(`確定要將目前選中的試卷【${currentExam.title}】（共 ${currentExam.questions.length} 題）設為本次測驗試卷並開放作答嗎？`);
      if (!confirmSwitch) return;
      examData = {
        id: currentExam.id,
        title: currentExam.title,
        examDate: currentExam.examDate,
        durationMinutes: currentExam.durationMinutes,
        isExamOpen: true,
        openedAt: openNow,
        ownerId: currentExam.ownerId || myId,
        ownerName: currentExam.ownerName || myName,
        startedByUserId: myId,
        startedByName: myName,
        questions: JSON.parse(JSON.stringify(currentExam.questions || []))
      };
    } else {
      examData.isExamOpen = true;
      examData.openedAt = openNow;
      examData.startedByUserId = myId;
      examData.startedByName = myName;
      if (!examData.ownerId) examData.ownerId = myId;
      if (!examData.ownerName) examData.ownerName = myName;
    }

    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    showToast(`🟢 已開始測驗！試卷【${examData.title || '未命名測驗'}】現已開放作答。`);
  } else {
    // 限制 4：一般考官不可結束他人正在進行中的測驗
    if (!canCurrentUserManageActiveSession()) {
      const starterLabel = examData.startedByName || examData.ownerName || '其他考官';
      alert(`⛔ 權限限制：目前的測驗是由考官【${starterLabel}】開放，您無法結束他人正在進行中的測驗！`);
      return;
    }

    // 防誤觸確認視窗：結束作答並收卷確認
    const isConfirmed = confirm('🔔 是否確定要結束作答並收卷？\n\n（結束後試卷將關閉，所有尚未交卷的考生將一律強制交卷）');
    if (!isConfirmed) return;

    examData.isExamOpen = false;
    examData.openedAt = null;
    stopExaminerLiveTimer();
    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    // 當考官將測驗設定為結束作答後，若當前有尚未交卷之考生，一律強制交卷
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
    }
    showToast('🔴 已結束測驗並關閉試卷！');
  }
}

// ==================== 考生端流程 (試卷關閉時顯示「目前非測驗時間」) ====================
function renderStudentLoginMeta() {
  const closedView = document.getElementById('studentClosedView');
  const loginView = document.getElementById('studentLoginView');
  const quizView = document.getElementById('studentQuizView');
  const resultView = document.getElementById('studentResultView');

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();

  // 若非考官且未持有隨機測驗連結，顯示失效提示並阻絕考生畫面
  if (!urlToken && !isExaminerAuthenticated) {
    showTokenInvalidView('⚠️ 請使用考官提供之測驗連結進入作答！');
    return;
  }

  // 若 Token 狀態已判定為無效且非考官，維持顯示失效畫面
  if (currentExamTokenStatus === 'invalid' && !isExaminerAuthenticated) {
    return;
  }

  // 若測驗卷已為關閉狀態
  if (!examData.isExamOpen) {
    // 若考生正在作答中，一律立即強制交卷
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
      return;
    }
    const isInResult = resultView && !resultView.classList.contains('hidden');
    if (loginView) loginView.classList.add('hidden');
    if (quizView) quizView.classList.add('hidden');
    if (closedView) {
      closedView.classList.toggle('hidden', isInResult);
    }
    return;
  }

  const isInQuizOrResult =
    activeSession.isActive ||
    (quizView && !quizView.classList.contains('hidden')) ||
    (resultView && !resultView.classList.contains('hidden'));

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

  if (!nameInput || !emailInput) {
    showLoginError('請完整填寫考生姓名與電子郵件 (Email)！');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
    showLoginError('請輸入格式正確的電子郵件 (Email) 信箱！');
    return;
  }

  // 開考前校驗隨機測驗 Token 時效
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();
  if (!urlToken) {
    showLoginError('缺少有效隨機測驗憑證，請透過考官提供的測驗連結開啟！');
    return;
  }
  const isTokenValid = await validateCurrentExamToken(urlToken);
  if (!isTokenValid) {
    showLoginError('測驗連結已失效或已逾期，無法開始作答！');
    return;
  }

  // 若已連線雲端，開考前先向雲端拉取最新題庫、開放狀態並驗證 Email 是否已作答
  const gasUrl = getActiveGasUrl();
  if (gasUrl) {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '正在同步載入試卷...';
    }
    await syncStateFromCloud(true);
    let cloudEmailDuplicate = null;
    try {
      const tokenQuery = urlToken ? `&token=${encodeURIComponent(urlToken)}` : '';
      const checkRes = await fetch(`${gasUrl}?action=checkEmail&email=${encodeURIComponent(emailInput)}${tokenQuery}&_t=${Date.now()}`);
      const checkJson = await checkRes.json();
      if (checkJson && checkJson.status === 'token_invalid') {
        if (startBtn) {
          startBtn.disabled = false;
          startBtn.innerHTML = `進入全螢幕並開始作答 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
        }
        showLoginError('測驗連結憑證無效或已逾期，無法開始作答！');
        return;
      }
      if (checkJson && checkJson.status === 'success' && checkJson.exists) {
        cloudEmailDuplicate = checkJson;
      }
    } catch (e) { }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = `進入全螢幕並開始作答 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
    }
    if (cloudEmailDuplicate) {
      const timeNote = cloudEmailDuplicate.submittedAt ? ` (${cloudEmailDuplicate.submittedAt})` : '';
      showLoginError(`電子郵件「${emailInput}」已於本場次${timeNote}完成交卷，同一組 Email 限作答一次！`);
      return;
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

  // 檢查當前場次同一電子郵件 (Email) 是否已作答過 (不區分大小寫)
  const duplicated = submissions.find(
    s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === emailInput.toLowerCase()
  );
  if (duplicated) {
    showLoginError(`電子郵件「${emailInput}」已於本場次 (${duplicated.submittedAt}) 完成交卷，同一組 Email 限作答一次！`);
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
  const roleSwitcherEl = document.getElementById('roleSwitcher');
  if (roleSwitcherEl) roleSwitcherEl.classList.add('hidden');
  document.getElementById('examLiveBar').classList.remove('hidden');
  document.body.classList.add('exam-mode'); // 手機版作答時精簡頂部列
  document.getElementById('liveStudentDisplay').textContent = idInput ? `${nameInput} (${idInput})` : nameInput;
  document.getElementById('liveWarnCount').textContent = '0';
  document.getElementById('liveWarningBadge').classList.remove('warned');
  document.getElementById('liveTimerBox').classList.remove('timer-urgent');

  // 切換畫面至作答區
  document.getElementById('studentLoginView').classList.add('hidden');
  document.getElementById('studentResultView').classList.add('hidden');
  document.getElementById('studentQuizView').classList.remove('hidden');

  renderQuizQuestions();
  startCountdownTimer();
  startActiveExamStatusChecker();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showLoginError(msg) {
  const errorBox = document.getElementById('studentLoginError');
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function normalizeAnswerString(raw) {
  const letters = String(raw || '').toUpperCase().match(/[A-Z]/g);
  if (!letters || letters.length === 0) return '';
  return Array.from(new Set(letters)).sort().join('');
}

function isMultipleChoiceQuestion(q) {
  if (!q) return false;
  if (q.answer) return normalizeAnswerString(q.answer).length >= 2;
  return Boolean(q.isMultiple);
}

function evaluateQuestionCorrectness(q, rawSelected) {
  if (!q) return false;
  const selected = normalizeAnswerString(rawSelected === '未作答' ? '' : rawSelected);
  const correct = normalizeAnswerString(q.answer);
  if (!selected || !correct) return false;
  if (isMultipleChoiceQuestion(q) && q.multiScoreRule === 'any') {
    const correctSet = new Set(correct.split(''));
    return selected.split('').some(ch => correctSet.has(ch));
  }
  return selected === correct;
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
    const isMulti = isMultipleChoiceQuestion(q);
    const inputType = isMulti ? 'checkbox' : 'radio';
    const multiTagHtml = isMulti ? ' <span class="q-multi-tag">(*複選題)</span>' : '';

    // 建立題目卡片
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = `q-card-${q.id}`;

    const optionsHtml = q.options
      .map(opt => {
        return `
          <label class="option-item" id="opt-label-${q.id}-${opt.key}">
            <input type="${inputType}" class="option-radio" name="q_${q.id}" value="${opt.key}" onchange="handleOptionChange(${q.id}, '${opt.key}', this.checked)">
            <span class="option-key">${opt.key}</span>
            <span class="option-label-text">${escapeHtml(opt.text)}</span>
          </label>
        `;
      })
      .join('');

    const displayImgUrl = formatGoogleDriveImageUrl(q.imageUrl);
    const imgHtml = displayImgUrl
      ? `
        <div class="question-image-wrap">
          <img src="${escapeHtml(displayImgUrl)}" alt="第 ${displayNum} 題圖檔" class="question-image-thumb js-lightbox-trigger" ${getImageOnErrorAttr(displayImgUrl)} data-img-url="${escapeHtml(displayImgUrl)}" data-caption="第 ${displayNum} 題附圖">
          <div class="question-image-hint">🔍 點擊圖片可放大檢視</div>
        </div>
      `
      : '';

    card.innerHTML = `
      <div class="q-header">
        <span class="q-badge">第 ${displayNum} 題</span>
        <div class="q-text">${escapeHtml(q.question)}${multiTagHtml}</div>
      </div>
      ${imgHtml}
      <div class="options-grid">
        ${optionsHtml}
      </div>
    `;
    const thumbImg = card.querySelector('.js-lightbox-trigger');
    if (thumbImg) {
      thumbImg.addEventListener('click', () => {
        openImageLightbox(thumbImg.dataset.imgUrl, thumbImg.dataset.caption);
      });
    }
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

function handleOptionChange(questionId, optionKey, isChecked) {
  if (!activeSession.isActive) return;

  const qObj = activeSession.shuffledQuestions.find(q => q.id === questionId);
  const isMulti = isMultipleChoiceQuestion(qObj);

  if (isMulti) {
    const currentSet = new Set(normalizeAnswerString(activeSession.answers[questionId] || '').split('').filter(Boolean));
    if (isChecked) {
      currentSet.add(optionKey);
    } else {
      currentSet.delete(optionKey);
    }
    const nextAns = Array.from(currentSet).sort().join('');
    if (nextAns) {
      activeSession.answers[questionId] = nextAns;
    } else {
      delete activeSession.answers[questionId];
    }
  } else {
    activeSession.answers[questionId] = optionKey;
  }

  const selectedSet = new Set(normalizeAnswerString(activeSession.answers[questionId] || '').split('').filter(Boolean));
  const hasAnySelected = selectedSet.size > 0;

  // 更新該題選項樣式
  if (qObj) {
    qObj.options.forEach(opt => {
      const labelEl = document.getElementById(`opt-label-${questionId}-${opt.key}`);
      if (labelEl) {
        const inputEl = labelEl.querySelector('input');
        const checked = selectedSet.has(opt.key);
        labelEl.classList.toggle('selected', checked);
        if (inputEl) inputEl.checked = checked;
      }
    });
  }

  // 更新卡片與導覽列狀態
  const cardEl = document.getElementById(`q-card-${questionId}`);
  if (cardEl) cardEl.classList.toggle('answered', hasAnySelected);

  const pBtn = document.getElementById(`palette-btn-${questionId}`);
  if (pBtn) pBtn.classList.toggle('answered', hasAnySelected);

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

// ==================== 作答進行中測驗狀態即時監控 (考官結束測驗時強制交卷) ====================
function startActiveExamStatusChecker() {
  if (activeExamStatusTimer) {
    clearInterval(activeExamStatusTimer);
    activeExamStatusTimer = null;
  }

  // 立即檢查一次本機狀態
  if (!examData.isExamOpen && activeSession.isActive) {
    finalizeExamSubmission('測驗結束強制交卷');
    return;
  }

  activeExamStatusTimer = setInterval(async () => {
    if (!activeSession.isActive) {
      clearInterval(activeExamStatusTimer);
      activeExamStatusTimer = null;
      return;
    }

    // 1. 本機狀態檢查 (例如同一視窗或同瀏覽器考官關閉了試卷)
    if (!examData.isExamOpen) {
      clearInterval(activeExamStatusTimer);
      activeExamStatusTimer = null;
      finalizeExamSubmission('測驗結束強制交卷');
      return;
    }

    // 2. 雲端狀態輕量化快速檢查 (每 6 秒非同步查詢雲端 isExamOpen)
    const gasUrl = getActiveGasUrl();
    if (!gasUrl || isCheckingExamStatus) return;

    isCheckingExamStatus = true;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlToken = (urlParams.get('token') || '').trim();
      const tokenParam = urlToken ? `&token=${encodeURIComponent(urlToken)}` : '';
      const res = await fetch(`${gasUrl}?action=checkState${tokenParam}&_t=${Date.now()}`);
      const json = await res.json();
      if (json && json.status === 'success') {
        if (json.isExamOpen === false || json.tokenStatus === 'invalid' || json.tokenStatus === 'expired' || json.tokenStatus === 'not_generated') {
          clearInterval(activeExamStatusTimer);
          activeExamStatusTimer = null;
          examData.isExamOpen = false;
          try {
            const raw = localStorage.getItem(STORAGE_KEYS.EXAM_DATA);
            if (raw) {
              const parsed = JSON.parse(raw);
              parsed.isExamOpen = false;
              localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(parsed));
            }
          } catch (e) { }
          if (activeSession.isActive) {
            finalizeExamSubmission('測驗結束強制交卷');
          }
        }
      }
    } catch (err) {
      console.warn('輪詢雲端測驗開放狀態失敗:', err);
    } finally {
      isCheckingExamStatus = false;
    }
  }, 6000);
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

  if (activeSession.warningCount < 3) {
    // 第 1、2 次離開：跳出嚴重警告 Modal
    const titleEl = document.getElementById('antiCheatModalTitle');
    const ruleEl = document.getElementById('antiCheatModalRuleText');
    if (titleEl) {
      titleEl.textContent = `防作弊系統警告 (第 ${activeSession.warningCount} / 3 次)`;
    }
    if (ruleEl) {
      ruleEl.innerHTML = `請注意：這是您的<strong>第 ${activeSession.warningCount} 次警告</strong>。<br>若離開作答畫面累計達 <strong>3 次</strong>，系統將<strong>立即強制終止您的測驗並自動交卷</strong>！`;
    }
    document.getElementById('antiCheatModal').classList.remove('hidden');
  } else if (activeSession.warningCount >= 3) {
    // 第 3 次離開：立即關閉所有 Modal 並強制終止測驗
    document.getElementById('antiCheatModal').classList.add('hidden');
    document.getElementById('submitConfirmModal').classList.add('hidden');
    finalizeExamSubmission('防作弊強制終止 (離開畫面達3次)');
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
  if (activeExamStatusTimer) {
    clearInterval(activeExamStatusTimer);
    activeExamStatusTimer = null;
  }

  if (statusReason.includes('考官結束') || statusReason.includes('結束作答')) {
    showToast('⚠️ 考官已結束本次測驗，系統已強制為您提交目前試卷！');
  }

  document.getElementById('submitConfirmModal').classList.add('hidden');
  document.getElementById('antiCheatModal').classList.add('hidden');

  // 退回一般視窗模式
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
  } catch (e) { }

  // 計算成績 (支援本機離線與伺服器雙重校驗)
  const totalQ = examData.questions.length;
  let correctCount = 0;
  const answerDetails = {};

  examData.questions.forEach(q => {
    const rawSelected = activeSession.answers[q.id] || '';
    const selected = normalizeAnswerString(rawSelected);
    const correct = normalizeAnswerString(q.answer);
    const hasAnswer = Boolean(correct);
    const isCorrect = hasAnswer ? evaluateQuestionCorrectness(q, selected) : false;
    if (isCorrect) correctCount++;
    answerDetails[q.id] = {
      selected: selected || '未作答',
      correctAnswer: correct || q.answer || '',
      isCorrect: hasAnswer ? isCorrect : false
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
    id: (window.crypto && crypto.randomUUID) ? ('SUB_' + crypto.randomUUID().substring(0, 12)) : ('SUB_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
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
    answers: Object.assign({}, activeSession.answers),
    answerDetails
  };

  submissions.unshift(record);
  localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));

  // 恢復頂部導覽列
  document.getElementById('examLiveBar').classList.add('hidden');
  const roleSwitcherEl = document.getElementById('roleSwitcher');
  if (roleSwitcherEl) roleSwitcherEl.classList.remove('hidden');
  document.body.classList.remove('exam-mode');

  // 顯示交卷完成憑證畫面 (不顯示分數與標準答案)
  document.getElementById('studentQuizView').classList.add('hidden');
  document.getElementById('studentResultView').classList.remove('hidden');

  const iconWrap = document.getElementById('resultIconWrap');
  const titleEl = document.getElementById('resultTitle');
  const subEl = document.getElementById('resultSubtitle');

  if (statusReason.includes('強制終止')) {
    iconWrap.classList.add('forced');
    titleEl.textContent = '測驗已遭系統強制終止並自動交卷';
    subEl.textContent = '因系統偵測到您離開作答畫面達 3 次，已依防作弊規定立即終止測驗並鎖定目前已填寫之答案。考試結束後將寄送成績單至您的信箱。';
  } else if (statusReason.includes('考官結束') || statusReason.includes('結束作答')) {
    iconWrap.classList.add('forced');
    titleEl.textContent = '考官已結束本次測驗並強制交卷';
    subEl.textContent = '考官已結束本次測驗作答權限，系統已為您強制提交目前已作答之答案。考試成績將由考官另行寄送通知至您的電子信箱。';
  } else {
    iconWrap.classList.remove('forced');
    titleEl.textContent = '已完成測驗交卷';
    subEl.textContent = '您的作答紀錄已成功儲存。為維護考試公平性，現場不公佈分數與標準答案，考官將於考試結束後寄送成績單至您的電子信箱。';
  }

  document.getElementById('receiptExamTitle').textContent = record.examTitle;
  document.getElementById('receiptName').textContent = record.studentName;
  document.getElementById('receiptStudentId').textContent = record.studentId || '-';
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
      examToken: getUrlExamToken(),
      record: record
    });
    if (cloudRes && (cloudRes.status === 'success' || cloudRes.status === 'duplicate')) {
      cloudStatusEl.innerHTML = '<span style="color:var(--primary);">✅ 已成功上傳</span>';
      // 同步後端生成的權威 submissionId 與交卷時間戳 (H1)
      if (cloudRes.submissionId) {
        record.id = cloudRes.submissionId;
      }
      if (cloudRes.submittedAt) {
        record.submittedAt = cloudRes.submittedAt;
        document.getElementById('receiptTimestamp').textContent = record.submittedAt;
      }
      // 若後端完成客觀權威評分，同步更新本機端分數與作答明細
      if (cloudRes.record) {
        record.score = cloudRes.record.score;
        record.correctCount = cloudRes.record.correctCount;
        record.totalQuestions = cloudRes.record.totalQuestions;
        record.answerDetails = cloudRes.record.answerDetails;
      }
      localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
    } else if (cloudRes && (cloudRes.status === 'token_invalid' || cloudRes.status === 'token_expired')) {
      cloudStatusEl.innerHTML = `<span style="color:var(--danger);">❌ ${escapeHtml(cloudRes.message || '測驗連結憑證無效或已逾期')}</span>`;
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
// 純 JavaScript SHA-256 備援實作 (確保在任何環境、協定或舊版瀏覽器皆可穩定計算雜湊)
function sha256Fallback(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i, j;
  let result = '';

  const words = [];
  const asciiBitLength = ascii[lengthProperty] * 8;

  let hash = [];
  const k = [];
  let primeCounter = 0;

  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  hash = hash.slice(0, 8);

  ascii += '\x80';
  while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
  words[words[lengthProperty]] = (asciiBitLength) | 0;

  for (j = 0; j < words[lengthProperty];) {
    const w = words.slice(j, j += 16);
    const oldHash = hash;
    hash = hash.slice(0, 8);

    for (i = 0; i < 64; i++) {
      const i2 = i + j;
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ ((~e) & hash[6]))
        + k[i]
        + (w[i] = (i < 16) ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0
        );
      const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }

    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

async function hashWithSalt(salt, value) {
  const salted = `${salt}:${value}`;
  if (window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const enc = new TextEncoder();
      const data = enc.encode(salted);
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('crypto.subtle 失敗，切換至純 JS 雜湊', e);
    }
  }
  return sha256Fallback(salted);
}

async function hashExaminerPin(pin) {
  return hashWithSalt('LOCAL_CUSTOM_SALT', pin);
}

function getStoredExaminerPinHash() {
  localStorage.removeItem(STORAGE_KEYS.EXAMINER_PIN_HASH);
  return '';
}

// ==================== Cloudflare Turnstile (Verify Visitors Without CAPTCHA) ====================
function getActiveTurnstileSiteKey() {
  return String(TURNSTILE_SITE_KEY || '').trim();
}

function initOrResetExaminerTurnstile() {
  const siteKey = getActiveTurnstileSiteKey();
  const wrap = document.getElementById('turnstileWidgetWrap');
  const container = document.getElementById('examinerTurnstileContainer');
  if (!wrap || !container) return;

  if (!siteKey) {
    wrap.classList.add('hidden');
    currentTurnstileToken = '';
    return;
  }
  wrap.classList.remove('hidden');

  if (typeof window.turnstile === 'undefined' || typeof window.turnstile.render !== 'function') {
    if (!turnstileLoadPollTimer) {
      let attempts = 0;
      turnstileLoadPollTimer = setInterval(() => {
        attempts++;
        if (typeof window.turnstile !== 'undefined' && typeof window.turnstile.render === 'function') {
          clearInterval(turnstileLoadPollTimer);
          turnstileLoadPollTimer = null;
          initOrResetExaminerTurnstile();
        } else if (attempts >= 25) {
          clearInterval(turnstileLoadPollTimer);
          turnstileLoadPollTimer = null;
        }
      }, 200);
    }
    return;
  }

  currentTurnstileToken = '';
  if (turnstileWidgetId !== null) {
    try {
      window.turnstile.reset(turnstileWidgetId);
      return;
    } catch (e) {
      turnstileWidgetId = null;
      container.innerHTML = '';
    }
  }

  try {
    container.innerHTML = '';
    turnstileWidgetId = window.turnstile.render('#examinerTurnstileContainer', {
      sitekey: siteKey,
      theme: 'light',
      callback: function (token) {
        currentTurnstileToken = String(token || '').trim();
      },
      'expired-callback': function () {
        currentTurnstileToken = '';
      },
      'error-callback': function () {
        currentTurnstileToken = '';
      }
    });
  } catch (err) {
    console.warn('Turnstile render error:', err);
  }
}

function getExaminerTurnstileToken() {
  if (currentTurnstileToken) return currentTurnstileToken;
  if (typeof window.turnstile !== 'undefined' && turnstileWidgetId !== null) {
    try {
      const resp = window.turnstile.getResponse(turnstileWidgetId);
      if (resp) return String(resp).trim();
    } catch (e) { }
  }
  return '';
}

function isStrongPasswordClient(pw) {
  if (typeof pw !== 'string') return false;
  if (pw.length < 8 || pw.length > 64) return false;
  return /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
}

function switchExaminerAuthMode(mode) {
  currentExaminerAuthMode = mode || 'login';
  const loginForm = document.getElementById('pinForm');
  const regForm = document.getElementById('examinerRegisterForm');
  const forgotView = document.getElementById('examinerForgotView');
  const btnLogin = document.getElementById('authTabBtnLogin');
  const btnReg = document.getElementById('authTabBtnRegister');
  const btnForgot = document.getElementById('authTabBtnForgot');
  const titleEl = document.getElementById('examinerAuthCardTitle');
  const subEl = document.getElementById('examinerAuthCardSubtitle');

  if (loginForm) loginForm.classList.toggle('hidden', currentExaminerAuthMode !== 'login');
  if (regForm) regForm.classList.toggle('hidden', currentExaminerAuthMode !== 'register');
  if (forgotView) forgotView.classList.toggle('hidden', currentExaminerAuthMode !== 'forgot');

  if (btnLogin) btnLogin.className = currentExaminerAuthMode === 'login' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  if (btnReg) btnReg.className = currentExaminerAuthMode === 'register' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  if (btnForgot) btnForgot.className = currentExaminerAuthMode === 'forgot' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';

  if (currentExaminerAuthMode === 'register') {
    if (titleEl) titleEl.textContent = '考官帳號註冊申請';
    if (subEl) subEl.textContent = '請填寫您的資料，送出後由系統管理員審核通過即可登入';
  } else if (currentExaminerAuthMode === 'forgot') {
    if (titleEl) titleEl.textContent = '考官忘記密碼重設';
    if (subEl) subEl.textContent = '核對註冊帳號、西元出生年月日與 Email 信箱即可重設密碼';
  } else {
    if (titleEl) titleEl.textContent = 'EZ線上測驗管理系統';
    if (subEl) subEl.textContent = '請輸入帳號與密碼進入本系統';
  }

  initOrResetExaminerTurnstile();
}

async function handleExaminerRegister(event) {
  if (event) event.preventDefault();
  const displayName = (document.getElementById('regDisplayName')?.value || '').trim();
  const birthDate = (document.getElementById('regBirthDate')?.value || '').trim();
  const organization = (document.getElementById('regOrganization')?.value || '').trim();
  const username = (document.getElementById('regUsername')?.value || '').trim();
  const email = (document.getElementById('regEmail')?.value || '').trim();
  const password = document.getElementById('regPassword')?.value || '';
  const passwordConfirm = document.getElementById('regPasswordConfirm')?.value || '';
  const consent = document.getElementById('regPrivacyConsent')?.checked;
  const alertBox = document.getElementById('regAlertBox');
  const submitBtn = document.getElementById('btnSubmitRegister');

  function showRegAlert(msg, type = 'danger') {
    if (!alertBox) {
      alert(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type}`;
    alertBox.classList.remove('hidden');
  }

  if (!displayName || displayName.length < 2) {
    showRegAlert('⚠️ 請填寫真實姓名（至少 2 個字）！');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    showRegAlert('⚠️ 請選擇正確的西元出生年月日！');
    return;
  }
  if (!organization || organization.length < 2) {
    showRegAlert('⚠️ 請填寫服務單位！');
    return;
  }
  if (!/^[a-zA-Z0-9_]{4,24}$/.test(username)) {
    showRegAlert('⚠️ 自訂帳號須為 4~24 碼半形英文字母、數字或底線 (_)！');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showRegAlert('⚠️ 請輸入格式正確的電子郵件 (Email)！');
    return;
  }
  if (!isStrongPasswordClient(password)) {
    showRegAlert('⚠️ 密碼強度不足！長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」！');
    return;
  }
  if (password !== passwordConfirm) {
    showRegAlert('⚠️ 兩次輸入的密碼不一致，請重新確認！');
    return;
  }
  if (!consent) {
    showRegAlert('⚠️ 請勾選同意個人資料蒐集與使用聲明！');
    return;
  }

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    showRegAlert('⚠️ 尚未設定 Google Apps Script 雲端資料庫網址，無法提交考官註冊申請！');
    return;
  }

  const siteKey = getActiveTurnstileSiteKey();
  const turnstileToken = getExaminerTurnstileToken();
  if (siteKey && !turnstileToken) {
    showRegAlert('🛡️ 請先完成下方訪客安全驗證後再送出註冊申請！', 'warning');
    initOrResetExaminerTurnstile();
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ 正在提交註冊申請...';
  }

  try {
    const res = await postToCloud({
      action: 'registerExaminer',
      displayName,
      birthDate,
      organization,
      username,
      email,
      password,
      turnstileToken,
      clientId: getOrCreateClientDeviceId()
    });
    initOrResetExaminerTurnstile();

    if (res && res.status === 'success') {
      showRegAlert(res.message || '✅ 註冊申請已送出！請靜候管理員審核通過後即可登入。', 'success');
      showToast('✅ 考官註冊申請已成功送出！');
      document.getElementById('examinerRegisterForm')?.reset();
    } else {
      showRegAlert((res && res.message) ? res.message : '❌ 註冊申請送出失敗，請檢查網路連線後再試！', 'danger');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '📤 送出註冊申請 (待管理員審核)';
    }
  }
}

async function handleRequestPasswordReset(event) {
  if (event) event.preventDefault();
  const username = (document.getElementById('forgotUsername')?.value || '').trim();
  const birthDate = (document.getElementById('forgotBirthDate')?.value || '').trim();
  const email = (document.getElementById('forgotEmail')?.value || '').trim();
  const alertBox = document.getElementById('forgotAlertBox');
  const sendBtn = document.getElementById('btnSendResetCode');

  function showForgotAlert(msg, type = 'danger') {
    if (!alertBox) {
      alert(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type}`;
    alertBox.classList.remove('hidden');
  }

  if (!username || !birthDate || !email) {
    showForgotAlert('⚠️ 請完整填寫自訂帳號、西元出生年月日與註冊 Email！');
    return;
  }

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    showForgotAlert('⚠️ 尚未綁定雲端資料庫網址，無法執行忘記密碼重設！');
    return;
  }

  const siteKey = getActiveTurnstileSiteKey();
  const turnstileToken = getExaminerTurnstileToken();
  if (siteKey && !turnstileToken) {
    showForgotAlert('🛡️ 請先完成下方訪客安全驗證後再點擊寄送驗證碼！', 'warning');
    initOrResetExaminerTurnstile();
    return;
  }

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ 正在核對身分並寄送驗證碼...';
  }

  try {
    const res = await postToCloud({
      action: 'requestPasswordReset',
      username,
      birthDate,
      email,
      turnstileToken,
      clientId: getOrCreateClientDeviceId()
    });
    initOrResetExaminerTurnstile();

    if (res && res.status === 'success') {
      showForgotAlert(res.message || '📧 已寄出重設驗證碼，請至信箱查收並於步驟 2 輸入。', 'success');
      showToast('📧 重設驗證碼已寄至您的信箱！');
      document.getElementById('forgotResetCode')?.focus();
    } else {
      showForgotAlert((res && res.message) ? res.message : '❌ 核對失敗或寄信異常，請確認資料無誤後再試！', 'danger');
    }
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '📧 核對身分並寄送重設驗證碼';
    }
  }
}

async function handleConfirmPasswordReset(event) {
  if (event) event.preventDefault();
  const username = (document.getElementById('forgotUsername')?.value || '').trim();
  const resetCode = (document.getElementById('forgotResetCode')?.value || '').trim().toUpperCase();
  const newPassword = document.getElementById('forgotNewPassword')?.value || '';
  const confirmPw = document.getElementById('forgotNewPasswordConfirm')?.value || '';
  const alertBox = document.getElementById('forgotAlertBox');
  const confirmBtn = document.getElementById('btnConfirmResetPw');

  function showForgotAlert(msg, type = 'danger') {
    if (!alertBox) {
      alert(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type}`;
    alertBox.classList.remove('hidden');
  }

  if (!username) {
    showForgotAlert('⚠️ 請於上方步驟 1 欄位填寫您的自訂帳號！');
    document.getElementById('forgotUsername')?.focus();
    return;
  }
  if (!resetCode) {
    showForgotAlert('⚠️ 請輸入信箱收到的 8 碼重設驗證碼！');
    return;
  }
  if (!isStrongPasswordClient(newPassword)) {
    showForgotAlert('⚠️ 新密碼強度不足！長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」！');
    return;
  }
  if (newPassword !== confirmPw) {
    showForgotAlert('⚠️ 兩次輸入的新密碼不一致，請重新確認！');
    return;
  }

  const siteKey = getActiveTurnstileSiteKey();
  const turnstileToken = getExaminerTurnstileToken();
  if (siteKey && !turnstileToken) {
    showForgotAlert('🛡️ 請先完成下方訪客安全驗證後再送出重設密碼！', 'warning');
    initOrResetExaminerTurnstile();
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ 正在驗證並更新密碼...';
  }

  try {
    const res = await postToCloud({
      action: 'confirmPasswordReset',
      username,
      resetCode,
      newPassword,
      turnstileToken,
      clientId: getOrCreateClientDeviceId()
    });
    initOrResetExaminerTurnstile();

    if (res && res.status === 'success') {
      showForgotAlert(res.message || '✅ 密碼重設成功！請返回帳號登入頁面使用新密碼登入。', 'success');
      showToast('✅ 密碼已成功重設！');
      document.getElementById('forgotStep1Form')?.reset();
      document.getElementById('forgotStep2Form')?.reset();
      setTimeout(() => {
        switchExaminerAuthMode('login');
        const uInput = document.getElementById('examinerUsernameInput');
        if (uInput) uInput.value = username;
      }, 1500);
    } else {
      showForgotAlert((res && res.message) ? res.message : '❌ 驗證碼錯誤或已過期，請重新確認！', 'danger');
    }
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '✅ 確認重設密碼';
    }
  }
}

async function handlePinLogin(event) {
  event.preventDefault();
  if (isPinLoggingIn) return;

  const usernameInputEl = document.getElementById('examinerUsernameInput');
  const pinInputEl = document.getElementById('examinerPinInput');
  const usernameInput = (usernameInputEl ? usernameInputEl.value : '').trim();
  const pinInput = (pinInputEl ? pinInputEl.value : '').trim();
  const errBox = document.getElementById('pinErrorMsg');
  const loadingBar = document.getElementById('pinLoadingBar');
  const pinBtn = document.getElementById('pinSubmitBtn') || document.querySelector('#pinForm button[type="submit"]');

  if (pinLockoutRemaining > 0) {
    errBox.textContent = `⚠️ 連續錯誤次數過多，目前系統鎖定中！請等待 ${pinLockoutRemaining} 秒後再試。`;
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    return;
  }

  if (!usernameInput) {
    errBox.textContent = '⚠️ 請輸入您的考官帳號！';
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    if (usernameInputEl) usernameInputEl.focus();
    return;
  }

  if (!pinInput) {
    errBox.textContent = '⚠️ 請輸入考官登入密碼 (PIN)！';
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    if (pinInputEl) pinInputEl.focus();
    return;
  }

  // 檢查 Cloudflare Turnstile 訪客安全驗證狀態 (Fail-Closed：強制必須完成驗證取得 Token 始得送出)
  const siteKey = getActiveTurnstileSiteKey();
  const turnstileToken = getExaminerTurnstileToken();
  if (siteKey && !turnstileToken) {
    errBox.textContent = '🛡️ 請稍候，正在完成訪客安全驗證（或請勾選驗證框）後再登入！';
    errBox.className = 'alert alert-warning';
    errBox.classList.remove('hidden');
    initOrResetExaminerTurnstile();
    return;
  }

  isPinLoggingIn = true;
  let isPinValid = false;
  let issuedSessionToken = '';
  errBox.classList.add('hidden');
  if (loadingBar) loadingBar.classList.remove('hidden');
  if (pinBtn) pinBtn.disabled = true;
  if (usernameInputEl) usernameInputEl.disabled = true;
  if (pinInputEl) pinInputEl.disabled = true;

  try {
    const gasUrl = getActiveGasUrl();
    let cloudLockedMsg = '';
    let turnstileErrorMsg = '';
    let customErrMsg = '';

    // 考官登入一律強制透過雲端 Google Apps Script 權威驗證 Cloudflare Turnstile Token 與帳號密碼
    if (gasUrl) {
      const verifyRes = await postToCloud({
        action: 'verifyExaminer',
        username: usernameInput,
        password: pinInput,
        pin: pinInput,
        turnstileToken: turnstileToken,
        clientId: getOrCreateClientDeviceId()
      });
      if (verifyRes && verifyRes.status === 'success') {
        isPinValid = true;
        issuedSessionToken = verifyRes.sessionToken || '';
        currentExaminerProfile = verifyRes.userProfile || null;
        localStorage.removeItem(STORAGE_KEYS.EXAMINER_PIN_HASH);
      } else if (verifyRes && (verifyRes.status === 'turnstile_failed' || verifyRes.status === 'pending_review')) {
        isPinValid = false;
        turnstileErrorMsg = verifyRes.message || '⏳ 您的帳號尚在等待管理員審核中！';
      } else if (verifyRes && verifyRes.status === 'locked') {
        isPinValid = false;
        cloudLockedMsg = verifyRes.message || '❌ 密碼錯誤次數過多，已暫時鎖定！';
      } else if (verifyRes && verifyRes.status === 'unauthorized') {
        isPinValid = false;
        customErrMsg = verifyRes.message || '❌ 帳號或密碼錯誤，請重新確認！';
      } else {
        isPinValid = false;
        cloudLockedMsg = (verifyRes && verifyRes.message) ? verifyRes.message : '⚠️ 無法連線至雲端伺服器進行考官身分驗證，請檢查網路狀態！';
      }
    } else {
      isPinValid = false;
      turnstileErrorMsg = '⚠️ 尚未設定 Google Apps Script 雲端後端網址（DEFAULT_GAS_URL），為確保資安，系統禁止於無後端驗證狀態下登入後台！';
    }

    if (isPinValid) {
      pinFailedAttempts = 0;
      isExaminerAuthenticated = true;
      currentExaminerAuthToken = issuedSessionToken;
      lastExaminerActivityTime = Date.now();
      lastExaminerActivityRecordAt = Date.now();
      errBox.classList.add('hidden');
      if (gasUrl) {
        await syncStateFromCloud(true, true);
      }
      showExaminerDashboard();
      if (isCurrentUserAdmin()) {
        fetchAdminUsersList(true);
      }
    } else {
      initOrResetExaminerTurnstile();

      if (turnstileErrorMsg) {
        errBox.textContent = turnstileErrorMsg;
        errBox.className = 'alert alert-warning';
        errBox.classList.remove('hidden');
      } else {
        pinFailedAttempts++;
        if (cloudLockedMsg) {
          startPinLockout(30);
          errBox.textContent = cloudLockedMsg;
        } else if (pinFailedAttempts >= 5) {
          startPinLockout(30);
          errBox.textContent = '❌ 帳號或密碼已連續錯誤 5 次，系統已暫時鎖定 30 秒！';
        } else {
          errBox.textContent = customErrMsg || `❌ 帳號或密碼錯誤，請重新確認！（剩餘 ${5 - pinFailedAttempts} 次嘗試機會）`;
        }
        errBox.className = 'alert alert-danger';
        errBox.classList.remove('hidden');
      }
    }
  } finally {
    isPinLoggingIn = false;
    if (loadingBar) loadingBar.classList.add('hidden');
    if (pinLockoutRemaining <= 0) {
      if (pinBtn) pinBtn.disabled = false;
      if (usernameInputEl) usernameInputEl.disabled = false;
      if (pinInputEl) {
        pinInputEl.disabled = false;
        if (!isPinValid) {
          pinInputEl.focus();
          pinInputEl.select();
        }
      }
    }
  }
}

function startPinLockout(seconds) {
  pinLockoutRemaining = seconds;
  const pinBtn = document.querySelector('#pinForm button[type="submit"]');
  const usernameInputEl = document.getElementById('examinerUsernameInput');
  const pinInputEl = document.getElementById('examinerPinInput');
  const errBox = document.getElementById('pinErrorMsg');

  if (pinBtn) pinBtn.disabled = true;
  if (usernameInputEl) usernameInputEl.disabled = true;
  if (pinInputEl) pinInputEl.disabled = true;

  if (pinLockoutTimer) clearInterval(pinLockoutTimer);
  pinLockoutTimer = setInterval(() => {
    pinLockoutRemaining--;
    if (pinLockoutRemaining <= 0) {
      clearInterval(pinLockoutTimer);
      pinLockoutTimer = null;
      pinLockoutRemaining = 0;
      pinFailedAttempts = 0;
      if (pinBtn) pinBtn.disabled = false;
      if (usernameInputEl) usernameInputEl.disabled = false;
      if (pinInputEl) {
        pinInputEl.disabled = false;
        pinInputEl.focus();
      }
      if (errBox) {
        errBox.textContent = '鎖定已解除，請重新輸入帳號與密碼。';
        errBox.className = 'alert alert-info';
      }
    } else {
      if (errBox) {
        errBox.textContent = `❌ 連續錯誤達 5 次，系統鎖定中... 請等待 ${pinLockoutRemaining} 秒後再試！`;
      }
    }
  }, 1000);
}

// ==================== 考官端閒置自動登出機制 (桌面與行動裝置全面適用) ====================
const EXAMINER_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 閒置超過 30 分鐘 (1,800,000 毫秒) 自動登出
let lastExaminerActivityTime = Date.now();
let lastExaminerActivityRecordAt = 0;
let examinerIdleCheckTimer = null;

function recordExaminerActivity() {
  if (!isExaminerAuthenticated) return;
  const now = Date.now();
  // 節流保護：每 2 秒最多記錄一次，避免高頻 touchmove/mousemove 消耗行動裝置 CPU 與電力
  if (now - lastExaminerActivityRecordAt > 2000) {
    lastExaminerActivityRecordAt = now;
    lastExaminerActivityTime = now;
  }
}

function checkExaminerIdleTimeout() {
  if (!isExaminerAuthenticated) return;
  const now = Date.now();
  if (now < lastExaminerActivityTime) {
    // 預防裝置系統時間異常回調
    lastExaminerActivityTime = now;
    return;
  }
  const elapsed = now - lastExaminerActivityTime;
  if (elapsed >= EXAMINER_IDLE_TIMEOUT_MS) {
    console.warn(`[考官端安全防護] 系統已閒置超過 30 分鐘 (累計 ${Math.round(elapsed / 1000)} 秒未動作)，執行自動安全登出。`);
    logoutExaminer('idle');
  }
}

function setupExaminerIdleDetector() {
  // 監聽桌面與行動裝置的使用者互動事件
  // 使用 passive: true 確保觸控滾動與畫面滑動維持最高流暢度
  const activityEvents = [
    'mousedown', 'mousemove', 'keydown', 'wheel', 'click', 'input', 'change',
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointerup',
    'scroll', 'dragover', 'drop'
  ];

  activityEvents.forEach(evt => {
    window.addEventListener(evt, recordExaminerActivity, { passive: true });
  });

  // 定期檢查閒置時間 (每 15 秒檢查一次)
  if (examinerIdleCheckTimer) clearInterval(examinerIdleCheckTimer);
  examinerIdleCheckTimer = setInterval(checkExaminerIdleTimeout, 15000);

  // 行動裝置喚醒、螢幕解鎖、切換應用程式或瀏覽器分頁切回時立即檢查
  window.addEventListener('focus', checkExaminerIdleTimeout);
  window.addEventListener('pageshow', checkExaminerIdleTimeout);
}

function logoutExaminer(reason) {
  const isIdle = (reason === 'idle');
  const isSessionExpired = (reason === 'session_expired');
  const tokenToRevoke = currentExaminerAuthToken;
  isExaminerAuthenticated = false;
  currentExaminerAuthToken = '';
  currentExaminerProfile = null;
  adminUsersCache = [];
  isGasUrlUnlockedBySecret = false;
  gasSecretClickCount = 0;
  stopExaminerLiveTimer();
  updateCloudStatusUI();

  if (tokenToRevoke && tokenToRevoke.startsWith('exs_') && getActiveGasUrl()) {
    postToCloud({
      action: 'logoutExaminer',
      sessionToken: tokenToRevoke
    });
  }

  // 關閉考官端可能開啟中的浮動視窗 (Modal)
  const examinerModals = ['studentDetailModal', 'addQuestionModal', 'archiveSessionModal', 'imageLightboxModal'];
  examinerModals.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const dashView = document.getElementById('examinerDashboardView');
  const pinView = document.getElementById('examinerPinView');
  const pinInput = document.getElementById('examinerPinInput');
  const pinLoading = document.getElementById('pinLoadingBar');
  const pinErr = document.getElementById('pinErrorMsg');

  if (dashView) dashView.classList.add('hidden');
  if (pinView) pinView.classList.remove('hidden');
  if (pinInput) pinInput.value = '';
  if (pinLoading) pinLoading.classList.add('hidden');
  switchExaminerAuthMode('login');

  if (isIdle || isSessionExpired) {
    const msg = isSessionExpired
      ? '⚠️ 雲端考官登入工作階段已逾時，請重新輸入帳號與密碼登入。'
      : '⚠️ 閒置已超過 30 分鐘，系統已自動安全登出。';
    showToast(msg);
    if (pinErr) {
      pinErr.textContent = msg;
      pinErr.className = 'alert alert-warning';
      pinErr.classList.remove('hidden');
    }
  } else {
    if (pinErr) {
      pinErr.classList.add('hidden');
    }
  }
}

async function handleUpdateExaminerPin(event) {
  if (event) event.preventDefault();
  const currentPwEl = document.getElementById('currentExaminerPasswordInput');
  const newPinEl = document.getElementById('newExaminerPinInput');
  const confirmPinEl = document.getElementById('confirmExaminerPinInput');
  const alertBox = document.getElementById('updatePinAlertBox');

  const currentPassword = (currentPwEl ? currentPwEl.value : '').trim();
  const newPassword = (newPinEl ? newPinEl.value : '').trim();
  const confirmPassword = (confirmPinEl ? confirmPinEl.value : '').trim();

  function showPinAlert(msg, type) {
    if (!alertBox) {
      if (type === 'danger') alert(msg);
      else showToast(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
    alertBox.classList.remove('hidden');
  }

  if (!currentPassword) {
    showPinAlert('⚠️ 請輸入您目前的登入密碼以驗證本人身分！', 'danger');
    if (currentPwEl) currentPwEl.focus();
    return;
  }

  if (!newPassword) {
    showPinAlert('⚠️ 請輸入新密碼！', 'danger');
    if (newPinEl) newPinEl.focus();
    return;
  }
  if (!isStrongPasswordClient(newPassword)) {
    showPinAlert('⚠️ 新密碼強度不足！長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」！', 'danger');
    if (newPinEl) newPinEl.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    showPinAlert('⚠️ 兩次輸入的新密碼不一致，請重新確認！', 'danger');
    if (confirmPinEl) confirmPinEl.focus();
    return;
  }

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    showPinAlert('⚠️ 變更個人密碼必須先綁定並連線至 Google Apps Script 雲端後端！', 'danger');
    return;
  }

  const reqPayload = {
    action: 'updateOwnPassword',
    currentPassword: currentPassword,
    newPassword: newPassword,
    clientId: getOrCreateClientDeviceId()
  };

  const loadingBar = document.getElementById('updatePinLoadingBar');
  const submitBtn = document.getElementById('btnUpdatePinSubmit');
  if (alertBox) alertBox.classList.add('hidden');
  if (loadingBar) loadingBar.classList.remove('hidden');
  if (submitBtn) submitBtn.disabled = true;
  if (currentPwEl) currentPwEl.disabled = true;
  if (newPinEl) newPinEl.disabled = true;
  if (confirmPinEl) confirmPinEl.disabled = true;

  let res = null;
  try {
    res = await postToCloud(reqPayload);
  } finally {
    if (loadingBar) loadingBar.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
    if (currentPwEl) currentPwEl.disabled = false;
    if (newPinEl) newPinEl.disabled = false;
    if (confirmPinEl) confirmPinEl.disabled = false;
  }

  if (!res || res.status !== 'success') {
    const errMsg = (res && res.message) ? res.message : '❌ 目前密碼驗證失敗或雲端連線異常！無法變更密碼。';
    showPinAlert(errMsg, 'danger');
    if (currentPwEl) currentPwEl.select();
    return;
  }

  if (res.sessionToken) {
    currentExaminerAuthToken = res.sessionToken;
  }
  if (res.userProfile) {
    currentExaminerProfile = res.userProfile;
  }
  localStorage.removeItem(STORAGE_KEYS.EXAMINER_PIN_HASH);

  if (currentPwEl) currentPwEl.value = '';
  if (newPinEl) newPinEl.value = '';
  if (confirmPinEl) confirmPinEl.value = '';

  renderExaminerSettingsTab();
  showPinAlert(res.message || '✅ 您的個人登入密碼已安全更新！下次登入請使用新密碼。', 'success');
  showToast('✅ 個人密碼已成功變更！');
}

async function handleUpdateOwnOrganization(event) {
  if (event) event.preventDefault();
  const orgInputEl = document.getElementById('newExaminerOrgInput');
  const alertBox = document.getElementById('updateOrgAlertBox');
  const loadingBar = document.getElementById('updateOrgLoadingBar');
  const submitBtn = document.getElementById('btnUpdateOrgSubmit');

  const newOrg = (orgInputEl ? orgInputEl.value : '').trim();

  function showOrgAlert(msg, type) {
    if (!alertBox) {
      if (type === 'danger') alert(msg);
      else showToast(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
    alertBox.classList.remove('hidden');
  }

  if (!newOrg || newOrg.length < 2) {
    showOrgAlert('⚠️ 請填寫正確的服務單位名稱（至少 2 個字）！', 'danger');
    if (orgInputEl) orgInputEl.focus();
    return;
  }

  const currentOrg = (currentExaminerProfile && currentExaminerProfile.organization)
    ? String(currentExaminerProfile.organization).trim()
    : '';
  if (currentOrg && currentOrg === newOrg) {
    showOrgAlert('⚠️ 新輸入的服務單位與目前設定相同，無須變更！', 'danger');
    if (orgInputEl) orgInputEl.select();
    return;
  }

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    showOrgAlert('⚠️ 修改服務單位必須先綁定並連線至 Google Apps Script 雲端後端！', 'danger');
    return;
  }

  if (alertBox) alertBox.classList.add('hidden');
  if (loadingBar) loadingBar.classList.remove('hidden');
  if (submitBtn) submitBtn.disabled = true;
  if (orgInputEl) orgInputEl.disabled = true;

  let res = null;
  try {
    res = await postToCloud({
      action: 'updateOwnOrganization',
      newOrganization: newOrg,
      clientId: getOrCreateClientDeviceId()
    });
  } finally {
    if (loadingBar) loadingBar.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
    if (orgInputEl) orgInputEl.disabled = false;
  }

  if (!res || res.status !== 'success') {
    const errMsg = (res && res.message) ? res.message : '❌ 雲端連線異常，無法更新服務單位！';
    showOrgAlert(errMsg, 'danger');
    return;
  }

  if (res.userProfile) {
    currentExaminerProfile = res.userProfile;
  } else if (currentExaminerProfile) {
    currentExaminerProfile.organization = newOrg;
  }

  // 同步更新本機試卷庫中本人名下試卷的單位標記
  const myId = getCurrentExaminerUserId();
  if (myId && Array.isArray(examLibrary)) {
    let libChanged = false;
    examLibrary.forEach(ex => {
      if (ex && ex.ownerId === myId) {
        ex.ownerOrg = newOrg;
        libChanged = true;
      }
    });
    if (libChanged) {
      localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(examLibrary));
    }
  }

  if (orgInputEl) orgInputEl.value = '';
  renderExaminerSettingsTab();
  if (isCurrentUserAdmin()) {
    fetchAdminUsersList(true);
  }
  showOrgAlert(res.message || `✅ 服務單位已成功更新為「${newOrg}」！`, 'success');
  showToast('✅ 服務單位已成功更新！');
}

async function handleResetExaminerPin() {
  alert('💡 若忘記密碼，請登出後於登入畫面點擊「❓ 忘記密碼」，透過帳號、西元出生年月日與 Email 驗證重設密碼。');
}

// ==================== 管理員專屬：考官註冊審核 & 成員管理 ====================
async function fetchAdminUsersList(silent = false) {
  if (!isCurrentUserAdmin() || !getActiveGasUrl()) return;
  const res = await postToCloud({
    action: 'adminListUsers'
  });
  if (res && res.status === 'success' && Array.isArray(res.users)) {
    adminUsersCache = res.users;
    renderAdminUsersTable();
    if (!silent) {
      showToast(`👥 已同步成員清單（共 ${adminUsersCache.length} 位帳號）`);
    }
  } else if (!silent && res && res.message) {
    showToast(res.message);
  }
}

function renderAdminUsersTable() {
  const pendingBadge = document.getElementById('adminPendingReviewBadge');
  const pendingCount = (adminUsersCache || []).filter(u => u && u.status === 'pending_review').length;
  if (pendingBadge) {
    if (isCurrentUserAdmin() && pendingCount > 0) {
      pendingBadge.textContent = `${pendingCount} 待審核`;
      pendingBadge.classList.remove('hidden');
    } else {
      pendingBadge.classList.add('hidden');
    }
  }

  const tbody = document.getElementById('adminUsersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!Array.isArray(adminUsersCache) || adminUsersCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 20px;">目前尚無任何註冊考官帳號資料。</td></tr>`;
    return;
  }

  // 待審核排最前，其次管理員，再依建立時間排序
  const sorted = [...adminUsersCache].sort((a, b) => {
    if (a.status === 'pending_review' && b.status !== 'pending_review') return -1;
    if (b.status === 'pending_review' && a.status !== 'pending_review') return 1;
    if (a.role === 'admin' && b.role !== 'admin') return -1;
    if (b.role === 'admin' && a.role !== 'admin') return 1;
    return 0;
  });

  sorted.forEach(u => {
    const tr = document.createElement('tr');
    if (u.status === 'pending_review') {
      tr.style.background = '#fffbeb';
    }

    let statusBadgeHtml = '';
    if (u.status === 'pending_review') {
      statusBadgeHtml = '<span class="badge badge-amber">⏳ 待審核</span>';
    } else if (u.status === 'active') {
      statusBadgeHtml = '<span class="badge badge-teal">🟢 已啟用</span>';
    } else if (u.status === 'suspended') {
      statusBadgeHtml = '<span class="badge badge-danger">⛔ 已停用</span>';
    } else {
      statusBadgeHtml = '<span class="badge badge-secondary">❌ 已駁回</span>';
    }

    const roleBadgeHtml = u.role === 'admin'
      ? '<span class="badge badge-amber">👑管理員</span>'
      : '<span class="badge badge-secondary">👤考官</span>';

    const lockHtml = u.isLocked ? '<div><span class="badge badge-danger">🔒 錯誤過多鎖定中</span></div>' : '';
    const isMe = (currentExaminerProfile && currentExaminerProfile.userId === u.userId);

    tr.innerHTML = `
      <td style="white-space: nowrap;">
        <div style="display: flex; flex-direction: column; align-items: flex-start; gap: 4px;">
          <div>${statusBadgeHtml}</div>
          <div>${roleBadgeHtml}</div>
          ${lockHtml}
        </div>
      </td>
      <td style="white-space: nowrap;"><strong>${escapeHtml(u.username)}</strong>${isMe ? '<br><span class="badge badge-teal" style="margin-top:4px;">本人</span>' : ''}</td>
      <td style="white-space: nowrap;">${escapeHtml(u.displayName)}</td>
      <td style="min-width: 170px; word-break: break-word;">${escapeHtml(u.organization || '-')}</td>
      <td style="white-space: nowrap;">${escapeHtml(u.birthDate || '-')}</td>
      <td class="cell-wrap-email" style="min-width: 210px; font-size: 0.88rem; word-break: break-all;">${escapeHtml(u.email || '-')}</td>
      <td style="width: 145px; max-width: 155px; font-size: 0.76rem; line-height: 1.4; color: var(--text-muted);">
        <div style="margin-bottom: 4px;"><strong style="color: var(--text-secondary);">註冊：</strong><br>${escapeHtml(u.createdAt || '-')}</div>
        <div><strong style="color: var(--text-secondary);">最後登入：</strong><br>${escapeHtml(u.lastLoginAt || '尚未登入')}</div>
      </td>
      <td style="white-space: nowrap;">
        <div class="js-admin-actions" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
      </td>
    `;

    const actWrap = tr.querySelector('.js-admin-actions');
    if (actWrap) {
      if (u.status === 'pending_review') {
        const btnApprove = document.createElement('button');
        btnApprove.type = 'button';
        btnApprove.className = 'btn btn-primary btn-sm';
        btnApprove.textContent = '✅ 核准通過';
        btnApprove.onclick = () => handleAdminReviewUser(u.userId, u.displayName, 'approve');
        actWrap.appendChild(btnApprove);

        const btnReject = document.createElement('button');
        btnReject.type = 'button';
        btnReject.className = 'btn btn-danger-outline btn-sm';
        btnReject.textContent = '❌ 駁回';
        btnReject.onclick = () => handleAdminReviewUser(u.userId, u.displayName, 'reject');
        actWrap.appendChild(btnReject);
      } else {
        // 啟用 / 停用切換
        if (u.status === 'active') {
          const btnSuspend = document.createElement('button');
          btnSuspend.type = 'button';
          btnSuspend.className = 'btn btn-outline btn-sm';
          btnSuspend.textContent = '⛔ 停用';
          btnSuspend.disabled = isMe;
          btnSuspend.onclick = () => handleAdminUpdateUser(u.userId, u.displayName, { newStatus: 'suspended' });
          actWrap.appendChild(btnSuspend);
        } else {
          const btnActivate = document.createElement('button');
          btnActivate.type = 'button';
          btnActivate.className = 'btn btn-primary btn-sm';
          btnActivate.textContent = '✅ 啟用';
          btnActivate.onclick = () => handleAdminUpdateUser(u.userId, u.displayName, { newStatus: 'active', unlockAccount: true });
          actWrap.appendChild(btnActivate);
        }

        // 角色切換
        const nextRole = u.role === 'admin' ? 'examiner' : 'admin';
        const btnRole = document.createElement('button');
        btnRole.type = 'button';
        btnRole.className = 'btn btn-secondary btn-sm';
        btnRole.textContent = u.role === 'admin' ? '設為一般考官' : '設為管理員';
        btnRole.disabled = isMe;
        btnRole.onclick = () => handleAdminUpdateUser(u.userId, u.displayName, { newRole: nextRole });
        actWrap.appendChild(btnRole);

        // 協助重設密碼
        const btnResetPw = document.createElement('button');
        btnResetPw.type = 'button';
        btnResetPw.className = 'btn btn-secondary btn-sm';
        btnResetPw.textContent = '🔑 重設密碼';
        btnResetPw.onclick = () => handleAdminResetUserPassword(u.userId, u.username, u.displayName);
        actWrap.appendChild(btnResetPw);
      }

      // 刪除帳號
      if (!isMe) {
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn btn-danger-outline btn-sm';
        btnDel.textContent = '🗑️ 刪除';
        btnDel.onclick = () => handleAdminDeleteUser(u.userId, u.username, u.displayName);
        actWrap.appendChild(btnDel);
      }
    }

    tbody.appendChild(tr);
  });
}

async function handleAdminReviewUser(targetUserId, displayName, decision) {
  const actionText = decision === 'approve' ? '核准通過' : '駁回';
  if (!confirm(`確定要【${actionText}】考官「${displayName}」的註冊申請嗎？`)) return;
  const res = await postToCloud({
    action: 'adminReviewUser',
    targetUserId,
    decision
  });
  if (res && res.status === 'success') {
    if (Array.isArray(res.users)) adminUsersCache = res.users;
    renderAdminUsersTable();
    showToast(res.message || `已${actionText}申請！`);
  } else {
    alert((res && res.message) ? res.message : '操作失敗，請稍後再試');
  }
}

async function handleAdminUpdateUser(targetUserId, displayName, updates) {
  const res = await postToCloud(Object.assign({
    action: 'adminUpdateUser',
    targetUserId
  }, updates));
  if (res && res.status === 'success') {
    if (Array.isArray(res.users)) adminUsersCache = res.users;
    renderAdminUsersTable();
    showToast(res.message || `已更新「${displayName}」的帳號狀態`);
  } else {
    alert((res && res.message) ? res.message : '更新失敗');
  }
}

async function handleAdminResetUserPassword(targetUserId, username, displayName) {
  const newPassword = prompt(`請為考官【${displayName} (${username})】輸入新的登入密碼：\n\n（密碼長度須為 8~64 碼，且同時包含大寫英文、小寫英文與數字）`, '');
  if (newPassword === null) return;
  const cleanPw = newPassword.trim();
  if (!isStrongPasswordClient(cleanPw)) {
    alert('⚠️ 密碼格式不符！長度須至少 8 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」！');
    return;
  }
  const res = await postToCloud({
    action: 'adminResetUserPassword',
    targetUserId,
    newPassword: cleanPw
  });
  if (res && res.status === 'success') {
    if (Array.isArray(res.users)) adminUsersCache = res.users;
    renderAdminUsersTable();
    showToast(res.message || '已成功重設密碼！');
  } else {
    alert((res && res.message) ? res.message : '重設密碼失敗');
  }
}

async function handleAdminDeleteUser(targetUserId, username, displayName) {
  if (!confirm(`⚠️ 確定要永久刪除帳號【${displayName} (${username})】嗎？\n\n（刪除後該帳號將立即無法登入，其上傳過的試卷將自動保留並轉移至管理員名下）`)) return;
  const res = await postToCloud({
    action: 'adminDeleteUser',
    targetUserId
  });
  if (res && res.status === 'success') {
    if (Array.isArray(res.users)) adminUsersCache = res.users;
    renderAdminUsersTable();
    showToast(res.message || '已刪除帳號！');
  } else {
    alert((res && res.message) ? res.message : '刪除帳號失敗');
  }
}

function renderExaminerSettingsTab() {
  const isAdmin = isCurrentUserAdmin();
  const adminUsersCard = document.getElementById('adminUserManagementCard');
  const adminCloudCard = document.getElementById('adminCloudConfigCard');
  const ownUsernameEl = document.getElementById('ownProfileUsername');
  const ownNameOrgEl = document.getElementById('ownProfileNameAndOrg');
  const ownCurrentOrgEl = document.getElementById('ownProfileCurrentOrg');
  const currPwGroup = document.getElementById('currentPasswordGroup');

  // 管理員才可檢視與操作「註冊審核 & 成員管理」以及「Google 雲端資料庫 & 自動寄成績信設定」
  if (adminUsersCard) {
    adminUsersCard.classList.toggle('hidden', !isAdmin);
  }
  if (adminCloudCard) {
    adminCloudCard.classList.toggle('hidden', !isAdmin);
  }

  if (ownUsernameEl) {
    ownUsernameEl.textContent = (currentExaminerProfile && currentExaminerProfile.username) ? currentExaminerProfile.username : '-';
  }
  if (ownNameOrgEl) {
    const nameStr = (currentExaminerProfile && currentExaminerProfile.displayName) ? currentExaminerProfile.displayName : '-';
    const roleStr = isAdmin ? ' 【管理員】' : ' 【一般考官】';
    ownNameOrgEl.textContent = `${nameStr}${roleStr}`;
  }
  if (ownCurrentOrgEl) {
    ownCurrentOrgEl.textContent = (currentExaminerProfile && currentExaminerProfile.organization)
      ? currentExaminerProfile.organization
      : '尚未填寫';
  }

  if (currPwGroup) {
    currPwGroup.classList.remove('hidden');
  }
}

function showExaminerDashboard() {
  document.getElementById('examinerPinView').classList.add('hidden');
  document.getElementById('examinerDashboardView').classList.remove('hidden');
  renderExaminerSettingsTab();
  refreshExaminerAllViews(true);
}

function switchExaminerTab(tabId) {
  currentActiveExaminerTab = tabId;
  document.querySelectorAll('.dashboard-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  ['tabQuestions', 'tabScores', 'tabAnalytics', 'tabHistory', 'tabExamLink', 'tabSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== tabId);
  });

  if (tabId === 'tabSettings' && isCurrentUserAdmin()) {
    fetchAdminUsersList(true);
  }
  refreshExaminerAllViews();
}

function refreshExaminerAllViews(forceAll = false) {
  renderExamControlBanner();
  renderExaminerSettingsTab();
  updateCloudStatusUI();

  // 更新頁籤計數徽章
  const scoreBadge = document.getElementById('tabScoreCount');
  if (scoreBadge) scoreBadge.textContent = submissions.length;
  const histBadge = document.getElementById('tabHistoryCount');
  if (histBadge) histBadge.textContent = historySessions.length;

  // 效能優化：僅渲染目前活動的分頁，避免每次輪詢全量重建所有 DOM
  if (forceAll || currentActiveExaminerTab === 'tabQuestions') {
    renderExaminerQuestionTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabScores') {
    renderExaminerScoresTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabAnalytics') {
    renderExaminerAnalyticsTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabHistory') {
    renderExaminerHistoryTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabExamLink') {
    updateExamLinkTabUI();
  }
}

// ==================== 考官端頁籤 1：試卷庫與考題管理 (支援多份試卷獨立保存) ====================
function handleSelectExamFromLibrary(examId) {
  if (!examId) return;
  currentSelectedExamId = examId;
  refreshExaminerAllViews();
  const exam = getCurrentSelectedExam();
  if (exam) {
    showToast(`📖 已載入試卷【${exam.title || '未命名試卷'}】（共 ${(exam.questions || []).length} 題）`);
  }
}

function handleCreateNewExamPaper() {
  const defaultTitle = `新試卷 ${examLibrary.length + 1}`;
  const inputTitle = prompt('請輸入新試卷名稱：', defaultTitle);
  if (inputTitle === null) return;
  const title = inputTitle.trim() || defaultTitle;

  const isDup = examLibrary.some(e => e.title.trim().toLowerCase() === title.toLowerCase());
  if (isDup) {
    alert(`試卷庫中已存在同名試卷「${title}」，請使用其他名稱！`);
    return;
  }

  const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
  const myId = getCurrentExaminerUserId() || 'SYSTEM_ADMIN';
  const myName = (currentExaminerProfile && currentExaminerProfile.displayName) || '考官';
  const myOrg = (currentExaminerProfile && currentExaminerProfile.organization) || '';
  const newExam = {
    id: 'exam_' + Date.now(),
    title: title,
    examDate: todayStr,
    durationMinutes: 60,
    questions: [],
    ownerId: myId,
    ownerName: myName,
    ownerOrg: myOrg,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  examLibrary.push(newExam);
  currentSelectedExamId = newExam.id;
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`➕ 已建立新試卷「${title}」！您可直接開始新增考題或自左側匯入 Excel。`);
}

function isExamLockedForEditing(exam) {
  const target = exam || getCurrentSelectedExam();
  if (!target) return false;
  if (!canCurrentUserModifyExam(target)) return true;
  return Boolean(examData && examData.isExamOpen && examData.id === target.id);
}

function guardActiveExamEditing(exam, actionLabel = '異動此試卷') {
  const target = exam || getCurrentSelectedExam();
  if (target && !canCurrentUserModifyExam(target)) {
    const ownerLabel = target.ownerName || '其他考官';
    alert(`⛔ 權限限制：試卷「${target.title || '未命名試卷'}」是由考官【${ownerLabel}】所上傳，您無法${actionLabel}他人上傳的試卷！`);
    return true;
  }
  if (!isExamLockedForEditing(exam)) return false;
  const title = (target && target.title) ? target.title : (examData.title || '當前試卷');
  alert(`⛔ 試卷「${title}」正在測驗進行中！\n\n測驗進行中的試卷禁止${actionLabel}。\n請先於上方控制列點擊「結束作答」後再進行修改。`);
  return true;
}

function handleRenameExamPaper() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '重新命名')) return;
  const newTitle = prompt('請輸入此份試卷的新名稱：', currentExam.title || '');
  if (newTitle === null) return;
  const trimmed = newTitle.trim();
  if (!trimmed) {
    alert('試卷名稱不可為空白！');
    return;
  }

  const isDup = examLibrary.some(e => e.id !== currentExam.id && e.title.trim().toLowerCase() === trimmed.toLowerCase());
  if (isDup) {
    alert(`試卷庫中已存在同名試卷「${trimmed}」，請使用其他名稱！`);
    return;
  }

  currentExam.title = trimmed;
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.title = trimmed;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`✏️ 試卷已重新命名為「${trimmed}」！`);
}

function handleDeleteExamPaper() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) {
    alert('⚠️ 您目前尚未擁有任何試卷可刪除！');
    return;
  }
  // 限制 1：一般考官不可刪除他人上傳的試卷
  if (!canCurrentUserModifyExam(currentExam)) {
    const ownerLabel = currentExam.ownerName || '其他考官';
    alert(`⛔ 權限限制：試卷「${currentExam.title}」是由考官【${ownerLabel}】所上傳，您無法刪除他人上傳的試卷！`);
    return;
  }
  if (examData.id === currentExam.id && examData.isExamOpen) {
    alert(`⛔ 試卷「${currentExam.title}」目前正處於「測驗開放中」狀態！\n\n請先於上方控制列點擊「結束作答」後再進行刪除。`);
    return;
  }

  const qCount = (currentExam.questions || []).length;
  if (!confirm(`⚠️ 確定要自試卷庫中刪除試卷「${currentExam.title}」嗎？\n\n（此試卷內含 ${qCount} 題考題將一併刪除，此操作無法復原）`)) {
    return;
  }

  examLibrary = examLibrary.filter(e => e.id !== currentExam.id);
  const nextExam = getCurrentSelectedExam();
  currentSelectedExamId = nextExam ? nextExam.id : '';

  if (examData.id === currentExam.id) {
    if (nextExam) {
      examData = {
        ...nextExam,
        isExamOpen: false
      };
    } else {
      examData = JSON.parse(JSON.stringify(DEFAULT_EXAM_DATA));
    }
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`🗑️ 已自試卷庫中刪除試卷「${currentExam.title}」！`);
}

function handleApplyAsActiveExam() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (!canCurrentUserModifyExam(currentExam)) {
    const ownerLabel = currentExam.ownerName || '其他考官';
    alert(`⛔ 權限限制：試卷「${currentExam.title}」是由考官【${ownerLabel}】所上傳，您僅能將自己上傳的試卷設為當前測驗試卷！`);
    return;
  }
  if (examData.id === currentExam.id) {
    showToast(`此試卷【${currentExam.title}】已經是當前測驗試卷！`);
    return;
  }

  // 當有測驗正在開放中，如欲套用的試卷與開放中的試卷不相同時，跳出提醒並不讓使用者覆蓋
  if (examData.isExamOpen) {
    alert(
      `⛔ 目前正在測驗中！\n\n試卷【${examData.title || '未命名測驗'}】目前正處於「測驗開放中」狀態。\n若將其他試卷設為當前會影響目前進行中的測驗與線上考生作答！\n\n如需切換為此試卷，請先於上方控制列點擊「結束作答」關閉測驗後再進行更換。`
    );
    return;
  }

  if (submissions.length > 0 && canCurrentUserManageActiveSession()) {
    const shouldArchive = confirm(
      `⚠️ 切換測驗試卷前提醒：\n目前場次已有 ${submissions.length} 位考生的交卷成績！\n\n是否先將當前場次的考生成績封存為「歷次測驗紀錄」並清空當前名單？`
    );
    if (shouldArchive) {
      createAndSaveHistorySession(`${examData.title || '未命名測驗'} (${examData.examDate || '-'})`, true);
    }
  }

  const myId = getCurrentExaminerUserId() || 'SYSTEM_ADMIN';
  const myName = (currentExaminerProfile && currentExaminerProfile.displayName) || '考官';
  examData = {
    id: currentExam.id,
    title: currentExam.title,
    examDate: currentExam.examDate,
    durationMinutes: currentExam.durationMinutes,
    ownerId: currentExam.ownerId || myId,
    ownerName: currentExam.ownerName || myName,
    isExamOpen: false,
    questions: JSON.parse(JSON.stringify(currentExam.questions || []))
  };

  saveExamDataToStorage(true);
  refreshExaminerAllViews();
  showToast(`✅ 已將試卷【${currentExam.title}】設為當前測驗試卷（目前為關閉狀態，確認無誤後可點擊上方開放作答）！`);
}

function setupExamMetaAutoSync() {
  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');

  const syncMetaFromInputs = (pushCloud = false) => {
    const currentExam = getCurrentSelectedExam();
    if (!currentExam) return;
    if (isExamLockedForEditing(currentExam)) {
      if (titleInput) titleInput.value = currentExam.title ?? '';
      if (dateInput) dateInput.value = normalizeDateForInput(currentExam.examDate ?? '');
      if (durationInput) durationInput.value = currentExam.durationMinutes === '' ? '' : (currentExam.durationMinutes ?? 60);
      return;
    }
    if (titleInput) currentExam.title = titleInput.value.trim();
    if (dateInput) currentExam.examDate = normalizeDateForInput(dateInput.value);
    if (durationInput) {
      const rawVal = durationInput.value.trim();
      currentExam.durationMinutes = rawVal === '' ? '' : Math.max(1, Number(rawVal) || 60);
    }
    currentExam.updatedAt = new Date().toISOString();

    // 即時更新下拉選單文字
    const libSelect = document.getElementById('examLibrarySelect');
    if (libSelect && libSelect.selectedOptions && libSelect.selectedOptions[0]) {
      const isActive = examData && examData.id === currentExam.id;
      const statusMark = isActive ? (examData.isExamOpen ? '　【🟢測驗進行中】' : '　【📍當前試卷】') : '';
      libSelect.selectedOptions[0].textContent = `${currentExam.title || '未命名試卷'} (${(currentExam.questions || []).length} 題)${statusMark}`;
    }

    if (examData.id === currentExam.id) {
      examData.title = currentExam.title;
      examData.examDate = currentExam.examDate;
      examData.durationMinutes = currentExam.durationMinutes;
      saveExamDataToStorage(pushCloud);
    }
    saveExamLibraryToStorage(pushCloud);
  };

  [titleInput, dateInput, durationInput].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => syncMetaFromInputs(false));
    el.addEventListener('change', () => syncMetaFromInputs(true));
  });
}

function renderExaminerQuestionTab() {
  const currentExam = getCurrentSelectedExam();
  const hasNoOwnedExam = !currentExam;
  const noExamNotice = document.getElementById('noOwnedExamNotice');
  if (noExamNotice) {
    noExamNotice.classList.toggle('hidden', !hasNoOwnedExam);
  }

  // 1. 渲染試卷庫下拉選單 (一般考官僅顯示自己上傳的試卷，或若他人試卷正在測驗中則標示擁有者唯讀；管理員可檢視與管理全部試卷)
  const libSelect = document.getElementById('examLibrarySelect');
  if (libSelect) {
    libSelect.innerHTML = '';
    if (hasNoOwnedExam) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '（您尚未擁有任何試卷，請先建立新試卷或匯入考題）';
      libSelect.appendChild(emptyOpt);
      libSelect.value = '';
    } else {
      examLibrary.forEach(exam => {
        if (!isCurrentUserAdmin() && !canCurrentUserModifyExam(exam) && (!examData || examData.id !== exam.id)) {
          return;
        }
        const opt = document.createElement('option');
        opt.value = exam.id;
        const isActive = examData && examData.id === exam.id;
        const statusMark = isActive ? (examData.isExamOpen ? '　【🟢測驗進行中】' : '　【📍當前試卷】') : '';
        const ownerMark = exam.ownerName ? ` (by ${exam.ownerName})` : '';
        opt.textContent = `${exam.title || '未命名試卷'}  ${ownerMark} ${statusMark}`;
        libSelect.appendChild(opt);
      });
      libSelect.value = currentExam.id;
    }
  }

  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');
  const metaSubmitBtn = document.querySelector('#examMetaForm button[type="submit"]');
  const btnApply = document.getElementById('btnApplyAsActiveExam');
  const tbody = document.getElementById('questionsTableBody');

  if (hasNoOwnedExam) {
    if (btnApply) btnApply.style.display = 'none';
    if (titleInput) {
      titleInput.value = '';
      titleInput.disabled = true;
      titleInput.classList.add('input-locked');
    }
    if (dateInput) {
      dateInput.value = '';
      dateInput.disabled = true;
      dateInput.classList.add('input-locked');
    }
    if (durationInput) {
      durationInput.value = '';
      durationInput.disabled = true;
      durationInput.classList.add('input-locked');
    }
    if (metaSubmitBtn) {
      metaSubmitBtn.disabled = true;
      metaSubmitBtn.title = '請先建立新試卷或匯入考題';
    }
    document.getElementById('metaValidQCount').textContent = '0';
    document.getElementById('metaPointsPerQ').textContent = '0';
    document.getElementById('questionTableCount').textContent = '0';
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 28px;">💡 您目前尚未擁有任何試卷！請點擊上方「<strong>➕ 建立新試卷</strong>」或自「<strong>📥 匯入考題 Excel / CSV</strong>」匯入題庫。</td></tr>`;
    }
    return;
  }

  // 2. 顯示當前選中試卷是否為活動測驗試卷的徽章與套用按鈕
  const isCurrentActive = examData && examData.id === currentExam.id;

  if (btnApply) {
    btnApply.style.display = isCurrentActive ? 'none' : 'inline-block';
  }

  const qCount = (currentExam.questions || []).length;
  const pts = getPointsPerQuestion(qCount);

  if (titleInput && document.activeElement !== titleInput) {
    titleInput.value = currentExam.title ?? '';
  }
  if (dateInput && document.activeElement !== dateInput) {
    dateInput.value = normalizeDateForInput(currentExam.examDate ?? '');
  }
  if (durationInput && document.activeElement !== durationInput) {
    durationInput.value = currentExam.durationMinutes === '' ? '' : (currentExam.durationMinutes ?? 60);
  }

  const isLocked = isExamLockedForEditing(currentExam);
  [titleInput, dateInput, durationInput].forEach(el => {
    if (!el) return;
    el.disabled = isLocked;
    el.classList.toggle('input-locked', isLocked);
  });
  if (metaSubmitBtn) {
    metaSubmitBtn.disabled = isLocked;
    metaSubmitBtn.title = isLocked ? '測驗進行中，禁止修改試卷資訊' : '';
  }

  document.getElementById('metaValidQCount').textContent = qCount;
  document.getElementById('metaPointsPerQ').textContent = pts;
  document.getElementById('questionTableCount').textContent = qCount;

  tbody.innerHTML = '';

  if (qCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 24px;">目前試卷【${escapeHtml(currentExam.title)}】為空白（0 題），可從上方匯入 Excel 範本或點擊「➕ 手動新增題目」</td></tr>`;
    return;
  }

  currentExam.questions.forEach((q, idx) => {
    const tr = document.createElement('tr');
    const formattedOpts = (q.options || [])
      .map(o => `<span class="badge badge-teal" style="margin-right:4px;">${o.key}</span>${escapeHtml(o.text)}`)
      .join('<br>');

    const displayTableImg = formatGoogleDriveImageUrl(q.imageUrl);
    const imgBadge = displayTableImg
      ? `<br><span class="table-img-badge js-table-lightbox" data-img-url="${escapeHtml(displayTableImg)}" data-caption="第 ${idx + 1} 題圖檔">🖼️ 查看圖片</span>`
      : '';

    const isMulti = isMultipleChoiceQuestion(q);
    const multiBadge = isMulti
      ? '<br><span class="badge badge-teal" style="margin-top:4px;font-size:0.75rem;">複選題</span>'
      : '';

    let scoreRuleHtml = '';
    if (isMulti) {
      if (q.multiScoreRule === 'all') {
        scoreRuleHtml = '<br><span class="badge badge-teal" style="margin-top:4px;font-size:0.75rem;">全對得分</span>';
      } else if (q.multiScoreRule === 'any') {
        scoreRuleHtml = '<br><span class="badge badge-teal" style="margin-top:4px;font-size:0.75rem;">對一項即得分</span>';
      } else {
        scoreRuleHtml = `<br><span class="score-rule-warn-badge js-edit-q-btn" title="此複選題尚未設定得分方式，點擊進入編輯設定">⚠️ 未設定得分方式</span>`;
      }
    }

    tr.innerHTML = `
      <td><strong>#${idx + 1}</strong></td>
      <td>${escapeHtml(q.question)}${imgBadge}</td>
      <td style="font-size: 0.86rem; line-height: 1.7;">${formattedOpts}</td>
      <td><span class="badge badge-amber" style="font-size:0.9rem;">${escapeHtml(q.answer)}</span>${multiBadge}</td>
      <td>${pts} 分${scoreRuleHtml}</td>
      <td style="white-space: nowrap;">
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn btn-secondary btn-sm js-edit-q-btn">編輯</button>
          <button type="button" class="btn btn-danger-outline btn-sm js-del-q-btn">刪除</button>
        </div>
      </td>
    `;
    const lbBtn = tr.querySelector('.js-table-lightbox');
    if (lbBtn) {
      lbBtn.addEventListener('click', () => {
        openImageLightbox(lbBtn.dataset.imgUrl, lbBtn.dataset.caption);
      });
    }
    tr.querySelectorAll('.js-edit-q-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditQuestionModal(q.id));
    });
    const delBtn = tr.querySelector('.js-del-q-btn');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteQuestion(q.id));
    }
    tbody.appendChild(tr);
  });
}

function saveExamMetadata(event) {
  event.preventDefault();
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '修改試卷資訊（名稱、日期、作答時間）')) return;

  currentExam.title = document.getElementById('metaExamTitle').value.trim();
  currentExam.examDate = normalizeDateForInput(document.getElementById('metaExamDate').value.trim());
  const rawDuration = document.getElementById('metaExamDuration').value.trim();
  currentExam.durationMinutes = rawDuration === '' ? '' : Math.max(1, Number(rawDuration) || 60);
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.title = currentExam.title;
    examData.examDate = currentExam.examDate;
    examData.durationMinutes = currentExam.durationMinutes;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`已成功儲存試卷【${currentExam.title}】的設定並同步至試卷資料庫！`, 'success');
}

function deleteQuestion(qId) {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '刪除題目')) return;
  const targetQ = currentExam.questions.find(q => q.id === qId);
  const qPreview = targetQ && targetQ.question ? `\n\n題目：${targetQ.question}` : '';
  if (!confirm(`確定要刪除第 ${qId} 題嗎？${qPreview}`)) return;

  currentExam.questions = currentExam.questions.filter(q => q.id !== qId);
  // 重新編號
  currentExam.questions.forEach((q, i) => {
    q.id = i + 1;
  });
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = currentExam.questions;
    if (examData.questions.length === 0) {
      examData.isExamOpen = false;
    }
    saveExamDataToStorage(true);
  }
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
}

function clearAllQuestions() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '清空全部題目')) return;
  const hasQuestions = (currentExam.questions || []).length > 0;
  if (!hasQuestions) return;
  if (!confirm(`確定要清空試卷「${currentExam.title}」中的所有考題嗎？`)) return;

  currentExam.questions = [];
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = [];
    examData.isExamOpen = false;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`已清空試卷「${currentExam.title}」中的所有題目。`, 'success');
}

function setModalMultiScoreRule(rule) {
  const radios = document.querySelectorAll('input[name="newQMultiScoreRule"]');
  radios.forEach(r => {
    r.checked = (rule !== undefined && rule !== '' && r.value === rule);
  });
}

function updateAnswerTypeHint() {
  const hintEl = document.getElementById('newQAnswerTypeHint');
  const ruleGroup = document.getElementById('multiScoreRuleGroup');
  const radios = document.querySelectorAll('input[name="newQMultiScoreRule"]');
  const checkedCount = document.querySelectorAll('#newQAnswerGroup input[type="checkbox"]:checked').length;
  const isMulti = checkedCount >= 2;

  radios.forEach(r => {
    r.disabled = !isMulti;
  });

  const hasRuleSelected = Array.from(radios).some(r => r.checked);

  if (ruleGroup) {
    ruleGroup.classList.toggle('disabled', !isMulti);
    ruleGroup.classList.toggle('needs-selection', isMulti && !hasRuleSelected);
  }

  if (!hintEl) return;
  if (isMulti) {
    if (!hasRuleSelected) {
      hintEl.innerHTML = `<span style="color: var(--danger); font-weight: 700;">（已選 ${checkedCount} 個答案 → 複選題，請選擇得分規則）</span>`;
    } else {
      hintEl.innerHTML = `<span style="color: var(--danger); font-weight: 700;">（已選 ${checkedCount} 個答案 → 複選題）</span>`;
    }
  } else if (checkedCount === 1) {
    hintEl.textContent = '（單選題）';
  } else {
    hintEl.textContent = '（答案 2 個以上 → 複選題）';
  }
}

function handleModalAnswerCheckboxChange(checkboxEl) {
  const pill = checkboxEl ? checkboxEl.closest('.answer-checkbox-pill') : null;
  if (pill) {
    pill.classList.toggle('checked', checkboxEl.checked);
  }
  updateAnswerTypeHint();
}

function syncAnswerSelectWithOptions(preferredAnswer) {
  const optionsEl = document.getElementById('newQOptions');
  const answerGroup = document.getElementById('newQAnswerGroup');
  if (!optionsEl || !answerGroup) return;

  let selectedStr = '';
  if (preferredAnswer !== undefined) {
    selectedStr = normalizeAnswerString(preferredAnswer);
  } else {
    const checkedVals = Array.from(answerGroup.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    selectedStr = normalizeAnswerString(checkedVals.join(''));
  }

  const parsedOptions = parseOptionsString(optionsEl.value);
  answerGroup.innerHTML = '';

  if (parsedOptions.length === 0) {
    answerGroup.innerHTML = '<span class="text-muted text-sm">請先於上方輸入選項內容（每行一項）</span>';
    updateAnswerTypeHint();
    return;
  }

  let selectedSet = new Set(selectedStr.split('').filter(key => parsedOptions.some(o => o.key === key)));
  if (selectedSet.size === 0 && preferredAnswer !== undefined && preferredAnswer !== '') {
    selectedSet.add(parsedOptions[0].key);
  }

  parsedOptions.forEach(opt => {
    const isChecked = selectedSet.has(opt.key);
    const label = document.createElement('label');
    label.className = `answer-checkbox-pill${isChecked ? ' checked' : ''}`;
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(opt.key)}" ${isChecked ? 'checked' : ''} onchange="handleModalAnswerCheckboxChange(this)">
      <span>${escapeHtml(opt.key)}</span>
    `;
    answerGroup.appendChild(label);
  });

  updateAnswerTypeHint();
}

function openAddQuestionModal() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) {
    alert('⚠️ 您目前尚未擁有任何試卷！請先點擊上方「➕ 建立新試卷」或「📥 匯入考題 Excel / CSV」建立試卷後再新增題目。');
    return;
  }
  if (guardActiveExamEditing(currentExam, '新增題目')) return;
  editingQuestionId = null;
  document.getElementById('addQuestionForm').reset();
  const titleEl = document.getElementById('questionModalTitle');
  const submitBtn = document.getElementById('questionModalSubmitBtn');
  if (titleEl) titleEl.textContent = '新增題目';
  if (submitBtn) submitBtn.textContent = '新增題目';
  setQuestionModalImageState('');
  setModalMultiScoreRule('');
  syncAnswerSelectWithOptions('A');
  document.getElementById('addQuestionModal').classList.remove('hidden');
}

function openEditQuestionModal(qId) {
  const currentExam = getCurrentSelectedExam();
  if (guardActiveExamEditing(currentExam, '編輯題目內容')) return;
  const targetQ = (currentExam ? currentExam.questions : examData.questions).find(q => q.id === qId);
  if (!targetQ) return;

  editingQuestionId = qId;
  const titleEl = document.getElementById('questionModalTitle');
  const submitBtn = document.getElementById('questionModalSubmitBtn');
  if (titleEl) titleEl.textContent = `✏️ 編輯第 ${qId} 題`;
  if (submitBtn) submitBtn.textContent = '儲存修改';

  document.getElementById('newQText').value = targetQ.question || '';
  const formattedLines = Array.isArray(targetQ.options) && targetQ.options.length > 0
    ? targetQ.options.map(o => `(${o.key}) ${o.text}`).join('\n')
    : (targetQ.rawOptions || '');
  document.getElementById('newQOptions').value = formattedLines;
  setModalMultiScoreRule(targetQ.multiScoreRule || '');
  syncAnswerSelectWithOptions(normalizeAnswerString(targetQ.answer || 'A'));

  setQuestionModalImageState(targetQ.imageUrl || '');
  document.getElementById('addQuestionModal').classList.remove('hidden');
}

function closeAddQuestionModal() {
  editingQuestionId = null;
  setQuestionModalImageState('');
  document.getElementById('addQuestionModal').classList.add('hidden');
}

/**
 * 將各類 Google 雲端硬碟檔案連結格式自動轉換為可跨域直接在 <img> 標籤中載入的直連圖片網址
 */
function formatGoogleDriveImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const url = rawUrl.trim();

  // 若為 Data URL 或一般外鏈非 Google Drive 圖片，直接返回
  if (url.startsWith('data:')) {
    return url;
  }

  // 匹配 Google Drive File ID 的各種常見格式
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/open\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/uc\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/thumbnail\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/i,
    /googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/i
  ];

  for (const reg of patterns) {
    const match = url.match(reg);
    if (match && match[1]) {
      const fileId = match[1];
      // 優先使用 Google 官方 CDN 直連網址，支援跨域嵌入 <img>
      return `https://lh3.googleusercontent.com/d/${fileId}`;
    }
  }

  return url;
}

/**
 * 取得圖片載入失敗時的自動 fallback 屬性 (若 lh3.googleusercontent.com 失敗則切換至 drive thumbnail)
 */
function getImageOnErrorAttr(url) {
  if (!url) return '';
  const fileIdMatch = String(url).match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
  if (!fileIdMatch) return '';
  const fileId = fileIdMatch[1];
  return `onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='https://drive.google.com/thumbnail?id=${fileId}&sz=w1600';}"`;
}

function setQuestionModalImageState(url, localPreviewUrl) {
  const formattedUrl = formatGoogleDriveImageUrl(url);
  const urlInput = document.getElementById('newQImageUrl');
  const previewWrap = document.getElementById('newQImagePreviewWrap');
  const previewImg = document.getElementById('newQImagePreview');
  const btnClear = document.getElementById('btnClearQImage');
  const statusEl = document.getElementById('qImageUploadStatus');

  if (urlInput) urlInput.value = formattedUrl || '';
  if (statusEl) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
  }

  const effectiveSrc = localPreviewUrl || formattedUrl;

  if (effectiveSrc) {
    if (previewImg) {
      previewImg.removeAttribute('data-fallback');
      previewImg.src = effectiveSrc;
      const fileIdMatch = formattedUrl.match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
      if (fileIdMatch && !localPreviewUrl) {
        const fileId = fileIdMatch[1];
        previewImg.onerror = function () {
          if (!this.dataset.fallback) {
            this.dataset.fallback = '1';
            this.src = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
          }
        };
      } else {
        previewImg.onerror = null;
      }
    }
    if (previewWrap) previewWrap.classList.remove('hidden');
    if (btnClear) btnClear.classList.remove('hidden');
  } else {
    if (previewImg) {
      previewImg.src = '';
      previewImg.onerror = null;
    }
    if (previewWrap) previewWrap.classList.add('hidden');
    if (btnClear) btnClear.classList.add('hidden');
  }
}

function handleImageUrlInput() {
  const urlInput = document.getElementById('newQImageUrl');
  if (!urlInput) return;
  const rawUrl = urlInput.value.trim();
  if (rawUrl) {
    const formatted = formatGoogleDriveImageUrl(rawUrl);
    setQuestionModalImageState(formatted);
  } else {
    setQuestionModalImageState('');
  }
}

function clearQuestionImage() {
  setQuestionModalImageState('');
}

async function handleQuestionImageSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  await uploadQuestionImageFile(file);
}

async function handleQuestionImagePaste(event) {
  const clipboardData = event.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  let imageFile = null;
  if (clipboardData.items) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.type && item.type.startsWith('image/')) {
        imageFile = item.getAsFile();
        break;
      }
    }
  }
  if (!imageFile && clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const f = clipboardData.files[i];
      if (f.type && f.type.startsWith('image/')) {
        imageFile = f;
        break;
      }
    }
  }

  // 若剪貼簿並非圖片（例如是一般圖片網址文字），放行預設貼上文字行為
  if (!imageFile) return;

  event.preventDefault();
  event.stopPropagation();

  const ext = (imageFile.type && imageFile.type.split('/')[1]) ? imageFile.type.split('/')[1].replace(/[^a-z0-9]/gi, '') : 'png';
  const customFileName = `paste_${Date.now()}.${ext || 'png'}`;
  await uploadQuestionImageFile(imageFile, customFileName);
}

async function uploadQuestionImageFile(file, customFileName) {
  if (!file) return;

  // M1 安全加固：前端限制僅允許上傳安全點陣圖格式 (PNG, JPEG, GIF, WEBP)，禁止 SVG/HTML 等可能夾帶腳本之檔案
  const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
  const fileMime = String(file.type || '').trim().toLowerCase();
  if (!ALLOWED_MIMES.includes(fileMime)) {
    alert('⚠️ 不支援的圖片格式！僅允許上傳 PNG、JPG、GIF 或 WEBP 圖片檔案。');
    return;
  }

  const gasUrl = getActiveGasUrl();
  const statusEl = document.getElementById('qImageUploadStatus');
  const btnUpload = document.getElementById('btnUploadQImage');

  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = '⏳ 正在讀取並準備上傳圖片...';
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const dataUrl = e.target.result;
    const base64Index = dataUrl.indexOf(',');
    const base64Data = base64Index !== -1 ? dataUrl.substring(base64Index + 1) : dataUrl;

    if (gasUrl) {
      if (statusEl) statusEl.textContent = '☁️ 正在上傳圖檔至 Google 雲端硬碟資料夾...';
      if (btnUpload) btnUpload.disabled = true;

      const res = await postToCloud({
        action: 'uploadQuestionImage',
        base64Data: base64Data,
        mimeType: file.type || 'image/png',
        fileName: customFileName || file.name || 'question.png'
      });

      if (btnUpload) btnUpload.disabled = false;

      if (res && res.status === 'success' && res.imageUrl) {
        // 設定雲端直連網址並以本機 dataUrl 確保預覽立即順暢顯示
        setQuestionModalImageState(res.imageUrl, dataUrl);
        if (statusEl) {
          statusEl.classList.remove('hidden');
          statusEl.style.color = '#15803d';
          statusEl.textContent = '✅ 圖片已成功上傳至指定 Google 雲端硬碟！';
        }
        showToast('🖼️ 考題圖片已成功上傳至雲端資料夾！');
        return;
      } else {
        const errMsg = (res && res.message) ? res.message : '雲端上傳回應異常';
        if (String(errMsg).includes('DriveApp') || String(errMsg).includes('權限') || String(errMsg).includes('authorization')) {
          alert(`【Google 雲端硬碟尚未授權】\n\n原因：Google 尚未授予此 Apps Script 存取 Google 雲端硬碟 (DriveApp) 的權限。\n\n解決步驟：\n1. 打開 Google 試算表的「擴充功能」>「Apps Script」\n2. 上方執行函式下拉選單選擇「testDriveAuthorization」並點選「執行」\n3. 依提示完成 Google 帳號授權（核對權限 -> 進階 -> 前往 -> 允許）\n4. 點選右上角「部署」>「管理部署作業」> 點鉛筆圖示「編輯」> 版本選擇「建立新版本」後儲存即可！\n\n（本次系統已自動改用本機圖片預覽）`);
        } else {
          alert(`上傳至雲端硬碟失敗（${errMsg}），系統將自動使用本機圖片預覽。`);
        }
      }
    }

    // 若尚未連線雲端或連線失敗，以 Data URL 作為本地備援
    setQuestionModalImageState(dataUrl);
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.style.color = '#d97706';
      statusEl.textContent = '⚠️ 已以本機圖片載入（若連線雲端可自動上傳至雲端硬碟備份）';
    }
  };
  reader.readAsDataURL(file);
}

function handleSaveNewQuestion(event) {
  event.preventDefault();
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, editingQuestionId !== null ? '編輯題目內容' : '新增題目')) {
    closeAddQuestionModal();
    return;
  }

  const qText = document.getElementById('newQText').value.trim();
  const rawOpts = document.getElementById('newQOptions').value.trim();
  const checkedBoxes = Array.from(document.querySelectorAll('#newQAnswerGroup input[type="checkbox"]:checked'));
  const ans = normalizeAnswerString(checkedBoxes.map(cb => cb.value).join(''));
  const rawImgUrl = (document.getElementById('newQImageUrl') ? document.getElementById('newQImageUrl').value.trim() : '');
  const imgUrl = formatGoogleDriveImageUrl(rawImgUrl);

  const parsedOptions = parseOptionsString(rawOpts);
  if (parsedOptions.length < 2) {
    alert('請輸入至少 2 個選項（每行一個選項）！');
    return;
  }

  if (!ans) {
    alert('請至少勾選 1 個標準答案！');
    return;
  }

  const isMultiple = ans.length >= 2;
  const selectedRuleEl = document.querySelector('input[name="newQMultiScoreRule"]:checked');
  const multiScoreRule = isMultiple ? (selectedRuleEl ? selectedRuleEl.value : '') : '';

  if (editingQuestionId !== null) {
    const targetQ = currentExam.questions.find(q => q.id === editingQuestionId);
    if (targetQ) {
      const prevAns = normalizeAnswerString(targetQ.answer);
      const prevRule = targetQ.multiScoreRule || '';
      targetQ.question = qText;
      targetQ.rawOptions = rawOpts;
      targetQ.options = parsedOptions;
      targetQ.answer = ans;
      targetQ.isMultiple = isMultiple;
      targetQ.multiScoreRule = multiScoreRule;
      targetQ.imageUrl = imgUrl;

      // 若目前選取的試卷恰為當前進行中的測驗且已有考生交卷，考官修改答案或得分規則時同步重算考生成績
      if (examData.id === currentExam.id && (prevAns !== ans || prevRule !== multiScoreRule) && submissions.length > 0) {
        const totalQ = examData.questions.length;
        submissions.forEach(sub => {
          if (sub.answerDetails && sub.answerDetails[targetQ.id]) {
            const d = sub.answerDetails[targetQ.id];
            d.correctAnswer = ans;
            d.isCorrect = evaluateQuestionCorrectness(targetQ, d.selected);
          }
          let newCorrectCount = 0;
          examData.questions.forEach(q => {
            const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
            if (detail && detail.isCorrect) newCorrectCount++;
          });
          sub.correctCount = newCorrectCount;
          sub.totalQuestions = totalQ;
          sub.score = totalQ > 0 ? Number(((newCorrectCount / totalQ) * 100).toFixed(1)) : 0;
        });
        saveSubmissionsToStorage(true);
      }
    }

    currentExam.updatedAt = new Date().toISOString();
    if (examData.id === currentExam.id) {
      examData.questions = currentExam.questions;
      saveExamDataToStorage(true);
    }
    saveExamLibraryToStorage(true);
    closeAddQuestionModal();
    refreshExaminerAllViews();
    showImportAlert(`已成功更新試卷【${currentExam.title}】內容並同步至試卷庫！`, 'success');
    return;
  }

  const newId = (currentExam.questions || []).length + 1;
  currentExam.questions.push({
    id: newId,
    question: qText,
    imageUrl: imgUrl,
    rawOptions: rawOpts,
    options: parsedOptions,
    answer: ans,
    isMultiple: isMultiple,
    multiScoreRule: multiScoreRule
  });
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = currentExam.questions;
    saveExamDataToStorage(true);
  }
  saveExamLibraryToStorage(true);
  closeAddQuestionModal();
  refreshExaminerAllViews();
  showImportAlert(`已新增第 ${newId} 題至試卷【${currentExam.title}】！`, 'success');
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
        const cleanAns = normalizeAnswerString(answerText) || 'A';

        parsedQuestions.push({
          id: parsedQuestions.length + 1,
          question: questionText,
          rawOptions: rawOptionsText,
          options: optionsArr,
          answer: cleanAns,
          isMultiple: cleanAns.length >= 2,
          multiScoreRule: ''
        });
      }

      r = k - 1;
    }
  }

  const fileBaseTitle = fileName.replace(/\.[^/.]+$/, '').replace(/_考題範本$/, '').trim() || '匯入試卷';
  const existingExam = examLibrary.find(e => e.title.trim().toLowerCase() === fileBaseTitle.toLowerCase() && canCurrentUserModifyExam(e));

  if (existingExam) {
    const shouldOverwrite = confirm(
      `偵測到試卷庫中已存在同名試卷「${fileBaseTitle}」（現有 ${(existingExam.questions || []).length} 題）！\n\n【確定】：覆蓋更新原試卷「${fileBaseTitle}」的題目內容\n【取消】：另存為新試卷（將另存為新版試卷獨立保存）`
    );

    if (shouldOverwrite) {
      if (guardActiveExamEditing(existingExam, '匯入覆蓋題目')) return;
      if (examData.id === existingExam.id && submissions.length > 0) {
        const shouldArchive = confirm(
          `提醒：當前場次已有 ${submissions.length} 位考生的交卷成績！\n\n是否先將當前場次的考生成績封存為「歷次測驗紀錄」並清空當前名單？`
        );
        if (shouldArchive) {
          createAndSaveHistorySession(`${examData.title || '未命名測驗'} (${examData.examDate || '-'})`, true);
        }
      }

      existingExam.questions = parsedQuestions;
      existingExam.updatedAt = new Date().toISOString();
      currentSelectedExamId = existingExam.id;

      if (examData.id === existingExam.id) {
        examData.questions = parsedQuestions;
        saveExamDataToStorage(true);
      }

      saveExamLibraryToStorage(true);
      refreshExaminerAllViews();
      showImportAlert(`已成功覆蓋更新試卷「${fileBaseTitle}」！共讀取 ${parsedQuestions.length} 題有效題目。`, 'success');
      return;
    } else {
      // 另存為新試卷
      let newTitle = `${fileBaseTitle} (新版)`;
      let counter = 2;
      while (examLibrary.some(e => e.title.trim().toLowerCase() === newTitle.toLowerCase())) {
        newTitle = `${fileBaseTitle} (新版 ${counter++})`;
      }

      const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
      const newExam = {
        id: 'exam_' + Date.now(),
        title: newTitle,
        examDate: todayStr,
        durationMinutes: 60,
        questions: parsedQuestions,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      examLibrary.push(newExam);
      currentSelectedExamId = newExam.id;
      saveExamLibraryToStorage(true);
      refreshExaminerAllViews();
      showImportAlert(`已將題目另存為新試卷「${newTitle}」！共讀取 ${parsedQuestions.length} 題有效題目。`, 'success');
      return;
    }
  }

  // 試卷庫中尚無同名試卷，直接新建一份
  const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
  const newExam = {
    id: 'exam_' + Date.now(),
    title: fileBaseTitle,
    examDate: todayStr,
    durationMinutes: 60,
    questions: parsedQuestions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  examLibrary.push(newExam);
  currentSelectedExamId = newExam.id;
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`成功自「${fileName}」匯入新試卷「${fileBaseTitle}」至試卷庫！共讀取 ${parsedQuestions.length} 題有效題目。`, 'success');
}

function parseOptionsString(rawStr) {
  const lines = String(rawStr)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const result = [];
  const usedKeys = new Set();

  lines.forEach((line, idx) => {
    const defaultKey = idx < 26 ? String.fromCharCode(65 + idx) : String(idx + 1);
    const match = line.match(/^[\(\[（]?([A-Za-z])[\)\]）．.、]+\s*(.*)$/);
    if (match) {
      const parsedKey = match[1].toUpperCase();
      const finalKey = usedKeys.has(parsedKey) ? defaultKey : parsedKey;
      usedKeys.add(finalKey);
      result.push({
        key: finalKey,
        text: match[2].trim()
      });
    } else {
      usedKeys.add(defaultKey);
      result.push({
        key: defaultKey,
        text: line
      });
    }
  });

  return result;
}

function showImportAlert(msg, type) {
  const boxes = document.querySelectorAll('#importAlertBox');
  boxes.forEach(box => {
    box.textContent = msg;
    box.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
    box.classList.remove('hidden');
  });
}

function downloadSampleExcel(event) {
  showToast('📥 正在下載「考題匯入範本.xlsx」...');
  const sampleFileName = '考題匯入範本.xlsx';
  const githubRawUrl = 'https://raw.githubusercontent.com/bruceabc0511/EZOnlineEXAM/main/%E8%80%83%E9%A1%8C%E5%8C%AF%E5%85%A5%E7%AF%84%E6%9C%AC.xlsx';

  // 若為原生 <a> 點擊，瀏覽器將依 href 與 download 屬性自動觸發下載
  if (event && event.currentTarget && event.currentTarget.tagName === 'A') {
    return;
  }

  const link = document.createElement('a');
  link.href = window.location.protocol.startsWith('http') ? encodeURI(sampleFileName) : githubRawUrl;
  link.download = sampleFileName;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
    <td style="white-space: nowrap;"><strong>${escapeHtml(sub.studentId || '-')}</strong></td>
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
      <button type="button" class="btn btn-danger-outline btn-sm js-del-sub-btn">刪除</button>
    </td>
  `;
  const delSubBtn = tr.querySelector('.js-del-sub-btn');
  if (delSubBtn) {
    delSubBtn.addEventListener('click', () => deleteSingleSubmission(sub.id, sessionId));
  }
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

  document.getElementById('detailModalTitle').textContent = `${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''} - 作答明細 (${sub.score} 分)`;
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
      <button type="button" class="btn btn-primary btn-sm js-send-single-email-btn">📧 寄送此考生成績單 Email</button>
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
  const sendEmailBtn = body.querySelector('.js-send-single-email-btn');
  if (sendEmailBtn) {
    sendEmailBtn.addEventListener('click', () => sendSingleScoreEmail(sessionId, sub.id));
  }

  document.getElementById('studentDetailModal').classList.remove('hidden');
}

function closeStudentDetailModal() {
  document.getElementById('studentDetailModal').classList.add('hidden');
}

function deleteSingleSubmission(subId, sessionId = 'CURRENT') {
  if (!confirm('確定要刪除此位考生的作答紀錄嗎？（刪除後該電子郵件即可重新應試）')) return;
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

// ==================== 考後寄送成績單 Email 功能 (含考生作答明細與對錯標記，不含題目與標準答案) ====================
function extractStudentAnswersForEmail(sub, sessionObj) {
  const details = sub.answerDetails || {};
  const questions = (sessionObj && Array.isArray(sessionObj.questions) && sessionObj.questions.length > 0)
    ? sessionObj.questions
    : null;

  const list = [];
  if (questions) {
    questions.forEach((q, idx) => {
      const d = details[q.id];
      list.push({
        qNum: idx + 1,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    });
  } else {
    const total = Number(sub.totalQuestions) || Object.keys(details).length;
    for (let i = 1; i <= total; i++) {
      const d = details[i];
      list.push({
        qNum: i,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    }
  }
  return list;
}

function buildStudentAnswerGridHtml(studentAnswers) {
  if (!Array.isArray(studentAnswers) || studentAnswers.length === 0) return '';

  const perRow = 5;
  let rowsHtml = '';

  for (let i = 0; i < studentAnswers.length; i += perRow) {
    const chunk = studentAnswers.slice(i, i + perRow);

    let qNumCells = '';
    let ansCells = '';

    for (let j = 0; j < perRow; j++) {
      const item = chunk[j];
      if (item) {
        qNumCells += `<td style="background: #005959;color: #ffffff;font-weight:700;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;font-size:15px;">${item.qNum}</td>`;
        const bg = item.isCorrect ? '#ccfbf1' : '#ffc8c8ff';
        const fg = item.isCorrect ? '#0f172a' : '#c40b0bff';
        ansCells += `<td style="background:${bg};color:${fg};font-weight:700;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;font-size:16px;">${escapeHtml(item.selected)}</td>`;
      } else {
        qNumCells += `<td style="background:#005959;color:#ffffff;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;"></td>`;
        ansCells += `<td style="background:#f8fafc;color:#94a3b8;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;"></td>`;
      }
    }

    rowsHtml += `
      <tr>
        <td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:8px 10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">題號</td>
        ${qNumCells}
      </tr>
      <tr>
        <td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">答案</td>
        ${ansCells}
      </tr>
    `;
  }

  return `
    <div style="margin-top:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div style="font-size:15px;font-weight:700;color: #005959;">📋 考生作答明細　　</div>
        <div style="font-size:12.5px;color: #475569;">
          <span style="display:inline-block;width:12px;height:12px;background: #d1fdf4ff;border:1px solid #005959;vertical-align:middle;margin-right:4px;"></span>正確
          <span style="display:inline-block;width:12px;height:12px;background: #ffc8c8ff;border:1px solid #dc2626;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>錯誤
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;border:2px solid #003d3d;font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;">
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function buildScoreEmailHtmlClient(sub, sessionObj, studentAnswers) {
  const scoreColor = Number(sub.score) >= 60 ? '#007979' : '#dc2626';
  const passBadge = Number(sub.score) >= 60 ? '及格' : '未達及格標準 (60分)';
  const examDateStr = sub.examDate || (sessionObj && sessionObj.examDate) || '-';
  const gridHtml = buildStudentAnswerGridHtml(studentAnswers);

  return `
    <div style="font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:620px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#ffffff;">
      <div style="background:linear-gradient(135deg,#005959,#007979);color:#ffffff;padding:20px 24px;">
        <div style="font-size:13px;opacity:0.9;">線上筆試測驗系統 — 成績通知單</div>
        <h2 style="margin:6px 0 0;font-size:20px;">${escapeHtml(sub.examTitle || (sessionObj && sessionObj.title) || '線上筆試測驗')}</h2>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 16px;font-size:15px;color:#334155;">
          <strong>${escapeHtml(sub.studentName)}</strong>${sub.studentId ? `（編號：<strong>${escapeHtml(sub.studentId)}</strong>）` : ''} 您好，您的筆試測驗成績結果如下：
        </p>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;margin-bottom:16px;">
          <div style="font-size:14px;color:#64748b;">測驗總分（滿分 100 分）</div>
          <div style="font-size:34px;font-weight:800;color:${scoreColor};margin:6px 0;">
            ${sub.score} <span style="font-size:16px;font-weight:600;">分（${passBadge}）</span>
          </div>
          <div style="font-size:13.5px;color:#475569;margin-top:10px;line-height:1.8;">
            • 考試日期：<strong>${escapeHtml(examDateStr)}</strong><br>
            • 答對題數：<strong>${sub.correctCount} / ${sub.totalQuestions} 題</strong><br>
            • 作答耗時：<strong>${escapeHtml(sub.timeSpentFormatted || '-')}</strong><br>
            • 交卷狀態：<strong>${escapeHtml(sub.status || '正常交卷')}</strong><br>
            • 交卷時間：<strong>${escapeHtml(sub.submittedAt || '-')}</strong>
          </div>
        </div>

        ${gridHtml}

        <p style="margin-top:20px;font-size:12px;color:#94a3b8;text-align:center;">
          本信件由「線上筆試測驗系統」自動發送，僅提供個人作答選項與對錯結果，不附載試題與標準答案。
        </p>
      </div>
    </div>
  `;
}

function buildPlainTextScoreEmail(sub, sessionObj) {
  const passText = Number(sub.score) >= 60 ? '及格' : '未達及格標準(60分)';
  const examDateStr = sub.examDate || sessionObj.examDate || '-';
  const studentAnswers = extractStudentAnswersForEmail(sub, sessionObj);
  const ansSummaryLines = studentAnswers.map(
    item => `第 ${item.qNum} 題：${item.selected} (${item.isCorrect ? '答對' : '答錯'})`
  );

  const lines = [
    `${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''} 您好：`,
    ``,
    `以下為您在【${sub.examTitle || sessionObj.title || '線上筆試測驗'}】的筆試測驗成績通知單：`,
    `----------------------------------------`,
    `• 考生姓名：${sub.studentName}`,
    `• 編號：${sub.studentId || '-'}`,
    `• 考試日期：${examDateStr}`,
    `• 測驗總分：${sub.score} 分 (${passText})`,
    `• 答對題數：${sub.correctCount} / ${sub.totalQuestions} 題`,
    `• 作答耗時：${sub.timeSpentFormatted}`,
    `• 交卷狀態：${sub.status}`,
    `• 交卷時間：${sub.submittedAt}`,
    `----------------------------------------`,
    `【考生作答明細】`,
    ...ansSummaryLines,
    `----------------------------------------`,
    `（為維護題庫保密原則，本成績單不附載考題與標準答案）`,
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
    if (sessionId === 'CURRENT') {
      saveSubmissionsToStorage(true);
    } else {
      saveHistorySessionsToStorage(true);
    }
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
    if (!confirm(`確定要寄送成績通知信給本場次共 ${validSubs.length} 位考生嗎？\n（信件含個人測驗總分與考生作答對錯明細，不包含題目與標準答案）`)) {
      return;
    }
  }

  await dispatchScoreEmails(sessionId, validSubs, sessionObj);
}

async function dispatchScoreEmails(sessionId, recipients, sessionObj) {
  const gasUrl = getActiveGasUrl();
  const nowStr = formatDateTime(new Date());

  // H3 安全加固：僅傳遞收件人交卷紀錄 ID 清單，由伺服器端根據 state 中的真實考生紀錄與題庫獨立組建 HTML 成績信，不再傳送 customHtmlBody
  const sanitizedRecipients = recipients.map(r => ({
    id: r.id
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
        showToast(`✅ 成功寄出 ${res.sentCount} 封考生成績單 Email！`);
      }
      return;
    } else {
      showToast('⚠️ 雲端寄信未回應，將切換為本機郵件發送模式');
    }
  }

  // 模式 2：本機未綁定雲端時，使用 mailto: 喚起系統郵件客戶端寄發完整成績單
  if (recipients.length === 1) {
    const sub = recipients[0];
    const subject = `【測驗成績通知】${sub.examTitle || sessionObj.title || '線上筆試測驗'} - ${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''}`;
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
      summaryLines.push(`• ${r.studentName}${r.studentId ? ` (${r.studentId})` : ''}：${r.score} 分 (答對 ${r.correctCount}/${r.totalQuestions} 題)`);
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
  document.getElementById('archiveAutoSendEmail').checked = true;
  document.getElementById('archiveClearCurrent').checked = true;
  document.getElementById('archiveSessionModal').classList.remove('hidden');
}

function closeArchiveSessionModal() {
  document.getElementById('archiveSessionModal').classList.add('hidden');
}

async function confirmArchiveCurrentSession(event) {
  event.preventDefault();
  const customTitle = document.getElementById('archiveSessionTitle').value.trim() || examData.title || '未命名測驗';
  const autoSendEmail = document.getElementById('archiveAutoSendEmail').checked;
  const clearCurrent = document.getElementById('archiveClearCurrent').checked;

  closeArchiveSessionModal();

  // 歸檔時一併關閉當前測驗開放狀態
  examData.isExamOpen = false;
  saveExamDataToStorage(true);

  // 若勾選歸檔同時自動寄送成績信給尚未收到信的考生
  if (autoSendEmail) {
    const unsentSubs = submissions.filter(s => s.studentEmail && s.studentEmail.includes('@') && !s.emailSentAt);
    if (unsentSubs.length > 0) {
      await dispatchScoreEmails('CURRENT', unsentSubs, {
        title: examData.title,
        examDate: examData.examDate,
        questions: examData.questions,
        submissions: submissions
      });
    }
  }

  const newHist = createAndSaveHistorySession(customTitle, clearCurrent, null);
  switchExaminerTab('tabHistory');
  viewHistorySessionDetail(newHist.id);
  showToast(`🗂️ 已結束測驗並將「${customTitle}」儲存至歷次測驗紀錄！`);
}

function createAndSaveHistorySession(sessionTitle, clearCurrent = true, newExamData = null) {
  const stats = calculateStatsForList(submissions);
  const myId = getCurrentExaminerUserId() || 'SYSTEM_ADMIN';
  const myName = (currentExaminerProfile && currentExaminerProfile.displayName) || '考官';
  const archivedRecord = {
    id: 'HIST_' + Date.now(),
    sessionTitle: sessionTitle || examData.title || '未命名測驗',
    examTitle: examData.title || '未命名測驗',
    examDate: examData.examDate || '-',
    durationMinutes: examData.durationMinutes,
    ownerId: examData.ownerId || myId,
    ownerName: examData.ownerName || myName,
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

function canCurrentUserModifyHistory(hist) {
  if (!hist) return false;
  if (isCurrentUserAdmin()) return true;
  const myId = getCurrentExaminerUserId();
  if (!myId || !hist.ownerId) return true;
  return hist.ownerId === myId;
}

function renderExaminerHistoryTab() {
  const visibleHistoryList = isCurrentUserAdmin()
    ? historySessions
    : historySessions.filter(h => canCurrentUserModifyHistory(h));

  const countEl = document.getElementById('tabHistoryCount');
  if (countEl) countEl.textContent = visibleHistoryList.length;

  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (visibleHistoryList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color: var(--text-muted); padding: 28px;">目前尚無您個人封存的歷次測驗紀錄。於每次考試結束後點擊「💾 儲存本次測驗紀錄」，即可將測驗結果獨立保存於此！</td></tr>`;
    return;
  }

  visibleHistoryList.forEach((hist, idx) => {
    const st = hist.stats || calculateStatsForList(hist.submissions || []);
    const qLen = hist.questionsSnapshot ? hist.questionsSnapshot.length : 0;
    const subLen = hist.submissions ? hist.submissions.length : 0;
    const ownerTag = hist.ownerName ? `<div class="text-muted text-sm">👤 考官：${escapeHtml(hist.ownerName)}</div>` : '';

    const tr = document.createElement('tr');
    if (currentViewingHistoryId === hist.id) {
      tr.style.background = 'var(--primary-tint)';
    }

    tr.innerHTML = `
      <td>
        <strong>#${visibleHistoryList.length - idx}</strong>
        <div class="text-muted text-sm">${escapeHtml(hist.archivedAt)}</div>
      </td>
      <td><strong>${escapeHtml(hist.sessionTitle || hist.examTitle)}</strong>${ownerTag}</td>
      <td>${escapeHtml(hist.examDate || '-')}</td>
      <td>${qLen} 題</td>
      <td><strong>${subLen} 人</strong></td>
      <td><strong style="color:var(--primary);">${st.mean} 分</strong></td>
      <td><strong style="color:var(--accent-dark);">${st.median} 分</strong></td>
      <td>${st.stdDev}</td>
      <td><span class="badge ${st.passRate >= 60 ? 'badge-teal' : 'badge-danger'}">${st.passRate}%</span></td>
      <td>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-sm js-hist-view">🔍 檢視本場次明細</button>
          <button type="button" class="btn btn-secondary btn-sm js-hist-export">📥 匯出報表</button>
          <button type="button" class="btn btn-outline btn-sm js-hist-email">📩 寄送成績單</button>
          <button type="button" class="btn btn-danger-outline btn-sm js-hist-del">刪除</button>
        </div>
      </td>
    `;
    const viewBtn = tr.querySelector('.js-hist-view');
    if (viewBtn) viewBtn.addEventListener('click', () => viewHistorySessionDetail(hist.id));
    const expBtn = tr.querySelector('.js-hist-export');
    if (expBtn) expBtn.addEventListener('click', () => exportScoresToExcel(hist.id));
    const mailBtn = tr.querySelector('.js-hist-email');
    if (mailBtn) mailBtn.addEventListener('click', () => sendAllScoresEmail(hist.id));
    const delHistBtn = tr.querySelector('.js-hist-del');
    if (delHistBtn) delHistBtn.addEventListener('click', () => deleteHistorySession(hist.id));
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
  const targetHist = historySessions.find(h => h.id === histId);
  if (!targetHist) return;
  // 限制 2：一般考官不可刪除他人的歷史測驗紀錄
  if (!canCurrentUserModifyHistory(targetHist)) {
    const ownerLabel = targetHist.ownerName || '其他考官';
    alert(`⛔ 權限限制：此筆歷史測驗紀錄屬於考官【${ownerLabel}】，您無法刪除他人的歷史測驗紀錄！`);
    return;
  }
  if (!confirm('確定要永久刪除此筆歷史測驗紀錄嗎？此操作無法復原！')) return;
  historySessions = historySessions.filter(h => h.id !== histId);
  if (currentViewingHistoryId === histId) {
    closeHistorySessionDetail();
  }
  saveHistorySessionsToStorage(true);
  refreshExaminerAllViews();
}

// ==================== 匯出考試成績與錯題統計成 Excel (.xlsx) ====================
function getCellDisplayWidth(val) {
  if (val === null || val === undefined) return 0;
  const lines = String(val).split(/\r?\n/);
  let maxLineLen = 0;
  lines.forEach(line => {
    let len = 0;
    for (const ch of line) {
      len += ch.charCodeAt(0) > 255 ? 2.1 : 1;
    }
    if (len > maxLineLen) maxLineLen = len;
  });
  return Math.ceil(maxLineLen);
}

function autoFitWorksheetColumns(rows, worksheet, minWidth = 10, maxWidth = 90) {
  if (!rows || rows.length === 0 || !worksheet) return;
  const colCount = rows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);
  const cols = [];
  for (let c = 0; c < colCount; c++) {
    let maxW = minWidth;
    for (let r = 0; r < rows.length; r++) {
      const cellVal = rows[r] ? rows[r][c] : '';
      const w = getCellDisplayWidth(cellVal) + 4;
      if (w > maxW) maxW = w;
    }
    cols.push({ wch: Math.min(maxW, maxWidth) });
  }
  worksheet['!cols'] = cols;
}

// 試算表公式注入防護 (H2 CSV / Formula Injection Protection)：開頭為 =、+、-、@、Tab 或換行時加上單引號前綴
function sanitizeExcelCell(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  const str = String(val);
  if (/^[=+\-@\t\r\n]/.test(str)) {
    return "'" + str;
  }
  return str;
}

function exportScoresToExcel(sessionId = 'CURRENT') {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj || sessionObj.submissions.length === 0) {
    alert('尚無考生成績可供匯出！');
    return;
  }

  const targetSubs = sessionObj.submissions;
  const targetQuestions = sessionObj.questions;

  const headers = [
    '編號',
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
    headers.push(sanitizeExcelCell(`第${idx + 1}題(正解:${q.answer})`));
  });

  const scoreRows = [headers];
  targetSubs.forEach(sub => {
    const row = [
      sanitizeExcelCell(sub.studentId || ''),
      sanitizeExcelCell(sub.studentName),
      sanitizeExcelCell(sub.studentEmail || ''),
      sub.score,
      sub.correctCount,
      sub.totalQuestions,
      sanitizeExcelCell(sub.timeSpentFormatted),
      sub.warningCount,
      sanitizeExcelCell(sub.status),
      sanitizeExcelCell(sub.submittedAt),
      sanitizeExcelCell(sub.emailSentAt ? `已寄送 (${sub.emailSentAt})` : '尚未寄送')
    ];
    targetQuestions.forEach(q => {
      const d = sub.answerDetails ? sub.answerDetails[q.id] : null;
      row.push(sanitizeExcelCell(d ? d.selected : '未作答'));
    });
    scoreRows.push(row);
  });

  const stats = calculateStatsForList(targetSubs);
  scoreRows.push([]);
  scoreRows.push(['【統計摘要】']);
  scoreRows.push(['應試人數', targetSubs.length]);
  scoreRows.push(['平均分數', stats.mean]);
  scoreRows.push(['中位數', stats.median]);
  scoreRows.push(['標準差', stats.stdDev]);
  scoreRows.push(['及格率', `${stats.passRate}%`]);

  const wsScores = XLSX.utils.aoa_to_sheet(scoreRows);
  autoFitWorksheetColumns(scoreRows, wsScores);

  const qAnalysisHeaders = ['題號', '題目內容', '標準答案', '總作答人數', '答錯人數', '答錯率(%)', '最常誤選選項'];
  const qAnalysisRows = [qAnalysisHeaders];
  const itemStats = calculateQuestionErrorStatsForList(targetQuestions, targetSubs);

  itemStats.forEach(item => {
    qAnalysisRows.push([
      `第 ${item.index} 題`,
      sanitizeExcelCell(item.question),
      sanitizeExcelCell(item.answerDisplay || item.answer),
      item.totalAttempts,
      item.wrongCount,
      `${item.errorRate}%`,
      sanitizeExcelCell(item.topWrongOption || '無')
    ]);
  });

  const wsAnalysis = XLSX.utils.aoa_to_sheet(qAnalysisRows);
  autoFitWorksheetColumns(qAnalysisRows, wsAnalysis);

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

    // 統計各選項被選次數（供獨立檢討視窗完整呈現各選項誘答分佈）
    const optionSelectionCounts = {};
    targetSubmissions.forEach(sub => {
      const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
      const picked = detail && detail.selected ? String(detail.selected).toUpperCase() : '未作答';
      optionSelectionCounts[picked] = (optionSelectionCounts[picked] || 0) + 1;
    });

    return {
      id: q.id,
      index: idx + 1,
      question: q.question,
      imageUrl: q.imageUrl || '',
      options: q.options || [],
      answer: q.answer,
      answerDisplay,
      totalAttempts: totalStudents,
      wrongCount,
      errorRate,
      topWrongOption,
      optionSelectionCounts
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

function openErrorRankingWindow(sessionId = 'CURRENT') {
  const targetId = sessionId || 'CURRENT';
  const sessionObj = getSessionDataById(targetId);
  if (!sessionObj || !sessionObj.questions || sessionObj.questions.length === 0) {
    alert('目前題庫中尚無題目可供檢討！');
    return;
  }
  if (!sessionObj.submissions || sessionObj.submissions.length === 0) {
    alert('目前尚無考生作答數據可供檢討分析！');
    return;
  }

  const itemStats = calculateQuestionErrorStatsForList(sessionObj.questions, sessionObj.submissions);
  const stats = calculateStatsForList(sessionObj.submissions);
  const examTitle = sessionObj.title || '線上筆試測驗';
  const examDate = sessionObj.examDate || '-';

  const win = window.open('', '_blank');
  if (!win) {
    alert('瀏覽器阻擋了彈出視窗，請允許本網站開啟新視窗！');
    return;
  }

  const buildItemCardHtml = (item, rankNum) => {
    const badgeBg = item.errorRate >= 50 ? '#fee2e2' : item.errorRate >= 25 ? '#fef3c7' : '#dcfce7';
    const badgeFg = item.errorRate >= 50 ? '#991b1b' : item.errorRate >= 25 ? '#92400e' : '#166534';

    const optionsHtml = (item.options || [])
      .map(opt => {
        const keyUpper = String(opt.key).toUpperCase();
        const isCorrectOpt = keyUpper === String(item.answer).toUpperCase();
        const count = (item.optionSelectionCounts && item.optionSelectionCounts[keyUpper]) || 0;
        const pct = item.totalAttempts > 0 ? Math.round((count / item.totalAttempts) * 100) : 0;

        let optStyle = 'background:#f8fafc;border:1.5px solid #e2e8f0;color:#1e293b;';
        let tagHtml = '';
        if (isCorrectOpt) {
          optStyle = 'background:#ecfdf5;border:2px solid #16a34a;color:#065f46;font-weight:700;';
          tagHtml = `<span style="background:#16a34a;color:#ffffff;font-size:12px;padding:2px 8px;border-radius:99px;margin-left:8px;">✔ 正確答案</span>`;
        } else if (count > 0) {
          optStyle = 'background:#fff1f2;border:1.5px solid #fda4af;color:#881337;';
          tagHtml = `<span style="background:#fecdd3;color:#9f1239;font-size:12px;padding:2px 8px;border-radius:99px;margin-left:8px;font-weight:600;">誤選</span>`;
        }

        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:8px;margin-top:8px;${optStyle}">
            <div style="font-size:15.5px;line-height:1.5;">
              <span style="display:inline-block;min-width:28px;font-weight:800;">(${escapeHtml(opt.key)})</span>
              ${escapeHtml(opt.text)}
              ${tagHtml}
            </div>
            <div style="white-space:nowrap;font-size:14px;font-weight:700;">
              ${count} 人 (${pct}%)
            </div>
          </div>
        `;
      })
      .join('');

    const displayItemImg = formatGoogleDriveImageUrl(item.imageUrl);
    const itemImgHtml = displayItemImg
      ? `<div style="margin:10px 0 14px 0; text-align:center;">
           <img src="${escapeHtml(displayItemImg)}" alt="第 ${item.index} 題圖檔" class="js-review-zoom-img" ${getImageOnErrorAttr(displayItemImg)} data-img-url="${escapeHtml(displayItemImg)}" style="max-height:240px; max-width:100%; border-radius:6px; border:1px solid #cbd5e1; cursor:zoom-in;">
         </div>`
      : '';

    return `
      <div class="review-card" data-rank="${rankNum}" data-qindex="${item.index}">
        <div class="review-card-top">
          <div class="review-q-title">
            <span class="rank-pill">排名 #${rankNum}</span>
            <span class="qnum-pill">第 ${item.index} 題</span>
            <span class="q-text">${escapeHtml(item.question)}</span>
          </div>
          <span class="err-pill" style="background:${badgeBg};color:${badgeFg};">
            答錯率 ${item.errorRate}% (${item.wrongCount}/${item.totalAttempts}人)
          </span>
        </div>
        ${itemImgHtml}
        <div class="bar-track">
          <div class="bar-fill" style="width:${item.errorRate}%;"></div>
        </div>
        <div class="options-wrap">
          ${optionsHtml}
        </div>
        <div class="review-meta">
          <span>正確答案：<strong style="color:#15803d;">${escapeHtml(item.answerDisplay || item.answer)}</strong></span>
          <span>答錯人數：<strong>${item.wrongCount} / ${item.totalAttempts} 人</strong></span>
          <span>最常誤選：<strong style="color:#be123c;">${escapeHtml(item.topWrongOption || '無')}</strong></span>
        </div>
      </div>
    `;
  };

  const cardsHtml = itemStats.map((item, idx) => buildItemCardHtml(item, idx + 1)).join('');

  const docHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>題目答錯率排行榜與試題檢討 — ${escapeHtml(examTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans TC', 'Microsoft JhengHei', sans-serif;
      background: #f8f1f1;
      color: #1e293b;
      padding-bottom: 48px;
    }
    .top-header {
      background: linear-gradient(135deg, #4a0000 0%, #750000 100%);
      color: #ffffff;
      padding: 20px 28px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 14px;
    }
    .top-header h1 {
      font-size: 1.35rem;
      margin-bottom: 4px;
    }
    .top-meta {
      font-size: 0.92rem;
      opacity: 0.92;
    }
    .toolbar-btns {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn-tool {
      border: 1px solid rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.15);
      color: #ffffff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-tool:hover, .btn-tool.active {
      background: #ffffff;
      color: #750000;
    }
    .container {
      max-width: 1060px;
      margin: 24px auto;
      padding: 0 20px;
    }
    .review-card {
      background: #ffffff;
      border-radius: 12px;
      padding: 22px 24px;
      margin-bottom: 18px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
    }
    .review-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 12px;
    }
    .review-q-title {
      font-size: 1.12rem;
      font-weight: 700;
      line-height: 1.55;
      color: #0f172a;
    }
    .rank-pill {
      display: inline-block;
      background: #750000;
      color: #ffffff;
      font-size: 0.82rem;
      padding: 3px 10px;
      border-radius: 99px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .qnum-pill {
      display: inline-block;
      background: #f1f5f9;
      color: #334155;
      font-size: 0.85rem;
      padding: 3px 10px;
      border-radius: 99px;
      margin-right: 8px;
      vertical-align: middle;
    }
    .err-pill {
      white-space: nowrap;
      padding: 5px 12px;
      border-radius: 99px;
      font-size: 0.9rem;
      font-weight: 800;
    }
    .bar-track {
      width: 100%;
      height: 8px;
      background: #f1f5f9;
      border-radius: 99px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #f59e0b, #e11d48);
      border-radius: 99px;
    }
    .options-wrap {
      margin-bottom: 14px;
    }
    .review-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      padding-top: 12px;
      border-top: 1px dashed #cbd5e1;
      font-size: 0.92rem;
      color: #475569;
    }
    @media print {
      .top-header { position: static; background: #750000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .toolbar-btns { display: none; }
      body { background: #ffffff; }
      .review-card { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <header class="top-header">
    <div>
      <h1>🚨 題目答錯率排行榜與試題檢討 — ${escapeHtml(examTitle)}</h1>
      <div class="top-meta">
        考試日期：${escapeHtml(examDate)} ｜ 應試人數：${sessionObj.submissions.length} 人 ｜ 平均分數：${stats.mean} 分 ｜ 及格率：${stats.passRate}%
      </div>
    </div>
    <div class="toolbar-btns">
      <button type="button" class="btn-tool active" id="btnSortErr" onclick="sortCards('rank')">🔥 依答錯率排序 (高➔低)</button>
      <button type="button" class="btn-tool" id="btnSortQNum" onclick="sortCards('qindex')">🔢 依題號排序 (第1題➔第${sessionObj.questions.length}題)</button>
      <button type="button" class="btn-tool" onclick="window.print()">🖨️ 列印 / 匯出 PDF</button>
    </div>
  </header>
  <main class="container" id="cardsContainer">
    ${cardsHtml}
  </main>
  <script>
    function sortCards(mode) {
      const container = document.getElementById('cardsContainer');
      const cards = Array.from(container.querySelectorAll('.review-card'));
      cards.sort((a, b) => {
        return Number(a.dataset[mode]) - Number(b.dataset[mode]);
      });
      cards.forEach(c => container.appendChild(c));
      document.getElementById('btnSortErr').classList.toggle('active', mode === 'rank');
      document.getElementById('btnSortQNum').classList.toggle('active', mode === 'qindex');
    }
    document.querySelectorAll('.js-review-zoom-img').forEach(img => {
      img.addEventListener('click', () => {
        const url = img.dataset.imgUrl;
        if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });
    });
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(docHtml);
  win.document.close();
}

// ==================== 題目圖片放大檢視燈箱 ====================
function openImageLightbox(imgUrl, caption = '題目附圖') {
  if (!imgUrl) return;
  const formattedUrl = formatGoogleDriveImageUrl(imgUrl);
  const modal = document.getElementById('imageLightboxModal');
  const imgEl = document.getElementById('lightboxImage');
  const capEl = document.getElementById('lightboxCaption');

  if (imgEl) {
    imgEl.removeAttribute('data-fallback');
    imgEl.src = formattedUrl;
    const fileIdMatch = formattedUrl.match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
    if (fileIdMatch) {
      const fileId = fileIdMatch[1];
      imgEl.onerror = function () {
        if (!this.dataset.fallback) {
          this.dataset.fallback = '1';
          this.src = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
        }
      };
    } else {
      imgEl.onerror = null;
    }
  }
  if (capEl) capEl.textContent = `${caption}（點擊背景或右上角 ✕ 關閉）`;
  if (modal) modal.classList.remove('hidden');
}

function closeImageLightbox() {
  const modal = document.getElementById('imageLightboxModal');
  const imgEl = document.getElementById('lightboxImage');
  if (modal) modal.classList.add('hidden');
  if (imgEl) imgEl.src = '';
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
  }, 5000);
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
