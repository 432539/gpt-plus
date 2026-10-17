<template>
  <div class="email-page">
    <div class="page-header">
      <div class="toolbar">
        <input v-model.trim="keyword" class="input toolbar-search" placeholder="搜索母号 / 子号 / 备注" @keyup.enter="load" />
        <select v-model="statusFilter" class="input toolbar-select" @change="page = 1">
          <option value="">全部状态</option>
          <option value="未使用">未使用</option>
          <option value="已使用">已使用</option>
        </select>
        <button class="btn btn-ghost" @click="load">搜索</button>
        <div class="toolbar-spacer"></div>
        <button class="btn btn-ghost btn-danger" v-if="selectedSubs.length" @click="batchDeleteSubs">
          删除选中子号({{ selectedSubs.length }})
        </button>
        <button class="btn btn-ghost btn-danger" :disabled="!usedCount || batchBusy" @click="batchDeleteUsed">
          {{ batchBusy ? '处理中...' : `批量删除已使用${usedCount ? `(${usedCount})` : ''}` }}
        </button>
        <button class="btn btn-ghost btn-danger" :disabled="!all.length || batchBusy" @click="openClearDialog">清空全部</button>
        <button class="btn btn-ghost" @click="importDialog = true">批量导入</button>
        <button class="btn" @click="openCreate">新增邮箱</button>
      </div>
    </div>

    <div class="card flush email-card">
      <div class="email-board">
        <div class="email-head">
          <div class="c-check"></div>
          <div>邮箱地址</div>
          <div>类型</div>
          <div>密码</div>
          <div>状态</div>
          <div class="c-ops">操作</div>
        </div>
        <div v-if="!displayRows.length" class="email-empty">暂无邮箱数据,点击右上角新增或批量导入</div>
        <div
          v-for="d in displayRows"
          :key="d.row.id"
          class="email-row"
          :class="{ 'is-mother': d.kind === 'mother', 'is-child': d.kind === 'child' }"
        >
          <div class="c-check">
            <button v-if="d.kind === 'mother'" class="expander" type="button" @click="toggleExpand(d.row.id)">
              <span :class="{ open: expanded[d.row.id] }">▶</span>
            </button>
            <input v-else-if="d.kind === 'child'" type="checkbox" :value="d.row.id" v-model="selectedSubs" />
          </div>
          <div class="c-addr" :title="d.row.address">
            <span :class="{ 'child-addr': d.kind === 'child' }">{{ d.row.address }}</span>
          </div>
          <div class="c-type">
            <template v-if="d.kind === 'mother'">
              <span class="tag tag-blue">母号</span>
              <span class="child-count">{{ d.row.child_count }} 个子号</span>
            </template>
            <span v-else-if="d.kind === 'child'" class="tag tag-gray">子号</span>
            <span v-else class="tag tag-blue">{{ typeLabel(d.row.mailbox_type) }}</span>
          </div>
          <div class="c-pwd">
            <template v-if="d.kind === 'child'"><span class="muted">共用母号</span></template>
            <template v-else>
              <span class="pwd">{{ revealed[d.row.id] !== undefined ? (revealed[d.row.id] || '(空)') : '••••••' }}</span>
              <button class="btn btn-ghost btn-sm" type="button" @click="togglePwd(d.row)">
                {{ revealed[d.row.id] !== undefined ? '隐藏' : '查看' }}
              </button>
            </template>
          </div>
          <div class="c-status">
            <span v-if="d.kind === 'mother'" class="tag tag-green">正常</span>
            <span v-else class="tag" :class="d.row.status === '已使用' ? 'tag-orange' : 'tag-green'">
              {{ d.row.status === '已使用' ? '已使用' : '未使用' }}
            </span>
          </div>
          <div class="c-ops">
            <div class="row-actions">
              <template v-if="d.kind === 'mother'">
                <button class="btn btn-sm btn-ghost" type="button" @click="openMail(d.row)">收件</button>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="busy[d.row.id]" @click="syncMother(d.row)">同步</button>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="busy[d.row.id]" @click="pullMother(d.row)">拉满</button>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="busy[d.row.id]" @click="recycleMother(d.row)">回收已用</button>
                <button class="btn btn-sm btn-danger" type="button" @click="deleteMother(d.row)">删除母号</button>
              </template>
              <template v-else-if="d.kind === 'child'">
                <button class="btn btn-sm btn-ghost" type="button" @click="openMail(d.row)">收件</button>
                <button class="btn btn-sm btn-ghost" type="button" @click="toggleUsed(d.row)">
                  {{ d.row.status === '已使用' ? '标记未用' : '标记已用' }}
                </button>
                <button class="btn btn-sm btn-danger" type="button" @click="deleteSub(d.row)">删除</button>
              </template>
              <template v-else>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="testing[d.row.id]" @click="testReceive(d.row)">
                  {{ testing[d.row.id] ? '测试中' : '收件测试' }}
                </button>
                <button class="btn btn-sm btn-ghost" type="button" @click="openEdit(d.row)">编辑</button>
                <button class="btn btn-sm btn-danger" type="button" @click="removePlain(d.row)">删除</button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <div class="pagination">
        <div class="pagination-info">
          共 {{ topTotal }} 条{{ topTotal ? `,当前 ${rangeStart}-${rangeEnd}` : '' }}
        </div>
        <div class="pagination-actions">
          <label class="page-size">
            每页
            <select v-model.number="pageSize" class="input" style="width: 80px" @change="changePageSize">
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="200">200</option>
            </select>
            条
          </label>
          <div class="pagination-btns">
            <button class="page-btn" :disabled="page <= 1" @click="goPage(1)">首页</button>
            <button class="page-btn" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
            <span class="page-current">{{ page }} / {{ totalPages }}</span>
            <button class="page-btn" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
            <button class="page-btn" :disabled="page >= totalPages" @click="goPage(totalPages)">末页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增/编辑 -->
    <Modal :show="dialog" :title="form.id ? '编辑邮箱' : '新增邮箱'" :loading="saving" @close="dialog = false" @confirm="save">
      <div class="form-item">
        <label>邮箱地址 *</label>
        <input v-model.trim="form.address" class="input" placeholder="example@mail.com" />
      </div>
      <div class="form-item">
        <label>邮箱类型</label>
        <select v-model="form.mailbox_type" class="input">
          <option value="password">密码</option>
          <option value="mailcom">mail.com(母号)</option>
          <option value="url">取件链接</option>
          <option value="outlook">Outlook</option>
        </select>
      </div>
      <div class="form-item">
        <label>密码{{ form.id ? '(留空则不修改)' : '' }}</label>
        <input v-model="form.password" class="input" placeholder="邮箱密码" />
      </div>
      <div class="form-item" v-show="form.mailbox_type === 'url'">
        <label>取件链接</label>
        <input v-model.trim="form.fetch_url" class="input" placeholder="https://..." />
      </div>
      <div class="form-item">
        <label>备注</label>
        <input v-model="form.remark" class="input" placeholder="备注信息" />
      </div>
    </Modal>

    <!-- 批量导入 -->
    <Modal :show="importDialog" title="批量导入邮箱" :loading="importing" confirmText="开始导入" @close="importDialog = false" @confirm="doImport">
      <div class="form-item">
        <label>粘贴邮箱列表(每行一条)</label>
        <textarea v-model="importText" class="input" rows="9" placeholder="邮箱----密码（mail.com 母号）
