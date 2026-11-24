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

// 考題圖片專用 Google 雲端硬碟資料夾 ID (優先讀取 Script Properties 的 EXAM_IMAGE_FOLDER_ID，未設定時使用此預設指定資料夾)
const DEFAULT_EXAM_IMAGE_FOLDER_ID = '11vY2bQE-3G_gwrcanjCeCJMYjPbnYYrl';

function getExamImageFolderId() {
  try {
    const propId = PropertiesService.getScriptProperties().getProperty('EXAM_IMAGE_FOLDER_ID');
    if (propId && propId.trim()) return propId.trim();
  } catch (e) {}
  return DEFAULT_EXAM_IMAGE_FOLDER_ID;
}

/**
 * 首次部署或需要更新後端管理員金鑰時，可在 Apps Script 編輯器修改下方參數並執行一次 `initCustomSecurityCredentials`
 * 執行後系統會自動產生高熵隨機 Salt/Pepper 並將雜湊安全寫入 Script Properties (請勿將真實密碼留存於程式碼中提交至 GitHub)
 */
function initCustomSecurityCredentials() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const adminSalt = all.ADMIN_KEY_SALT || ('ADM_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  const pwPepper = all.USER_PASSWORD_PEPPER || ('PEPPER_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, ''));
  // 如需重設管理員金鑰，請暫時將下方空字串改為自訂金鑰並點選「執行」，執行完畢後請清空還原為 ''
  const customAdminKey = '';
  const updates = {
    ADMIN_KEY_SALT: adminSalt,
    USER_PASSWORD_PEPPER: pwPepper
  };
  if (customAdminKey) {
    updates.ADMIN_KEY_HASH = sha256Hex(`${adminSalt}:${customAdminKey}`).toLowerCase();
  }
  props.setProperties(updates, false);
  Logger.log('✅ 安全憑證設定已更新至 Script Properties！');
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

const PW_HASH_ITERATIONS_V2 = 10000;

/**
 * 考官密碼雜湊 (Per-User Random Salt + Server Pepper + 10,000 次迭代 SHA-256 雜湊鏈，M4 安全加固)
 * 防止離線字典破解與彩虹表攻擊
 */
