/**
 * ============================================================================
 * 線上筆試測驗系統 - Google Apps Script 雲端資料庫與自動寄信後端 (Code.gs)
 * ============================================================================
 * 功能包含：
 * 1. 多人同時連線應試：集中儲存「當前開放題庫」、「當前場次考生成績」與「歷次測驗歷史紀錄」
 * 2. Google 試算表視覺化同步：自動建立並更新【系統狀態設定】、【當前考生成績】、【歷次測驗紀錄】工作表
 * 3. 自動寄送成績單 Email：透過 Google MailApp 寄送精美 HTML 考生成績通知單（不含考題與作答明細，防止試題外流）
 *
 * 部署步驟：
 * 1. 新建一份 Google 試算表 -> 點選「擴充功能」>「Apps Script」
 * 2. 將本檔案內容完整貼上並儲存 (Ctrl+S)
 * 3. 點選右上角「部署」>「新增部署作業」> 類型選擇「網頁應用程式 (Web App)」
 * 4. 執行身分：「我 (Me)」；誰可以存取：「所有人 (Anyone)」
 * 5. 部署並授權後，複製「網頁應用程式網址 (.../exec)」貼回考官端「雲端連線與寄信設定」即可！
 *
 * 安全設定說明 (Script Properties)：
 * - 首次執行時，系統會自動將預設的 EXAMINER_PIN_HASH、EXAMINER_PIN_SALT、ADMIN_KEY_HASH、ADMIN_KEY_SALT 寫入指令碼屬性 (Script Properties)。
 * - 強烈建議考官在部署後，至「專案設定 (齒輪)」>「指令碼屬性 (Script Properties)」修改金鑰或於考官後台變更 PIN 碼。
 * ============================================================================
 */

const SHEET_NAMES = {
  STATE: '系統狀態資料庫',
  CURRENT_SCORES: '當前考生成績',
  HISTORY_LOG: '歷次測驗紀錄',
  EXAM_LIBRARY: '試卷庫資料'
};

// 考題圖片專用 Google 雲端硬碟資料夾 ID (可於 Script Properties 設定 EXAM_IMAGE_FOLDER_ID 覆蓋)
const DEFAULT_EXAM_IMAGE_FOLDER_ID = '11vY2bQE-3G_gwrcanjCeCJMYjPbnYYrl';

function getExamImageFolderId() {
  try {
    const propId = PropertiesService.getScriptProperties().getProperty('EXAM_IMAGE_FOLDER_ID');
    if (propId && propId.trim()) return propId.trim();
  } catch (e) {}
  return DEFAULT_EXAM_IMAGE_FOLDER_ID;
}

/**
 * 首次使用考題圖片上傳時，請在 Apps Script 編輯器上方函式選單中選擇此「testDriveAuthorization」
 * 並點選「執行」，Google 會彈出授權視窗，點擊「核對權限」->「進階」->「前往... (不安全)」->「允許」即可完成雲端硬碟授權！
 */
function testDriveAuthorization() {
  const folder = DriveApp.getFolderById(getExamImageFolderId());
  Logger.log('✅ Google Drive 雲端硬碟權限授權成功！目標資料夾名稱：' + folder.getName());
}

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/**
 * 讀取與自動初始化 Script Properties 中的安全憑證雜湊與鹽值
 * (將機敏驗證參數存放於伺服器端 Script Properties，避免暴露於前端原始碼或試算表儲存格)
 */
function getSecurityConfig(state) {
  const props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  const updates = {};

  const pinSalt = all.EXAMINER_PIN_SALT || 'HD_EXAM_SECURE_SALT_2026';
  if (!all.EXAMINER_PIN_SALT) updates.EXAMINER_PIN_SALT = pinSalt;

  const adminSalt = all.ADMIN_KEY_SALT || 'HD_EXAM_ADMIN_SALT_2026';
  if (!all.ADMIN_KEY_SALT) updates.ADMIN_KEY_SALT = adminSalt;

  // 若舊版試算表 state 中曾儲存自訂 examinerPinHash，優先無痛遷移至 Script Properties
  const defaultPinHash = '391f59f4ca8480648b504098e96bffa16f970d261a5cacea40fe5e7789c3f961';
  const legacyStateHash = (state && state.examinerPinHash) ? String(state.examinerPinHash).trim().toLowerCase() : '';
  const pinHash = (all.EXAMINER_PIN_HASH || legacyStateHash || defaultPinHash).trim().toLowerCase();
  if (!all.EXAMINER_PIN_HASH) updates.EXAMINER_PIN_HASH = pinHash;

  const defaultAdminHash = '4007531f25ed2a163a091d340f3fcb5d7bbabb98c22c65074d60152eec2c9b6a';
  const adminHash = (all.ADMIN_KEY_HASH || defaultAdminHash).trim().toLowerCase();
  if (!all.ADMIN_KEY_HASH) updates.ADMIN_KEY_HASH = adminHash;

  if (Object.keys(updates).length > 0) {
    try {
      props.setProperties(updates, false);
    } catch (e) {}
  }

  return { pinSalt, pinHash, adminSalt, adminHash };
}

/**
 * 統一失敗次數限流防護 (防範針對 PIN 或管理員金鑰之線上暴力破解)
 */
const AUTH_RATE_LIMIT_KEY = 'EXAMINER_AUTH_FAIL_COUNT';
const AUTH_MAX_FAILS = 10;
const AUTH_LOCK_SECONDS = 300; // 鎖定 5 分鐘

function isAuthRateLimited() {
  const cache = CacheService.getScriptCache();
  return Number(cache.get(AUTH_RATE_LIMIT_KEY) || 0) >= AUTH_MAX_FAILS;
}

function recordAuthFailure() {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(AUTH_RATE_LIMIT_KEY) || 0) + 1;
  cache.put(AUTH_RATE_LIMIT_KEY, String(count), AUTH_LOCK_SECONDS);
  return count;
}

function clearAuthFailures() {
  try {
    CacheService.getScriptCache().remove(AUTH_RATE_LIMIT_KEY);
  } catch (e) {}
}

/**
 * 考官伺服器端 Session Token 管理 (隨機高熵 UUID，30 分鐘滑動有效期限)
 */
const EXAMINER_SESSION_TTL_SEC = 1800;

function createExaminerSession() {
  const token = 'exs_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, '');
  const cache = CacheService.getScriptCache();
  cache.put('EXAMINER_SESS_' + token, String(Date.now()), EXAMINER_SESSION_TTL_SEC);
  return token;
}

function isExaminerSessionValid(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return false;
  const clean = sessionToken.trim();
  if (!clean.startsWith('exs_')) return false;
  const cache = CacheService.getScriptCache();
  const val = cache.get('EXAMINER_SESS_' + clean);
  if (!val) return false;
  // 滑動延長 Session 有效期限
  try {
    cache.put('EXAMINER_SESS_' + clean, String(Date.now()), EXAMINER_SESSION_TTL_SEC);
  } catch (e) {}
  return true;
}

function revokeExaminerSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return;
  try {
    CacheService.getScriptCache().remove('EXAMINER_SESS_' + sessionToken.trim());
  } catch (e) {}
}

/**
 * 驗證考官 PIN (支援明文 PIN 由後端計算雜湊，或向下相容比對雜湊)
 */
function verifyExaminerPinSecret(pinOrHash, state) {
  if (!pinOrHash || typeof pinOrHash !== 'string') return false;
  const cfg = getSecurityConfig(state);
  const clean = pinOrHash.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return clean.toLowerCase() === cfg.pinHash;
  }
  const computed = sha256Hex(`${cfg.pinSalt}:${clean}`).toLowerCase();
  return computed === cfg.pinHash;
}

/**
 * 驗證考官操作授權 (優先驗證伺服器端 Session Token；若為舊版傳入 PIN 雜湊亦受統一限流保護)
 */
function isExaminerRequestAuthorized(payload, state) {
  if (!payload) return false;
  if (payload.sessionToken && isExaminerSessionValid(payload.sessionToken)) {
    return true;
  }
  // 相容備援：若帶有 authPin 或 authPinHash，必須先通過限流檢查
  const secret = payload.authPin || payload.authPinHash;
  if (secret) {
    if (isAuthRateLimited()) return false;
    if (verifyExaminerPinSecret(secret, state)) {
      clearAuthFailures();
      return true;
    }
    recordAuthFailure();
  }
  return false;
}

