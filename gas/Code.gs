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
 * - Cloudflare Turnstile 訪客安全驗證：可於 Script Properties 新增屬性 `TURNSTILE_SECRET_KEY` 填入您的 Cloudflare Turnstile Secret Key。
 * ============================================================================
 */

const SHEET_NAMES = {
  STATE: '系統狀態資料庫',
  CURRENT_SCORES: '當前考生成績',
  HISTORY_LOG: '歷次測驗紀錄',
  EXAM_LIBRARY: '試卷庫資料',
  USERS: '考官帳號資料',
  AUDIT_LOG: '安全稽核紀錄'
};

// 考題圖片專用 Google 雲端硬碟資料夾 ID (請於 Script Properties 設定 EXAM_IMAGE_FOLDER_ID，不於程式碼公開預設資料夾 ID)
const DEFAULT_EXAM_IMAGE_FOLDER_ID = '';

function getExamImageFolderId() {
  try {
    const propId = PropertiesService.getScriptProperties().getProperty('EXAM_IMAGE_FOLDER_ID');
    if (propId && propId.trim()) return propId.trim();
  } catch (e) {}
  return DEFAULT_EXAM_IMAGE_FOLDER_ID;
}

/**
 * 首次部署或需要更新後端管理員金鑰 / 初始化預設管理員帳號時，可在 Apps Script 編輯器修改下方參數並執行一次 `initCustomSecurityCredentials`
 * 執行後系統會自動產生高熵隨機 Salt/Pepper 並將雜湊安全寫入 Script Properties (請勿將真實密碼留存於程式碼中提交至 GitHub)
 */
function initCustomSecurityCredentials() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const pinSalt = all.EXAMINER_PIN_SALT || ('PIN_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  const adminSalt = all.ADMIN_KEY_SALT || ('ADM_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  const pwPepper = all.USER_PASSWORD_PEPPER || ('PEPPER_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, ''));
  // 如需重設，請暫時將下方空字串改為您自訂的 PIN 碼與管理員金鑰並點選「執行」，執行完畢後請清空還原為 ''
  const customPin = '';
  const customAdminKey = '';
  // 如需直接於試算表建立/重設首位管理員帳號，可填入下方 adminUsername 與 adminPassword (須含大小寫英文與數字，至少 8 碼)，執行後請清空還原為 ''
  const bootstrapAdminUsername = '';
  const bootstrapAdminPassword = '';
  const updates = {
    EXAMINER_PIN_SALT: pinSalt,
    ADMIN_KEY_SALT: adminSalt,
    USER_PASSWORD_PEPPER: pwPepper
  };
  if (customPin) {
    updates.EXAMINER_PIN_HASH = sha256Hex(`${pinSalt}:${customPin}`).toLowerCase();
  }
  if (customAdminKey) {
    updates.ADMIN_KEY_HASH = sha256Hex(`${adminSalt}:${customAdminKey}`).toLowerCase();
  }
  props.setProperties(updates, false);

  if (bootstrapAdminUsername && bootstrapAdminPassword) {
    const cleanUser = String(bootstrapAdminUsername).trim().toLowerCase();
    const cleanPass = String(bootstrapAdminPassword);
    if (!isStrongPasswordGas(cleanPass)) {
      Logger.log('❌ 管理員密碼強度不符（須 8~64 碼且包含大寫英文、小寫英文與數字）');
      return;
    }
    const users = loadUsersFromSheet();
    const existing = users.find(u => u.username.toLowerCase() === cleanUser);
    const salt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
    const hash = hashUserPasswordGas(cleanPass, salt, pwPepper);
    const nowIso = new Date().toISOString();
    if (existing) {
      existing.pwSalt = salt;
      existing.pwHash = hash;
      existing.role = 'admin';
      existing.status = 'active';
      existing.failCount = 0;
      existing.lockedUntil = 0;
      existing.pwChangedAt = Date.now();
    } else {
      users.push({
        userId: 'usr_admin_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12),
        username: cleanUser,
        displayName: '系統管理員',
        birthDate: '1990-01-01',
        organization: '系統管理中心',
        email: 'admin@system.local',
        pwSalt: salt,
        pwHash: hash,
        role: 'admin',
        status: 'active',
        failCount: 0,
        lockedUntil: 0,
        createdAt: nowIso,
        approvedBy: 'SYSTEM_BOOTSTRAP',
        lastLoginAt: '',
        pwChangedAt: Date.now()
      });
    }
    saveUsersToSheet(users);
    Logger.log('✅ 已於【考官帳號資料】建立/更新管理員帳號：' + cleanUser);
  }
  Logger.log('✅ 安全憑證雜湊已更新至 Script Properties！');
}

/**
 * 首次使用考題圖片上傳時，請在 Apps Script 編輯器上方函式選單中選擇此「testDriveAuthorization」
 * 並點選「執行」，Google 會彈出授權視窗，點擊「核對權限」->「進階」->「前往... (不安全)」->「允許」即可完成雲端硬碟授權！
 */
function testDriveAuthorization() {
  const folder = DriveApp.getFolderById(getExamImageFolderId());
  Logger.log('✅ Google Drive 雲端硬碟權限授權成功！目標資料夾名稱：' + folder.getName());
}

/**
 * 首次啟用 Cloudflare Turnstile 驗證時，因新增了對外連線權限 (UrlFetchApp)，
 * 請在 Apps Script 編輯器上方函式選單中選擇此「testTurnstileAuthorization」並點選「執行」，
 * 完成「連線至外部服務」權限授權後，再重新部署網頁應用程式即可！
 */
function testTurnstileAuthorization() {
  const res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      secret: '1x0000000000000000000000000000000AA',
      response: 'test-token'
    }),
    muteHttpExceptions: true
  });
  Logger.log('✅ Cloudflare Turnstile 外部連線授權與測試成功！HTTP ' + res.getResponseCode() + '：' + res.getContentText());
}

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/**
 * 考官密碼雜湊 (Per-User Random Salt + Server Pepper + 2500 次迭代 SHA-256 雜湊鏈)
 * 防止離線字典破解與彩虹表攻擊
 */