邮箱----取件链接
邮箱----密码----client_id----refresh_token
也支持 JSON / CSV"></textarea>
      </div>
      <p class="hint">mail.com 母号导入后,点「同步」或「拉满」即可生成子号。导入按「个人设置 → 邮箱域名」过滤后缀。</p>
      <div v-if="importResult" class="import-result">
        成功 <b>{{ importResult.success }}</b> · 去重 {{ importResult.skipped }} · 域名过滤 {{ importResult.filtered }} · 共 {{ importResult.total }}
      </div>
    </Modal>

    <!-- 清空全部 -->
    <Modal :show="clearDialog" title="清空全部邮箱" :loading="batchBusy" danger confirmText="确认清空" @close="clearDialog = false" @confirm="doClearAll">
      <p class="clear-lead">将删除当前账号下的邮箱数据，此操作不可恢复。请选择清空范围：</p>
      <label class="choice" :class="{ on: !clearIncludeMothers }">
        <input type="radio" :value="false" v-model="clearIncludeMothers" />
        <span>
          <b>只清空子号和普通邮箱</b>
          <small>保留全部母号，仅删除子号别名与非母号邮箱</small>
        </span>
      </label>
      <label class="choice" :class="{ on: clearIncludeMothers }">
        <input type="radio" :value="true" v-model="clearIncludeMothers" />
        <span>
          <b>连同母号一起清空</b>
          <small>删除所有母号、子号和普通邮箱</small>
        </span>
      </label>
    </Modal>

    <!-- 邮件浮窗 -->
    <div v-if="mailViewer.open" class="modal-mask" @click.self="closeMail">
      <div class="modal mail-modal">
        <div class="modal-head">
          <div class="modal-title">收件箱 · {{ mailViewer.row?.address }}</div>
          <button class="modal-close" @click="closeMail">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="modal-body mail-body">
          <div class="mail-toolbar">
            <button class="btn btn-sm" :disabled="mailViewer.loading" @click="refreshInbox">
              {{ mailViewer.loading ? '收取中...' : '刷新收件' }}
            </button>
            <span class="muted" style="margin-left: 10px">历史 {{ mailViewer.mails.length }} 封</span>
          </div>
          <div class="mail-layout">
            <div class="mail-list">
              <div v-if="!mailViewer.mails.length" class="empty" style="padding: 30px 0">点「刷新收件」拉取</div>
              <div
                v-for="m in mailViewer.mails"
                :key="m.mail_uid"
                class="mail-item"
                :class="{ active: mailViewer.current?.mail_uid === m.mail_uid }"
                @click="openBody(m)"
              >
                <div class="mail-subject">{{ m.subject || '(无主题)' }}</div>
                <div class="mail-meta">{{ shortFrom(m.from_addr) }} · {{ formatExpiresAt(m.mail_date || m.fetched_at) }}</div>
              </div>
            </div>
            <div class="mail-detail">
              <div v-if="!mailViewer.current" class="muted" style="padding: 20px">选择左侧邮件查看正文</div>
              <template v-else>
                <div class="detail-subject">{{ mailViewer.current.subject || '(无主题)' }}</div>
                <div class="detail-meta">发件人:{{ shortFrom(mailViewer.current.from_addr) }}</div>
                <div class="detail-body" v-if="mailViewer.bodyLoading">正在加载正文...</div>
                <pre class="detail-body" v-else>{{ mailViewer.body || '(空正文)' }}</pre>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import api from '../api';
