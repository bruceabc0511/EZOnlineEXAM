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

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'getExamState';

    if (action === 'ping') {
      ensureSheetsInitialized();
      return jsonResponse({
        status: 'success',
        message: 'Google 試算表雲端測驗資料庫與自動寄信服務運作正常！',
        hasExamLibrarySupport: true,
        version: '2026-11-10-v2-exam-library',
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'getExamState') {
      const state = loadCloudState();
      return jsonResponse({
        status: 'success',
        examData: state.examData,
        submissions: state.submissions,
        historySessions: state.historySessions,
        examLibrary: state.examLibrary,
        updatedAt: state.updatedAt
      });
    }

    return jsonResponse({ status: 'error', message: '未知的 GET action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawBody);
    const action = payload.action || '';

    const state = loadCloudState();

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
        stateSheet.getRange('A5:B5').setValues([['UPDATED_AT', new Date().toISOString()]]);
      }
      return jsonResponse({
        status: 'success',
        message: '試卷庫已同步至雲端',
        examLibrary: state.examLibrary
      });
    }

    // 2. 考生提交試卷 (多人併發安全追加)
    if (action === 'submitExam') {
      const record = payload.record;
      if (!record || !record.studentId) {
        return jsonResponse({ status: 'error', message: '缺少考生作答資料' });
      }

      // 檢查當前場次是否已有相同學號 (不區分大小寫)
      const existsIdx = state.submissions.findIndex(
        s => String(s.studentId).toLowerCase() === String(record.studentId).toLowerCase()
      );
      if (existsIdx !== -1) {
        return jsonResponse({
          status: 'duplicate',
          message: '此學號已於本場次完成交卷',
          existingRecord: state.submissions[existsIdx]
        });
      }

      state.submissions.unshift(record);
      saveCloudState(state);
      syncCurrentScoresSheet(state.examData, state.submissions);

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
          const subject = `【測驗成績通知】${sub.examTitle || examInfo.title || '線上筆試測驗'} - ${sub.studentName} (${sub.studentId})`;
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
          <strong>${escapeHtmlStr(sub.studentName)}</strong>（學號／座號：<strong>${escapeHtmlStr(sub.studentId)}</strong>）您好，您的筆試測驗成績結果如下：
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
      '學號', '考生姓名', '電子郵件 (Email)', '總分', '答對題數', '總題數', '作答耗時', '防作弊警告', '交卷狀態', '交卷時間'
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

function loadCloudState() {
  const { stateSheet, librarySheet } = ensureSheetsInitialized();
  const rows = stateSheet.getRange('A2:B5').getValues();
  const map = {};
  rows.forEach(r => {
    map[String(r[0]).trim()] = r[1];
  });

  let examData = null;
  let submissions = [];
  let historySessions = [];

  try {
    if (map.EXAM_DATA) examData = JSON.parse(map.EXAM_DATA);
  } catch (e) {}
  try {
    if (map.SUBMISSIONS) submissions = JSON.parse(map.SUBMISSIONS);
  } catch (e) {}
  try {
    if (map.HISTORY_SESSIONS) historySessions = JSON.parse(map.HISTORY_SESSIONS);
  } catch (e) {}

  let examLibrary = loadExamLibraryFromSheet(librarySheet);
  // 若試卷庫工作表尚無試卷資料但 EXAM_DATA 有資料，自動無痛遷移為第一筆試卷
  if (examLibrary.length === 0 && examData && Array.isArray(examData.questions)) {
    const initialExam = {
      id: examData.id || ('exam_' + Date.now()),
      title: examData.title || '預設試卷',
      examDate: examData.examDate || '',
      durationMinutes: examData.durationMinutes !== '' ? examData.durationMinutes : 60,
      questions: examData.questions,
      updatedAt: new Date().toISOString()
    };
    examLibrary = [initialExam];
    syncExamLibrarySheet(librarySheet, examLibrary);
  }

  return {
    examData: examData,
    submissions: Array.isArray(submissions) ? submissions : [],
    historySessions: Array.isArray(historySessions) ? historySessions : [],
    examLibrary: examLibrary,
    updatedAt: map.UPDATED_AT || ''
  };
}

function saveCloudState(state) {
  const { stateSheet, librarySheet } = ensureSheetsInitialized();
  const nowIso = new Date().toISOString();
  stateSheet.getRange('A2:B5').setValues([
    ['EXAM_DATA', state.examData ? JSON.stringify(state.examData) : ''],
    ['SUBMISSIONS', JSON.stringify(state.submissions || [])],
    ['HISTORY_SESSIONS', JSON.stringify(state.historySessions || [])],
    ['UPDATED_AT', nowIso]
  ]);

  if (Array.isArray(state.examLibrary)) {
    syncExamLibrarySheet(librarySheet, state.examLibrary);
  }
}

function syncCurrentScoresSheet(examData, submissions) {
  const { scoreSheet } = ensureSheetsInitialized();
  scoreSheet.clearContents();

  const headers = [
    '學號', '考生姓名', '電子郵件 (Email)', '總分', '答對題數', '總題數', '作答耗時', '防作弊警告', '交卷狀態', '交卷時間', '成績信寄送時間'
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

