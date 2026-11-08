/**
 * ============================================================================
 * 線上筆試測驗系統 - Google Apps Script 雲端資料庫與自動寄信後端 (Code.gs)
 * ============================================================================
 * 功能包含：
 * 1. 多人同時連線應試：集中儲存「當前開放題庫」、「當前場次考生成績」與「歷次測驗歷史紀錄」
 * 2. Google 試算表視覺化同步：自動建立並更新【系統狀態設定】、【當前考生成績】、【歷次測驗紀錄】工作表
 * 3. 自動寄送成績單 Email：透過 Google MailApp 寄送精美 HTML 考生成績與標準答案對照表
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
  HISTORY_LOG: '歷次測驗紀錄'
};

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'getExamState';

    if (action === 'ping') {
      ensureSheetsInitialized();
      return jsonResponse({
        status: 'success',
        message: 'Google 試算表雲端測驗資料庫與自動寄信服務運作正常！',
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
      saveCloudState(state);
      return jsonResponse({
        status: 'success',
        message: '題庫與試卷設定已同步至雲端',
        examData: state.examData
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
          const htmlBody = buildScoreEmailHtml(sub, examInfo);

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

    return jsonResponse({ status: 'error', message: '未知的 POST action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 建立考生成績通知 HTML 信件內容
 */
function buildScoreEmailHtml(sub, examInfo) {
  const questions = (examInfo && Array.isArray(examInfo.questions)) ? examInfo.questions : [];
  const scoreColor = Number(sub.score) >= 60 ? '#0f766e' : '#dc2626';
  const passBadge = Number(sub.score) >= 60 ? '及格' : '未達及格標準 (60分)';

  let detailRowsHtml = '';
  questions.forEach((q, idx) => {
    const detail = (sub.answerDetails && sub.answerDetails[q.id]) ? sub.answerDetails[q.id] : null;
    const picked = detail ? detail.selected : '未作答';
    const isCorrect = detail ? detail.isCorrect : false;
    const statusText = isCorrect
      ? '<span style="color:#0f766e;font-weight:bold;">✔ 答對</span>'
      : '<span style="color:#dc2626;font-weight:bold;">✘ 答錯</span>';

    detailRowsHtml += `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">第 ${idx + 1} 題</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtmlStr(q.question)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:bold;">${escapeHtmlStr(picked)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0f766e;font-weight:bold;">${escapeHtmlStr(q.answer)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">${statusText}</td>
      </tr>
    `;
  });

  return `
    <div style="font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:680px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#ffffff;">
      <div style="background:linear-gradient(135deg,#0f766e,#115e59);color:#ffffff;padding:20px 24px;">
        <div style="font-size:13px;opacity:0.9;">線上筆試測驗系統 — 成績通知單</div>
        <h2 style="margin:6px 0 0;font-size:20px;">${escapeHtmlStr(sub.examTitle || examInfo.title || '線上筆試測驗')}</h2>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 16px;font-size:15px;color:#334155;">
          <strong>${escapeHtmlStr(sub.studentName)}</strong>（學號／編號：<strong>${escapeHtmlStr(sub.studentId)}</strong>）您好，您的筆試測驗成績與作答明細如下：
        </p>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
          <div style="font-size:14px;color:#64748b;">測驗總分（滿分 100 分）</div>
          <div style="font-size:32px;font-weight:800;color:${scoreColor};margin:4px 0;">
            ${sub.score} <span style="font-size:16px;font-weight:600;">分（${passBadge}）</span>
          </div>
          <div style="font-size:13px;color:#475569;margin-top:8px;line-height:1.7;">
            • 答對題數：<strong>${sub.correctCount} / ${sub.totalQuestions} 題</strong><br>
            • 作答耗時：<strong>${escapeHtmlStr(sub.timeSpentFormatted || '-')}</strong><br>
            • 交卷狀態：<strong>${escapeHtmlStr(sub.status || '正常交卷')}</strong><br>
            • 交卷時間：<strong>${escapeHtmlStr(sub.submittedAt || '-')}</strong>
          </div>
        </div>

        ${detailRowsHtml ? `
        <h3 style="font-size:16px;color:#0f172a;margin:20px 0 10px;">📋 各題作答明細與標準答案</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;color:#1e293b;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;width:75px;">題號</th>
              <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:left;">題目內容</th>
              <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;width:75px;">您的答案</th>
              <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;width:75px;">標準答案</th>
              <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;width:75px;">結果</th>
            </tr>
          </thead>
          <tbody>
            ${detailRowsHtml}
          </tbody>
        </table>
        ` : ''}

        <p style="margin-top:24px;font-size:12px;color:#94a3b8;text-align:center;">
          本信件由「線上筆試測驗系統」自動發送。
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

  return { ss, stateSheet, scoreSheet, histSheet };
}

function loadCloudState() {
  const { stateSheet } = ensureSheetsInitialized();
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

  return {
    examData: examData,
    submissions: Array.isArray(submissions) ? submissions : [],
    historySessions: Array.isArray(historySessions) ? historySessions : [],
    updatedAt: map.UPDATED_AT || ''
  };
}

function saveCloudState(state) {
  const { stateSheet } = ensureSheetsInitialized();
  const nowIso = new Date().toISOString();
  stateSheet.getRange('A2:B5').setValues([
    ['EXAM_DATA', state.examData ? JSON.stringify(state.examData) : ''],
    ['SUBMISSIONS', JSON.stringify(state.submissions || [])],
    ['HISTORY_SESSIONS', JSON.stringify(state.historySessions || [])],
    ['UPDATED_AT', nowIso]
  ]);
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