import Modal from '../components/Modal.vue';
import { toast } from '../utils/toast';
import { confirmDialog } from '../utils/confirm';
import { formatExpiresAt } from '../utils/datetime';

const LONG_TIMEOUT = 180000;

const all = ref([]);
const keyword = ref('');
const statusFilter = ref('');
const page = ref(1);
const pageSize = ref(10);
const revealed = reactive({});
const testing = reactive({});
const busy = reactive({});
const expanded = reactive({});
const selectedSubs = ref([]);
const batchBusy = ref(false);

const dialog = ref(false);
const saving = ref(false);
const importDialog = ref(false);
const importText = ref('');
const importing = ref(false);
const importResult = ref(null);
const clearDialog = ref(false);
const clearIncludeMothers = ref(false);

const emptyForm = () => ({ id: null, address: '', password: '', mailbox_type: 'password', fetch_url: '', remark: '' });
const form = reactive(emptyForm());

const mailViewer = reactive({ open: false, row: null, mails: [], current: null, body: '', loading: false, bodyLoading: false });

const TYPE_LABELS = { password: '密码', url: '取件链接', outlook: 'Outlook', mailcom: 'mail.com', unknown: '其他' };
const typeLabel = (t) => TYPE_LABELS[t] || t || '其他';
const shortFrom = (f) => String(f || '').replace(/[{}"]/g, '').slice(0, 40);

const usedCount = computed(() => all.value.filter((r) => !r.is_mother && r.status === '已使用').length);

function emailHit(row, q) {
  const needle = q.toLowerCase();
  return [row.address, row.remark, row.label, row.usage].some((v) => String(v || '').toLowerCase().includes(needle));
}

const keywordMatched = computed(() => {
  const q = keyword.value.trim();
  if (!q) return all.value;
  const matched = all.value.filter((r) => emailHit(r, q));
  const ids = new Set(matched.map((r) => r.id));
  const motherHits = new Set(matched.filter((r) => r.is_mother).map((r) => r.id));
  for (const r of matched) {
    if (r.mother_id) ids.add(r.mother_id);
  }
  for (const r of all.value) {
    if (r.mother_id && motherHits.has(r.mother_id)) ids.add(r.id);
  }
  return all.value.filter((r) => ids.has(r.id));
});

// 展开的展示行:母号 →(展开)子号,再普通邮箱
const visibleEmails = computed(() => {
  const source = keywordMatched.value;
  if (!statusFilter.value) return source;
  const wantUsed = statusFilter.value === '已使用';
  const keep = new Set();
  for (const r of source) {
    if (r.is_mother) continue;
    const used = r.status === '已使用';
    if (used === wantUsed) {
      keep.add(r.id);
      if (r.mother_id) keep.add(r.mother_id);
    }
  }
  return source.filter((r) => keep.has(r.id));
});

const topRows = computed(() => {
  const list = visibleEmails.value;
  const mothers = list.filter((r) => r.is_mother);
  const plains = list.filter((r) => !r.is_mother && !r.mother_id);
  return [
    ...mothers.map((row) => ({ row, kind: 'mother' })),
    ...plains.map((row) => ({ row, kind: 'plain' })),
  ];
});
const topTotal = computed(() => topRows.value.length);
const totalPages = computed(() => Math.max(1, Math.ceil(topTotal.value / pageSize.value)));
const rangeStart = computed(() => (topTotal.value ? (page.value - 1) * pageSize.value + 1 : 0));
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, topTotal.value));