/**
 * 管理員金鑰後端驗證 (讀取 Script Properties，不再將雜湊暴露於前端)
 */
function isAdminKeyValid(adminKey, state) {
  if (!adminKey || typeof adminKey !== 'string') return false;
  const cfg = getSecurityConfig(state);
  const clean = adminKey.trim();
  return sha256Hex(`${cfg.adminSalt}:${clean}`).toLowerCase() === cfg.adminHash;
}

/**
 * 考生隨機測驗連結 Token 後端權威驗證
 */
function evaluateExamTokenStatus(activeExamToken, reqToken) {
  const cleanReq = String(reqToken || '').trim();
  if (!cleanReq) return 'none';
  if (!activeExamToken || !activeExamToken.token) return 'not_generated';
  if (String(activeExamToken.token).trim() !== cleanReq) return 'invalid';
  if (Date.now() > Number(activeExamToken.expiresAt || 0)) return 'expired';
  return 'valid';
}

/**
 * 僅更新 UPDATED_AT 時間戳 (以 Key 搜尋所在列，相容分塊儲存後列位置不固定)
 */
function touchUpdatedAt(stateSheet) {
  try {
    CacheService.getScriptCache().remove('STATE_MAP_LIGHT');
  } catch (e) {}
  const lastRow = stateSheet.getLastRow();
  const nowIso = new Date().toISOString();
  if (lastRow >= 2) {
    const keys = stateSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === 'UPDATED_AT') {
        stateSheet.getRange(i + 2, 2).setValue(nowIso);
        return;
      }
    }
  }
  stateSheet.getRange(lastRow + 1, 1, 1, 2).setValues([['UPDATED_AT', nowIso]]);
}

/**
 * 輕量讀取系統狀態工作表 (不讀取試卷庫、不做遷移)，支援短期記憶體快取以承受多人高頻輪詢
 */
