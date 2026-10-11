'use strict';
/**
 * Client gọi ris-api + quy trình automation 7 bước hoàn toàn bằng REST:
 *  1) Lấy worklist ca Chờ chụp (Scheduled)
 *  2) Tiếp nhận ca chụp  -> POST /study/{id}/device/{deviceId}
 *  3) Xác nhận ca chụp   -> PUT  /study/{id}/complete
 *  4) Xem ca đọc         -> GET  /study/{id} (+ /report/me)
 *  5) Khóa ca            -> PUT  /study/{id}/lock {isLocked:true}
 *  6) Lưu nháp mô tả/kết luận -> POST /study/{id}/report/draft
 *  7) Duyệt kết quả      -> POST /study/{id}/report/approve
 * Mapping endpoint khớp 1-1 với frontend PACS-AI (bundle index-DXMOtbjm.js).
 */
const API = 'https://ris-api.bvmathanoi.sotamed.ai:8443';

// Chỉ làm việc với các ca đã gán máy Siêu âm CS1 (lọc cứng theo device.id).
const CS1_ULTRASOUND_DEVICE_ID = '01a0fd54-4b68-7a58-8489-3d023e5064ca';
const CS1_ULTRASOUND_DEVICE_NAME = 'CS1 - Máy siêu âm mắt';

const DEFAULT_DESCRIPTION = '.';
const DEFAULT_CONCLUSION = 'dịch kính vẩn đục không bong võng mạc';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDiagnosticContent(description, conclusion) {
  return `<p><strong>Mô tả</strong></p><p>${escHtml(description)}</p>` +
    `<p><strong>Kết luận</strong></p><p>${escHtml(conclusion)}</p>`;
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { for (const x of v) q.append(k, x); continue; }
    q.append(k, v);
  }
  const s = q.toString();
  return s ? '?' + s : '';
}