const displayRows = computed(() => {
  const childrenByMother = {};
  for (const r of visibleEmails.value) {
    if (r.mother_id) (childrenByMother[r.mother_id] ||= []).push(r);
  }
  const start = (page.value - 1) * pageSize.value;
  const slice = topRows.value.slice(start, start + pageSize.value);
  const out = [];
  for (const item of slice) {
    out.push(item);
    if (item.kind === 'mother' && expanded[item.row.id]) {
      for (const c of childrenByMother[item.row.id] || []) out.push({ row: c, kind: 'child' });
    }
  }
  return out;
});

function goPage(n) {
  page.value = Math.min(totalPages.value, Math.max(1, n));
}
function changePageSize() {
  page.value = 1;
}

async function load() {
  try {
    all.value = await api.get('/emails');
    selectedSubs.value = [];
    Object.keys(revealed).forEach((k) => delete revealed[k]);
    if (page.value > Math.max(1, Math.ceil(topRows.value.length / pageSize.value))) page.value = 1;
  } catch (e) {
    toast.error(e.message);
  }
}

onMounted(() => {
  load();
});

watch(keyword, () => {
  page.value = 1;
});
watch([keyword, all], () => {
  const q = keyword.value.trim();
  if (!q) return;
  for (const r of all.value) {
    if (r.mother_id && emailHit(r, q)) expanded[r.mother_id] = true;
  }
});

function toggleExpand(id) {
  expanded[id] = !expanded[id];
}

async function togglePwd(row) {
  if (revealed[row.id] !== undefined) {
    delete revealed[row.id];
    return;
  }
  try {
    const { password } = await api.get(`/emails/${row.id}/password`);
    revealed[row.id] = password;
  } catch (e) {
    toast.error(e.message);
  }
}

async function withBusy(id, fn) {
  busy[id] = true;
  try {
    await fn();
  } catch (e) {
    toast.error(e.message);
  } finally {
    busy[id] = false;
  }
}

const syncMother = (row) =>
  withBusy(row.id, async () => {
    const r = await api.post(`/emails/${row.id}/sync`);
    toast.success(`同步完成:新增 ${r.added}、清理 ${r.pruned}`);
    load();
  });

const pullMother = (row) =>
  withBusy(row.id, async () => {
    const r = await api.post(`/emails/${row.id}/pull`);
    toast.success(`已拉取 ${r.added} 个子号${r.errors?.length ? ',部分失败' : ''}`);
    load();
  });

const recycleMother = (row) =>
  withBusy(row.id, async () => {
    const ok = await confirmDialog({
      title: '回收已使用子号',
      message: '回收该母号下所有「已使用」子号？',
      confirmText: '确认回收',
      danger: true,
    });
    if (!ok) return;
    const r = await api.post(`/emails/${row.id}/recycle`);
    toast.success(`已删除 ${r.deleted}、补充 ${r.added}`);
    load();
  });