function readStateMapLight() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get('STATE_MAP_LIGHT');
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {}

  const { stateSheet } = ensureSheetsInitialized();
  const rawRows = stateSheet.getDataRange().getValues();
  const map = {};
  rawRows.forEach((r, idx) => {
    if (idx === 0) return;
    const k = String(r[0] || '').trim();
    if (k) map[k] = r[1] !== undefined ? String(r[1]) : '';
  });

  try {
    cache.put('STATE_MAP_LIGHT', JSON.stringify(map), 4); // 4 秒快取，大幅減輕 Google Sheets API 負擔
  } catch (e) {}

  return map;
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'getExamState';

    if (action === 'ping') {
      const state = loadCloudState();
      getSecurityConfig(state); // 確保 Script Properties 已自動初始化
      return jsonResponse({
        status: 'success',
        message: 'Google 試算表雲端測驗資料庫與自動寄信服務運作正常！',
        hasExamLibrarySupport: true,
        version: '2026-11-22-v4-security-hardened',
        timestamp: new Date().toISOString()
      });
    }

    // 輕量化狀態輪詢 (只讀狀態工作表，不讀試卷庫，節省網路頻寬與 GAS 執行額度；支援隨機測驗 Token 權威校驗，絕不外洩 Token 本體)
    if (action === 'checkState') {
      const map = readStateMapLight();
      let isOpen = false;
      let activeExamToken = null;
      try {
        const examStr = safeChunkRead(map, 'EXAM_DATA', '');
        if (examStr) {
          const parsed = JSON.parse(examStr);
          isOpen = Boolean(parsed.isExamOpen);
          activeExamToken = parsed.activeExamToken || null;
        }
      } catch (err) {}

      const reqToken = String((e && e.parameter && e.parameter.token) || '').trim();
      const tokenStatus = evaluateExamTokenStatus(activeExamToken, reqToken);

      return jsonResponse({
        status: 'success',
        isExamOpen: isOpen,
        tokenStatus: tokenStatus,
        tokenExpiresAt: (tokenStatus === 'valid' && activeExamToken) ? Number(activeExamToken.expiresAt || 0) : null,
        serverTime: Date.now(),
        updatedAt: map.UPDATED_AT || ''
      });
    }

    // 開考前檢查 Email 是否已於本場次交卷 (M2 防枚舉與個資保護：必須持有有效之隨機測驗 Token 且試卷為開放狀態，並僅回傳布林值 exists，不外洩交卷時間)
    if (action === 'checkEmail') {
      const email = String((e.parameter && e.parameter.email) || '').trim().toLowerCase();
      const reqToken = String((e.parameter && e.parameter.token) || '').trim();
      const map = readStateMapLight();
      let isOpen = false;
      let activeExamToken = null;
      try {
        const examStr = safeChunkRead(map, 'EXAM_DATA', '');
        if (examStr) {
          const parsed = JSON.parse(examStr);
          isOpen = Boolean(parsed.isExamOpen);
          activeExamToken = parsed.activeExamToken || null;
        }
      } catch (err) {}

      if (!isOpen) {
        return jsonResponse({
          status: 'closed',
          exists: false,
          message: '目前非測驗開放時間'
        });
      }

      if (activeExamToken && activeExamToken.token) {
        const tokenStatus = evaluateExamTokenStatus(activeExamToken, reqToken);
        if (tokenStatus !== 'valid') {
          return jsonResponse({
            status: 'token_invalid',
            tokenStatus: tokenStatus,
            message: '測驗連結憑證無效或已逾期'
          });
        }
      }

      let found = false;
      try {
        const subs = JSON.parse(safeChunkRead(map, 'SUBMISSIONS', '[]') || '[]');
        if (email) {
          found = subs.some(s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === email);
        }
      } catch (err) {}
      return jsonResponse({
        status: 'success',
        exists: Boolean(found)
      });
    }

    if (action === 'getExamState') {
      const state = loadCloudState();
      // 考生端透過 GET 取得試卷狀態 (考官端已全面改走 POST getExamState + Session Token，不於 URL 暴露憑證)
      const reqExamToken = String((e && e.parameter && e.parameter.examToken) || (e && e.parameter && e.parameter.token) || '').trim();
      const activeTokenObj = (state.examData && state.examData.activeExamToken) ? state.examData.activeExamToken : null;
      const isExamOpen = Boolean(state.examData && state.examData.isExamOpen);
      const tokenStatus = evaluateExamTokenStatus(activeTokenObj, reqExamToken);

      // 後端權威把關：考生必須持有有效之隨機測驗 Token，且試卷處於開放作答期間，才下發試卷題目
      const canReceiveQuestions = isExamOpen && tokenStatus === 'valid';

      let sanitizedExamData = null;
      if (state.examData) {
        sanitizedExamData = {
          id: state.examData.id || 'exam_default',
          title: state.examData.title || '',
          durationMinutes: state.examData.durationMinutes,
          examDate: state.examData.examDate || '',
          isExamOpen: isExamOpen,
          openedAt: state.examData.openedAt || null,
          // 絕不向未授權之考生端暴露 activeExamToken.token 本體
          questions: []
        };
        if (canReceiveQuestions && Array.isArray(state.examData.questions)) {
          sanitizedExamData.questions = state.examData.questions.map(q => {
            const safeQ = Object.assign({}, q);
            safeQ.isMultiple = Boolean(q.isMultiple) || normalizeAnswerStringGas(q.answer).length >= 2;
            delete safeQ.answer; // 刪除正解欄位，防範考生查看 Network/F12 窺探答案
            return safeQ;
          });
        }
      }
      return jsonResponse({
        status: 'success',
        isExaminer: false,
        tokenStatus: tokenStatus,
        examData: sanitizedExamData,
        submissionsCount: (state.submissions || []).length,
        submissions: null, // 隱匿所有已交卷考生成績與個資
        historySessions: null,
        examLibrary: null,
        updatedAt: state.updatedAt
      });
    }

    return jsonResponse({ status: 'error', message: '未知的 GET action' });
  } catch (err) {
    console.error('doGet Exception:', err);
    return jsonResponse({ status: 'error', message: '雲端伺服器處理請求時發生錯誤，請稍後再試' });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  // 併發安全防護：取鎖失敗時回傳 busy 狀態，由前端自動隨機退避重試，避免資料覆蓋
  const hasLock = lock.tryLock(20000);
  if (!hasLock) {
    return jsonResponse({
      status: 'busy',
      message: '雲端伺服器併發處理中，請稍候重試'
    });
  }

  try {
    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawBody);
    const action = payload.action || '';

    const state = loadCloudState();

    // 考官 PIN 驗證：核對成功後簽發伺服器端隨機高熵 Session Token (含統一失敗次數限流防暴力破解)
    if (action === 'verifyExaminer') {
      if (isAuthRateLimited()) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }
      const secret = payload.pin || payload.authPin || payload.authPinHash || '';
      if (verifyExaminerPinSecret(secret, state)) {
        clearAuthFailures();
        const sessionToken = createExaminerSession();
        return jsonResponse({
          status: 'success',
          sessionToken: sessionToken,
          expiresInSeconds: EXAMINER_SESSION_TTL_SEC
        });
      }
      const fails = recordAuthFailure();
      if (fails >= AUTH_MAX_FAILS) {
        return jsonResponse({ status: 'locked', message: 'PIN 碼錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }
      return jsonResponse({ status: 'unauthorized', message: 'PIN 碼錯誤' });
    }

    // 考官登出：立即銷毀伺服器端 Session Token
    if (action === 'logoutExaminer') {
      if (payload.sessionToken) {
        revokeExaminerSession(payload.sessionToken);
      }
      return jsonResponse({ status: 'success', message: '已安全登出並撤銷雲端工作階段' });
    }

    // 變更 / 重設考官 PIN (統一於後端驗證管理員金鑰並寫入 Script Properties，含統一限流防暴力破解)
    if (action === 'updateExaminerPin') {
      if (isAuthRateLimited()) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }

      const byAdmin = isAdminKeyValid(payload.adminKey, state);
      if (!byAdmin) {
        const fails = recordAuthFailure();
        if (fails >= AUTH_MAX_FAILS) {
          return jsonResponse({ status: 'locked', message: '管理員金鑰錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
        }
        return jsonResponse({ status: 'unauthorized', message: '管理員金鑰驗證失敗！無法變更或重設考官 PIN 碼。' });
      }

      const cfg = getSecurityConfig(state);
      let newHash = '';
      if (payload.resetToDefault) {
        newHash = sha256Hex(`${cfg.pinSalt}:9999`).toLowerCase();
      } else if (payload.newPin) {
        const cleanNewPin = String(payload.newPin).trim();
        if (!/^\d{4,12}$/.test(cleanNewPin)) {
          return jsonResponse({ status: 'error', message: '新 PIN 碼格式不符（須為 4 至 12 碼半形數字）' });
        }
        newHash = sha256Hex(`${cfg.pinSalt}:${cleanNewPin}`).toLowerCase();
      } else if (payload.newPinHash) {
        const candidateHash = String(payload.newPinHash).trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(candidateHash)) {
          return jsonResponse({ status: 'error', message: '新 PIN 雜湊格式不正確' });
        }
        newHash = candidateHash;
      } else {
        return jsonResponse({ status: 'error', message: '缺少新 PIN 碼資料' });
      }

      clearAuthFailures();
      PropertiesService.getScriptProperties().setProperty('EXAMINER_PIN_HASH', newHash);
      // 清除舊版殘留於試算表儲存格的雜湊，集中由 Script Properties 保管
      if (state.examinerPinHash) {
        state.examinerPinHash = '';
        saveCloudState(state);
      } else {
        const { stateSheet } = ensureSheetsInitialized();
        touchUpdatedAt(stateSheet);
      }

      const sessionToken = createExaminerSession();
      return jsonResponse({
        status: 'success',
        message: '雲端考官 PIN 已安全更新至 Script Properties',
        sessionToken: sessionToken
      });
    }

    // 考官授權檢視或考生透過 POST 讀取試卷狀態 (憑證不暴露於 URL Query String)
    if (action === 'getExamState') {
      if (isAuthRateLimited() && (payload.authPin || payload.authPinHash)) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }
      const isAuth = isExaminerRequestAuthorized(payload, state);
      if (isAuth) {
        return jsonResponse({
          status: 'success',
          isExaminer: true,
          examData: state.examData,
          submissions: state.submissions,
          historySessions: state.historySessions,
          examLibrary: state.examLibrary,
          updatedAt: state.updatedAt
        });
      }

      // 若原本嘗試以考官身分請求但 Session 已過期或無效，明確回傳 session_expired 供前端引導重新登入
      if (payload.sessionToken || payload.authPin || payload.authPinHash) {
        return jsonResponse({
          status: 'unauthorized',
          isExaminer: false,
          message: '考官登入工作階段已逾時或失效，請重新輸入 PIN 碼登入'
        });
      }

      // 考生端模式：必須驗證隨機測驗 Token 與試卷開放狀態
      const reqExamToken = String(payload.examToken || '').trim();
      const activeTokenObj = (state.examData && state.examData.activeExamToken) ? state.examData.activeExamToken : null;
      const isExamOpen = Boolean(state.examData && state.examData.isExamOpen);
      const tokenStatus = evaluateExamTokenStatus(activeTokenObj, reqExamToken);
      const canReceiveQuestions = isExamOpen && tokenStatus === 'valid';

      let sanitizedExamData = null;
      if (state.examData) {
        sanitizedExamData = {
          id: state.examData.id || 'exam_default',
          title: state.examData.title || '',
          durationMinutes: state.examData.durationMinutes,
          examDate: state.examData.examDate || '',
          isExamOpen: isExamOpen,
          openedAt: state.examData.openedAt || null,
          questions: []
        };
        if (canReceiveQuestions && Array.isArray(state.examData.questions)) {
          sanitizedExamData.questions = state.examData.questions.map(q => {
            const safeQ = Object.assign({}, q);
            safeQ.isMultiple = Boolean(q.isMultiple) || normalizeAnswerStringGas(q.answer).length >= 2;
            delete safeQ.answer;
            return safeQ;
          });
        }
      }
      return jsonResponse({
        status: 'success',
        isExaminer: false,
        tokenStatus: tokenStatus,
        examData: sanitizedExamData,
        submissionsCount: (state.submissions || []).length,
        submissions: null,
        historySessions: null,
        examLibrary: null,
        updatedAt: state.updatedAt
      });
    }

    // 檢查考官權限 (除了考生交卷 submitExam 以外，所有後台管理操作均需驗證考官 Session Token，並受統一限流保護)
    const examinerActions = [
      'saveExamData', 'saveExamLibrary', 'syncSubmissions',
      'archiveSession', 'syncHistory', 'sendScoreEmails', 'uploadQuestionImage'
    ];

    if (examinerActions.indexOf(action) !== -1) {
      if (isAuthRateLimited()) {
        return jsonResponse({
          status: 'locked',
          message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘'
        });
      }
      if (!isExaminerRequestAuthorized(payload, state)) {
        return jsonResponse({
          status: 'unauthorized',
          message: '未經授權的考官操作或登入工作階段已逾時，請重新登入考官端！'
        });
      }
    }

    // 1. 考官儲存題庫與試卷設定
    if (action === 'saveExamData') {
      if (payload.examData) {
        // 若試卷由開放切換為關閉狀態，由伺服器端記錄剛關閉之時間戳 closedAt，供 3 分鐘強制收卷寬限期判定 (H1)
        const wasOpen = Boolean(state.examData && state.examData.isExamOpen);
        const nowOpen = Boolean(payload.examData.isExamOpen);
        if (!nowOpen && wasOpen) {
          payload.examData.closedAt = Date.now();
        } else if (!nowOpen && state.examData && state.examData.closedAt && !payload.examData.closedAt) {
          payload.examData.closedAt = state.examData.closedAt;
        } else if (nowOpen) {
          payload.examData.closedAt = null;
        }
        state.examData = payload.examData;
      }
      if (Array.isArray(payload.examLibrary)) {
        state.examLibrary = payload.examLibrary;
      }
      saveCloudState(state);
      return jsonResponse({
        status: 'success',
        message: '題庫與試卷設定已同步至雲端',
        examData: state.examData,
        examLibrary: state.examLibrary
      });
    }

    // 1-b. 考官儲存試卷庫 (多份試卷獨立保存於試卷庫資料工作表)
    if (action === 'saveExamLibrary') {
      const libraryData = Array.isArray(payload.examLibrary)
        ? payload.examLibrary
        : (payload.examLibrary ? [payload.examLibrary] : null);

      if (libraryData) {
        state.examLibrary = libraryData;
        const { stateSheet, librarySheet } = ensureSheetsInitialized();
        syncExamLibrarySheet(librarySheet, state.examLibrary);
        touchUpdatedAt(stateSheet);
      }
      return jsonResponse({
        status: 'success',
        message: '試卷庫已同步至雲端',
        examLibrary: state.examLibrary
      });
    }

    // 2. 考生提交試卷 (H1 安全加固：白名單欄位與長度限制、伺服器端生成 ID/時間戳、開考狀態與關閉寬限期權威校驗、後端客觀評分)
    if (action === 'submitExam') {
      const rawRecord = payload.record;
      if (!rawRecord || typeof rawRecord !== 'object') {
        return jsonResponse({ status: 'error', message: '缺少考生作答資料' });
      }

      const cleanEmail = String(rawRecord.studentEmail || '').trim().substring(0, 120);
      const cleanName = String(rawRecord.studentName || '').trim().substring(0, 60);
      const cleanStudentId = String(rawRecord.studentId || '').trim().substring(0, 40);

      if (!cleanName || !cleanEmail) {
        return jsonResponse({ status: 'error', message: '缺少考生姓名或電子郵件' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return jsonResponse({ status: 'error', message: '電子郵件格式不正確' });
      }

      // 交卷狀態僅允許已知合法列舉值，不信任任意長字串
      const ALLOWED_STATUSES = [
        '正常交卷',
        '時間到自動交卷',
        '測驗結束強制交卷',
        '防作弊強制終止 (離開畫面達3次)'
      ];
      const rawStatus = String(rawRecord.status || '正常交卷').trim();
      const safeStatus = ALLOWED_STATUSES.indexOf(rawStatus) !== -1 ? rawStatus : '正常交卷';
      const isForcedSubmission = safeStatus !== '正常交卷';

      // 伺服器端權威判定試卷是否開放，或是否處於考官剛關閉試卷的 3 分鐘自動收卷寬限期內（不單純依賴客戶端傳來的 status 字串）
      const isExamOpen = Boolean(state.examData && state.examData.isExamOpen);
      const closedAt = Number((state.examData && state.examData.closedAt) || 0);
      const withinCloseGracePeriod = !isExamOpen && closedAt > 0 && (Date.now() - closedAt <= 180000);

      if (!isExamOpen && !(isForcedSubmission && withinCloseGracePeriod)) {
        return jsonResponse({
          status: 'closed',
          message: '考官已結束本次測驗作答，已停止接收交卷！'
        });
      }

      // 後端驗證考生隨機測驗連結 Token (若系統已啟用 activeExamToken，必須持有相符之 Token 始得交卷)
      const activeTokenObj = (state.examData && state.examData.activeExamToken) ? state.examData.activeExamToken : null;
      const reqExamToken = String(payload.examToken || rawRecord.examToken || '').trim();
      if (activeTokenObj && activeTokenObj.token) {
        const tokenStatus = evaluateExamTokenStatus(activeTokenObj, reqExamToken);
        if (tokenStatus === 'none' || tokenStatus === 'invalid') {
          return jsonResponse({
            status: 'token_invalid',
            message: '無效的測驗連結憑證，系統拒絕接收交卷！'
          });
        }
        const tokenExpiredAt = Number(activeTokenObj.expiresAt || 0);
        const withinTokenGrace = tokenStatus === 'expired' && isForcedSubmission && (Date.now() - tokenExpiredAt <= 180000);
        if (tokenStatus === 'expired' && !withinTokenGrace) {
          return jsonResponse({
            status: 'token_expired',
            message: '此測驗連結已超過有效期限，已停止接收交卷！'
          });
        }
      }

      // 檢查當前場次是否已有相同電子郵件 (Email) (不區分大小寫)
      const existsIdx = state.submissions.findIndex(
        s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === cleanEmail.toLowerCase()
      );
      if (existsIdx !== -1) {
        // 不回傳既有紀錄內容，避免外洩他人作答與標準答案
        return jsonResponse({
          status: 'duplicate',
          message: '此電子郵件 (Email) 已於本場次完成交卷'
        });
      }

      // 後端依真實題庫客觀精準評分，徹底防範前端洩漏題目答案或遭竄改成績
      const examQuestions = (state.examData && Array.isArray(state.examData.questions)) ? state.examData.questions : [];
      const totalQ = examQuestions.length;
      let correctCount = 0;
      let answeredCount = 0;
      const gradedAnswerDetails = {};
      const cleanAnswersMap = {};
      const studentAnswers = (rawRecord.answers && typeof rawRecord.answers === 'object') ? rawRecord.answers : {};

      examQuestions.forEach(q => {
        const selected = (studentAnswers[q.id] !== undefined)
          ? studentAnswers[q.id]
          : (rawRecord.answerDetails && rawRecord.answerDetails[q.id] ? rawRecord.answerDetails[q.id].selected : '');
        const cleanSelected = (selected === '未作答' || !selected) ? '' : normalizeAnswerStringGas(selected);
        if (cleanSelected) {
          answeredCount++;
          cleanAnswersMap[q.id] = cleanSelected;
        }
        const cleanCorrect = normalizeAnswerStringGas(q.answer);
        const isCorrect = evaluateQuestionCorrectnessGas(q, cleanSelected);
        if (isCorrect) correctCount++;
        gradedAnswerDetails[q.id] = {
          selected: cleanSelected || '未作答',
          correctAnswer: cleanCorrect || q.answer,
          isCorrect: isCorrect
        };
      });

      // 驗證與正規化作答耗時（限制於 1 秒至考卷時限 + 寬限時間內）
      const maxAllowedSec = Math.max(60, (Number((state.examData && state.examData.durationMinutes) || 60) * 60) + 300);
      let timeSpentSec = Math.round(Number(rawRecord.timeSpentSeconds) || 1);
      if (timeSpentSec < 1) timeSpentSec = 1;
      if (timeSpentSec > maxAllowedSec) timeSpentSec = maxAllowedSec;
      const mins = Math.floor(timeSpentSec / 60);
      const secs = timeSpentSec % 60;
      const serverTimeSpentFormatted = `${mins} 分 ${secs} 秒`;

      let safeWarnCount = Math.floor(Number(rawRecord.warningCount) || 0);
      if (safeWarnCount < 0) safeWarnCount = 0;
      if (safeWarnCount > 99) safeWarnCount = 99;

      const rawScore = totalQ > 0 ? (correctCount / totalQ) * 100 : 0;
      const serverNowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
      const serverSubId = 'SUB_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);

      // 僅以白名單欄位建構純淨交卷紀錄，拒絕客戶端注入任意未知屬性
      const sanitizedRecord = {
        id: serverSubId,
        examTitle: String((state.examData && state.examData.title) || rawRecord.examTitle || '未命名測驗').substring(0, 120),
        examDate: String((state.examData && state.examData.examDate) || rawRecord.examDate || '').substring(0, 20),
        studentName: cleanName,
        studentId: cleanStudentId,
        studentEmail: cleanEmail,
        score: Number(rawScore.toFixed(1)),
        correctCount: correctCount,
        totalQuestions: totalQ,
        answeredCount: answeredCount,
        warningCount: safeWarnCount,
        status: safeStatus,
        timeSpentSeconds: timeSpentSec,
        timeSpentFormatted: serverTimeSpentFormatted,
        submittedAt: serverNowStr,
        emailSentAt: '',
        answers: cleanAnswersMap,
        answerDetails: gradedAnswerDetails
      };

      state.submissions.unshift(sanitizedRecord);
      saveCloudState(state);
      // 效能優化：使用 appendRow 追加，不再全量清空整張工作表重寫
      appendSubmissionToScoresSheet(state.examData, sanitizedRecord);

      // 不回傳評分後的 record (內含標準答案)，避免交卷後考生取得答案外流給其他考生
      return jsonResponse({
        status: 'success',
        message: '交卷成功並已寫入雲端資料庫',
        submissionId: serverSubId,
        submittedAt: serverNowStr,
        submissionsCount: state.submissions.length
      });
    }

    // 3. 考官同步當前場次成績列表 (刪除單筆、清空、或產生測試資料)
    if (action === 'syncSubmissions') {
      if (Array.isArray(payload.submissions)) {
        state.submissions = payload.submissions;
      }
      if (payload.examData) {
        state.examData = payload.examData;
      }
      saveCloudState(state);
      syncCurrentScoresSheet(state.examData, state.submissions);

      return jsonResponse({
        status: 'success',
        message: '考生成績已同步更新至雲端',
        submissions: state.submissions
      });
    }

    // 4. 將當前測驗場次結算並歸檔為一筆獨立歷史紀錄
    if (action === 'archiveSession') {
      const historyRecord = payload.historyRecord;
      if (!historyRecord || !historyRecord.id) {
        return jsonResponse({ status: 'error', message: '缺少歷史場次歸檔資料' });
      }

      // 避免重複歸檔同 ID
      const existingIdx = state.historySessions.findIndex(h => h.id === historyRecord.id);
      if (existingIdx !== -1) {
        state.historySessions[existingIdx] = historyRecord;
      } else {
        state.historySessions.unshift(historyRecord);
      }

      // 若指定歸檔後清空當前場次考生成績
      if (payload.clearCurrent !== false) {
        state.submissions = [];
      }
      // 若同時傳入新試卷資料
      if (payload.newExamData) {
        state.examData = payload.newExamData;
      }

      saveCloudState(state);
      syncCurrentScoresSheet(state.examData, state.submissions);
      syncHistoryLogSheet(state.historySessions);

      return jsonResponse({
        status: 'success',
        message: '已成功將測驗結果歸檔為獨立歷史紀錄',
        historySessions: state.historySessions,
        submissions: state.submissions,
        examData: state.examData
      });
    }

    // 5. 同步或刪除歷史測驗紀錄
    if (action === 'syncHistory') {
      if (Array.isArray(payload.historySessions)) {
        state.historySessions = payload.historySessions;
      }
      saveCloudState(state);
      syncHistoryLogSheet(state.historySessions);

      return jsonResponse({
        status: 'success',
        message: '歷史紀錄已同步更新',
        historySessions: state.historySessions
      });
    }

    // 6. 寄送考生成績單 Email (H3 安全加固：僅允許寄發予伺服器端 state 既有的真實考生紀錄、強制由伺服器端組建 HTML 信件、拒絕客戶端 customHtmlBody、限制單次最多 100 封)
    if (action === 'sendScoreEmails') {
      const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
      const sessionId = payload.sessionId || 'CURRENT';
      const MAX_BATCH_EMAILS = 100;

      if (rawRecipients.length === 0) {
        return jsonResponse({ status: 'error', message: '沒有可寄送的考生 Email 名單' });
      }
      if (rawRecipients.length > MAX_BATCH_EMAILS) {
        return jsonResponse({ status: 'error', message: `單次寄送數量超過上限（最多 ${MAX_BATCH_EMAILS} 封），請分批寄送` });
      }

      // 鎖定伺服器端真實場次與交卷紀錄清單
      let authoritativeList = [];
      let examInfo = state.examData || {};
      if (sessionId === 'CURRENT') {
        authoritativeList = Array.isArray(state.submissions) ? state.submissions : [];
      } else {
        const targetHist = (state.historySessions || []).find(h => h && h.id === sessionId);
        if (!targetHist) {
          return jsonResponse({ status: 'error', message: '找不到指定的歷史測驗場次紀錄' });
        }
        authoritativeList = Array.isArray(targetHist.submissions) ? targetHist.submissions : [];
        examInfo = {
          title: targetHist.examTitle || targetHist.sessionTitle || examInfo.title || '線上筆試測驗',
          examDate: targetHist.examDate || examInfo.examDate || '-',
          questions: Array.isArray(targetHist.questionsSnapshot) ? targetHist.questionsSnapshot : (examInfo.questions || [])
        };
      }

      let sentCount = 0;
      const sentIds = [];
      const errors = [];
      const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

      rawRecipients.forEach(reqSub => {
        if (!reqSub || !reqSub.id) return;
        // 強制比對伺服器端真實交卷紀錄 ID，防止偽造收件人或釣魚信濫用
        const authSub = authoritativeList.find(s => s && s.id === reqSub.id);
        if (!authSub) {
          errors.push(`找不到交卷紀錄 (${String(reqSub.id).substring(0, 24)})，請先將成績同步至雲端後再寄信`);
          return;
        }
        const targetEmail = String(authSub.studentEmail || '').trim();
        if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
          errors.push(`${authSub.studentName || '考生'}：缺少有效的電子郵件信箱`);
          return;
        }
        try {
          const subject = `【測驗成績通知】${authSub.examTitle || examInfo.title || '線上筆試測驗'} - ${authSub.studentName}${authSub.studentId ? ` (${authSub.studentId})` : ''}`;
          const htmlBody = buildScoreEmailHtml(authSub, examInfo, state);

          MailApp.sendEmail({
            to: targetEmail,
            subject: subject,
            htmlBody: htmlBody
          });

          authSub.emailSentAt = nowStr;
          sentCount++;
          sentIds.push(authSub.id);
        } catch (mailErr) {
          console.error('MailApp.sendEmail error:', mailErr);
          errors.push(`${authSub.studentName} (${targetEmail}): 郵件發送失敗`);
        }
      });

      // 更新雲端狀態中的 emailSentAt 標記
      if (sentIds.length > 0) {
        if (sessionId === 'CURRENT') {
          syncCurrentScoresSheet(state.examData, state.submissions);
        }
        saveCloudState(state);
      }

      return jsonResponse({
        status: 'success',
        sentCount: sentCount,
        sentIds: sentIds,
        emailSentAt: nowStr,
        errors: errors,
        message: `成功寄出 ${sentCount} 封考生成績通知信！`
      });
    }

    // 7. 考題圖片上傳至 Google 雲端硬碟指定資料夾 (M1 安全加固：嚴格驗證圖片 MIME 類型、副檔名白名單與檔案魔術位元組 Magic Bytes)
    if (action === 'uploadQuestionImage') {
      const base64Data = String(payload.base64Data || '').trim();
      const rawMimeType = String(payload.mimeType || 'image/png').trim().toLowerCase();

      if (!base64Data) {
        return jsonResponse({ status: 'error', message: '未收到圖片檔案資料' });
      }

      // 僅允許安全點陣圖格式 (PNG, JPEG, GIF, WEBP)，阻絕 SVG / HTML / 腳本檔案上傳以防範 Stored XSS
      const ALLOWED_IMAGE_MIMES = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp'
      };
      if (!ALLOWED_IMAGE_MIMES[rawMimeType]) {
        return jsonResponse({
          status: 'error',
          message: '不支援的圖片格式！僅允許上傳 PNG、JPG、GIF 或 WEBP 圖片檔'
        });
      }

      try {
        const decoded = Utilities.base64Decode(base64Data);
        if (!decoded || decoded.length < 12) {
          return jsonResponse({ status: 'error', message: '圖片檔案內容無效或損毀' });
        }

        // 檢查檔案開頭 Magic Bytes，確保真實內容為合法的點陣圖檔
        const b0 = decoded[0] & 0xff;
        const b1 = decoded[1] & 0xff;
        const b2 = decoded[2] & 0xff;
        const b3 = decoded[3] & 0xff;
        const isPng = (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47);
        const isJpg = (b0 === 0xff && b1 === 0xd8 && b2 === 0xff);
        const isGif = (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38);
        const isWebp = (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46 &&
                        (decoded[8] & 0xff) === 0x57 && (decoded[9] & 0xff) === 0x45 &&
                        (decoded[10] & 0xff) === 0x42 && (decoded[11] & 0xff) === 0x50);

        if (!isPng && !isJpg && !isGif && !isWebp) {
          return jsonResponse({
            status: 'error',
            message: '檔案內容驗證失敗：非有效的 PNG、JPG、GIF 或 WEBP 影像格式'
          });
        }

        const detectedExt = isPng ? 'png' : (isJpg ? 'jpg' : (isGif ? 'gif' : 'webp'));
        const canonicalMime = isPng ? 'image/png' : (isJpg ? 'image/jpeg' : (isGif ? 'image/gif' : 'image/webp'));

        let folder;
        const folderId = getExamImageFolderId();
        if (folderId) {
          folder = DriveApp.getFolderById(folderId);
        } else {
          folder = DriveApp.getRootFolder();
        }

        const safeName = `exam_q_${Date.now()}_${Math.floor(Math.random() * 1000)}.${detectedExt}`;
        const blob = Utilities.newBlob(decoded, canonicalMime, safeName);
        const file = folder.createFile(blob);

        // 設定檢視權限為知道連結者皆可檢視
        try {
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        } catch (shareErr) {
          console.warn('Set sharing error:', shareErr);
        }

        const fileId = file.getId();
        // 採用 Google 官方 CDN 直連網址 (lh3.googleusercontent.com) 與 thumbnail 備援，支援網頁 <img> 標籤直接顯示
        const directUrl = `https://lh3.googleusercontent.com/d/${fileId}`;
        const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;

        return jsonResponse({
          status: 'success',
          fileId: fileId,
          imageUrl: directUrl,
          thumbnailUrl: thumbUrl,
          message: '圖片已成功上傳至 Google 雲端硬碟！'
        });
      } catch (uploadErr) {
        console.error('uploadQuestionImage Exception:', uploadErr);
        return jsonResponse({
          status: 'error',
          message: '上傳圖片至雲端硬碟失敗，請確認已執行 testDriveAuthorization 完成雲端硬碟授權'
        });
      }
    }

    return jsonResponse({ status: 'error', message: '未知的 POST action' });
  } catch (err) {
    console.error('doPost Exception:', err);
    return jsonResponse({ status: 'error', message: '雲端伺服器處理請求時發生錯誤，請稍後再試' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 建立考生成績通知 HTML 信件內容 (完全由伺服器端根據真實交卷紀錄與題庫順序組建，不含考題與標準答案)
 */
function extractStudentAnswersForGasEmail(sub, examInfo, state) {
  let details = (sub && sub.answerDetails) ? sub.answerDetails : null;
  if (!details && state && Array.isArray(state.submissions)) {
    const found = state.submissions.find(s => s && s.id === sub.id);
    if (found && found.answerDetails) {
      details = found.answerDetails;
    }
  }
  if (!details && state && Array.isArray(state.historySessions)) {
    for (let i = 0; i < state.historySessions.length; i++) {
      const h = state.historySessions[i];
      if (h && Array.isArray(h.submissions)) {
        const found = h.submissions.find(s => s && s.id === sub.id);
        if (found && found.answerDetails) {
          details = found.answerDetails;
          break;
        }
      }
    }
  }

  if (!details) return [];

  const questions = (examInfo && Array.isArray(examInfo.questions) && examInfo.questions.length > 0)
    ? examInfo.questions
    : (state && state.examData && Array.isArray(state.examData.questions) ? state.examData.questions : []);

  const list = [];
  if (questions.length > 0) {
    questions.forEach((q, idx) => {
      const d = details[q.id] !== undefined ? details[q.id] : details[idx + 1];
      list.push({
        qNum: idx + 1,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    });
  } else {
    const keys = Object.keys(details);
    keys.forEach((k, idx) => {
      const d = details[k];
      list.push({
        qNum: idx + 1,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    });
  }
  return list;
}

function buildStudentAnswerGridGasHtml(studentAnswers) {
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
        ansCells += `<td style="background:${bg};color:${fg};font-weight:700;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;font-size:16px;">${escapeHtmlStr(item.selected)}</td>`;
      } else {
        qNumCells += `<td style="background:#005959;color:#ffffff;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;"></td>`;
        ansCells += `<td style="background:#f8fafc;color:#94a3b8;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;"></td>`;
      }
    }

    rowsHtml += `
      <tr>
        <td style="background:#005959;color: #ffffff;font-weight:700;text-align:center;padding:8px 10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">題號</td>
        ${qNumCells}
      </tr>
      <tr>
        <td style="background:#005959;color: #ffffff;font-weight:700;text-align:center;padding:10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">答案</td>
        ${ansCells}
      </tr>
    `;
  }

  return `
    <div style="margin-top:18px;">
      <div style="margin-bottom:8px;">
        <span style="font-size:15px;font-weight:700;color: #005959;">📋 考生作答明細</span>
        <span style="font-size:12.5px;color: #475569;margin-left:14px;">
          <span style="display:inline-block;width:12px;height:12px;background: #d1fdf4ff;border:1px solid #005959;vertical-align:middle;margin-right:4px;"></span>正確
          <span style="display:inline-block;width:12px;height:12px;background: #ffc8c8ff;border:1px solid #dc2626;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>錯誤
        </span>
      </div>
      <table style="width:100%;border-collapse:collapse;border:2px solid #003d3d;font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;">
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function buildScoreEmailHtml(sub, examInfo, state) {
  // H3 安全加固：強制由伺服器端組建 HTML 成績通知信，不再接受客戶端傳入的 sub.customHtmlBody，防範任意 HTML 釣魚信注入
  const scoreColor = Number(sub.score) >= 60 ? '#007979' : '#dc2626';
  const passBadge = Number(sub.score) >= 60 ? '及格' : '未達及格標準 (60分)';
  const examDateStr = sub.examDate || (examInfo && examInfo.examDate) || '-';
  const studentAnswers = extractStudentAnswersForGasEmail(sub, examInfo, state);
  const gridHtml = buildStudentAnswerGridGasHtml(studentAnswers);

  return `
    <div style="font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:620px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#ffffff;">
      <div style="background:linear-gradient(135deg,#005959,#007979);color:#ffffff;padding:20px 24px;">
        <div style="font-size:13px;opacity:0.9;">線上筆試測驗系統 — 成績通知單</div>
        <h2 style="margin:6px 0 0;font-size:20px;">${escapeHtmlStr(sub.examTitle || examInfo.title || '線上筆試測驗')}</h2>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 16px;font-size:15px;color:#334155;">
          <strong>${escapeHtmlStr(sub.studentName)}</strong>${sub.studentId ? `（編號：<strong>${escapeHtmlStr(sub.studentId)}</strong>）` : ''} 您好，您的筆試測驗成績結果如下：
        </p>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;margin-bottom:16px;">
          <div style="font-size:14px;color:#64748b;">測驗總分（滿分 100 分）</div>
          <div style="font-size:34px;font-weight:800;color:${scoreColor};margin:6px 0;">
            ${sub.score} <span style="font-size:16px;font-weight:600;">分（${passBadge}）</span>
          </div>
          <div style="font-size:13.5px;color:#475569;margin-top:10px;line-height:1.8;">
            • 考試日期：<strong>${escapeHtmlStr(examDateStr)}</strong><br>
            • 答對題數：<strong>${sub.correctCount} / ${sub.totalQuestions} 題</strong><br>
            • 作答耗時：<strong>${escapeHtmlStr(sub.timeSpentFormatted || '-')}</strong><br>
            • 交卷狀態：<strong>${escapeHtmlStr(sub.status || '正常交卷')}</strong><br>
            • 交卷時間：<strong>${escapeHtmlStr(sub.submittedAt || '-')}</strong>
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

/**
 * 讀寫 Google 試算表中的系統狀態
 */
function ensureSheetsInitialized() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let stateSheet = ss.getSheetByName(SHEET_NAMES.STATE);
  if (!stateSheet) {
    stateSheet = ss.insertSheet(SHEET_NAMES.STATE);
    stateSheet.getRange('A1:B1').setValues([['Key', 'JSON_Value']]);
    stateSheet.getRange('A2:B5').setValues([
      ['EXAM_DATA', ''],
      ['SUBMISSIONS', '[]'],
      ['HISTORY_SESSIONS', '[]'],
      ['UPDATED_AT', new Date().toISOString()]
    ]);
  }

  let scoreSheet = ss.getSheetByName(SHEET_NAMES.CURRENT_SCORES);
  if (!scoreSheet) {
    scoreSheet = ss.insertSheet(SHEET_NAMES.CURRENT_SCORES);
    scoreSheet.getRange('A1:J1').setValues([[
      '編號', '考生姓名', '電子郵件 (Email)', '總分', '答對題數', '總題數', '作答耗時', '防作弊警告', '交卷狀態', '交卷時間'
    ]]);
  }

  let histSheet = ss.getSheetByName(SHEET_NAMES.HISTORY_LOG);
  if (!histSheet) {
    histSheet = ss.insertSheet(SHEET_NAMES.HISTORY_LOG);
    histSheet.getRange('A1:I1').setValues([[
      '場次紀錄ID', '試卷名稱', '考試日期', '歸檔時間', '應試人數', '平均分數', '中位數', '標準差', '及格率(%)'
    ]]);
  }

  let librarySheet = ss.getSheetByName(SHEET_NAMES.EXAM_LIBRARY);
  if (!librarySheet) {
    librarySheet = ss.insertSheet(SHEET_NAMES.EXAM_LIBRARY);
    librarySheet.getRange('A1:G1').setValues([[
      '試卷ID', '試卷名稱', '考試日期', '測驗時間(分)', '題目數', '建立/更新時間', '完整考題資料JSON'
    ]]);
  }

  return { ss, stateSheet, scoreSheet, histSheet, librarySheet };
}

function loadExamLibraryFromSheet(librarySheet) {
  const lastRow = librarySheet.getLastRow();
  if (lastRow <= 1) return [];
  const rows = librarySheet.getRange(2, 1, lastRow - 1, 7).getValues();
  const library = [];
  rows.forEach(r => {
    if (!r[0] && !r[1]) return;
    let questions = [];
    try {
      if (r[6]) questions = JSON.parse(r[6]);
    } catch (e) {}

    let dateVal = '';
    if (r[2] instanceof Date) {
      dateVal = Utilities.formatDate(r[2], Session.getScriptTimeZone() || 'GMT+8', 'yyyy-MM-dd');
    } else {
      dateVal = String(r[2] || '').trim();
    }

    library.push({
      id: String(r[0] || ''),
      title: String(r[1] || ''),
      examDate: dateVal,
      durationMinutes: r[3] !== '' ? Number(r[3]) : 60,
      questions: Array.isArray(questions) ? questions : [],
      updatedAt: String(r[5] || '')
    });
  });
  return library;
}

function syncExamLibrarySheet(librarySheet, examLibrary) {
  librarySheet.clearContents();
  const headers = ['試卷ID', '試卷名稱', '考試日期', '測驗時間(分)', '題目數', '建立/更新時間', '完整考題資料JSON'];
  const rows = [headers];
  (examLibrary || []).forEach(exam => {
    let questionsJson = '[]';
    try {
      // 若考題內含過長之本地 Base64 預覽字串，先進行精簡以防超過試算表單一儲存格 50,000 字元限制
      const sanitizedQuestions = (exam.questions || []).map(q => {
        if (q.imageUrl && String(q.imageUrl).startsWith('data:')) {
          const clone = Object.assign({}, q);
          delete clone.imageUrl;
          return clone;
        }
        return q;
      });
      questionsJson = JSON.stringify(sanitizedQuestions);
      if (questionsJson.length > 49000) {
        questionsJson = questionsJson.substring(0, 49000);
      }
    } catch (e) {
      questionsJson = '[]';
    }

    let examDateStr = '';
    if (exam.examDate instanceof Date) {
      examDateStr = Utilities.formatDate(exam.examDate, Session.getScriptTimeZone() || 'GMT+8', 'yyyy-MM-dd');
    } else {
      examDateStr = String(exam.examDate || '');
    }

    rows.push([
      sanitizeSheetCellGas(exam.id || ''),
      sanitizeSheetCellGas(exam.title || '未命名試卷'),
      sanitizeSheetCellGas(examDateStr),
      exam.durationMinutes !== '' ? exam.durationMinutes : 60,
      Array.isArray(exam.questions) ? exam.questions.length : 0,
      sanitizeSheetCellGas(exam.updatedAt || new Date().toISOString()),
      sanitizeSheetCellGas(questionsJson)
    ]);
  });

  // 自動拓展工作表長寬以避免超出維度錯誤
  if (librarySheet.getMaxRows() < rows.length) {
    librarySheet.insertRowsAfter(librarySheet.getMaxRows(), rows.length - librarySheet.getMaxRows());
  }
  if (librarySheet.getMaxColumns() < headers.length) {
    librarySheet.insertColumnsAfter(librarySheet.getMaxColumns(), headers.length - librarySheet.getMaxColumns());
  }

  librarySheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  // 格式化標題列背景色與防止長 JSON 折行撐高儲存格
  try {
    librarySheet.getRange(1, 1, 1, headers.length).setBackground('#f1f5f9').setFontWeight('bold');
    librarySheet.getRange(1, 7, rows.length, 1).setWrap(false);
  } catch (fmtErr) {}
}

/**
 * Google 試算表單一儲存格 50,000 字元上限安全保護：
 * 當字串超過 40,000 字元時，自動分塊 (chunking) 儲存，徹底防範 Base64 圖片或大量交卷資料截斷報錯
 */
function safeChunkWrite(key, dataStr, rows) {
  const CHUNK_SIZE = 40000;
  if (!dataStr || dataStr.length <= CHUNK_SIZE) {
    rows.push([key, dataStr || '']);
  } else {
    const count = Math.ceil(dataStr.length / CHUNK_SIZE);
    rows.push([key + '#count', 'n' + count]);
    for (let i = 0; i < count; i++) {
      // 每塊前綴 "~"：避免切塊後開頭為 = + - 或數字時被試算表誤判為公式/數值而破壞資料
      rows.push([key + '#' + i, '~' + dataStr.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)]);
    }
  }
}

function safeChunkRead(map, key, fallback) {
  if (map[key + '#count']) {
    const count = parseInt(String(map[key + '#count']).replace(/^n/, ''), 10) || 0;
    let combined = '';
    for (let i = 0; i < count; i++) {
      const piece = map[key + '#' + i] || '';
      combined += piece.charAt(0) === '~' ? piece.substring(1) : piece;
    }
    return combined;
  }
  return map[key] !== undefined ? map[key] : (fallback || '');
}

function loadCloudState() {
  const { stateSheet, librarySheet } = ensureSheetsInitialized();
  const rawRows = stateSheet.getDataRange().getValues();
  const map = {};
  rawRows.forEach((r, idx) => {
    if (idx === 0) return; // 跳過標題列
    const k = String(r[0] || '').trim();
    if (k) map[k] = r[1] !== undefined ? String(r[1]) : '';
  });

  let examData = null;
  let submissions = [];
  let historySessions = [];

  try {
    const examStr = safeChunkRead(map, 'EXAM_DATA', '');
    if (examStr) examData = JSON.parse(examStr);
  } catch (e) {
    console.warn('解析 EXAM_DATA 失敗:', e);
  }
  try {
    const subStr = safeChunkRead(map, 'SUBMISSIONS', '[]');
    if (subStr) submissions = JSON.parse(subStr);
  } catch (e) {
    console.warn('解析 SUBMISSIONS 失敗:', e);
  }
  try {
    const histStr = safeChunkRead(map, 'HISTORY_SESSIONS', '[]');
    if (histStr) historySessions = JSON.parse(histStr);
  } catch (e) {
    console.warn('解析 HISTORY_SESSIONS 失敗:', e);
  }

  let examLibrary = loadExamLibraryFromSheet(librarySheet);
  // 若試卷庫工作表尚無試卷資料但 EXAM_DATA 有資料，自動無痛遷移為試卷庫資料
  if (examLibrary.length === 0 && examData && Array.isArray(examData.questions)) {
    if (Array.isArray(examData.examLibrary) && examData.examLibrary.length > 0) {
      examLibrary = examData.examLibrary;
    } else {
      const initialExam = {
        id: examData.id || ('exam_' + Date.now()),
        title: examData.title || '預設試卷',
        examDate: examData.examDate || '',
        durationMinutes: examData.durationMinutes !== '' ? examData.durationMinutes : 60,
        questions: examData.questions,
        updatedAt: new Date().toISOString()
      };
      examLibrary = [initialExam];
    }
    syncExamLibrarySheet(librarySheet, examLibrary);
  }

  // 確保 EXAM_DATA 乾淨單純，不冗餘堆疊試卷庫資料
  if (examData && examData.examLibrary) {
    delete examData.examLibrary;
  }

  return {
    examData: examData,
    submissions: Array.isArray(submissions) ? submissions : [],
    historySessions: Array.isArray(historySessions) ? historySessions : [],
    examLibrary: examLibrary,
    examinerPinHash: map.EXAMINER_PIN_HASH || '',
    updatedAt: map.UPDATED_AT || ''
  };
}

function saveCloudState(state) {
  try {
    CacheService.getScriptCache().remove('STATE_MAP_LIGHT');
  } catch (e) {}
  const { stateSheet, librarySheet } = ensureSheetsInitialized();
  const nowIso = new Date().toISOString();
  state.updatedAt = nowIso;

  // 確保寫入「系統狀態資料庫」的 EXAM_DATA 僅存放當前測驗設定，所有試卷資料統一保存在「試卷庫資料」工作表中
  let cleanExamData = null;
  if (state.examData) {
    cleanExamData = Object.assign({}, state.examData);
    delete cleanExamData.examLibrary;
  }

  const rows = [];
  safeChunkWrite('EXAM_DATA', cleanExamData ? JSON.stringify(cleanExamData) : '', rows);
  safeChunkWrite('SUBMISSIONS', JSON.stringify(state.submissions || []), rows);
  safeChunkWrite('HISTORY_SESSIONS', JSON.stringify(state.historySessions || []), rows);
  rows.push(['UPDATED_AT', nowIso]);
  if (state.examinerPinHash) {
    rows.push(['EXAMINER_PIN_HASH', state.examinerPinHash]);
  }

  // 清除舊資料區塊並寫入新 rows (支援自動擴充至多行 chunk，絕不超過單格 50,000 字元)
  const currentMaxRows = Math.max(stateSheet.getLastRow(), rows.length + 1, 10);
  stateSheet.getRange(2, 1, currentMaxRows, 2).clearContent();
  stateSheet.getRange(2, 1, rows.length, 2).setValues(rows);

  if (Array.isArray(state.examLibrary)) {
    syncExamLibrarySheet(librarySheet, state.examLibrary);
  }
}

/**
 * 試算表公式注入防護 (H2 CSV / Formula Injection Protection)：
 * 若文字欄位開頭為 =、+、-、@、Tab (\t) 或換行 (\r, \n)，自動加上單引號 (') 前綴，防止在 Google Sheets 或匯出 Excel 時被當成公式執行
 */
function sanitizeSheetCellGas(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  const str = String(val);
  if (/^[=+\-@\t\r\n]/.test(str)) {
    return "'" + str;
  }
  return str;
}

/**
 * 考生交卷時快速追加單筆成績 (appendRow)，不再清除全表重寫，提升 10 倍以上寫入效率
 */
function appendSubmissionToScoresSheet(examData, sub) {
  const { scoreSheet } = ensureSheetsInitialized();
  const questions = (examData && Array.isArray(examData.questions)) ? examData.questions : [];

  // 每次以單列 setValues 校正標題列 (含題目欄位)，確保與追加資料欄位對齊
  const headers = [
    '編號', '考生姓名', '電子郵件 (Email)', '總分', '答對題數', '總題數', '作答耗時', '防作弊警告', '交卷狀態', '交卷時間', '成績信寄送時間'
  ];
  questions.forEach((q, idx) => {
    headers.push(sanitizeSheetCellGas(`第${idx + 1}題(正解:${q.answer})`));
  });
  if (headers.length > scoreSheet.getMaxColumns()) {
    scoreSheet.insertColumnsAfter(scoreSheet.getMaxColumns(), headers.length - scoreSheet.getMaxColumns());
  }
  scoreSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const row = [
    sanitizeSheetCellGas(sub.studentId || ''),
    sanitizeSheetCellGas(sub.studentName || ''),
    sanitizeSheetCellGas(sub.studentEmail || ''),
    Number(sub.score ?? 0),
    Number(sub.correctCount ?? 0),
    Number(sub.totalQuestions ?? 0),
    sanitizeSheetCellGas(sub.timeSpentFormatted || ''),
    Number(sub.warningCount ?? 0),
    sanitizeSheetCellGas(sub.status || ''),
    sanitizeSheetCellGas(sub.submittedAt || ''),
    sanitizeSheetCellGas(sub.emailSentAt || '尚未寄送')
  ];
  questions.forEach(q => {
    const d = (sub.answerDetails && sub.answerDetails[q.id]) ? sub.answerDetails[q.id] : null;
    row.push(sanitizeSheetCellGas(d ? d.selected : '未作答'));
  });
  scoreSheet.appendRow(row);
}

function syncCurrentScoresSheet(examData, submissions) {
  const { scoreSheet } = ensureSheetsInitialized();
  scoreSheet.clearContents();

  const headers = [
    '編號', '考生姓名', '電子郵件 (Email)', '總分', '答對題數', '總題數', '作答耗時', '防作弊警告', '交卷狀態', '交卷時間', '成績信寄送時間'
  ];
  const questions = (examData && Array.isArray(examData.questions)) ? examData.questions : [];
  questions.forEach((q, idx) => {
    headers.push(sanitizeSheetCellGas(`第${idx + 1}題(正解:${q.answer})`));
  });

  const rows = [headers];
  (submissions || []).forEach(sub => {
    const row = [
      sanitizeSheetCellGas(sub.studentId || ''),
      sanitizeSheetCellGas(sub.studentName || ''),
      sanitizeSheetCellGas(sub.studentEmail || ''),
      Number(sub.score ?? 0),
      Number(sub.correctCount ?? 0),
      Number(sub.totalQuestions ?? 0),
      sanitizeSheetCellGas(sub.timeSpentFormatted || ''),
      Number(sub.warningCount ?? 0),
      sanitizeSheetCellGas(sub.status || ''),
      sanitizeSheetCellGas(sub.submittedAt || ''),
      sanitizeSheetCellGas(sub.emailSentAt || '尚未寄送')
    ];
    questions.forEach(q => {
      const d = (sub.answerDetails && sub.answerDetails[q.id]) ? sub.answerDetails[q.id] : null;
      row.push(sanitizeSheetCellGas(d ? d.selected : '未作答'));
    });
    rows.push(row);
  });

  if (headers.length > scoreSheet.getMaxColumns()) {
    scoreSheet.insertColumnsAfter(scoreSheet.getMaxColumns(), headers.length - scoreSheet.getMaxColumns());
  }
  scoreSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
}

function syncHistoryLogSheet(historySessions) {
  const { histSheet } = ensureSheetsInitialized();
  histSheet.clearContents();

  const headers = [
    '場次紀錄ID', '試卷名稱', '考試日期', '歸檔時間', '應試人數', '平均分數', '中位數', '標準差', '及格率(%)'
  ];
  const rows = [headers];

  (historySessions || []).forEach(h => {
    const st = h.stats || {};
    rows.push([
      sanitizeSheetCellGas(h.id || ''),
      sanitizeSheetCellGas(h.examTitle || ''),
      sanitizeSheetCellGas(h.examDate || ''),
      sanitizeSheetCellGas(h.archivedAt || ''),
      Number(h.submissions ? h.submissions.length : 0),
      Number(st.mean ?? 0),
      Number(st.median ?? 0),
      Number(st.stdDev ?? 0),
      Number(st.passRate ?? 0)
    ]);
  });

  histSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
}

function normalizeAnswerStringGas(raw) {
  const letters = String(raw || '').toUpperCase().match(/[A-Z]/g);
  if (!letters || letters.length === 0) return '';
  return Array.from(new Set(letters)).sort().join('');
}

function evaluateQuestionCorrectnessGas(q, rawSelected) {
  if (!q) return false;
  const selected = normalizeAnswerStringGas(rawSelected === '未作答' ? '' : rawSelected);
  const correct = normalizeAnswerStringGas(q.answer);
  if (!selected || !correct) return false;
  const isMulti = Boolean(q.isMultiple) || correct.length >= 2;
  if (isMulti && q.multiScoreRule === 'any') {
    const correctChars = correct.split('');
    return selected.split('').some(function(ch) { return correctChars.indexOf(ch) !== -1; });
  }
  return selected === correct;
}

function escapeHtmlStr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