async function api(token, method, path, { query = null, body = undefined } = {}) {
  const url = API + path + qs(query);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
  if (!res.ok) {
    const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || text.slice(0, 300) || ('HTTP ' + res.status);
    const err = new Error(`${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  if (json && json.isSuccess === false) {
    const msg = (json.errors && json.errors[0] && json.errors[0].message) || 'API báo thất bại';
    const err = new Error(`${method} ${path}: ${msg}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json ? json.data : null;
}

const get = (t, p, q) => api(t, 'GET', p, { query: q });
const post = (t, p, b) => api(t, 'POST', p, { body: b });
const put = (t, p, b) => api(t, 'PUT', p, { body: b });

function lastDaysRangeUTC(n = 3) {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const from = new Date(to.getTime() - (n - 1) * 24 * 3600 * 1000);
  from.setUTCHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

const IMG_STATUS_VI = { Scheduled: 'chờ chụp', InProgress: 'đang chụp', Completed: 'đã chụp', Cancelled: 'đã hủy' };
const READ_STATUS_VI = { NotImaged: 'chưa đọc', Scheduled: 'chờ đọc', InProgress: 'đang đọc', WaitForSign: 'chờ ký', Completed: 'đã ký', Approved: 'đã duyệt', Cancelled: 'đã hủy' };

function matchSmart(item, q) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  // Mỗi token phải khớp trong CÙNG một nhóm trường (tránh nhiễu xuyên trường).
  const groups = [
    // Tên bệnh nhân: khớp đầu từ (gõ "nguyen van" ra đúng người họ Nguyễn Văn)
    { text: norm(item.patient && item.patient.fullName), prefix: true },
    // Mã: khớp chuỗi con
    { text: norm([item.order && item.order.orderNumber, item.order && item.order.alternateVisitId, item.patient && item.patient.patientId].join(' ')) },
    // Dịch vụ / máy / phòng
    { text: norm([item.procedure && item.procedure.name, item.procedure && item.procedure.code, item.device && item.device.name, item.room && item.room.name, item.modality].join(' ')) },
    // Trạng thái (cả tiếng Anh gốc lẫn tiếng Việt hiển thị)
    { text: norm([item.imageStatus, IMG_STATUS_VI[item.imageStatus] || '', item.readStatus, READ_STATUS_VI[item.readStatus] || ''].join(' ')) },
    // Mô tả yêu cầu
    { text: norm(item.description) },
  ];
  return groups.some((g) => {
    if (!g.text) return false;
    if (g.prefix) {
      const words = g.text.split(/\s+/);
      return tokens.every((t) => words.some((w) => w.startsWith(t)));
    }
    return tokens.every((t) => g.text.includes(t));
  });
}

async function getWorklist(token, { page = 1, pageSize = 100, days = 3, onlyCS1 = true, q = '' } = {}) {
  const { from, to } = lastDaysRangeUTC(days);
  // Lọc máy theo đúng cách web thật làm: ModalityIds=<id thiết bị> (server-side).
  const baseQuery = {
    Page: 1, PageSize: 100, OrderDateFrom: from, OrderDateTo: to,
    ...(onlyCS1 ? { ModalityIds: [CS1_ULTRASOUND_DEVICE_ID] } : {}),
  };
  let items;
  if (q && q.trim()) {
    // Search: tải đủ các trang (tối đa 1000 ca) rồi lọc thông minh phía app.
    items = [];
    let total = Infinity;
    let p = 1;
    while (items.length < total && p <= 10) {
      const data = await get(token, '/study/image', { ...baseQuery, Page: p });
      const totalItems = (data && data.totalItems) || 0;
      total = totalItems;
      items = items.concat((data && data.items) || []);
      if (!data || !(data.items || []).length) break;
      p++;
    }
    items = items.filter((s) => matchSmart(s, q));
  } else {
    const data = await get(token, '/study/image', { ...baseQuery, Page: page, PageSize: pageSize });
    items = (data && data.items) || [];
    return { items, totalItems: (data && data.totalItems) || items.length, onlyCS1, from, to };
  }
  const totalItems = items.length;
  const sliced = items.slice((page - 1) * pageSize, page * pageSize);
  return { items: sliced, totalItems, onlyCS1, from, to };
}

async function getStudy(token, id) {
  return get(token, `/study/${id}`);
}

async function pickDevice(token, study, { onlyCS1 = true } = {}) {
  if (study.device && study.device.id) {
    if (onlyCS1 && study.device.id !== CS1_ULTRASOUND_DEVICE_ID) {
      throw new Error('Ca đã gán máy khác (' + (study.device.name || study.device.id) + '), không phải Siêu âm CS1');
    }
    return { id: study.device.id, name: study.device.name, roomId: (study.room && study.room.id) || null, preset: true };
  }
  const procedureId = study.procedure && study.procedure.id;
  if (!procedureId) throw new Error('Ca chụp thiếu procedureId, không chọn được thiết bị');
  const data = await get(token, '/device', { ProcedureId: procedureId, IsActive: true, ExcludeRoom: true });
  const items = ((data && data.items) || []).filter((d) => d.isActive !== false);
  if (!items.length) throw new Error('Không có thiết bị phù hợp với dịch vụ "' + ((study.procedure && study.procedure.name) || '') + '"');
  if (onlyCS1) {
    const dev = items.find((d) => d.id === CS1_ULTRASOUND_DEVICE_ID);
    if (!dev) throw new Error('Dịch vụ "' + ((study.procedure && study.procedure.name) || '') + '" không chụp được ở máy Siêu âm CS1');
    return { id: dev.id, name: dev.name, roomId: (dev.room && dev.room.id) || null, preset: false };
  }
  const dev = items[0];
  return { id: dev.id, name: dev.name, roomId: (dev.room && dev.room.id) || null, preset: false };
}

function lockOwner(detail) {
  return (detail && detail.lockedByUser) || null;
}

function lockedByOther(detail, meId) {
  const o = lockOwner(detail);
  return !!(detail && detail.isLocked && o && o.id && o.id !== meId);
}

// Ném lỗi rõ ràng khi ca bị người khác giữ khóa (server khi đó thường trả 500 chung chung).
function lockStolenError(detail) {
  const o = lockOwner(detail);
  return new Error('Ca đang bị khóa bởi ' + ((o && o.fullName) || (o && o.id) || 'người khác') + ', không thể ghi. Hãy thử lại sau.');
}

function nonPdfImageUrls(study) {
  const atts = (study && study.attachments) || [];
  return atts
    .filter((a) => !String((a && a.fileName) || '').toLowerCase().endsWith('.pdf'))
    .map((a) => a.fileUrl || a.url || null)
    .filter(Boolean);
}

/**
 * Chạy trọn quy trình cho 1 ca. Trả về { study, steps[] }.
 * dryRun=true: chỉ đọc + chọn thiết bị, không ghi gì lên server.
 */
async function runAutomation(token, user, opts = {}) {
  const {
    studyId = null,
    description = DEFAULT_DESCRIPTION,
    conclusion = DEFAULT_CONCLUSION,
    confirmOverlap = false,
    dryRun = false,
    onlyCS1 = true,
  } = opts;
  const steps = [];
  const push = (key, label, status, detail) => {
    steps.push({ key, label, status, detail: detail === undefined ? null : detail });
  };

  // 1. Worklist
  let study = null;
  if (studyId) {
    study = await getStudy(token, studyId);
    push('worklist', 'Lấy thông tin ca chụp', 'ok', { id: study.id });
  } else {
    const wl = await getWorklist(token, { onlyCS1 });
    const items = (wl && wl.items) || [];
    study = items.find((s) => s.imageStatus === 'Scheduled') || null;
    if (!study) throw Object.assign(new Error(onlyCS1 ? 'Không còn ca Chờ chụp nào cho máy Siêu âm CS1 trong 3 ngày gần nhất' : 'Không còn ca Chờ chụp (Scheduled) nào trong 3 ngày gần nhất'), { steps });
    push('worklist', 'Lấy worklist CS1, chọn ca Chờ chụp đầu tiên', 'ok', {
      id: study.id,
      orderNumber: study.order && study.order.orderNumber,
      patient: study.patient && study.patient.fullName,
      procedure: study.procedure && study.procedure.name,
      total: wl.totalItems,
    });
  }

  // 2. Tiếp nhận (chỉ khi Scheduled)
  let detail = await getStudy(token, study.id);
  let device = await pickDevice(token, detail, { onlyCS1 });
  push('device', 'Chọn thiết bị', 'ok', { id: device.id, name: device.name, preset: device.preset });
  if (detail.imageStatus === 'Scheduled') {
    if (dryRun) {
      push('receive', 'Tiếp nhận ca chụp (dry-run: bỏ qua)', 'skipped', { deviceId: device.id });
    } else {
      await post(token, `/study/${detail.id}/device/${device.id}`);
      detail = await getStudy(token, study.id);
      push('receive', 'Tiếp nhận ca chụp', 'ok', { imageStatus: detail.imageStatus });
    }
  } else {
    push('receive', 'Tiếp nhận ca chụp (đã nhận trước đó)', 'skipped', { imageStatus: detail.imageStatus });
  }

  // 3. Xác nhận ca chụp (chỉ khi InProgress)
  if (detail.imageStatus === 'InProgress') {
    if (dryRun) {
      push('complete', 'Xác nhận ca chụp (dry-run: bỏ qua)', 'skipped', null);
    } else {
      await put(token, `/study/${detail.id}/complete`);
      detail = await getStudy(token, study.id);
      push('complete', 'Xác nhận ca chụp', 'ok', { imageStatus: detail.imageStatus });
    }
  } else {
    push('complete', 'Xác nhận ca chụp (không ở trạng thái Đang chụp)', 'skipped', { imageStatus: detail.imageStatus });
  }

  // 4. Xem ca đọc
  if (!dryRun && detail.imageStatus !== 'Completed') {
    detail = await getStudy(token, study.id);
  }
  if (detail.imageStatus !== 'Completed' && !dryRun) {
    throw Object.assign(new Error('Ca chưa sang trạng thái Đã chụp, dừng trước bước đọc'), { steps });
  }
  let myReports = [];
  try { myReports = (await get(token, `/study/${detail.id}/report/me`)) || []; } catch { myReports = []; }
  push('read', 'Xem ca đọc', 'ok', {
    imageStatus: detail.imageStatus,
    readStatus: detail.readStatus,
    reports: Array.isArray(myReports) ? myReports.length : 0,
  });

  // 5. Khóa ca
  const meId = user && user.sub;
  if (lockedByOther(detail, meId)) {
    throw Object.assign(lockStolenError(detail), { steps });
  }
  if (detail.isLocked && detail.lockedByUser && detail.lockedByUser.id === meId) {
    push('lock', 'Khóa ca (đã khóa bởi chính tôi)', 'skipped', null);
  } else if (dryRun) {
    push('lock', 'Khóa ca (dry-run: bỏ qua)', 'skipped', null);
  } else {
    await put(token, `/study/${detail.id}/lock`, { isLocked: true });
    detail = await getStudy(token, study.id);
    if (lockedByOther(detail, meId)) {
      throw Object.assign(lockStolenError(detail), { steps });
    }
    push('lock', 'Khóa ca', 'ok', { lockedBy: detail.lockedByUser && detail.lockedByUser.fullName });
  }

  // 6-7. Nháp + Duyệt
  const diagnosticContent = buildDiagnosticContent(description, conclusion);
  // Đã kiểm chứng: web thật gửi templateId/resultTemplateId=null cho ca mới.
  // Gửi procedure.defaultDocumentTemplateId vào resultTemplateId gây 500
  // "Không thể lưu thay đổi vào cơ sở dữ liệu".
  const templateId = null;
  const resultTemplateId = null;
  const imageUrls = nonPdfImageUrls(detail);
  push('payload', 'Dựng nội dung báo cáo', 'ok', {
    descriptionChars: String(description).length,
    conclusionChars: String(conclusion).length,
    templateId, resultTemplateId, imageCount: imageUrls.length,
  });

  if (dryRun) {
    push('draft', 'Lưu nháp (dry-run: bỏ qua)', 'skipped', null);
    push('sign', 'Hoàn thành ca chụp/ký (dry-run: bỏ qua)', 'skipped', null);
    push('overlap', 'Kiểm tra trùng ca (dry-run: bỏ qua)', 'skipped', null);
    push('approve', 'Duyệt kết quả (dry-run: bỏ qua)', 'skipped', null);
    return { study: { id: detail.id }, steps, dryRun: true };
  }

  const draftBody = { diagnosticContent, doctorAdvice: '', templateId, resultTemplateId, imageUrls };
  await assertMyLock();
  try {
    await post(token, `/study/${detail.id}/report/draft`, draftBody);
  } catch (e) {
    // Server hay trả 500 chung chung khi ca bị người khác giữ khóa hoặc lỗi DB nhất thời:
    // kiểm tra lại quyền khóa, retry 1 lần nếu vẫn là khóa của mình.
    const fresh = await getStudy(token, study.id).catch(() => null);
    if (fresh && lockedByOther(fresh, meId)) {
      throw Object.assign(lockStolenError(fresh), { steps });
    }
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await post(token, `/study/${detail.id}/report/draft`, draftBody);
      push('draft', 'Lưu nháp mô tả/kết luận (thành công sau retry)', 'ok', { retried: true });
    } catch (e2) {
      throw Object.assign(new Error('Lưu nháp thất bại: ' + e2.message), { steps });
    }
  }
  if (!steps.some((s) => s.key === 'draft')) {
    push('draft', 'Lưu nháp mô tả/kết luận', 'ok', null);
  }

  // Giờ chẩn đoán phải SAU giờ thực hiện (server so sánh tuyệt đối, bằng nhau cũng lỗi).
  const startedAt = new Date();
  const diagnosisAt = new Date(startedAt.getTime() + 60000);
  const startedAtIso = startedAt.toISOString();
  const diagnosisAtIso = diagnosisAt.toISOString();

  let technicianId = (detail.technician && detail.technician.id)
    || (detail.reportActionInfo && detail.reportActionInfo.technicianId) || null;
  if (!technicianId) {
    try {
      const techs = await get(token, '/user', { RoleType: 'Technician' });
      technicianId = (techs && techs.items && techs.items[0] && techs.items[0].id) || null;
    } catch { technicianId = null; }
  }
  const reportBody = {
    diagnosticContent,
    doctorAdvice: '',
    templateId,
    resultTemplateId,
    eSignUserId: meId,
    diagnosisAt: diagnosisAtIso,
    startedAt: startedAtIso,
    imageUrls,
    technicianId,
  };

  async function assertMyLock() {
    // Server tự mở khóa sau khi lưu nháp, nên phải đảm bảo khóa ngay trước mỗi bước ghi.
    let fresh = await getStudy(token, study.id);
    if (lockedByOther(fresh, meId)) {
      throw Object.assign(lockStolenError(fresh), { steps });
    }
    const mine = fresh.isLocked && fresh.lockedByUser && fresh.lockedByUser.id === meId;
    if (!mine) {
      await put(token, `/study/${study.id}/lock`, { isLocked: true });
      fresh = await getStudy(token, study.id);
      if (lockedByOther(fresh, meId)) {
        throw Object.assign(lockStolenError(fresh), { steps });
      }
      const stillMine = fresh.isLocked && fresh.lockedByUser && fresh.lockedByUser.id === meId;
      if (!stillMine) {
        throw Object.assign(new Error('Khóa ca thất bại, không thể tiếp tục ghi'), { steps });
      }
    }
    detail = fresh;
  }

  // 7. Hoàn thành ca chụp (ký): tạo báo cáo đã ký. Bắt buộc trước khi duyệt.
  await assertMyLock();
  if (detail.reportActionInfo && detail.reportActionInfo.isSigned) {
    push('sign', 'Hoàn thành ca chụp (đã ký trước đó)', 'skipped', null);
  } else {
    const signed = await post(token, `/study/${detail.id}/report`, reportBody).catch(async (e) => {
      throw Object.assign(new Error('Hoàn thành ca chụp (ký) thất bại: ' + e.message), { steps });
    });
    push('sign', 'Hoàn thành ca chụp (ký)', 'ok', signed && signed.reportId ? { reportId: signed.reportId } : null);
  }

  const overlapBody = {
    patientId: detail.patient && detail.patient.id,
    studyId: detail.id,
    endTime: diagnosisAtIso,
    startTime: startedAtIso,
    eSignUserId: meId,
  };
  let overlap = null;
  try {
    overlap = await post(token, '/study/check-overlap', overlapBody);
  } catch (e) {
    push('overlap', 'Kiểm tra trùng ca (lỗi, vẫn tiếp tục theo cấu hình)', 'warning', { error: e.message });
  }
  if (overlap && overlap.hasOverlap && !confirmOverlap) {
    throw Object.assign(new Error('Phát hiện ca trùng giờ, cần xác nhận confirmOverlap=true để duyệt'), { steps, overlap });
  }
  push('overlap', 'Kiểm tra trùng ca', 'ok', { hasOverlap: !!(overlap && overlap.hasOverlap) });

  // Kiểm tra lại quyền khóa ngay trước khi duyệt (tránh gọi khi ca đã bị người khác giữ).
  await assertMyLock();

  const approveBody = { ...reportBody };
  const approved = await post(token, `/study/${detail.id}/report/approve`, approveBody).catch(async (e) => {
    // Kiểm tra lại quyền khóa trước khi báo lỗi (tránh 500 chung chung của server).
    const fresh = await getStudy(token, study.id).catch(() => null);
    if (fresh && lockedByOther(fresh, meId)) {
      throw Object.assign(lockStolenError(fresh), { steps });
    }
    throw Object.assign(new Error('Duyệt kết quả thất bại: ' + e.message), { steps });
  });
  push('approve', 'Duyệt kết quả', 'ok', approved && approved.id ? { reportId: approved.id } : null);

  return { study: { id: detail.id }, steps, dryRun: false };
}

module.exports = {
  api, get, post, put,
  getWorklist, getStudy, pickDevice, runAutomation,
  DEFAULT_DESCRIPTION, DEFAULT_CONCLUSION,
  CS1_ULTRASOUND_DEVICE_ID, CS1_ULTRASOUND_DEVICE_NAME,
};