async function deleteMother(row) {
  const ok = await confirmDialog({
    title: '删除母号',
    message: `确认手工删除母号 ${row.address}？\n将同时删除其 ${row.child_count} 个子号，且在 mail.com 上不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/emails/${row.id}`, { params: { force: 1 } });
    toast.success('母号已删除');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function toggleUsed(row) {
  try {
    await api.post(`/emails/${row.id}/used`, { used: row.status !== '已使用' });
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function deleteSub(row) {
  const ok = await confirmDialog({
    title: '删除子号',
    message: `删除子号 ${row.address}？将同时在 mail.com 上删除别名。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.post('/emails/batch-delete-subs', { ids: [row.id] });
    if (r.deleted) toast.success('子号已删除');
    else toast.error(r.errors?.[0] || '删除失败');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function batchDeleteSubs() {
  const ok = await confirmDialog({
    title: '批量删除子号',
    message: `确认删除选中的 ${selectedSubs.value.length} 个子号？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.post('/emails/batch-delete-subs', { ids: selectedSubs.value });
    toast.success(`已删除 ${r.deleted} 个子号${r.errors?.length ? ',部分失败' : ''}`);
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function batchDeleteUsed() {
  if (!usedCount.value) return;
  const ok = await confirmDialog({
    title: '删除已使用邮箱',
    message: `确认删除全部 ${usedCount.value} 个「已使用」邮箱？\n母号不会删除，子号会同时在 mail.com 上删除别名。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  batchBusy.value = true;
  try {
    const r = await api.post('/emails/batch-delete-used', {}, { timeout: LONG_TIMEOUT });
    toast.success(`已删除 ${r.deleted} 条${r.errors?.length ? ',部分失败' : ''}`);
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    batchBusy.value = false;
  }
}

function openClearDialog() {
  clearIncludeMothers.value = false;
  clearDialog.value = true;
}

async function doClearAll() {
  batchBusy.value = true;
  try {
    const r = await api.post(
      '/emails/clear-all',
      { includeMothers: clearIncludeMothers.value },
      { timeout: LONG_TIMEOUT }
    );
    clearDialog.value = false;
    const parts = [`子号 ${r.children || 0}`, `普通邮箱 ${r.plains || 0}`];
    if (clearIncludeMothers.value) parts.push(`母号 ${r.mothers || 0}`);
    toast.success(`已清空 ${parts.join('、')}${r.errors?.length ? ',部分远端删除失败' : ''}`);
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    batchBusy.value = false;
  }
}

// ---- 邮件浮窗 ----
async function openMail(row) {
  mailViewer.open = true;
  mailViewer.row = row;
  mailViewer.mails = [];
  mailViewer.current = null;
  mailViewer.body = '';
  await loadHistory();
}
function closeMail() {
  mailViewer.open = false;
}
async function loadHistory() {
  try {
    mailViewer.mails = await api.get(`/emails/${mailViewer.row.id}/mails`);
  } catch (e) {
    toast.error(e.message);
  }
}
async function refreshInbox() {
  mailViewer.loading = true;
  try {
    const r = await api.get(`/emails/${mailViewer.row.id}/inbox`);
    toast.success(`收到 ${r.count} 封邮件`);
    await loadHistory();
  } catch (e) {
    toast.error(e.message);
  } finally {
    mailViewer.loading = false;
  }
}
async function openBody(m) {
  mailViewer.current = m;
  mailViewer.body = '';
  mailViewer.bodyLoading = true;
  try {
    const r = await api.get(`/emails/${mailViewer.row.id}/mail/${encodeURIComponent(m.mail_uid)}/body`);
    mailViewer.body = r.body;
  } catch (e) {
    mailViewer.body = '';
    toast.error(e.message);
  } finally {
    mailViewer.bodyLoading = false;
  }
}

// ---- 普通邮箱 ----
async function testReceive(row) {
  testing[row.id] = true;
  try {
    const r = await api.post(`/emails/${row.id}/test-receive`);
    if (r.ok) toast.success(r.message || '收件成功');
    else toast.error(r.message || '收件失败');
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    testing[row.id] = false;
  }
}

function openCreate() {
  Object.assign(form, emptyForm());
  dialog.value = true;
}
function openEdit(row) {
  Object.assign(form, {
    ...emptyForm(),
    id: row.id,
    address: row.address,
    mailbox_type: row.mailbox_type || 'password',
    fetch_url: row.fetch_url || '',
    remark: row.remark || '',
  });
  dialog.value = true;
}
async function save() {
  if (!form.address) return toast.error('邮箱地址不能为空');
  saving.value = true;
  try {
    if (form.id) await api.put(`/emails/${form.id}`, { ...form });
    else await api.post('/emails', { ...form });
    toast.success('已保存');
    dialog.value = false;
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}
async function removePlain(row) {
  const ok = await confirmDialog({
    title: '删除邮箱',
    message: `确定删除邮箱 ${row.address} 吗？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/emails/${row.id}`);
    toast.success('已删除');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}
async function doImport() {
  if (!importText.value.trim()) return toast.error('请粘贴邮箱列表');
  importing.value = true;
  importResult.value = null;
  try {
    const r = await api.post('/emails/batch-import', { text: importText.value });
    importResult.value = r;
    toast.success(`导入成功 ${r.success} 条`);
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    importing.value = false;
  }
}

</script>

<style scoped>
.email-page { width: 100%; min-width: 0; }
.toolbar-search { width: 200px; flex: 0 0 200px; }
.toolbar-select { width: auto; flex: 0 0 auto; }
.pwd { font-family: Consolas, monospace; font-size: 13px; }
.muted { color: var(--text-mute); font-size: 13px; }
.hint { font-size: 12px; color: var(--text-sub); margin: 6px 0 0; }
.import-result { margin-top: 14px; padding: 12px; background: var(--kb-lighter); border-radius: 8px; font-size: 13px; }

.email-card { width: 100%; min-width: 0; }
.email-board { width: 100%; min-width: 0; overflow-x: auto; }
.email-head,
.email-row {
  display: grid;
  grid-template-columns: 48px minmax(140px, 1fr) 168px 176px 96px minmax(420px, 2.2fr);
  align-items: center;
  width: 100%;
  min-width: 1080px;
  column-gap: 8px;
  padding: 0 18px;
  box-sizing: border-box;
}
.email-head {
  min-height: 44px;
  background: var(--bg);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 500;
  color: var(--ink-500);
  border-bottom: 1px solid var(--line);
}
.email-row {
  min-height: 56px;
  border-bottom: 1px solid var(--line-soft);
}
.email-row:hover { background: var(--klein-50); }
.email-row.is-mother { background: #fbfcff; font-weight: 500; }
.email-row.is-child { background: #fff; }
.email-empty { padding: 48px 16px; text-align: center; color: var(--ink-400); }
.c-check { display: flex; align-items: center; justify-content: center; }
.c-addr, .c-type, .c-pwd, .c-status, .c-ops { min-width: 0; }
.c-addr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
.c-pwd { display: flex; align-items: center; gap: 6px; }
.c-ops { justify-self: stretch; }
.row-actions { display: flex; flex-wrap: nowrap; gap: 6px; align-items: center; }
.row-actions .btn-sm { padding: 6px 10px; white-space: nowrap; }
.expander { border: none; background: transparent; cursor: pointer; color: var(--text-sub); font-size: 11px; padding: 4px; }
.expander span { display: inline-block; transition: transform 0.15s; }
.expander span.open { transform: rotate(90deg); }
.child-addr { color: var(--text-sub); padding-left: 12px; position: relative; }
.child-addr::before { content: "└"; position: absolute; left: -2px; color: var(--text-mute); }
.child-count { margin-left: 8px; font-size: 12px; color: var(--text-sub); }

.clear-lead { font-size: 14px; color: var(--ink-700); margin-bottom: 14px; line-height: 1.6; }
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 10px;
  cursor: pointer;
}
.choice.on { border-color: var(--klein-200); background: var(--klein-50); }
.choice b { display: block; font-size: 14px; color: var(--ink-900); }
.choice small { display: block; margin-top: 4px; color: var(--ink-500); font-size: 12px; line-height: 1.5; }
.choice input { margin-top: 3px; }

/* 邮件浮窗 */
.mail-modal { width: 860px; }
.mail-body { padding: 0; }
.mail-toolbar { padding: 14px 22px; border-bottom: 1px solid var(--border); display: flex; align-items: center; }
.mail-layout { display: grid; grid-template-columns: 300px 1fr; min-height: 380px; }
.mail-list { border-right: 1px solid var(--border); max-height: 460px; overflow-y: auto; }
.mail-item { padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
.mail-item:hover { background: var(--kb-soft); }
.mail-item.active { background: var(--kb-lighter); }
.mail-subject { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail-meta { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
.mail-detail { padding: 18px 22px; max-height: 460px; overflow-y: auto; }
.detail-subject { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.detail-meta { font-size: 12px; color: var(--text-sub); margin-bottom: 14px; }
.detail-body { font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
@media (max-width: 720px) {
  .mail-layout { grid-template-columns: 1fr; }
  .mail-list { max-height: 200px; }
  .toolbar-search, .toolbar-select { flex: 1 1 160px; width: auto; }
}
</style>