function hashUserPasswordGas(plainPassword, userSalt, serverPepper, iterations) {
  const iter = Number(iterations) || PW_HASH_ITERATIONS_V2;
  const seed = `${serverPepper || ''}:${userSalt || ''}:${plainPassword || ''}`;
  let digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
  for (let i = 0; i < iter; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  const hex = digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return iterations ? hex : `v2$${iter}$${hex}`;
}

/**
 * 驗證考官密碼 (支援 v2 高迭代格式並向下相容舊版 2500 次雜湊，登入成功時可無痛升級)
 */
function verifyUserPasswordGas(plainPassword, userSalt, serverPepper, storedHash) {
  const stored = String(storedHash || '').trim();
  if (!stored) return { matched: false, needsUpgrade: false };
  if (stored.startsWith('v2$')) {
    const parts = stored.split('$');
    const iter = parseInt(parts[1], 10);
    const expectedHex = parts[2] || '';
    if (!iter || iter < 1000 || !expectedHex) return { matched: false, needsUpgrade: false };
    const computedHex = hashUserPasswordGas(plainPassword, userSalt, serverPepper, iter);
    return {
      matched: constantTimeEqualsGas(computedHex, expectedHex),
      needsUpgrade: iter < PW_HASH_ITERATIONS_V2
    };
  }
  const legacyHex = hashUserPasswordGas(plainPassword, userSalt, serverPepper, 2500);
  return {
    matched: constantTimeEqualsGas(legacyHex, stored),
    needsUpgrade: true
  };
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
function getSecurityConfig() {
  const props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  const updates = {};

  const adminSalt = (all.ADMIN_KEY_SALT || '').trim() || ('ADM_SALT_' + Utilities.getUuid().replace(/-/g, ''));
  if (!all.ADMIN_KEY_SALT) updates.ADMIN_KEY_SALT = adminSalt;

  const pwPepper = (all.USER_PASSWORD_PEPPER || '').trim() || ('PEPPER_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, ''));
  if (!all.USER_PASSWORD_PEPPER) updates.USER_PASSWORD_PEPPER = pwPepper;

  const adminHash = (all.ADMIN_KEY_HASH || '').trim().toLowerCase();

  // Cloudflare Turnstile Secret Key (必須於 Script Properties 設定 TURNSTILE_SECRET_KEY)
  const turnstileSecretKey = (all.TURNSTILE_SECRET_KEY || '').trim();
  // 選填：於 Script Properties 設定 TURNSTILE_ALLOWED_HOSTNAMES (以逗號分隔，如 bruceabc0511.github.io) 以限制驗證網域 (M7)
  const turnstileAllowedHostnames = String(all.TURNSTILE_ALLOWED_HOSTNAMES || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);

  if (Object.keys(updates).length > 0) {
    try {
      props.setProperties(updates, false);
    } catch (e) {}
  }

  return { adminSalt, adminHash, pwPepper, turnstileSecretKey, turnstileAllowedHostnames };
}

/**
 * 向 Cloudflare Turnstile Siteverify API 驗證前端傳入之訪客 Token (Fail-Closed 強制驗證機制 + Hostname 檢查)
 * - 必須於 Script Properties 設定 TURNSTILE_SECRET_KEY，且前端必須傳入有效之單次 turnstileToken。
 * - 若設定了 TURNSTILE_ALLOWED_HOSTNAMES，會額外比對 Turnstile 回傳之 hostname，防止跨網域 Token 重放。
 */
function verifyCloudflareTurnstileToken(turnstileToken) {
  const cfg = getSecurityConfig();
  const configuredSecret = cfg.turnstileSecretKey;
  const cleanToken = String(turnstileToken || '').trim();

  if (!configuredSecret) {
    return {
      success: false,
      message: '🛡️ 雲端後端尚未於 Script Properties 設定 TURNSTILE_SECRET_KEY，系統拒絕請求！'
    };
  }

  if (!cleanToken) {
    return {
      success: false,
      message: '🛡️ 請先完成 Cloudflare 訪客安全驗證後再送出！'
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
      if (cfg.turnstileAllowedHostnames && cfg.turnstileAllowedHostnames.length > 0) {
        const respHost = String(result.hostname || '').trim().toLowerCase();
        if (!respHost || cfg.turnstileAllowedHostnames.indexOf(respHost) === -1) {
          console.warn('Turnstile hostname mismatch:', respHost);
          return {
            success: false,
            message: '🛡️ Cloudflare 驗證來源網域不符，請重新整理頁面後再試！'
          };
        }
      }
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
 * 考官伺服器端 Session Token 管理 (隨機高熵 UUID，綁定個人身分與角色，30 分鐘滑動有效期限 + 8 小時絕對存活上限)
 */
const EXAMINER_SESSION_TTL_SEC = 1800;
const EXAMINER_SESSION_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;

function createExaminerSession(userProfile) {
  if (!userProfile || !userProfile.userId) return '';
  const token = 'exs_' + Utilities.getUuid().replace(/-/g, '') + '_' + Utilities.getUuid().replace(/-/g, '');
  const cache = CacheService.getScriptCache();
  const sessObj = {
    userId: String(userProfile.userId),
    username: String(userProfile.username || ''),
    displayName: String(userProfile.displayName || ''),
    organization: String(userProfile.organization || ''),
    role: String(userProfile.role || 'examiner'),
    issuedAt: Date.now()
  };
  cache.put('EXAMINER_SESS_' + token, JSON.stringify(sessObj), EXAMINER_SESSION_TTL_SEC);
  return token;
}

/**
 * 取得並驗證考官 Session 身分物件 (檢查絕對存活上限、帳號撤銷標記並更新滑動效期)
 */
function getExaminerSessionUser(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const clean = sessionToken.trim();
  if (!clean.startsWith('exs_')) return null;
  const cache = CacheService.getScriptCache();
  const val = cache.get('EXAMINER_SESS_' + clean);
  if (!val || !val.startsWith('{')) return null;

  let sessObj = null;
  try {
    sessObj = JSON.parse(val);
  } catch (e) {
    return null;
  }

  if (!sessObj || !sessObj.userId || sessObj.userId === 'SYSTEM_ADMIN') {
    cache.remove('EXAMINER_SESS_' + clean);
    return null;
  }

  // M1: 檢查 Session 絕對存活上限 (8 小時)，防止透過滑動續期無限延長有效期限
  const issuedAt = Number(sessObj.issuedAt || 0);
  if (!issuedAt || (Date.now() - issuedAt > EXAMINER_SESSION_MAX_LIFETIME_MS)) {
    cache.remove('EXAMINER_SESS_' + clean);
    return null;
  }

  // 即時檢查帳號是否已被停用、降級或密碼已變更
  const revKey = 'USER_REVOKED_AT_' + sessObj.userId;
  const revokedAt = Number(cache.get(revKey) || 0);
  if (revokedAt > 0 && revokedAt > issuedAt) {
    cache.remove('EXAMINER_SESS_' + clean);
    return null;
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
 * 立即撤銷某位使用者的所有既有登入 Session (用於密碼變更、忘記密碼重設、管理員停用/降級/刪除帳號)
 */
function revokeAllUserSessionsGas(userId) {
  if (!userId) return;
  try {
    CacheService.getScriptCache().put('USER_REVOKED_AT_' + String(userId), String(Date.now()), EXAMINER_SESSION_TTL_SEC + 300);
  } catch (e) {}
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
      ensureSheetsInitialized();
      getSecurityConfig(); // 確保 Script Properties 已自動初始化，不載入完整試卷與成績狀態
      return jsonResponse({
        status: 'success',
        message: 'Google 試算表雲端測驗資料庫與自動寄信服務運作正常！',
        hasExamLibrarySupport: true,
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
  let payload = {};
  try {
    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    payload = JSON.parse(rawBody);
  } catch (parseErr) {
    return jsonResponse({ status: 'error', message: '請求格式不正確' });
  }
  const action = payload.action || '';

  // M4 & H1 安全加固：將外部 HTTP 驗證 (Turnstile) 與免鎖預檢移至全域 ScriptLock 之外，避免外部網路延遲阻塞考生交卷
  const turnstileActions = ['registerExaminer', 'requestPasswordReset', 'confirmPasswordReset', 'verifyExaminer'];
  if (turnstileActions.indexOf(action) !== -1) {
    const clientIdPre = String(payload.clientId || '').trim();
    if (isAuthRateLimited(clientIdPre)) {
      return jsonResponse({ status: 'locked', message: '操作過於頻繁或錯誤次數過多，系統已暫時鎖定 3 分鐘' });
    }
    const turnstileCheck = verifyCloudflareTurnstileToken(payload.turnstileToken);
    if (!turnstileCheck.success) {
      return jsonResponse({
        status: 'turnstile_failed',
        message: turnstileCheck.message
      });
    }
  }

  // 若為考官註冊，先於鎖外完成欄位格式檢查與高迭代密碼雜湊計算 (M4)
  let precomputedReg = null;
  if (action === 'registerExaminer') {
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

    const cfg = getSecurityConfig();
    const pwSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
    const pwHash = hashUserPasswordGas(password, pwSalt, cfg.pwPepper);
    precomputedReg = { displayName, birthDate, organization, username, email, pwSalt, pwHash };
  }

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
    const state = loadCloudState();

    // 0-A. 考官註冊申請 (Low #1：不洩漏是帳號還是 Email 重複)
    if (action === 'registerExaminer') {
      const { displayName, birthDate, organization, username, email, pwSalt, pwHash } = precomputedReg;
      const users = loadUsersFromSheet();
      const dupExists = users.some(u => u.username.toLowerCase() === username || u.email.toLowerCase() === email);
      if (dupExists) {
        return jsonResponse({
          status: 'error',
          message: '❌ 註冊失敗：此帳號或電子郵件已無法使用，請更換其他帳號與信箱，或聯繫管理員確認。'
        });
      }

      const nowIso = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
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
    // (Low #1：對外回傳統一訊息，防止帳號/信箱/生日枚舉；M3：使用密碼學安全雜湊衍生驗證碼)
    if (action === 'requestPasswordReset') {
      const clientId = String(payload.clientId || '').trim();
      const username = String(payload.username || '').trim().toLowerCase();
      const email = String(payload.email || '').trim().toLowerCase();
      const birthDate = String(payload.birthDate || '').trim();

      if (!username || !email || !birthDate) {
        return jsonResponse({ status: 'error', message: '請完整輸入您的自訂帳號、註冊 Email 與西元出生年月日' });
      }

      const users = loadUsersFromSheet();
      const targetUser = users.find(u => u.username.toLowerCase() === username);
      const genericSuccessMsg = '📧 若輸入的帳號、Email 與西元出生年月日與系統紀錄相符且帳號已啟用，系統已將 8 碼重設驗證碼寄至您的註冊信箱（15 分鐘內有效）。';

      if (!targetUser || targetUser.email.toLowerCase() !== email || targetUser.birthDate !== birthDate || targetUser.status !== 'active') {
        recordAuthFailure(clientId);
        appendAuditLogGas('-', username, 'PW_RESET_REQ_FAIL', username, '忘記密碼三要素核對不符或帳號未啟用');
        return jsonResponse({
          status: 'success',
          message: genericSuccessMsg
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

      // M3: 使用密碼學高熵 UUID + SHA-256 雜湊位元組產生 8 碼大寫英數驗證碼 (取代 Math.random)
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const entropySeed = `${Utilities.getUuid()}:${Utilities.getUuid()}:${Date.now()}:${targetUser.userId}`;
      const entropyBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, entropySeed, Utilities.Charset.UTF_8);
      let resetCode = '';
      for (let i = 0; i < 8; i++) {
        const idx = (entropyBytes[i] & 0xff) % chars.length;
        resetCode += chars.charAt(idx);
      }

      const cfg = getSecurityConfig();
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
        message: genericSuccessMsg
      });
    }

    // 0-C. 忘記密碼 — 步驟 2：驗證 Turnstile + 8 碼重設驗證碼並更新為新密碼 (H1)
    if (action === 'confirmPasswordReset') {
      const clientId = String(payload.clientId || '').trim();
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

      const cfg = getSecurityConfig();
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

    // 0-D. 考官帳號密碼登入驗證 (已移除舊版初始 SYSTEM_ADMIN 與預設 PIN 登入分支，Low #4)
    if (action === 'verifyExaminer') {
      const clientId = String(payload.clientId || '').trim();
      const rawUsername = String(payload.username || '').trim().toLowerCase();
      const rawPassword = String(payload.password !== undefined ? payload.password : (payload.pin || ''));

      if (!rawUsername || !rawPassword) {
        return jsonResponse({ status: 'unauthorized', message: '請輸入考官帳號與密碼！' });
      }

      const users = loadUsersFromSheet();
      const cfg = getSecurityConfig();
      const user = users.find(u => u.username.toLowerCase() === rawUsername);
      const genericAuthErr = '❌ 帳號或密碼錯誤，或此帳號暫時無法登入，請確認後再試！';

      if (!user) {
        const fails = recordAuthFailure(clientId);
        if (fails >= AUTH_CLIENT_MAX_FAILS) {
          return jsonResponse({ status: 'locked', message: '帳號或密碼錯誤次數過多，已暫時鎖定 3 分鐘' });
        }
        return jsonResponse({ status: 'unauthorized', message: genericAuthErr });
      }

      // 檢查帳號層級鎖定 (連續錯誤 5 次鎖定 5 分鐘，Low #1：不透露帳號是否存在)
      const nowTs = Date.now();
      if (user.lockedUntil && Number(user.lockedUntil) > nowTs) {
        recordAuthFailure(clientId);
        return jsonResponse({
          status: 'unauthorized',
          message: genericAuthErr
        });
      }

      const pwCheck = verifyUserPasswordGas(rawPassword, user.pwSalt, cfg.pwPepper, user.pwHash);

      if (!pwCheck.matched) {
        user.failCount = (Number(user.failCount) || 0) + 1;
        if (user.failCount >= 5) {
          user.lockedUntil = nowTs + 5 * 60 * 1000; // 鎖定 5 分鐘
          saveUsersToSheet(users);
          appendAuditLogGas(user.userId, user.username, 'ACCOUNT_LOCKED', user.userId, '連續密碼錯誤 5 次鎖定 5 分鐘');
          return jsonResponse({
            status: 'unauthorized',
            message: genericAuthErr
          });
        }
        saveUsersToSheet(users);
        const fails = recordAuthFailure(clientId);
        if (fails >= AUTH_CLIENT_MAX_FAILS) {
          return jsonResponse({ status: 'locked', message: '驗證錯誤次數過多，裝置已暫時鎖定 3 分鐘' });
        }
        return jsonResponse({ status: 'unauthorized', message: genericAuthErr });
      }

      // 密碼正確後，檢查審核與啟用狀態
      if (user.status === 'pending_review') {
        return jsonResponse({
          status: 'pending_review',
          message: '⏳ 您的考官帳號正在等待系統管理員審核中，審核通過後方可登入！'
        });
      }
      if (user.status !== 'active') {
        return jsonResponse({
          status: 'unauthorized',
          message: genericAuthErr
        });
      }

      // 登入成功：重置失敗計數、更新最後登入時間，若為舊版 2500 次雜湊則無痛升級至 10,000 次 (M4)
      user.failCount = 0;
      user.lockedUntil = 0;
      user.lastLoginAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
      if (pwCheck.needsUpgrade) {
        const upgradedSalt = 'USR_SALT_' + Utilities.getUuid().replace(/-/g, '');
        user.pwSalt = upgradedSalt;
        user.pwHash = hashUserPasswordGas(rawPassword, upgradedSalt, cfg.pwPepper);
      }
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

    // 考官登出：立即銷毀伺服器端 Session Token
    if (action === 'logoutExaminer') {
      if (payload.sessionToken) {
        revokeExaminerSession(payload.sessionToken);
      }
      return jsonResponse({ status: 'success', message: '已安全登出並撤銷雲端工作階段' });
    }

    // 0-E. 考官變更自己的登入密碼 / PIN 碼 (僅能變更自己帳號的密碼，並驗證本人目前密碼)
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
      const cfg = getSecurityConfig();

      // 強制鎖定只更新 sessionToken 本人的帳號 (防範 IDOR 越權)
      const me = users.find(u => u.userId === sessUser.userId);
      if (!me) {
        return jsonResponse({ status: 'error', message: '找不到您的帳號資料，請重新登入' });
      }
      if (!currentPassword) {
        return jsonResponse({ status: 'error', message: '請輸入您目前的密碼以驗證本人身分' });
      }

      const currPwCheck = verifyUserPasswordGas(currentPassword, me.pwSalt, cfg.pwPepper, me.pwHash);
      if (!currPwCheck.matched) {
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

    // 0-E2. 考官修改自己的服務單位 (強制鎖定僅能修改 sessionToken 本人帳號之 organization，防範 IDOR 越權)
    if (action === 'updateOwnOrganization') {
      const clientId = String(payload.clientId || '').trim();
      if (isAuthRateLimited(clientId)) {
        return jsonResponse({ status: 'locked', message: '操作過於頻繁，系統已暫時鎖定 3 分鐘' });
      }

      const sessUser = getAuthorizedExaminerUser(payload, state);
      if (!sessUser) {
        return jsonResponse({ status: 'unauthorized', message: '登入工作階段已逾時，請重新登入後再修改服務單位！' });
      }

      const newOrg = String(payload.newOrganization || '').trim().substring(0, 60);
      if (!newOrg || newOrg.length < 2) {
        return jsonResponse({ status: 'error', message: '請填寫正確的服務單位名稱（至少 2 個字，上限 60 字）' });
      }

      const users = loadUsersFromSheet();
      const me = users.find(u => u.userId === sessUser.userId);
      if (!me) {
        return jsonResponse({ status: 'error', message: '找不到您的帳號資料，請重新登入' });
      }

      const oldOrg = String(me.organization || '').trim();
      if (oldOrg === newOrg) {
        return jsonResponse({ status: 'error', message: '新輸入的服務單位與目前設定相同，無須變更' });
      }

      me.organization = newOrg;
      saveUsersToSheet(users);

      // 同步更新該考官名下已上傳試卷的擁有者單位標記
      let libUpdated = false;
      (state.examLibrary || []).forEach(ex => {
        if (ex && ex.ownerId === me.userId) {
          ex.ownerOrg = newOrg;
          libUpdated = true;
        }
      });
      if (libUpdated) {
        const { stateSheet, librarySheet } = ensureSheetsInitialized();
        syncExamLibrarySheet(librarySheet, state.examLibrary);
        touchUpdatedAt(stateSheet);
      }

      // 同步更新伺服器快取中的 Session 資訊 (保留原 issuedAt 絕對存活上限起算點)
      try {
        const cleanToken = String(payload.sessionToken || '').trim();
        if (cleanToken.startsWith('exs_')) {
          sessUser.organization = newOrg;
          CacheService.getScriptCache().put('EXAMINER_SESS_' + cleanToken, JSON.stringify(sessUser), EXAMINER_SESSION_TTL_SEC);
        }
      } catch (e) {}

      appendAuditLogGas(me.userId, me.username, 'UPDATE_OWN_ORG', me.userId, `本人變更服務單位：${oldOrg || '-'} -> ${newOrg}`);

      return jsonResponse({
        status: 'success',
        message: `✅ 服務單位已成功更新為「${newOrg}」！`,
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
        const prevRole = targetUser.role;
        const prevStatus = targetUser.status;
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
        // M1: 帳號遭停用、非 active 或角色變更（如降級）時，立即撤銷該使用者的所有既有 Session
        if (targetUser.status !== 'active' || targetUser.role !== prevRole || targetUser.status !== prevStatus) {
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
        const cfg = getSecurityConfig();
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

    // 考官授權檢視或考生透過 POST 讀取試卷狀態 (H1: 已登入 Session 不受全域未驗證限流阻擋; M6: 一般考官僅能看到自己上傳的試卷; Low #8: userProfile 經白名單過濾)
    if (action === 'getExamState') {
      const sessUser = getAuthorizedExaminerUser(payload, state);
      if (sessUser) {
        const isAdmin = (sessUser.role === 'admin');
        const myId = sessUser.userId;

        // 過濾歷史測驗紀錄：考官僅能查看自己上傳試卷 / 自己歸檔的歷史紀錄；管理員可查看全部
        const visibleHistory = isAdmin
          ? (state.historySessions || [])
          : (state.historySessions || []).filter(h => h && h.ownerId === myId);

        // 過濾試卷庫：M6 一般考官僅能看到自己上傳的試卷；管理員可查看全部
        const visibleLibrary = isAdmin
          ? (state.examLibrary || [])
          : (state.examLibrary || []).filter(ex => ex && ex.ownerId === myId);

        // 過濾當前場次成績與試卷：考官僅能查看自己試卷 / 自己開考場次的成績與題目；管理員可查看全部
        const currentExamOwnerId = (state.examData && state.examData.ownerId) ? state.examData.ownerId : '';
        const currentStartedById = (state.examData && state.examData.startedByUserId) ? state.examData.startedByUserId : '';
        const canViewCurrentSubmissions = isAdmin || (currentExamOwnerId === myId) || (currentStartedById === myId);
        const visibleSubmissions = canViewCurrentSubmissions ? (state.submissions || []) : [];

        let visibleExamData = state.examData;
        if (!canViewCurrentSubmissions && state.examData) {
          // 若當前場次為他人正在進行或未歸檔之試卷，僅回傳基本占線狀態，不外洩他人試卷題目與答案
          visibleExamData = {
            id: state.examData.id || '',
            title: state.examData.title || '',
            durationMinutes: state.examData.durationMinutes || 60,
            examDate: state.examData.examDate || '',
            isExamOpen: Boolean(state.examData.isExamOpen),
            openedAt: state.examData.openedAt || null,
            ownerId: state.examData.ownerId || '',
            ownerName: state.examData.ownerName || '',
            startedByUserId: state.examData.startedByUserId || '',
            startedByName: state.examData.startedByName || '',
            activeExamToken: state.examData.activeExamToken ? { expiresAt: state.examData.activeExamToken.expiresAt } : null,
            questions: []
          };
        }

        return jsonResponse({
          status: 'success',
          isExaminer: true,
          userProfile: sanitizeUserForClientGas(sessUser, false),
          examData: visibleExamData,
          submissions: visibleSubmissions,
          historySessions: visibleHistory,
          examLibrary: visibleLibrary,
          updatedAt: state.updatedAt
        });
      }

      // 若原本嘗試以考官身分請求但 Session 已過期或無效，明確回傳 unauthorized 供前端引導重新登入
      if (payload.sessionToken) {
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

    // 檢查考官權限 (H1: 已登入之合法 Session 操作不受全域未驗證限流影響，防止免登入 DoS 癱瘓考官操作)
    const examinerActions = [
      'saveExamData', 'saveExamLibrary', 'syncSubmissions',
      'archiveSession', 'syncHistory', 'sendScoreEmails', 'uploadQuestionImage'
    ];

    let currentSessionUser = null;
    if (examinerActions.indexOf(action) !== -1) {
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

    // 1. 考官儲存題庫與試卷設定 (H2 安全加固：伺服器端強制決定 ownerId 與 startedByUserId，禁止接管他人場次或未歸檔成績)
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

        // H2: 若目前場次有他人尚未歸檔的考生成績，或他人測驗正進行中，一般考官不得覆寫 state.examData 接管場次
        const prevOwnerOrStarter = prevExam.startedByUserId || prevExam.ownerId || '';
        const hasOtherSubmissions = Array.isArray(state.submissions) && state.submissions.length > 0 && prevOwnerOrStarter && prevOwnerOrStarter !== myId;
        if (!isAdmin && ((wasOpen && !isPrevOpenExpired && prevOwnerOrStarter && prevOwnerOrStarter !== myId) || hasOtherSubmissions)) {
          return jsonResponse({
            status: 'forbidden',
            message: `⛔ 權限限制：目前場次尚有考官【${prevExam.startedByName || prevExam.ownerName || '其他考官'}】的進行中測驗或未歸檔成績，無法接管或覆寫！`
          });
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

        // 伺服器端從試卷庫或目前使用者強制判定 ownerId，忽略客戶端傳入的偽造 ownerId / startedByUserId
        const targetExamInLib = (state.examLibrary || []).find(e => e && e.id === payload.examData.id);
        let resolvedOwnerId = myId;
        let resolvedOwnerName = currentSessionUser.displayName;
        if (targetExamInLib && targetExamInLib.ownerId) {
          if (!isAdmin && targetExamInLib.ownerId !== myId) {
            return jsonResponse({
              status: 'forbidden',
              message: '⛔ 權限限制：您僅能將自己上傳的試卷設為當前測驗試卷或開放作答！'
            });
          }
          resolvedOwnerId = targetExamInLib.ownerId;
          resolvedOwnerName = targetExamInLib.ownerName || currentSessionUser.displayName;
        } else if (isAdmin && prevExam.id === payload.examData.id && prevExam.ownerId) {
          resolvedOwnerId = prevExam.ownerId;
          resolvedOwnerName = prevExam.ownerName || currentSessionUser.displayName;
        }

        payload.examData.ownerId = resolvedOwnerId;
        payload.examData.ownerName = resolvedOwnerName;

        if (nowOpen && !wasOpen) {
          payload.examData.startedByUserId = myId;
          payload.examData.startedByName = currentSessionUser.displayName;
          payload.examData.openedAt = Date.now();
          payload.examData.closedAt = null;
        } else if (nowOpen && wasOpen) {
          payload.examData.startedByUserId = prevExam.startedByUserId || myId;
          payload.examData.startedByName = prevExam.startedByName || currentSessionUser.displayName;
          payload.examData.openedAt = prevExam.openedAt || Date.now();
          payload.examData.closedAt = null;
        } else if (!nowOpen && wasOpen) {
          payload.examData.startedByUserId = prevExam.startedByUserId || myId;
          payload.examData.startedByName = prevExam.startedByName || currentSessionUser.displayName;
          payload.examData.closedAt = Date.now();
        } else {
          payload.examData.startedByUserId = (prevExam.id === payload.examData.id && prevExam.startedByUserId) ? prevExam.startedByUserId : myId;
          payload.examData.startedByName = (prevExam.id === payload.examData.id && prevExam.startedByName) ? prevExam.startedByName : currentSessionUser.displayName;
          payload.examData.closedAt = prevExam.closedAt || null;
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
      const visibleLib = isAdmin ? state.examLibrary : (state.examLibrary || []).filter(ex => ex && ex.ownerId === myId);
      return jsonResponse({
        status: 'success',
        message: '題庫與試卷設定已同步至雲端',
        examData: state.examData,
        examLibrary: visibleLib
      });
    }

    // 1-b. 考官儲存試卷庫 (M6: 多份試卷獨立保存於試卷庫資料工作表，一般考官僅回傳自己上傳的試卷)
    if (action === 'saveExamLibrary') {
      const isAdmin = (currentSessionUser.role === 'admin');
      const myId = currentSessionUser.userId;
      const libraryData = Array.isArray(payload.examLibrary)
        ? payload.examLibrary
        : (payload.examLibrary ? [payload.examLibrary] : null);

      if (libraryData) {
        state.examLibrary = mergeAndProtectExamLibraryGas(libraryData, state.examLibrary, currentSessionUser);
        const { stateSheet, librarySheet } = ensureSheetsInitialized();
        syncExamLibrarySheet(librarySheet, state.examLibrary);
        touchUpdatedAt(stateSheet);
      }
      const visibleLib = isAdmin ? state.examLibrary : (state.examLibrary || []).filter(ex => ex && ex.ownerId === myId);
      return jsonResponse({
        status: 'success',
        message: '試卷庫已同步至雲端',
        examLibrary: visibleLib
      });
    }

    // 2. 考生提交試卷 (M5 Fail-Closed：必須已有有效測驗連結 Token 始得交卷；H1 白名單與伺服器時間戳)
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

      // M5 Fail-Closed：一律要求系統必須已生成測驗連結 Token，且考生必須持有相符的 Token 始得交卷
      const activeTokenObj = (state.examData && state.examData.activeExamToken) ? state.examData.activeExamToken : null;
      const reqExamToken = String(payload.examToken || rawRecord.examToken || '').trim();
      if (!activeTokenObj || !activeTokenObj.token) {
        return jsonResponse({
          status: 'token_invalid',
          message: '測驗尚未生成有效專屬連結憑證，系統拒絕接收交卷！'
        });
      }
      const tokenStatus = evaluateExamTokenStatus(activeTokenObj, reqExamToken);
      if (tokenStatus === 'none' || tokenStatus === 'invalid' || tokenStatus === 'not_generated') {
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

    // 3. 考官同步當前場次成績列表 (H2: 僅允許當前場次試卷擁有者或管理員修改/刪除，且不允許透過此端點竄改 ownerId/startedByUserId)
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
        const nextExam = Object.assign({}, payload.examData);
        if (!isAdmin) {
          nextExam.ownerId = prevExam.ownerId || myId;
          nextExam.ownerName = prevExam.ownerName || currentSessionUser.displayName;
          nextExam.startedByUserId = prevExam.startedByUserId || myId;
          nextExam.startedByName = prevExam.startedByName || currentSessionUser.displayName;
        }
        state.examData = nextExam;
      }
      saveCloudState(state);
      syncCurrentScoresSheet(state.examData, state.submissions);

      return jsonResponse({
        status: 'success',
        message: '考生成績已同步更新至雲端',
        submissions: state.submissions
      });
    }

    // 4. 將當前測驗場次結算並歸檔為一筆獨立歷史紀錄 (H2: 檢查覆蓋既有歷史 ID 之擁有權與 newExamData 之擁有權)
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

      const existingIdx = state.historySessions.findIndex(h => h && h.id === historyRecord.id);
      if (existingIdx !== -1 && !isAdmin) {
        const prevHist = state.historySessions[existingIdx];
        if (prevHist && prevHist.ownerId && prevHist.ownerId !== myId) {
          return jsonResponse({
            status: 'forbidden',
            message: '⛔ 權限限制：禁止覆蓋其他考官的歷史場次紀錄！'
          });
        }
      }

      // 強制綁定歷史紀錄之擁有者資訊
      historyRecord.ownerId = prevExam.ownerId || myId;
      historyRecord.ownerName = prevExam.ownerName || currentSessionUser.displayName;
      historyRecord.ownerOrg = currentSessionUser.organization || '';

      if (existingIdx !== -1) {
        state.historySessions[existingIdx] = historyRecord;
      } else {
        state.historySessions.unshift(historyRecord);
      }

      // 若指定歸檔後清空當前場次考生成績
      if (payload.clearCurrent !== false) {
        state.submissions = [];
      }
      // 若同時傳入新試卷資料，強制伺服器端核對擁有權與綁定 ownerId
      if (payload.newExamData) {
        const nextExam = Object.assign({}, payload.newExamData);
        const libMatch = (state.examLibrary || []).find(e => e && e.id === nextExam.id);
        if (!isAdmin && libMatch && libMatch.ownerId && libMatch.ownerId !== myId) {
          return jsonResponse({
            status: 'forbidden',
            message: '⛔ 權限限制：您無法將他人試卷設定為下一個活動測驗試卷！'
          });
        }
        nextExam.ownerId = (libMatch && libMatch.ownerId) ? libMatch.ownerId : myId;
        nextExam.ownerName = (libMatch && libMatch.ownerName) ? libMatch.ownerName : currentSessionUser.displayName;
        nextExam.startedByUserId = myId;
        nextExam.startedByName = currentSessionUser.displayName;
        state.examData = nextExam;
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

function unsanitizeSheetCellGas(val) {
  const str = String(val || '').trim();
  // Low #5: 僅還原 sanitizeSheetCellGas 因公式注入防護而加上的前導單引號，保留使用者原本就以單引號開頭的名稱
  if (/^'[=+\-@\t\r\n]/.test(str)) {
    return str.substring(1);
  }
  return str;
}

function loadUsersFromSheet() {
  const { usersSheet } = ensureSheetsInitialized();
  const lastRow = usersSheet.getLastRow();
  if (lastRow <= 1) return [];
  const rows = usersSheet.getRange(2, 1, lastRow - 1, 16).getValues();
  const list = [];
  rows.forEach(r => {
    const uid = unsanitizeSheetCellGas(r[0]);
    const uname = unsanitizeSheetCellGas(r[1]);
    if (!uid && !uname) return;
    let bDate = '';
    if (r[3] instanceof Date) {
      bDate = Utilities.formatDate(r[3], Session.getScriptTimeZone() || 'GMT+8', 'yyyy-MM-dd');
    } else {
      bDate = unsanitizeSheetCellGas(r[3]);
    }
    list.push({
      userId: uid || ('usr_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12)),
      username: uname,
      displayName: unsanitizeSheetCellGas(r[2]),
      birthDate: bDate,
      organization: unsanitizeSheetCellGas(r[4]),
      email: unsanitizeSheetCellGas(r[5]).toLowerCase(),
      pwSalt: unsanitizeSheetCellGas(r[6]),
      pwHash: unsanitizeSheetCellGas(r[7]),
      role: unsanitizeSheetCellGas(r[8]) || 'examiner',
      status: unsanitizeSheetCellGas(r[9]) || 'pending_review',
      failCount: Number(r[10] || 0),
      lockedUntil: Number(r[11] || 0),
      createdAt: unsanitizeSheetCellGas(r[12]),
      approvedBy: unsanitizeSheetCellGas(r[13]),
      lastLoginAt: unsanitizeSheetCellGas(r[14]),
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

