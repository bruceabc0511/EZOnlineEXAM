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
 * ============================================================================
 */

const SHEET_NAMES = {
  STATE: '系統狀態資料庫',
  CURRENT_SCORES: '當前考生成績',
  HISTORY_LOG: '歷次測驗紀錄',
  EXAM_LIBRARY: '試卷庫資料'
};

// 考題圖片專用 Google 雲端硬碟資料夾 ID
const EXAM_IMAGE_FOLDER_ID = '11vY2bQE-3G_gwrcanjCeCJMYjPbnYYrl';

/**
 * 首次使用考題圖片上傳時，請在 Apps Script 編輯器上方函式選單中選擇此「testDriveAuthorization」
 * 並點選「執行」，Google 會彈出授權視窗，點擊「核對權限」->「進階」->「前往... (不安全)」->「允許」即可完成雲端硬碟授權！
 */
function testDriveAuthorization() {
  const folder = DriveApp.getFolderById(EXAM_IMAGE_FOLDER_ID);
  Logger.log('✅ Google Drive 雲端硬碟權限授權成功！目標資料夾名稱：' + folder.getName());
}

/**
 * 考官身份驗證輔助函式 (比對 Salt + SHA-256 雜湊值)
 */
function isExaminerAuthorized(token, state) {
  if (!token || typeof token !== 'string') return false;
  const cleanToken = token.trim().toLowerCase();
  const validHash = (state && state.examinerPinHash)
    ? String(state.examinerPinHash).trim().toLowerCase()
    : '391f59f4ca8480648b504098e96bffa16f970d261a5cacea40fe5e7789c3f961'; // 預設 PIN 9999 的雜湊
  return cleanToken === validHash;
}

/**
 * 管理員金鑰後端驗證 (Salt + SHA-256，與前端 ADMIN_KEY_HASH 相同演算法)
 */