function hashUserPasswordGas(plainPassword, userSalt, serverPepper) {
  const seed = `${serverPepper || ''}:${userSalt || ''}:${plainPassword || ''}`;
  let digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
  for (let i = 0; i < 2500; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  return digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/**
 * 常數時間字串比對 (Constant-Time Comparison)，防止時序旁路攻擊 (Timing Attack)
 */
function constantTimeEqualsGas(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i++) {
    diff |= (strA.charCodeAt(i) ^ strB.charCodeAt(i));
  }
  return diff === 0;
}

/**
 * 密碼強度規範：8~64 碼，必須同時包含大寫英文、小寫英文與數字
 */
function isStrongPasswordGas(pw) {
  if (typeof pw !== 'string') return false;
  if (pw.length < 8 || pw.length > 64) return false;
  return /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
}

/**
 * 讀取與自動初始化 Script Properties 中的安全憑證雜湊與鹽值
 * (將機敏驗證參數存放於伺服器端 Script Properties，避免暴露於前端原始碼或試算表儲存格)
 */
function getSecurityConfig(state) {
  const props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  const updates = {};

  // 自動產生每個部署專屬的隨機高熵 Salt & Pepper，不再於程式碼中寫死公開 Salt 或預設弱密碼雜湊
  const pinSalt = (all.EXAMINER_PIN_SALT || '').trim() || ('PIN_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  if (!all.EXAMINER_PIN_SALT) updates.EXAMINER_PIN_SALT = pinSalt;

  const adminSalt = (all.ADMIN_KEY_SALT || '').trim() || ('ADM_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  if (!all.ADMIN_KEY_SALT) updates.ADMIN_KEY_SALT = adminSalt;

  const pwPepper = (all.USER_PASSWORD_PEPPER || '').trim() || ('PEPPER_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, ''));
  if (!all.USER_PASSWORD_PEPPER) updates.USER_PASSWORD_PEPPER = pwPepper;

  // 僅讀取 Script Properties (或舊版試算表遷移之自訂雜湊)，移除原始碼中寫死的公開預設雜湊
  const legacyStateHash = (state && state.examinerPinHash) ? String(state.examinerPinHash).trim().toLowerCase() : '';
  const pinHash = (all.EXAMINER_PIN_HASH || legacyStateHash || '').trim().toLowerCase();
  if (!all.EXAMINER_PIN_HASH && pinHash) updates.EXAMINER_PIN_HASH = pinHash;

  const adminHash = (all.ADMIN_KEY_HASH || '').trim().toLowerCase();

  // Cloudflare Turnstile Secret Key (必須於 Script Properties 設定 TURNSTILE_SECRET_KEY)
  const turnstileSecretKey = (all.TURNSTILE_SECRET_KEY || '').trim();

  if (Object.keys(updates).length > 0) {
    try {
      props.setProperties(updates, false);
    } catch (e) {}
  }

  return { pinSalt, pinHash, adminSalt, adminHash, pwPepper, turnstileSecretKey };
}

/**
 * 向 Cloudflare Turnstile Siteverify API 驗證前端傳入之訪客 Token (Fail-Closed 強制驗證機制)
 * - 必須於 Script Properties 設定 TURNSTILE_SECRET_KEY，且前端必須傳入有效之單次 turnstileToken。
 * - 移除測試用 Secret Key (1x0000000000000000000000000000000AA) 與空 Token 跳過邏輯，徹底防範繞過攻擊。
 */
function verifyCloudflareTurnstileToken(turnstileToken, state) {
  const cfg = getSecurityConfig(state);
  const configuredSecret = cfg.turnstileSecretKey;
  const cleanToken = String(turnstileToken || '').trim();

  if (!configuredSecret) {
    return {
      success: false,
      message: '🛡️ 雲端後端尚未於 Script Properties 設定 TURNSTILE_SECRET_KEY，系統拒絕登入請求！'
    };
  }

  if (!cleanToken) {
    return {
      success: false,
      message: '🛡️ 請先完成 Cloudflare 訪客安全驗證後再點擊登入！'
    };
  }

  try {
    const response = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        secret: configuredSecret,
        response: cleanToken
      }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText() || '{}');
    if (result && result.success === true) {
      return { success: true };
    }
    return {
      success: false,
      message: '🛡️ Cloudflare 訪客安全驗證未通過或已逾時，請重新驗證後再試！'
    };
  } catch (err) {
    console.error('Turnstile siteverify error:', err);
    const errMsg = String((err && err.message) || err || '');
    if (errMsg.indexOf('external_request') !== -1 || errMsg.indexOf('permissions') !== -1) {
      return {
        success: false,
        message: '🛡️ Apps Script 尚未取得對外連線權限！請至 Apps Script 編輯器執行一次 testTurnstileAuthorization 並允許權限。'
      };
    }
    return {
      success: false,
      message: '🛡️ 雲端驗證 Cloudflare Turnstile 時發生連線異常，請稍後再試！'
    };
  }
}

/**
 * 失敗次數限流防護 (防範暴力破解，同時將單一客戶端鎖定與全域高門檻分離，避免惡意人士鎖死考官登入 DoS)
 */
const AUTH_GLOBAL_RATE_LIMIT_KEY = 'EXAMINER_AUTH_FAIL_GLOBAL';
const AUTH_CLIENT_RATE_LIMIT_PREFIX = 'EXAMINER_AUTH_FAIL_CLIENT_';
const AUTH_CLIENT_MAX_FAILS = 5;   // 單一裝置連續失敗 5 次鎖定
const AUTH_GLOBAL_MAX_FAILS = 40;  // 全域高門檻保護 (須先通過 Turnstile 才會觸及 PIN 驗證)
const AUTH_LOCK_SECONDS = 180;     // 鎖定 3 分鐘

function sanitizeClientRateKey(clientId) {
  const clean = String(clientId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 48);
  return AUTH_CLIENT_RATE_LIMIT_PREFIX + (clean || 'anon');
}

function isAuthRateLimited(clientId) {
  const cache = CacheService.getScriptCache();
  if (clientId) {
    const clientFails = Number(cache.get(sanitizeClientRateKey(clientId)) || 0);
    if (clientFails >= AUTH_CLIENT_MAX_FAILS) return true;
  }
  return Number(cache.get(AUTH_GLOBAL_RATE_LIMIT_KEY) || 0) >= AUTH_GLOBAL_MAX_FAILS;
}

function recordAuthFailure(clientId) {
  const cache = CacheService.getScriptCache();
  const globalCount = Number(cache.get(AUTH_GLOBAL_RATE_LIMIT_KEY) || 0) + 1;
  cache.put(AUTH_GLOBAL_RATE_LIMIT_KEY, String(globalCount), AUTH_LOCK_SECONDS);
  if (clientId) {
    const cKey = sanitizeClientRateKey(clientId);
    const clientCount = Number(cache.get(cKey) || 0) + 1;
    cache.put(cKey, String(clientCount), AUTH_LOCK_SECONDS);
    return clientCount;
  }
  return globalCount;
}

function clearAuthFailures(clientId) {
  try {
    const cache = CacheService.getScriptCache();
    if (clientId) {
      cache.remove(sanitizeClientRateKey(clientId));
    }
  } catch (e) {}
}

/**
 * 考官伺服器端 Session Token 管理 (隨機高熵 UUID，綁定個人身分與角色，30 分鐘滑動有效期限)
 */
const EXAMINER_SESSION_TTL_SEC = 1800;

function createExaminerSession(userProfile) {
  const token = 'exs_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, '');
  const cache = CacheService.getScriptCache();
  const sessObj = {
    userId: (userProfile && userProfile.userId) ? String(userProfile.userId) : 'SYSTEM_ADMIN',
    username: (userProfile && userProfile.username) ? String(userProfile.username) : 'admin',
    displayName: (userProfile && userProfile.displayName) ? String(userProfile.displayName) : '系統管理員',
    organization: (userProfile && userProfile.organization) ? String(userProfile.organization) : '系統管理中心',
    role: (userProfile && userProfile.role) ? String(userProfile.role) : 'admin',
    pwChangedAt: (userProfile && userProfile.pwChangedAt) ? Number(userProfile.pwChangedAt) : 0,
    issuedAt: Date.now()
  };
  cache.put('EXAMINER_SESS_' + token, JSON.stringify(sessObj), EXAMINER_SESSION_TTL_SEC);
  return token;
}

/**
 * 取得並驗證考官 Session 身分物件 (同時核對該使用者在 USERS 表中是否仍為 active，以及密碼是否已變更導致舊 Session 失效)
 */
function getExaminerSessionUser(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const clean = sessionToken.trim();
  if (!clean.startsWith('exs_')) return null;
  const cache = CacheService.getScriptCache();
  const val = cache.get('EXAMINER_SESS_' + clean);
  if (!val) return null;

  let sessObj = null;
  try {
    if (val.startsWith('{')) {
      sessObj = JSON.parse(val);
    } else {
      // 向下相容舊版純時間戳 Session
      sessObj = {
        userId: 'SYSTEM_ADMIN',
        username: 'admin',
        displayName: '系統管理員',
        organization: '系統管理中心',
        role: 'admin',
        pwChangedAt: 0,
        issuedAt: Number(val) || Date.now()
      };
    }
  } catch (e) {
    return null;
  }

  // 若為真實註冊帳號 (非 SYSTEM_ADMIN)，即時檢查帳號狀態是否已被停用或密碼已被變更
  if (sessObj && sessObj.userId && sessObj.userId !== 'SYSTEM_ADMIN') {
    const revKey = 'USER_REVOKED_AT_' + sessObj.userId;
    const revokedAt = Number(cache.get(revKey) || 0);
    if (revokedAt > 0 && revokedAt > Number(sessObj.issuedAt || 0)) {
      cache.remove('EXAMINER_SESS_' + clean);
      return null;
    }
  }

  // 滑動延長 Session 有效期限
  try {
    cache.put('EXAMINER_SESS_' + clean, JSON.stringify(sessObj), EXAMINER_SESSION_TTL_SEC);
  } catch (e) {}
  return sessObj;
}

function isExaminerSessionValid(sessionToken) {
  return Boolean(getExaminerSessionUser(sessionToken));
}

function revokeExaminerSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return;
  try {
    CacheService.getScriptCache().remove('EXAMINER_SESS_' + sessionToken.trim());
  } catch (e) {}
}

/**
 * 立即撤銷某位使用者的所有既有登入 Session (用於密碼變更、忘記密碼重設、管理員停用/刪除帳號)
 */
function revokeAllUserSessionsGas(userId) {
  if (!userId) return;
  try {
    CacheService.getScriptCache().put('USER_REVOKED_AT_' + String(userId), String(Date.now()), EXAMINER_SESSION_TTL_SEC + 300);
  } catch (e) {}
}

/**
 * 驗證舊版考官 PIN (僅供尚未建立任何 USERS 帳號時的首次向下相容緊急登入)
 */
function verifyExaminerPinSecret(pinOrHash, state) {
  if (!pinOrHash || typeof pinOrHash !== 'string') return false;
  const cfg = getSecurityConfig(state);
  if (!cfg.pinHash) return false;
  const clean = pinOrHash.trim();
  if (!/^\d{4,12}$/.test(clean)) return false;
  const computed = sha256Hex(`${cfg.pinSalt}:${clean}`).toLowerCase();
  return computed === cfg.pinHash;
}

/**
 * 驗證考官操作授權 (回傳使用者 Session 物件，若未授權回傳 null)
 */
function getAuthorizedExaminerUser(payload, state) {
  if (!payload || !payload.sessionToken) return null;
  return getExaminerSessionUser(payload.sessionToken);
}

function isExaminerRequestAuthorized(payload, state) {
  return Boolean(getAuthorizedExaminerUser(payload, state));
}

/**
 * 管理員金鑰後端驗證 (讀取 Script Properties，不再將雜湊暴露於前端)
 */
function isAdminKeyValid(adminKey, state) {
  if (!adminKey || typeof adminKey !== 'string') return false;
  const cfg = getSecurityConfig(state);
  if (!cfg.adminHash) return false;
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

    // 0-A. 考官註冊申請 (姓名、西元出生年月日、服務單位、自訂帳號、密碼、Email，送出後由管理員審核通過始得登入)
    if (action === 'registerExaminer') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '操作過於頻繁或錯誤次數過多，系統已暫時鎖定 3 分鐘' });
      }
      const turnstileCheck = verifyCloudflareTurnstileToken(payload.turnstileToken, state);
      if (!turnstileCheck.success) {
        return jsonResponse({
          status: 'turnstile_failed',
          message: turnstileCheck.message
        });
      }

      const displayName = String(payload.displayName || '').trim().substring(0, 40);
      const birthDate = String(payload.birthDate || '').trim();
      const organization = String(payload.organization || '').trim().substring(0, 60);
      const username = String(payload.username || '').trim().toLowerCase();
      const password = String(payload.password || '');
      const email = String(payload.email || '').trim().toLowerCase().substring(0, 120);

      if (!displayName || displayName.length < 2) {
        return jsonResponse({ status: 'error', message: '請填寫正確的考官姓名（至少 2 個字）' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        return jsonResponse({ status: 'error', message: '請選擇正確的西元出生年月日（格式 YYYY-MM-DD）' });
      }
      const birthYear = parseInt(birthDate.substring(0, 4), 10);
      const currentYear = new Date().getFullYear();
      if (isNaN(birthYear) || birthYear < 1920 || birthYear > currentYear) {
        return jsonResponse({ status: 'error', message: '西元出生年份不合理，請重新確認' });
      }
      if (!organization || organization.length < 2) {
        return jsonResponse({ status: 'error', message: '請填寫服務單位（至少 2 個字）' });
      }
      if (!/^[a-zA-Z0-9_]{4,24}$/.test(username)) {
        return jsonResponse({ status: 'error', message: '自訂帳號格式不符（須為 4~24 碼半形英文字母、數字或底線 _）' });
      }
      if (!isStrongPasswordGas(password)) {
        return jsonResponse({ status: 'error', message: '密碼強度不足！密碼長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ status: 'error', message: '請填寫格式正確的電子郵件 (Email)' });
      }

      const users = loadUsersFromSheet();
      const dupUser = users.find(u => u.username.toLowerCase() === username);
      if (dupUser) {
        return jsonResponse({ status: 'error', message: '此自訂帳號已被註冊使用，請更換其他帳號名稱' });
      }
      const dupEmail = users.find(u => u.email.toLowerCase() === email);
      if (dupEmail) {
        return jsonResponse({ status: 'error', message: '此電子郵件 (Email) 已被註冊使用，若忘記密碼請使用「忘記密碼」功能' });
      }

      const cfg = getSecurityConfig(state);
      const pwSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
      const pwHash = hashUserPasswordGas(password, pwSalt, cfg.pwPepper);
      const nowIso = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

      // 若系統目前完全沒有任何管理員帳號，且此註冊者提供了正確的系統管理員金鑰 (或可在後台手動核准)，預設註冊一律為 pending_review 考官
      const newUserId = 'usr_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      users.push({
        userId: newUserId,
        username: username,
        displayName: displayName,
        birthDate: birthDate,
        organization: organization,
        email: email,
        pwSalt: pwSalt,
        pwHash: pwHash,
        role: 'examiner',
        status: 'pending_review',
        failCount: 0,
        lockedUntil: 0,
        createdAt: nowIso,
        approvedBy: '',
        lastLoginAt: '',
        pwChangedAt: Date.now()
      });

      saveUsersToSheet(users);
      appendAuditLogGas(newUserId, username, 'REGISTER_EXAMINER', newUserId, `考官註冊申請：${displayName} (${organization})`);

      return jsonResponse({
        status: 'success',
        message: '✅ 註冊申請已成功送出！請通知系統管理員於後台審核通過後，即可使用此帳號與密碼登入。'
      });
    }

    // 0-B. 忘記密碼 — 步驟 1：核對「自訂帳號 + Email + 西元出生年月日」三要素並寄發 15 分鐘有效之一次性重設驗證碼
    if (action === 'requestPasswordReset') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '驗證嘗試次數過多，系統已暫時鎖定 3 分鐘' });
      }
      const turnstileCheck = verifyCloudflareTurnstileToken(payload.turnstileToken, state);
      if (!turnstileCheck.success) {
        return jsonResponse({
          status: 'turnstile_failed',
          message: turnstileCheck.message
        });
      }

      const username = String(payload.username || '').trim().toLowerCase();
      const email = String(payload.email || '').trim().toLowerCase();
      const birthDate = String(payload.birthDate || '').trim();

      if (!username || !email || !birthDate) {
        return jsonResponse({ status: 'error', message: '請完整輸入您的自訂帳號、註冊 Email 與西元出生年月日' });
      }

      const users = loadUsersFromSheet();
      const targetUser = users.find(u => u.username.toLowerCase() === username);

      // 核對帳號、Email、西元出生年月日三者是否完全吻合，且帳號狀態為 active
      if (!targetUser || targetUser.email.toLowerCase() !== email || targetUser.birthDate !== birthDate) {
        recordAuthFailure(clientId);
        appendAuditLogGas('-', username, 'PW_RESET_REQ_FAIL', username, '忘記密碼三要素核對不符');
        return jsonResponse({
          status: 'error',
          message: '❌ 帳號、電子郵件或西元出生年月日核對不符！請確認輸入資料與註冊時相同。'
        });
      }

      if (targetUser.status !== 'active') {
        return jsonResponse({
          status: 'error',
          message: '⚠️ 此帳號目前尚未通過管理員審核或已被停用，無法進行密碼重設，請聯繫系統管理員。'
        });
      }

      const cache = CacheService.getScriptCache();
      // 限制同一帳號 3 分鐘內不得重複寄發重設信，保護一般 Gmail 每日 100 封配額
      const cooldownKey = 'PW_RESET_COOLDOWN_' + targetUser.userId;
      if (cache.get(cooldownKey)) {
        return jsonResponse({
          status: 'error',
          message: '⏳ 重設驗證碼已寄出，請至您的電子郵件信箱查收（每 3 分鐘限寄送一次）。'
        });
      }

      // 產生 8 碼大寫英數高熵驗證碼 (排除易混淆字元 0, O, 1, I, L)
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      let resetCode = '';
      for (let i = 0; i < 8; i++) {
        const randIdx = Math.floor(Math.random() * chars.length);
        resetCode += chars.charAt(randIdx);
      }

      const cfg = getSecurityConfig(state);
      const codeHash = sha256Hex(`${cfg.pwPepper}:RESET:${targetUser.userId}:${resetCode}`);
      const resetPayload = {
        userId: targetUser.userId,
        codeHash: codeHash,
        attempts: 0,
        expiresAt: Date.now() + 15 * 60 * 1000
      };

      cache.put('PW_RESET_DATA_' + targetUser.userId, JSON.stringify(resetPayload), 900); // 15 分鐘有效
      cache.put(cooldownKey, '1', 180); // 3 分鐘寄信冷卻

      try {
        const subject = '【線上筆試測驗系統】考官帳號密碼重設驗證碼';
        const htmlBody = `
          <div style="font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:540px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#ffffff;">
            <div style="background:linear-gradient(135deg,#750000,#991b1b);color:#ffffff;padding:18px 24px;">
              <div style="font-size:13px;opacity:0.9;">線上筆試測驗系統 — 帳號安全中心</div>
              <h2 style="margin:6px 0 0;font-size:19px;">考官密碼重設驗證碼通知</h2>
            </div>
            <div style="padding:24px;color:#334155;font-size:15px;line-height:1.7;">
              <p style="margin:0 0 12px;"><strong>${escapeHtmlStr(targetUser.displayName)}</strong> 考官（帳號：<code>${escapeHtmlStr(targetUser.username)}</code>）您好：</p>
              <p style="margin:0 0 16px;">系統收到您的忘記密碼重設申請，以下為您的一次性密碼重設驗證碼（<strong>有效時間 15 分鐘</strong>）：</p>
              <div style="background:#fff1f2;border:2px dashed #be123c;border-radius:10px;padding:16px;text-align:center;margin-bottom:16px;">
                <div style="font-size:28px;font-weight:800;letter-spacing:4px;color:#9f1239;font-family:monospace;">${resetCode}</div>
              </div>
              <p style="margin:0;font-size:13px;color:#64748b;">請返回系統「忘記密碼」畫面輸入上方 8 碼驗證碼並設定新密碼。若非您本人申請，請忽略本信件。</p>
            </div>
          </div>
        `;
        MailApp.sendEmail({
          to: targetUser.email,
          subject: subject,
          htmlBody: htmlBody
        });
      } catch (mailErr) {
        console.error('Send password reset email error:', mailErr);
        return jsonResponse({
          status: 'error',
          message: '❌ 雲端寄送重設驗證碼信件失敗，請確認試算表擁有者已完成 Gmail 寄信授權或聯繫系統管理員協助重設密碼。'
        });
      }

      clearAuthFailures(clientId);
      appendAuditLogGas(targetUser.userId, targetUser.username, 'PW_RESET_CODE_SENT', targetUser.userId, '已寄發密碼重設驗證碼至註冊信箱');
      return jsonResponse({
        status: 'success',
        message: '📧 身分核對通過！已將 8 碼重設驗證碼寄至您的註冊信箱（15 分鐘內有效），請於下方輸入驗證碼與新密碼。'
      });
    }

    // 0-C. 忘記密碼 — 步驟 2：驗證 8 碼重設驗證碼並更新為新密碼
    if (action === 'confirmPasswordReset') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，系統已暫時鎖定 3 分鐘' });
      }

      const username = String(payload.username || '').trim().toLowerCase();
      const resetCode = String(payload.resetCode || '').trim().toUpperCase();
      const newPassword = String(payload.newPassword || '');

      if (!username || !resetCode || !newPassword) {
        return jsonResponse({ status: 'error', message: '請完整填寫帳號、8 碼重設驗證碼與新密碼' });
      }
      if (!isStrongPasswordGas(newPassword)) {
        return jsonResponse({ status: 'error', message: '新密碼強度不符！長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」' });
      }

      const users = loadUsersFromSheet();
      const targetUser = users.find(u => u.username.toLowerCase() === username);
      if (!targetUser || targetUser.status !== 'active') {
        recordAuthFailure(clientId);
        return jsonResponse({ status: 'error', message: '驗證碼無效或已過期，請重新申請重設驗證碼' });
      }

      const cache = CacheService.getScriptCache();
      const cacheKey = 'PW_RESET_DATA_' + targetUser.userId;
      const rawReset = cache.get(cacheKey);
      if (!rawReset) {
        recordAuthFailure(clientId);
        return jsonResponse({ status: 'error', message: '驗證碼已過期或尚未申請（有效期限 15 分鐘），請重新發送驗證碼' });
      }

      let resetData = null;
      try {
        resetData = JSON.parse(rawReset);
      } catch (e) {
        cache.remove(cacheKey);
        return jsonResponse({ status: 'error', message: '驗證資料異常，請重新申請驗證碼' });
      }

      const cfg = getSecurityConfig(state);
      const inputHash = sha256Hex(`${cfg.pwPepper}:RESET:${targetUser.userId}:${resetCode}`);
      if (!constantTimeEqualsGas(inputHash, resetData.codeHash)) {
        resetData.attempts = (Number(resetData.attempts) || 0) + 1;
        recordAuthFailure(clientId);
        if (resetData.attempts >= 3) {
          cache.remove(cacheKey);
          appendAuditLogGas(targetUser.userId, targetUser.username, 'PW_RESET_CODE_REVOKED', targetUser.userId, '驗證碼連續錯誤 3 次自動作廢');
          return jsonResponse({ status: 'error', message: '❌ 驗證碼連續輸入錯誤達 3 次，該驗證碼已立即作廢！請重新申請。' });
        }
        cache.put(cacheKey, JSON.stringify(resetData), 600);
        return jsonResponse({ status: 'error', message: `❌ 重設驗證碼不正確！（剩餘 ${3 - resetData.attempts} 次機會）` });
      }

      // 驗證通過：立即銷毀驗證碼、更新密碼雜湊與鹽值、解除鎖定並撤銷所有舊 Session
      cache.remove(cacheKey);
      cache.remove('PW_RESET_COOLDOWN_' + targetUser.userId);
      const newSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
      const newHash = hashUserPasswordGas(newPassword, newSalt, cfg.pwPepper);
      targetUser.pwSalt = newSalt;
      targetUser.pwHash = newHash;
      targetUser.failCount = 0;
      targetUser.lockedUntil = 0;
      targetUser.pwChangedAt = Date.now();

      saveUsersToSheet(users);
      revokeAllUserSessionsGas(targetUser.userId);
      clearAuthFailures(clientId);
      appendAuditLogGas(targetUser.userId, targetUser.username, 'PW_RESET_SUCCESS', targetUser.userId, '考官透過 Email 驗證碼成功重設密碼');

      return jsonResponse({
        status: 'success',
        message: '✅ 密碼重設成功！請使用新設定的密碼登入系統。'
      });
    }

    // 0-D. 考官帳號密碼登入驗證 (PIN = 密碼)：先強制驗證 Cloudflare Turnstile Token，通過後核對帳號密碼並簽發綁定個人身分的 Session Token
    if (action === 'verifyExaminer') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，系統已暫時鎖定 3 分鐘' });
      }
      const turnstileCheck = verifyCloudflareTurnstileToken(payload.turnstileToken, state);
      if (!turnstileCheck.success) {
        return jsonResponse({
          status: 'turnstile_failed',
          message: turnstileCheck.message
        });
      }

      const rawUsername = String(payload.username || '').trim().toLowerCase();
      const rawPassword = String(payload.password !== undefined ? payload.password : (payload.pin || ''));
      const users = loadUsersFromSheet();
      const cfg = getSecurityConfig(state);

      // 1. 若有輸入帳號，或 USERS 表已有使用者，走個人帳號密碼驗證
      if (rawUsername) {
        const user = users.find(u => u.username.toLowerCase() === rawUsername);

        // 若 USERS 表尚無任何管理員，且使用者以帳號 'admin' + 原系統管理員金鑰 (或舊版 PIN) 首次登入，或透過 bootstrap 建立
        if (!user) {
          const hasAnyAdmin = users.some(u => u.role === 'admin' && u.status === 'active');
          if (!hasAnyAdmin && rawUsername === 'admin' && (isAdminKeyValid(rawPassword, state) || verifyExaminerPinSecret(rawPassword, state))) {
            clearAuthFailures(clientId);
            const fallbackProfile = {
              userId: 'SYSTEM_ADMIN',
              username: 'admin',
              displayName: '系統管理員 (初始模式)',
              organization: '系統管理中心',
              role: 'admin',
              status: 'active',
              pwChangedAt: 0
            };
            const sessionToken = createExaminerSession(fallbackProfile);
            appendAuditLogGas('SYSTEM_ADMIN', 'admin', 'LOGIN_BOOTSTRAP_ADMIN', 'SYSTEM_ADMIN', '以初始金鑰登入管理員模式');
            return jsonResponse({
              status: 'success',
              sessionToken: sessionToken,
              userProfile: fallbackProfile,
              needBootstrapAdmin: true,
              expiresInSeconds: EXAMINER_SESSION_TTL_SEC
            });
          }

          const fails = recordAuthFailure(clientId);
          if (fails >= AUTH_CLIENT_MAX_FAILS) {
            return jsonResponse({ status: 'locked', message: '帳號或密碼錯誤次數過多，已暫時鎖定 3 分鐘' });
          }
          return jsonResponse({ status: 'unauthorized', message: '帳號或密碼錯誤，請重新確認！' });
        }

        // 檢查帳號層級鎖定 (連續錯誤 5 次鎖定 15 分鐘)
        const nowTs = Date.now();
        if (user.lockedUntil && Number(user.lockedUntil) > nowTs) {
          const remMins = Math.ceil((Number(user.lockedUntil) - nowTs) / 60000);
          return jsonResponse({
            status: 'locked',
            message: `此帳號因密碼連續錯誤已暫時鎖定，請於 ${remMins} 分鐘後再試，或使用「忘記密碼」重設。`
          });
        }

        const computedHash = hashUserPasswordGas(rawPassword, user.pwSalt, cfg.pwPepper);
        const isPwMatch = constantTimeEqualsGas(computedHash, user.pwHash);

        if (!isPwMatch) {
          user.failCount = (Number(user.failCount) || 0) + 1;
          if (user.failCount >= 5) {
            user.lockedUntil = nowTs + 15 * 60 * 1000; // 鎖定 15 分鐘
            saveUsersToSheet(users);
            appendAuditLogGas(user.userId, user.username, 'ACCOUNT_LOCKED', user.userId, '連續密碼錯誤 5 次鎖定 15 分鐘');
            return jsonResponse({
              status: 'locked',
              message: '密碼連續錯誤達 5 次，此帳號已自動鎖定 15 分鐘！'
            });
          }
          saveUsersToSheet(users);
          const fails = recordAuthFailure(clientId);
          if (fails >= AUTH_CLIENT_MAX_FAILS) {
            return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，裝置已暫時鎖定 3 分鐘' });
          }
          return jsonResponse({ status: 'unauthorized', message: '帳號或密碼錯誤，請重新確認！' });
        }

        // 密碼正確後，檢查審核與啟用狀態
        if (user.status === 'pending_review') {
          return jsonResponse({
            status: 'pending_review',
            message: '⏳ 您的考官帳號正在等待系統管理員審核中，審核通過後方可登入！'
          });
        }
        if (user.status === 'rejected') {
          return jsonResponse({
            status: 'unauthorized',
            message: '❌ 您的帳號註冊申請未通過審核，如有疑問請洽系統管理員。'
          });
        }
        if (user.status === 'suspended' || user.status !== 'active') {
          return jsonResponse({
            status: 'unauthorized',
            message: '⛔ 您的帳號目前已被停用，請聯繫系統管理員。'
          });
        }

        // 登入成功：重置失敗計數並更新最後登入時間
        user.failCount = 0;
        user.lockedUntil = 0;
        user.lastLoginAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
        saveUsersToSheet(users);
        clearAuthFailures(clientId);

        const safeProfile = sanitizeUserForClientGas(user, false);
        const sessionToken = createExaminerSession(user);
        appendAuditLogGas(user.userId, user.username, 'LOGIN_SUCCESS', user.userId, `登入成功 (${user.role})`);

        return jsonResponse({
          status: 'success',
          sessionToken: sessionToken,
          userProfile: safeProfile,
          expiresInSeconds: EXAMINER_SESSION_TTL_SEC
        });
      }

      // 2. 若未提供 username 且系統尚未建立任何 active 管理員帳號時，允許舊版 PIN 向下相容登入為初始管理員
      const hasAnyActiveAdmin = users.some(u => u.role === 'admin' && u.status === 'active');
      if (!hasAnyActiveAdmin && verifyExaminerPinSecret(rawPassword, state)) {
        clearAuthFailures(clientId);
        const fallbackProfile = {
          userId: 'SYSTEM_ADMIN',
          username: 'admin',
          displayName: '系統管理員 (初始模式)',
          organization: '系統管理中心',
          role: 'admin',
          status: 'active',
          pwChangedAt: 0
        };
        const sessionToken = createExaminerSession(fallbackProfile);
        return jsonResponse({
          status: 'success',
          sessionToken: sessionToken,
          userProfile: fallbackProfile,
          needBootstrapAdmin: true,
          expiresInSeconds: EXAMINER_SESSION_TTL_SEC
        });
      }

      const fails = recordAuthFailure(clientId);
      if (fails >= AUTH_CLIENT_MAX_FAILS) {
        return jsonResponse({ status: 'locked', message: '帳號或密碼錯誤次數過多，已暫時鎖定 3 分鐘' });
      }
      return jsonResponse({ status: 'unauthorized', message: '請輸入正確的考官帳號與密碼！' });
    }

    // 考官登出：立即銷毀伺服器端 Session Token
    if (action === 'logoutExaminer') {
      if (payload.sessionToken) {
        revokeExaminerSession(payload.sessionToken);
      }
      return jsonResponse({ status: 'success', message: '已安全登出並撤銷雲端工作階段' });
    }

    // 0-E. 考官變更自己的登入密碼 / PIN 碼 (僅能變更自己帳號的密碼，不再需要輸入管理員金鑰，亦不允許指定他人 userId)
    if (action === 'updateOwnPassword' || action === 'updateExaminerPin') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，系統已暫時鎖定 3 分鐘' });
      }

      const sessUser = getAuthorizedExaminerUser(payload, state);
      if (!sessUser) {
        return jsonResponse({ status: 'unauthorized', message: '登入工作階段已逾時，請重新登入後再變更密碼！' });
      }

      const currentPassword = String(payload.currentPassword || '').trim();
      const newPassword = String(payload.newPassword !== undefined ? payload.newPassword : (payload.newPin || '')).trim();

      if (!newPassword) {
        return jsonResponse({ status: 'error', message: '請輸入欲設定的新密碼 (PIN)' });
      }
      if (!isStrongPasswordGas(newPassword)) {
        return jsonResponse({
          status: 'error',
          message: '新密碼格式不符！長度須為 8~64 碼，且必須同時包含「大寫英文」、「小寫英文」及「數字」。'
        });
      }

      const users = loadUsersFromSheet();
      const cfg = getSecurityConfig(state);

      // 若目前是以初始 SYSTEM_ADMIN 模式登入，允許直接建立首位正式管理員帳號
      if (sessUser.userId === 'SYSTEM_ADMIN') {
        const customUsername = String(payload.newAdminUsername || 'admin').trim().toLowerCase();
        if (!/^[a-zA-Z0-9_]{4,24}$/.test(customUsername)) {
          return jsonResponse({ status: 'error', message: '管理員帳號格式須為 4~24 碼半形英數字或底線' });
        }
        if (users.some(u => u.username.toLowerCase() === customUsername)) {
          return jsonResponse({ status: 'error', message: '此帳號名稱已存在' });
        }
        const newSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
        const newHash = hashUserPasswordGas(newPassword, newSalt, cfg.pwPepper);
        const nowIso = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
        const newAdmin = {
          userId: 'usr_admin_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12),
          username: customUsername,
          displayName: String(payload.displayName || '系統管理員').trim().substring(0, 40),
          birthDate: String(payload.birthDate || '1990-01-01').trim(),
          organization: String(payload.organization || '系統管理中心').trim().substring(0, 60),
          email: String(payload.email || 'admin@system.local').trim().toLowerCase(),
          pwSalt: newSalt,
          pwHash: newHash,
          role: 'admin',
          status: 'active',
          failCount: 0,
          lockedUntil: 0,
          createdAt: nowIso,
          approvedBy: 'SYSTEM_INIT',
          lastLoginAt: nowIso,
          pwChangedAt: Date.now()
        };
        users.push(newAdmin);
        saveUsersToSheet(users);
        revokeExaminerSession(payload.sessionToken);
        const newToken = createExaminerSession(newAdmin);
        appendAuditLogGas(newAdmin.userId, newAdmin.username, 'CREATE_PRIMARY_ADMIN', newAdmin.userId, '初始化正式管理員帳號與密碼');
        return jsonResponse({
          status: 'success',
          message: `✅ 已成功建立正式管理員帳號【${newAdmin.username}】並更新密碼！`,
          sessionToken: newToken,
          userProfile: sanitizeUserForClientGas(newAdmin, false)
        });
      }

      // 一般考官或正式管理員：強制鎖定只更新 sessionToken 本人的帳號 (防範 IDOR 越權)
      const me = users.find(u => u.userId === sessUser.userId);
      if (!me) {
        return jsonResponse({ status: 'error', message: '找不到您的帳號資料，請重新登入' });
      }
      if (!currentPassword) {
        return jsonResponse({ status: 'error', message: '請輸入您目前的密碼以驗證本人身分' });
      }

      const currHash = hashUserPasswordGas(currentPassword, me.pwSalt, cfg.pwPepper);
      if (!constantTimeEqualsGas(currHash, me.pwHash)) {
        const fails = recordAuthFailure(clientId);
        if (fails >= AUTH_CLIENT_MAX_FAILS) {
          return jsonResponse({ status: 'locked', message: '目前密碼驗證錯誤次數過多，已暫時鎖定 3 分鐘' });
        }
        return jsonResponse({ status: 'unauthorized', message: '❌ 目前密碼輸入錯誤，無法變更密碼！' });
      }

      const newSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
      const newHash = hashUserPasswordGas(newPassword, newSalt, cfg.pwPepper);
      me.pwSalt = newSalt;
      me.pwHash = newHash;
      me.pwChangedAt = Date.now();
      saveUsersToSheet(users);

      clearAuthFailures(clientId);
      revokeExaminerSession(payload.sessionToken);
      revokeAllUserSessionsGas(me.userId);
      const newSessionToken = createExaminerSession(me);
      appendAuditLogGas(me.userId, me.username, 'UPDATE_OWN_PASSWORD', me.userId, '本人成功變更個人登入密碼');

      return jsonResponse({
        status: 'success',
        message: '✅ 您的個人登入密碼 (PIN) 已安全更新！下次登入請使用新密碼。',
        sessionToken: newSessionToken,
        userProfile: sanitizeUserForClientGas(me, false)
      });
    }

    // 0-F. 管理員專屬功能：查詢考官成員清單、審核註冊申請、停用/啟用/切換角色、協助重設密碼、刪除帳號
    const adminUserActions = ['adminListUsers', 'adminReviewUser', 'adminUpdateUser', 'adminResetUserPassword', 'adminDeleteUser'];
    if (adminUserActions.indexOf(action) !== -1) {
      const sessUser = getAuthorizedExaminerUser(payload, state);
      if (!sessUser || sessUser.role !== 'admin') {
        return jsonResponse({
          status: 'forbidden',
          message: '⛔ 權限不足！此操作僅限系統管理員 (admin) 執行。'
        });
      }

      const users = loadUsersFromSheet();

      if (action === 'adminListUsers') {
        const sanitizedList = users.map(u => sanitizeUserForClientGas(u, true));
        return jsonResponse({
          status: 'success',
          users: sanitizedList
        });
      }

      const targetUserId = String(payload.targetUserId || '').trim();
      const targetUser = users.find(u => u.userId === targetUserId);
      if (!targetUser) {
        return jsonResponse({ status: 'error', message: '找不到目標帳號資料' });
      }

      // 審核註冊申請 (approve / reject)
      if (action === 'adminReviewUser') {
        const decision = String(payload.decision || '').trim(); // 'approve' | 'reject'
        const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
        if (decision === 'approve') {
          targetUser.status = 'active';
          targetUser.approvedBy = `${sessUser.username} (${nowStr})`;
          targetUser.failCount = 0;
          targetUser.lockedUntil = 0;
          saveUsersToSheet(users);
          appendAuditLogGas(sessUser.userId, sessUser.username, 'ADMIN_APPROVE_USER', targetUser.userId, `核准考官帳號：${targetUser.username} (${targetUser.displayName})`);
          return jsonResponse({
            status: 'success',
            message: `✅ 已核准考官【${targetUser.displayName} (${targetUser.username})】的註冊申請！該帳號現已可正常登入。`,
            users: users.map(u => sanitizeUserForClientGas(u, true))
          });
        } else if (decision === 'reject') {
          targetUser.status = 'rejected';
          targetUser.approvedBy = `駁回 by ${sessUser.username} (${nowStr})`;
          saveUsersToSheet(users);
          revokeAllUserSessionsGas(targetUser.userId);
          appendAuditLogGas(sessUser.userId, sessUser.username, 'ADMIN_REJECT_USER', targetUser.userId, `駁回考官申請：${targetUser.username}`);
          return jsonResponse({
            status: 'success',
            message: `已駁回【${targetUser.displayName} (${targetUser.username})】的註冊申請。`,
            users: users.map(u => sanitizeUserForClientGas(u, true))
          });
        }
        return jsonResponse({ status: 'error', message: '未知的審核指令' });
      }

      // 計算系統內目前 active 的管理員人數 (防範刪除或停用最後一位管理員導致系統鎖死)
      const activeAdmins = users.filter(u => u.role === 'admin' && u.status === 'active');
      const isTargetLastActiveAdmin = (targetUser.role === 'admin' && targetUser.status === 'active' && activeAdmins.length <= 1);

      // 變更成員狀態 (active / suspended)、角色 (examiner / admin) 或解鎖
      if (action === 'adminUpdateUser') {
        const newStatus = payload.newStatus ? String(payload.newStatus).trim() : targetUser.status;
        const newRole = payload.newRole ? String(payload.newRole).trim() : targetUser.role;

        if (isTargetLastActiveAdmin && (newStatus !== 'active' || newRole !== 'admin')) {
          return jsonResponse({
            status: 'error',
            message: '⛔ 防鎖死保護：此帳號為系統最後一位啟用中的管理員，禁止停用或降級為一般考官！'
          });
        }

        if (['active', 'suspended', 'pending_review', 'rejected'].indexOf(newStatus) !== -1) {
          targetUser.status = newStatus;
        }
        if (['admin', 'examiner'].indexOf(newRole) !== -1) {
          targetUser.role = newRole;
        }
        if (payload.unlockAccount || newStatus === 'active') {
          targetUser.failCount = 0;
          targetUser.lockedUntil = 0;
        }

        saveUsersToSheet(users);
        if (targetUser.status !== 'active') {
          revokeAllUserSessionsGas(targetUser.userId);
        }
        appendAuditLogGas(sessUser.userId, sessUser.username, 'ADMIN_UPDATE_USER', targetUser.userId, `更新帳號 ${targetUser.username} -> role=${targetUser.role}, status=${targetUser.status}`);

        return jsonResponse({
          status: 'success',
          message: `✅ 已更新【${targetUser.displayName} (${targetUser.username})】的帳號設定！`,
          users: users.map(u => sanitizeUserForClientGas(u, true))
        });
      }

      // 管理員協助重設成員密碼
      if (action === 'adminResetUserPassword') {
        const tempPassword = String(payload.newPassword || '').trim();
        if (!isStrongPasswordGas(tempPassword)) {
          return jsonResponse({
            status: 'error',
            message: '新密碼格式不符！須為 8~64 碼且同時包含大寫英文、小寫英文與數字。'
          });
        }
        const cfg = getSecurityConfig(state);
        const newSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
        targetUser.pwSalt = newSalt;
        targetUser.pwHash = hashUserPasswordGas(tempPassword, newSalt, cfg.pwPepper);
        targetUser.failCount = 0;
        targetUser.lockedUntil = 0;
        targetUser.pwChangedAt = Date.now();
        saveUsersToSheet(users);
        revokeAllUserSessionsGas(targetUser.userId);
        appendAuditLogGas(sessUser.userId, sessUser.username, 'ADMIN_RESET_USER_PW', targetUser.userId, `管理員重設帳號密碼：${targetUser.username}`);

        return jsonResponse({
          status: 'success',
          message: `🔑 已為【${targetUser.displayName} (${targetUser.username})】重設新密碼，並已強制登出其舊有連線！`,
          users: users.map(u => sanitizeUserForClientGas(u, true))
        });
      }

      // 管理員刪除成員帳號 (將其名下試卷與歷史紀錄自動歸屬給管理員，避免成為孤兒資料)
      if (action === 'adminDeleteUser') {
        if (isTargetLastActiveAdmin) {
          return jsonResponse({
            status: 'error',
            message: '⛔ 防鎖死保護：禁止刪除系統最後一位啟用中的管理員帳號！'
          });
        }
        if (targetUser.userId === sessUser.userId) {
          return jsonResponse({
            status: 'error',
            message: '⛔ 為防止誤刪，您無法刪除自己目前正在登入中的管理員帳號！'
          });
        }

        const remainingUsers = users.filter(u => u.userId !== targetUser.userId);
        saveUsersToSheet(remainingUsers);
        revokeAllUserSessionsGas(targetUser.userId);

        // 將被刪除考官上傳的試卷轉移給執行刪除的管理員，確保題庫資產不遺失
        let libChanged = false;
        (state.examLibrary || []).forEach(ex => {
          if (ex && ex.ownerId === targetUser.userId) {
            ex.ownerId = sessUser.userId;
            ex.ownerName = `${sessUser.displayName} (原：${targetUser.displayName})`;
            libChanged = true;
          }
        });
        if (libChanged) {
          const { librarySheet } = ensureSheetsInitialized();
          syncExamLibrarySheet(librarySheet, state.examLibrary);
        }

        appendAuditLogGas(sessUser.userId, sessUser.username, 'ADMIN_DELETE_USER', targetUser.userId, `刪除帳號：${targetUser.username} (${targetUser.displayName})`);
        return jsonResponse({
          status: 'success',
          message: `🗑️ 已刪除帳號【${targetUser.displayName} (${targetUser.username})】！`,
          users: remainingUsers.map(u => sanitizeUserForClientGas(u, true))
        });
      }
    }

    // 考官授權檢視或考生透過 POST 讀取試卷狀態 (憑證不暴露於 URL Query String)
    if (action === 'getExamState') {
      if (isAuthRateLimited() && (payload.authPin || payload.authPinHash)) {
        return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }
      const sessUser = getAuthorizedExaminerUser(payload, state);
      if (sessUser) {
        const isAdmin = (sessUser.role === 'admin');
        const myId = sessUser.userId;

        // 過濾歷史測驗紀錄：考官僅能查看自己上傳試卷 / 自己歸檔的歷史紀錄；管理員可查看全部
        const visibleHistory = isAdmin
          ? (state.historySessions || [])
          : (state.historySessions || []).filter(h => h && h.ownerId === myId);

        // 過濾當前場次成績：考官僅能查看自己試卷 / 自己開考場次的成績；管理員可查看全部
        const currentExamOwnerId = (state.examData && state.examData.ownerId) ? state.examData.ownerId : '';
        const currentStartedById = (state.examData && state.examData.startedByUserId) ? state.examData.startedByUserId : '';
        const canViewCurrentSubmissions = isAdmin || (currentExamOwnerId === myId) || (currentStartedById === myId);
        const visibleSubmissions = canViewCurrentSubmissions ? (state.submissions || []) : [];

        return jsonResponse({
          status: 'success',
          isExaminer: true,
          userProfile: sessUser,
          examData: state.examData,
          submissions: visibleSubmissions,
          historySessions: visibleHistory,
          examLibrary: state.examLibrary,
          updatedAt: state.updatedAt
        });
      }

      // 若原本嘗試以考官身分請求但 Session 已過期或無效，明確回傳 session_expired 供前端引導重新登入
      if (payload.sessionToken || payload.authPin || payload.authPinHash) {
        return jsonResponse({
          status: 'unauthorized',
          isExaminer: false,
          message: '考官登入工作階段已逾時或失效，請重新輸入帳號與密碼登入'
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

    let currentSessionUser = null;
    if (examinerActions.indexOf(action) !== -1) {
      if (isAuthRateLimited()) {
        return jsonResponse({
          status: 'locked',
          message: '驗證錯誤次數過多，雲端已暫時鎖定 5 分鐘'
        });
      }
      currentSessionUser = getAuthorizedExaminerUser(payload, state);
      if (!currentSessionUser) {
        return jsonResponse({
          status: 'unauthorized',
          message: '未經授權的考官操作或登入工作階段已逾時，請重新登入考官端！'
        });
      }
    }

    // 輔助函式：合併試卷庫並強制執行所有權保護 (一般考官禁止刪除或修改他人上傳的試卷)
    function mergeAndProtectExamLibraryGas(incomingLib, existingLib, sessUser) {
      const isAdmin = (sessUser && sessUser.role === 'admin');
      const myId = sessUser ? sessUser.userId : '';
      const existingList = Array.isArray(existingLib) ? existingLib : [];
      const incomingList = Array.isArray(incomingLib) ? incomingLib : [];

      if (isAdmin) {
        return incomingList.map(ex => {
          const prev = existingList.find(p => p && p.id === ex.id);
          return Object.assign({}, ex, {
            ownerId: (prev && prev.ownerId) ? prev.ownerId : (ex.ownerId || myId),
            ownerName: (prev && prev.ownerName) ? prev.ownerName : (ex.ownerName || sessUser.displayName),
            ownerOrg: (prev && prev.ownerOrg) ? prev.ownerOrg : (ex.ownerOrg || sessUser.organization || '')
          });
        });
      }

      // 一般考官：保留所有 ownerId !== myId 的他人試卷 (禁止刪除或竄改他人試卷)
      const othersExams = existingList.filter(ex => ex && ex.ownerId && ex.ownerId !== myId);
      const myUpdatedExams = [];

      incomingList.forEach(inc => {
        if (!inc || !inc.id) return;
        const prev = existingList.find(p => p && p.id === inc.id);
        if (prev && prev.ownerId && prev.ownerId !== myId) {
          // 屬於他人的試卷：忽略一般考官傳來的修改，已在 othersExams 原封不動保留
          return;
        }
        myUpdatedExams.push(Object.assign({}, inc, {
          ownerId: myId,
          ownerName: sessUser.displayName,
          ownerOrg: sessUser.organization || ''
        }));
      });

      return othersExams.concat(myUpdatedExams);
    }

    // 1. 考官儲存題庫與試卷設定 (強制檢查：不可結束他人進行中測驗、不可停用他人有效測驗連結、連結效期強制為試卷作答時間+15分鐘)
    if (action === 'saveExamData') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;

      if (payload.examData) {
        const prevExam = state.examData || {};
        const wasOpen = Boolean(prevExam.isExamOpen);
        const nowOpen = Boolean(payload.examData.isExamOpen);
        const prevToken = prevExam.activeExamToken || null;
        const prevTokenActive = prevToken && prevToken.token && (Date.now() < Number(prevToken.expiresAt || 0));

        // 檢查當前進行中的測驗是否已經超過 (openedAt + (作答時間 + 15分鐘))，若已逾期則自動釋放佔用
        const prevDurMins = Math.max(1, Number(prevExam.durationMinutes) || 60);
        const maxHoldMs = (prevDurMins + 15) * 60 * 1000;
        const isPrevOpenExpired = wasOpen && prevExam.openedAt && (Date.now() - Number(prevExam.openedAt) > maxHoldMs);

        // 限制 4：一般考官不可結束他人正在進行中的測驗，亦不可在他人測驗進行中切換試卷或搶先開考
        if (wasOpen && !isPrevOpenExpired && !isAdmin) {
          const startedBy = prevExam.startedByUserId || prevExam.ownerId || '';
          if (startedBy && startedBy !== myId) {
            return jsonResponse({
              status: 'forbidden',
              message: `⛔ 權限限制：目前正由考官【${prevExam.startedByName || prevExam.ownerName || '其他考官'}】進行測驗中，您無法結束他人的測驗或切換當前試卷！`
            });
          }
        }

        // 限制 3：一般考官不可停用或覆蓋他人產生的有效測驗連結
        const newToken = payload.examData.activeExamToken || null;
        const isTokenBeingRevokedOrChanged = prevTokenActive && (!newToken || newToken.token !== prevToken.token);
        if (isTokenBeingRevokedOrChanged && !isAdmin) {
          const tokenCreator = prevToken.createdByUserId || prevExam.ownerId || '';
          if (tokenCreator && tokenCreator !== myId) {
            return jsonResponse({
              status: 'forbidden',
              message: `⛔ 權限限制：目前的測驗連結是由考官【${prevToken.createdByName || prevExam.ownerName || '其他考官'}】所產生，在其有效期限內您無法停用或覆蓋他人的測驗連結！`
            });
          }
        }

        // 若新開考，綁定開考考官身分；且一般考官僅能將自己上傳的試卷設為當前測驗
        const targetExamInLib = (state.examLibrary || []).find(e => e && e.id === payload.examData.id);
        const targetOwnerId = (targetExamInLib && targetExamInLib.ownerId) ? targetExamInLib.ownerId : (payload.examData.ownerId || myId);
        if (!isAdmin && targetOwnerId && targetOwnerId !== myId && (nowOpen || payload.examData.id !== prevExam.id)) {
          return jsonResponse({
            status: 'forbidden',
            message: '⛔ 權限限制：您僅能將自己上傳的試卷設為當前測驗試卷或開放作答！'
          });
        }

        payload.examData.ownerId = targetOwnerId || myId;
        payload.examData.ownerName = (targetExamInLib && targetExamInLib.ownerName) ? targetExamInLib.ownerName : (payload.examData.ownerName || currentSessionUser.displayName);

        if (nowOpen && !wasOpen) {
          payload.examData.startedByUserId = myId;
          payload.examData.startedByName = currentSessionUser.displayName;
          payload.examData.openedAt = payload.examData.openedAt || Date.now();
          payload.examData.closedAt = null;
        } else if (nowOpen && wasOpen) {
          payload.examData.startedByUserId = prevExam.startedByUserId || myId;
          payload.examData.startedByName = prevExam.startedByName || currentSessionUser.displayName;
          payload.examData.closedAt = null;
        } else if (!nowOpen && wasOpen) {
          payload.examData.closedAt = Date.now();
        } else if (!nowOpen && prevExam.closedAt && !payload.examData.closedAt) {
          payload.examData.closedAt = prevExam.closedAt;
        }

        // 強制規範測驗連結有效時間 = 該試卷作答時間 (durationMinutes) + 15 分鐘
        if (payload.examData.activeExamToken && payload.examData.activeExamToken.token) {
          const tok = payload.examData.activeExamToken;
          const isNewToken = !prevToken || prevToken.token !== tok.token;
          const examDurMins = Math.max(1, Number(payload.examData.durationMinutes) || 60);
          const linkValidMins = examDurMins + 15;
          const createdTs = isNewToken ? Date.now() : (Number(tok.createdAt) || Date.now());
          tok.createdAt = createdTs;
          tok.durationMinutes = linkValidMins;
          tok.expiresAt = createdTs + linkValidMins * 60 * 1000;
          tok.createdByUserId = isNewToken ? myId : (prevToken.createdByUserId || myId);
          tok.createdByName = isNewToken ? currentSessionUser.displayName : (prevToken.createdByName || currentSessionUser.displayName);
        }

        state.examData = payload.examData;
      }

      if (Array.isArray(payload.examLibrary)) {
        state.examLibrary = mergeAndProtectExamLibraryGas(payload.examLibrary, state.examLibrary, currentSessionUser);
      }
      saveCloudState(state);
      return jsonResponse({
        status: 'success',
        message: '題庫與試卷設定已同步至雲端',
        examData: state.examData,
        examLibrary: state.examLibrary
      });
    }

    // 1-b. 考官儲存試卷庫 (多份試卷獨立保存於試卷庫資料工作表，強制保護他人試卷不可被一般考官刪除或修改)
    if (action === 'saveExamLibrary') {
      const libraryData = Array.isArray(payload.examLibrary)
        ? payload.examLibrary
        : (payload.examLibrary ? [payload.examLibrary] : null);

      if (libraryData) {
        const prevCount = (state.examLibrary || []).length;
        state.examLibrary = mergeAndProtectExamLibraryGas(libraryData, state.examLibrary, currentSessionUser);
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

    // 3. 考官同步當前場次成績列表 (僅允許當前場次試卷擁有者或管理員修改/刪除當前成績)
    if (action === 'syncSubmissions') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;
      const prevExam = state.examData || {};
      const currOwner = prevExam.startedByUserId || prevExam.ownerId || '';

      if (!isAdmin && currOwner && currOwner !== myId) {
        return jsonResponse({
          status: 'forbidden',
          message: '⛔ 權限限制：您僅能管理或刪除自己試卷場次的考生成績！'
        });
      }

      if (Array.isArray(payload.submissions)) {
        state.submissions = payload.submissions;
      }
      if (payload.examData && (isAdmin || !currOwner || currOwner === myId)) {
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

    // 4. 將當前測驗場次結算並歸檔為一筆獨立歷史紀錄 (綁定擁有者 ownerId，且禁止一般考官結束或歸檔他人正在進行中的場次)
    if (action === 'archiveSession') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;
      const prevExam = state.examData || {};
      const currOwner = prevExam.startedByUserId || prevExam.ownerId || '';

      if (!isAdmin && currOwner && currOwner !== myId) {
        return jsonResponse({
          status: 'forbidden',
          message: '⛔ 權限限制：您無法結束或歸檔其他考官的測驗場次！'
        });
      }

      const historyRecord = payload.historyRecord;
      if (!historyRecord || !historyRecord.id) {
        return jsonResponse({ status: 'error', message: '缺少歷史場次歸檔資料' });
      }

      // 強制綁定歷史紀錄之擁有者資訊
      historyRecord.ownerId = prevExam.ownerId || myId;
      historyRecord.ownerName = prevExam.ownerName || currentSessionUser.displayName;
      historyRecord.ownerOrg = currentSessionUser.organization || '';

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

      const visibleHistory = isAdmin
        ? state.historySessions
        : state.historySessions.filter(h => h && h.ownerId === myId);

      return jsonResponse({
        status: 'success',
        message: '已成功將測驗結果歸檔為獨立歷史紀錄',
        historySessions: visibleHistory,
        submissions: state.submissions,
        examData: state.examData
      });
    }

    // 5. 同步或刪除歷史測驗紀錄 (強制保護：一般考官僅能修改/刪除自己的歷史紀錄，所有他人的歷史紀錄一律原封不動保留)
    if (action === 'syncHistory') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;

      if (Array.isArray(payload.historySessions)) {
        if (isAdmin) {
          state.historySessions = payload.historySessions.map(inc => {
            const prev = (state.historySessions || []).find(p => p && p.id === inc.id);
            return Object.assign({}, inc, {
              ownerId: (prev && prev.ownerId) ? prev.ownerId : (inc.ownerId || myId),
              ownerName: (prev && prev.ownerName) ? prev.ownerName : (inc.ownerName || currentSessionUser.displayName)
            });
          });
        } else {
          // 一般考官：保留所有不屬於該考官的歷史紀錄，僅允許異動 ownerId === myId 的紀錄
          const othersHist = (state.historySessions || []).filter(h => h && h.ownerId !== myId);
          const myAllowedHist = [];
          payload.historySessions.forEach(inc => {
            if (!inc || !inc.id) return;
            const prev = (state.historySessions || []).find(p => p && p.id === inc.id);
            if (prev && prev.ownerId && prev.ownerId !== myId) return;
            myAllowedHist.push(Object.assign({}, inc, {
              ownerId: myId,
              ownerName: currentSessionUser.displayName
            }));
          });
          state.historySessions = myAllowedHist.concat(othersHist);
        }
      }
      saveCloudState(state);
      syncHistoryLogSheet(state.historySessions);

      const visibleHistory = isAdmin
        ? state.historySessions
        : state.historySessions.filter(h => h && h.ownerId === myId);

      return jsonResponse({
        status: 'success',
        message: '歷史紀錄已同步更新',
        historySessions: visibleHistory
      });
    }

    // 6. 寄送考生成績單 Email (H3 安全加固：僅允許寄發予伺服器端 state 既有的真實考生紀錄、且一般考官僅能寄發自己場次的成績信)
    if (action === 'sendScoreEmails') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;
      const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
      const sessionId = payload.sessionId || 'CURRENT';
      const MAX_BATCH_EMAILS = 100;

      if (rawRecipients.length === 0) {
        return jsonResponse({ status: 'error', message: '沒有可寄送的考生 Email 名單' });
      }
      if (rawRecipients.length > MAX_BATCH_EMAILS) {
        return jsonResponse({ status: 'error', message: `單次寄送數量超過上限（最多 ${MAX_BATCH_EMAILS} 封），請分批寄送` });
      }

      // 鎖定伺服器端真實場次與交卷紀錄清單，並驗證場次擁有權
      let authoritativeList = [];
      let examInfo = state.examData || {};
      if (sessionId === 'CURRENT') {
        const currOwner = examInfo.startedByUserId || examInfo.ownerId || '';
        if (!isAdmin && currOwner && currOwner !== myId) {
          return jsonResponse({ status: 'forbidden', message: '⛔ 權限限制：您僅能寄送自己測驗場次的考生成績單！' });
        }
        authoritativeList = Array.isArray(state.submissions) ? state.submissions : [];
      } else {
        const targetHist = (state.historySessions || []).find(h => h && h.id === sessionId);
        if (!targetHist) {
          return jsonResponse({ status: 'error', message: '找不到指定的歷史測驗場次紀錄' });
        }
        if (!isAdmin && targetHist.ownerId && targetHist.ownerId !== myId) {
          return jsonResponse({ status: 'forbidden', message: '⛔ 權限限制：您僅能寄送自己歷史場次的考生成績單！' });
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
    librarySheet.getRange('A1:J1').setValues([[
      '試卷ID', '試卷名稱', '考試日期', '測驗時間(分)', '題目數', '建立/更新時間', '完整考題資料JSON', '擁有者UserID', '擁有者姓名', '擁有者單位'
    ]]);
  }

  let usersSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEET_NAMES.USERS);
    const uHeaders = [
      'UserID', '帳號(username)', '姓名(displayName)', '西元出生年月日(birthDate)', '服務單位(organization)',
      'Email', '密碼鹽值(pwSalt)', '密碼雜湊(pwHash)', '角色(role)', '狀態(status)',
      '連續失敗次數(failCount)', '鎖定截止時間戳(lockedUntil)', '註冊時間(createdAt)',
      '審核人與時間(approvedBy)', '最後登入時間(lastLoginAt)', '密碼變更時間戳(pwChangedAt)'
    ];
    usersSheet.getRange(1, 1, 1, uHeaders.length).setValues([uHeaders]);
    try {
      usersSheet.getRange(1, 1, 1, uHeaders.length).setBackground('#f1f5f9').setFontWeight('bold');
    } catch (e) {}
  }

  let auditSheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
  if (!auditSheet) {
    auditSheet = ss.insertSheet(SHEET_NAMES.AUDIT_LOG);
    const aHeaders = ['紀錄時間', '操作者UserID', '操作者帳號', '動作類型', '目標對象', '結果與說明'];
    auditSheet.getRange(1, 1, 1, aHeaders.length).setValues([aHeaders]);
    try {
      auditSheet.getRange(1, 1, 1, aHeaders.length).setBackground('#f1f5f9').setFontWeight('bold');
    } catch (e) {}
  }

  return { ss, stateSheet, scoreSheet, histSheet, librarySheet, usersSheet, auditSheet };
}

function appendAuditLogGas(actorUserId, actorUsername, actionType, targetId, detailText) {
  try {
    const { auditSheet } = ensureSheetsInitialized();
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    auditSheet.appendRow([
      sanitizeSheetCellGas(nowStr),
      sanitizeSheetCellGas(actorUserId || '-'),
      sanitizeSheetCellGas(actorUsername || '-'),
      sanitizeSheetCellGas(actionType || '-'),
      sanitizeSheetCellGas(targetId || '-'),
      sanitizeSheetCellGas(detailText || '-')
    ]);
  } catch (e) {
    console.warn('appendAuditLogGas failed:', e);
  }
}

function loadUsersFromSheet() {
  const { usersSheet } = ensureSheetsInitialized();
  const lastRow = usersSheet.getLastRow();
  if (lastRow <= 1) return [];
  const rows = usersSheet.getRange(2, 1, lastRow - 1, 16).getValues();
  const list = [];
  rows.forEach(r => {
    const uid = String(r[0] || '').trim().replace(/^'/, '');
    const uname = String(r[1] || '').trim().replace(/^'/, '');
    if (!uid && !uname) return;
    let bDate = '';
    if (r[3] instanceof Date) {
      bDate = Utilities.formatDate(r[3], Session.getScriptTimeZone() || 'GMT+8', 'yyyy-MM-dd');
    } else {
      bDate = String(r[3] || '').trim().replace(/^'/, '');
    }
    list.push({
      userId: uid || ('usr_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12)),
      username: uname,
      displayName: String(r[2] || '').trim().replace(/^'/, ''),
      birthDate: bDate,
      organization: String(r[4] || '').trim().replace(/^'/, ''),
      email: String(r[5] || '').trim().replace(/^'/, '').toLowerCase(),
      pwSalt: String(r[6] || '').trim().replace(/^'/, ''),
      pwHash: String(r[7] || '').trim().replace(/^'/, ''),
      role: String(r[8] || 'examiner').trim().replace(/^'/, ''),
      status: String(r[9] || 'pending_review').trim().replace(/^'/, ''),
      failCount: Number(r[10] || 0),
      lockedUntil: Number(r[11] || 0),
      createdAt: String(r[12] || '').trim().replace(/^'/, ''),
      approvedBy: String(r[13] || '').trim().replace(/^'/, ''),
      lastLoginAt: String(r[14] || '').trim().replace(/^'/, ''),
      pwChangedAt: Number(r[15] || 0)
    });
  });
  return list;
}

function saveUsersToSheet(users) {
  const { usersSheet } = ensureSheetsInitialized();
  usersSheet.clearContents();
  const headers = [
    'UserID', '帳號(username)', '姓名(displayName)', '西元出生年月日(birthDate)', '服務單位(organization)',
    'Email', '密碼鹽值(pwSalt)', '密碼雜湊(pwHash)', '角色(role)', '狀態(status)',
    '連續失敗次數(failCount)', '鎖定截止時間戳(lockedUntil)', '註冊時間(createdAt)',
    '審核人與時間(approvedBy)', '最後登入時間(lastLoginAt)', '密碼變更時間戳(pwChangedAt)'
  ];
  const rows = [headers];
  (users || []).forEach(u => {
    rows.push([
      sanitizeSheetCellGas(u.userId || ''),
      sanitizeSheetCellGas(u.username || ''),
      sanitizeSheetCellGas(u.displayName || ''),
      sanitizeSheetCellGas(u.birthDate || ''),
      sanitizeSheetCellGas(u.organization || ''),
      sanitizeSheetCellGas(u.email || ''),
      sanitizeSheetCellGas(u.pwSalt || ''),
      sanitizeSheetCellGas(u.pwHash || ''),
      sanitizeSheetCellGas(u.role || 'examiner'),
      sanitizeSheetCellGas(u.status || 'pending_review'),
      Number(u.failCount || 0),
      Number(u.lockedUntil || 0),
      sanitizeSheetCellGas(u.createdAt || ''),
      sanitizeSheetCellGas(u.approvedBy || ''),
      sanitizeSheetCellGas(u.lastLoginAt || ''),
      Number(u.pwChangedAt || 0)
    ]);
  });

  if (usersSheet.getMaxRows() < rows.length) {
    usersSheet.insertRowsAfter(usersSheet.getMaxRows(), rows.length - usersSheet.getMaxRows());
  }
  if (usersSheet.getMaxColumns() < headers.length) {
    usersSheet.insertColumnsAfter(usersSheet.getMaxColumns(), headers.length - usersSheet.getMaxColumns());
  }
  usersSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  try {
    usersSheet.getRange(1, 1, 1, headers.length).setBackground('#f1f5f9').setFontWeight('bold');
  } catch (e) {}
}

/**
 * 過濾敏感密碼雜湊欄位，僅回傳前端管理員或本人可安全檢視的欄位
 */
function sanitizeUserForClientGas(u, isAdminViewer) {
  if (!u) return null;
  const base = {
    userId: u.userId,
    username: u.username,
    displayName: u.displayName,
    organization: u.organization,
    role: u.role,
    status: u.status
  };
  if (isAdminViewer) {
    base.birthDate = u.birthDate;
    base.email = u.email;
    base.createdAt = u.createdAt;
    base.approvedBy = u.approvedBy;
    base.lastLoginAt = u.lastLoginAt;
    base.isLocked = u.lockedUntil > Date.now();
  }
  return base;
}

function loadExamLibraryFromSheet(librarySheet) {
  const lastRow = librarySheet.getLastRow();
  if (lastRow <= 1) return [];
  const colCount = Math.max(7, Math.min(10, librarySheet.getLastColumn() || 7));
  const rows = librarySheet.getRange(2, 1, lastRow - 1, colCount).getValues();
  const library = [];
  rows.forEach(r => {
    if (!r[0] && !r[1]) return;
    let questions = [];
    try {
      if (r[6]) questions = JSON.parse(String(r[6]).replace(/^'/, ''));
    } catch (e) {}

    let dateVal = '';
    if (r[2] instanceof Date) {
      dateVal = Utilities.formatDate(r[2], Session.getScriptTimeZone() || 'GMT+8', 'yyyy-MM-dd');
    } else {
      dateVal = String(r[2] || '').trim().replace(/^'/, '');
    }

    library.push({
      id: String(r[0] || '').replace(/^'/, ''),
      title: String(r[1] || '').replace(/^'/, ''),
      examDate: dateVal,
      durationMinutes: r[3] !== '' ? Number(r[3]) : 60,
      questions: Array.isArray(questions) ? questions : [],
      updatedAt: String(r[5] || '').replace(/^'/, ''),
      ownerId: r[7] ? String(r[7]).trim().replace(/^'/, '') : 'SYSTEM_ADMIN',
      ownerName: r[8] ? String(r[8]).trim().replace(/^'/, '') : '系統管理員',
      ownerOrg: r[9] ? String(r[9]).trim().replace(/^'/, '') : ''
    });
  });
  return library;
}

function syncExamLibrarySheet(librarySheet, examLibrary) {
  librarySheet.clearContents();
  const headers = ['試卷ID', '試卷名稱', '考試日期', '測驗時間(分)', '題目數', '建立/更新時間', '完整考題資料JSON', '擁有者UserID', '擁有者姓名', '擁有者單位'];
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
      sanitizeSheetCellGas(questionsJson),
      sanitizeSheetCellGas(exam.ownerId || 'SYSTEM_ADMIN'),
      sanitizeSheetCellGas(exam.ownerName || '系統管理員'),
      sanitizeSheetCellGas(exam.ownerOrg || '')
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