const ADMIN_KEY_SALT_GAS = 'HD_EXAM_ADMIN_SALT_2026';
const ADMIN_KEY_HASH_GAS = '4007531f25ed2a163a091d340f3fcb5d7bbabb98c22c65074d60152eec2c9b6a';

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function isAdminKeyValid(adminKey) {
  if (!adminKey || typeof adminKey !== 'string') return false;
  return sha256Hex(`${ADMIN_KEY_SALT_GAS}:${adminKey.trim()}`) === ADMIN_KEY_HASH_GAS;
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
      return jsonResponse({
        status: 'success',
        message: 'Google 試算表雲端測驗資料庫與自動寄信服務運作正常！',
        hasExamLibrarySupport: true,
        version: '2026-11-11-v3-security-perf',
        timestamp: new Date().toISOString()
      });
    }

    // 輕量化狀態輪詢 (只讀狀態工作表，不讀試卷庫，節省網路頻寬與 GAS 執行額度)
    if (action === 'checkState') {
      const map = readStateMapLight();
      let isOpen = false;
      try {
        const examStr = safeChunkRead(map, 'EXAM_DATA', '');
        if (examStr) isOpen = Boolean(JSON.parse(examStr).isExamOpen);
      } catch (err) {}
      return jsonResponse({
        status: 'success',
        isExamOpen: isOpen,
        updatedAt: map.UPDATED_AT || ''
      });
    }

    // 開考前檢查 Email 是否已於本場次交卷 (僅回傳是否存在與交卷時間，不回傳任何成績內容)
    if (action === 'checkEmail') {
      const email = String((e.parameter && e.parameter.email) || '').trim().toLowerCase();
      const map = readStateMapLight();
      let found = null;
      try {
        const subs = JSON.parse(safeChunkRead(map, 'SUBMISSIONS', '[]') || '[]');
        if (email) {
          found = subs.find(s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === email) || null;
        }
      } catch (err) {}
      return jsonResponse({
        status: 'success',
        exists: Boolean(found),
        submittedAt: found ? (found.submittedAt || '') : ''
      });
    }

    if (action === 'getExamState') {
      const state = loadCloudState();
      const token = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
      const isAuth = isExaminerAuthorized(token, state);

      if (isAuth) {
        // 考官端授權檢視：回傳完整題庫（含標準答案）、所有考生成績與歷史紀錄
        return jsonResponse({
          status: 'success',
          isExaminer: true,
          examData: state.examData,
          submissions: state.submissions,
          historySessions: state.historySessions,
          examLibrary: state.examLibrary,
          updatedAt: state.updatedAt
        });
      } else {
        // 考生端安全模式：剔除標準答案 (q.answer)，且不外洩其他考生之姓名、Email 與成績紀錄
        let sanitizedExamData = null;
        if (state.examData) {
          sanitizedExamData = Object.assign({}, state.examData);
          if (Array.isArray(sanitizedExamData.questions)) {
            sanitizedExamData.questions = sanitizedExamData.questions.map(q => {
              const safeQ = Object.assign({}, q);
              delete safeQ.answer; // 刪除正解欄位，防範考生查看 Network/F12 窺探答案
              return safeQ;
            });
          }
        }
        return jsonResponse({
          status: 'success',
          isExaminer: false,
          examData: sanitizedExamData,
          submissionsCount: (state.submissions || []).length,
          submissions: null, // 隱匿所有已交卷考生成績與個資 (設為 null 避免覆蓋本機快取)
          historySessions: null,
          examLibrary: null,
          updatedAt: state.updatedAt
        });
      }
    }

    return jsonResponse({ status: 'error', message: '未知的 GET action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
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

    // 考官 PIN 驗證 (登入時向雲端核對，支援多裝置一致；含失敗次數限流防暴力破解)
    if (action === 'verifyExaminer') {
      const cache = CacheService.getScriptCache();
      const failCount = Number(cache.get('PIN_FAIL_COUNT') || 0);
      if (failCount >= 10) {
        return jsonResponse({ status: 'locked', message: 'PIN 碼錯誤次數過多，雲端已暫時鎖定 5 分鐘' });
      }
      if (isExaminerAuthorized(payload.authPinHash, state)) {
        cache.remove('PIN_FAIL_COUNT');
        return jsonResponse({ status: 'success' });
      }
      cache.put('PIN_FAIL_COUNT', String(failCount + 1), 300);
      return jsonResponse({ status: 'unauthorized', message: 'PIN 碼錯誤' });
    }

    // 變更 / 重設考官 PIN (需目前 PIN 雜湊或管理員金鑰其一驗證)
    if (action === 'updateExaminerPin') {
      const newHash = String(payload.newPinHash || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(newHash)) {
        return jsonResponse({ status: 'error', message: '新 PIN 雜湊格式不正確' });
      }
      const byPin = isExaminerAuthorized(payload.authPinHash, state);
      const byAdmin = isAdminKeyValid(payload.adminKey);
      if (!byPin && !byAdmin) {
        return jsonResponse({ status: 'unauthorized', message: '管理員金鑰或目前 PIN 驗證失敗' });
      }
      state.examinerPinHash = newHash;
      saveCloudState(state);
      return jsonResponse({ status: 'success', message: '雲端考官 PIN 已更新' });
    }

    // 檢查考官權限 (除了考生交卷 submitExam 以外，所有後台管理操作均需驗證考官 PIN 雜湊)
    const examinerActions = [
      'saveExamData', 'saveExamLibrary', 'syncSubmissions',
      'archiveSession', 'syncHistory', 'sendScoreEmails', 'uploadQuestionImage'
    ];

    if (examinerActions.indexOf(action) !== -1) {
      if (!isExaminerAuthorized(payload.authPinHash, state)) {
        return jsonResponse({
          status: 'unauthorized',
          message: '未經授權的考官操作，請確認考官 PIN 碼！'
        });
      }
    }

    // 1. 考官儲存題庫與試卷設定
    if (action === 'saveExamData') {
      if (payload.examData) {
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

    // 2. 考生提交試卷 (多人併發安全追加 + 後端客觀權威評分)
    if (action === 'submitExam') {
      const record = payload.record;
      if (!record || !record.studentEmail) {
        return jsonResponse({ status: 'error', message: '缺少考生作答資料或電子郵件' });
      }

      // 檢查當前場次是否已有相同電子郵件 (Email) (不區分大小寫)
      const existsIdx = state.submissions.findIndex(
        s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === String(record.studentEmail).trim().toLowerCase()
      );
      if (existsIdx !== -1) {
        // 不回傳既有紀錄內容，避免外洩他人作答與標準答案
        return jsonResponse({
          status: 'duplicate',
          message: '此電子郵件 (Email) 已於本場次完成交卷'
        });
      }

      // 測驗若已被考官結束作答，檢查交卷原因：僅接受考官結束測驗強制交卷、倒數結束交卷或防作弊強制交卷，阻絕過期的一般交卷
      const isExamOpen = state.examData && Boolean(state.examData.isExamOpen);
      if (!isExamOpen) {
        const statusText = String(record.status || '');
        const isForcedSubmission = statusText.includes('強制') || statusText.includes('考官結束') || statusText.includes('自動交卷');
        if (!isForcedSubmission) {
          return jsonResponse({
            status: 'closed',
            message: '考官已結束本次測驗作答，已停止接收交卷！'
          });
        }
      }

      // 後端依真實題庫客觀精準評分，徹底防範前端洩漏題目答案或遭竄改成績
      const examQuestions = (state.examData && Array.isArray(state.examData.questions)) ? state.examData.questions : [];
      const totalQ = examQuestions.length;
      let correctCount = 0;
      const gradedAnswerDetails = {};
      const studentAnswers = record.answers || {};

      examQuestions.forEach(q => {
        const selected = (studentAnswers[q.id] !== undefined)
          ? studentAnswers[q.id]
          : (record.answerDetails && record.answerDetails[q.id] ? record.answerDetails[q.id].selected : '');
        const cleanSelected = (selected === '未作答' || !selected) ? '' : String(selected).trim().toUpperCase();
        const cleanCorrect = String(q.answer || '').trim().toUpperCase();
        const isCorrect = cleanSelected !== '' && cleanCorrect !== '' && cleanSelected === cleanCorrect;
        if (isCorrect) correctCount++;
        gradedAnswerDetails[q.id] = {
          selected: selected || '未作答',
          correctAnswer: q.answer,
          isCorrect: isCorrect
        };
      });

      const rawScore = totalQ > 0 ? (correctCount / totalQ) * 100 : 0;
      record.score = Number(rawScore.toFixed(1));
      record.correctCount = correctCount;
      record.totalQuestions = totalQ;
      record.answerDetails = gradedAnswerDetails;

      state.submissions.unshift(record);
      saveCloudState(state);
      // 效能優化：使用 appendRow 追加，不再全量清空整張工作表重寫
      appendSubmissionToScoresSheet(state.examData, record);

      // 不回傳評分後的 record (內含標準答案)，避免交卷後考生取得答案外流給其他考生
      return jsonResponse({
        status: 'success',
        message: '交卷成功並已寫入雲端資料庫',
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

    // 6. 寄送考生成績單 Email (支援單筆或批次寄送)
    if (action === 'sendScoreEmails') {
      const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
      const examInfo = payload.examData || state.examData || {};
      const sessionId = payload.sessionId || 'CURRENT';

      if (recipients.length === 0) {
        return jsonResponse({ status: 'error', message: '沒有可寄送的考生 Email 名單' });
      }

      let sentCount = 0;
      const sentIds = [];
      const errors = [];
      const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

      recipients.forEach(sub => {
        if (!sub.studentEmail || !String(sub.studentEmail).includes('@')) {
          return;
        }
        try {
          const subject = `【測驗成績通知】${sub.examTitle || examInfo.title || '線上筆試測驗'} - ${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''}`;
          const htmlBody = buildScoreEmailHtml(sub, examInfo, state);

          MailApp.sendEmail({
            to: String(sub.studentEmail).trim(),
            subject: subject,
            htmlBody: htmlBody
          });

          sentCount++;
          sentIds.push(sub.id);
        } catch (mailErr) {
          errors.push(`${sub.studentName} (${sub.studentEmail}): ${mailErr.toString()}`);
        }
      });

      // 更新雲端狀態中的 emailSentAt 標記
      if (sentIds.length > 0) {
        if (sessionId === 'CURRENT') {
          state.submissions.forEach(s => {
            if (sentIds.indexOf(s.id) !== -1) {
              s.emailSentAt = nowStr;
            }
          });
          syncCurrentScoresSheet(state.examData, state.submissions);
        } else {
          const targetHist = state.historySessions.find(h => h.id === sessionId);
          if (targetHist && Array.isArray(targetHist.submissions)) {
            targetHist.submissions.forEach(s => {
              if (sentIds.indexOf(s.id) !== -1) {
                s.emailSentAt = nowStr;
              }
            });
          }
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

    // 7. 考題圖片上傳至 Google 雲端硬碟指定資料夾
    if (action === 'uploadQuestionImage') {
      const base64Data = payload.base64Data || '';
      const mimeType = payload.mimeType || 'image/png';
      const originalFileName = payload.fileName || `question_img_${Date.now()}.png`;

      if (!base64Data) {
        return jsonResponse({ status: 'error', message: '未收到圖片檔案資料' });
      }

      try {
        let folder;
        if (EXAM_IMAGE_FOLDER_ID) {
          folder = DriveApp.getFolderById(EXAM_IMAGE_FOLDER_ID);
        } else {
          folder = DriveApp.getRootFolder();
        }

        const decoded = Utilities.base64Decode(base64Data);
        const extMatch = originalFileName.match(/\.([a-zA-Z0-9]+)$/);
        const ext = extMatch ? extMatch[1] : 'png';
        const safeName = `exam_q_${Date.now()}_${Math.floor(Math.random()*1000)}.${ext}`;
        const blob = Utilities.newBlob(decoded, mimeType, safeName);
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
        return jsonResponse({
          status: 'error',
          message: '上傳圖片至雲端硬碟失敗: ' + uploadErr.toString()
        });
      }
    }

    return jsonResponse({ status: 'error', message: '未知的 POST action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 建立考生成績通知 HTML 信件內容 (含個人成績摘要與 5 欄式考生作答對錯明細，不含考題與標準答案)
 */
function extractStudentAnswersForGasEmail(sub, examInfo, state) {
  if (Array.isArray(sub.studentAnswers) && sub.studentAnswers.length > 0) {
    return sub.studentAnswers;
  }

  // 若前端未直接傳入 studentAnswers，可從 sub.answerDetails 或雲端資料庫中的交卷紀錄提取
  let details = sub.answerDetails || null;
  if (!details && state && Array.isArray(state.submissions)) {
    const found = state.submissions.find(s => s.id === sub.id);
    if (found && found.answerDetails) {
      details = found.answerDetails;
    }
  }
  if (!details && state && Array.isArray(state.historySessions)) {
    for (let i = 0; i < state.historySessions.length; i++) {
      const h = state.historySessions[i];
      if (h && Array.isArray(h.submissions)) {
        const found = h.submissions.find(s => s.id === sub.id);
        if (found && found.answerDetails) {
          details = found.answerDetails;
          break;
        }
      }
    }
  }

  if (!details) return [];

  const list = [];
  const total = Number(sub.totalQuestions) || Object.keys(details).length;
  for (let i = 1; i <= total; i++) {
    const d = details[i];
    list.push({
      qNum: i,
      selected: d && d.selected ? String(d.selected) : '-',
      isCorrect: Boolean(d && d.isCorrect)
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
        qNumCells += `<td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;font-size:15px;">${item.qNum}</td>`;
        const bg = item.isCorrect ? '#ccfbf1' : '#fca5a5';
        const fg = item.isCorrect ? '#0f172a' : '#7f1d1d';
        ansCells += `<td style="background:${bg};color:${fg};font-weight:700;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;font-size:16px;">${escapeHtmlStr(item.selected)}</td>`;
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
        <td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">考生答案</td>
        ${ansCells}
      </tr>
    `;
  }

  return `
    <div style="margin-top:18px;">
      <div style="margin-bottom:8px;">
        <span style="font-size:15px;font-weight:700;color:#005959;">📋 考生作答明細</span>
        <span style="font-size:12.5px;color:#475569;margin-left:14px;">
          <span style="display:inline-block;width:12px;height:12px;background:#ccfbf1;border:1px solid #005959;vertical-align:middle;margin-right:4px;"></span>答對
          <span style="display:inline-block;width:12px;height:12px;background:#fca5a5;border:1px solid #dc2626;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>答錯（紅底標記）
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
  if (sub && sub.customHtmlBody) {
    return sub.customHtmlBody;
  }

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
      exam.id || '',
      exam.title || '未命名試卷',
      examDateStr,
      exam.durationMinutes !== '' ? exam.durationMinutes : 60,
      Array.isArray(exam.questions) ? exam.questions.length : 0,
      exam.updatedAt || new Date().toISOString(),
      questionsJson
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
    headers.push(`第${idx + 1}題(正解:${q.answer})`);
  });
  if (headers.length > scoreSheet.getMaxColumns()) {
    scoreSheet.insertColumnsAfter(scoreSheet.getMaxColumns(), headers.length - scoreSheet.getMaxColumns());
  }
  scoreSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const row = [
    sub.studentId || '',
    sub.studentName || '',
    sub.studentEmail || '',
    sub.score ?? 0,
    sub.correctCount ?? 0,
    sub.totalQuestions ?? 0,
    sub.timeSpentFormatted || '',
    sub.warningCount ?? 0,
    sub.status || '',
    sub.submittedAt || '',
    sub.emailSentAt || '尚未寄送'
  ];
  questions.forEach(q => {
    const d = (sub.answerDetails && sub.answerDetails[q.id]) ? sub.answerDetails[q.id] : null;
    row.push(d ? d.selected : '未作答');
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
    headers.push(`第${idx + 1}題(正解:${q.answer})`);
  });

  const rows = [headers];
  (submissions || []).forEach(sub => {
    const row = [
      sub.studentId || '',
      sub.studentName || '',
      sub.studentEmail || '',
      sub.score ?? 0,
      sub.correctCount ?? 0,
      sub.totalQuestions ?? 0,
      sub.timeSpentFormatted || '',
      sub.warningCount ?? 0,
      sub.status || '',
      sub.submittedAt || '',
      sub.emailSentAt || '尚未寄送'
    ];
    questions.forEach(q => {
      const d = (sub.answerDetails && sub.answerDetails[q.id]) ? sub.answerDetails[q.id] : null;
      row.push(d ? d.selected : '未作答');
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
      h.id || '',
      h.examTitle || '',
      h.examDate || '',
      h.archivedAt || '',
      (h.submissions ? h.submissions.length : 0),
      st.mean ?? 0,
      st.median ?? 0,
      st.stdDev ?? 0,
      st.passRate ?? 0
    ]);
  });

  histSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
}

function escapeHtmlStr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

