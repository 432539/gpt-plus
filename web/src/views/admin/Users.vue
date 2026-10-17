<template>
  <div>
    <div class="page-header">
      <div class="toolbar" style="width: 100%">
        <input
          v-model.trim="keyword"
          class="input"
          style="width: 200px"
          placeholder="搜索用户名"
          @keyup.enter="search"
        />
        <button class="btn btn-ghost" @click="search">搜索</button>
        <button class="btn" @click="openCreate">新增用户</button>
      </div>
    </div>

    <div class="card flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th><th>用户名</th><th>角色</th><th>等级</th><th>套餐</th>
              <th>套餐到期</th><th>账号/邮箱</th><th>状态</th><th>创建时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in rows" :key="u.id">
              <td>{{ u.id }}</td>
              <td><b>{{ u.username }}</b></td>
              <td>
                <span class="tag" :class="u.role === 'admin' ? 'tag-blue' : 'tag-gray'">
                  {{ u.role === 'admin' ? '管理员' : '用户' }}
                </span>
              </td>
              <td>Lv.{{ u.level }}</td>
              <td>{{ u.plan_name || '—' }}</td>
              <td>{{ formatShanghaiDate(u.plan_expires_at) }}</td>
              <td>{{ u.account_count }} / {{ u.email_count }}</td>
              <td>
                <span class="tag" :class="u.status === 1 ? 'tag-green' : 'tag-red'">
                  {{ u.status === 1 ? '启用' : '禁用' }}
                </span>
              </td>
              <td>{{ formatShanghaiDate(u.created_at) }}</td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openEdit(u)">编辑</button>
                <button class="btn btn-ghost btn-sm" @click="openReset(u)">重置密码</button>
                <button class="btn btn-ghost btn-sm" @click="toggleStatus(u)">
                  {{ u.status === 1 ? '禁用' : '启用' }}
                </button>
                <button class="btn btn-danger btn-sm" @click="remove(u)">删除</button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="10" class="empty">暂无用户</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <div class="pagination-info">
          共 {{ total }} 条{{ total ? `,当前 ${rangeStart}-${rangeEnd}` : '' }}
        </div>
        <div class="pagination-actions">
          <label class="page-size">
            每页
            <select v-model.number="pageSize" class="input" style="width: 80px" @change="changePageSize">
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
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

    <!-- 新增 / 编辑用户 -->
    <Modal :show="dialog" :title="form.id ? `编辑用户:${form.username}` : '新增用户'" :loading="saving" @close="dialog = false" @confirm="save">
      <div class="form-item" v-if="!form.id">
        <label>用户名 *</label>
        <input v-model.trim="form.username" class="input" placeholder="登录用户名" />
      </div>
      <div class="form-item" v-if="!form.id">
        <label>初始密码 *(至少 6 位)</label>
        <input v-model="form.password" class="input" placeholder="初始登录密码" />
      </div>
      <div class="form-item">
        <label>角色</label>
        <select v-model="form.role" class="input">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      <div class="form-item">
        <label>用户等级</label>
        <input v-model.number="form.level" type="number" min="1" max="99" class="input" />
      </div>
      <div class="form-item">
        <label>套餐(变更套餐将按套餐时长重新计算到期时间)</label>
        <select v-model="form.plan_id" class="input">
          <option :value="null">不分配套餐</option>
          <option v-for="p in plans" :key="p.id" :value="p.id">
            {{ p.name }}(账号{{ p.max_accounts }}/邮箱{{ p.max_emails }}/{{ p.duration_days }}天)
          </option>
        </select>
      </div>
      <div class="form-item" v-if="form.id">
        <label>套餐到期时间(可手动调整)</label>
        <input v-model="form.plan_expires_at" type="datetime-local" class="input" />
      </div>
    </Modal>

    <!-- 重置密码 -->
    <Modal :show="resetDialog" :title="`重置密码:${resetTarget?.username}`" :loading="saving" @close="resetDialog = false" @confirm="doReset">
      <div class="form-item">
        <label>新密码(至少 6 位)</label>
        <input v-model="resetPassword" class="input" placeholder="输入新密码" />
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import api from '../../api';
import Modal from '../../components/Modal.vue';
import { toast } from '../../utils/toast';
import { confirmDialog } from '../../utils/confirm';
import { formatShanghaiDate, fromExpiresInput, toExpiresInput } from '../../utils/datetime';

const rows = ref([]);
const plans = ref([]);
const keyword = ref('');
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const dialog = ref(false);
const saving = ref(false);
const form = reactive({ id: null, username: '', password: '', role: 'user', level: 1, plan_id: null, plan_expires_at: '' });
const editExpiresOriginal = ref('');

const resetDialog = ref(false);
const resetTarget = ref(null);
const resetPassword = ref('');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const rangeStart = computed(() => (total.value ? (page.value - 1) * pageSize.value + 1 : 0));
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, total.value));

async function load() {
  try {
    const data = await api.get('/admin/users', {
      params: { keyword: keyword.value, page: page.value, page_size: pageSize.value },
    });
    if (data.total > 0 && page.value > Math.ceil(data.total / pageSize.value)) {
      page.value = Math.ceil(data.total / pageSize.value);
      return load();
    }
    rows.value = data.items;
    total.value = data.total;
  } catch (e) {
    toast.error(e.message);
  }
}

function search() {
  page.value = 1;
  load();
}

function changePageSize() {
  page.value = 1;
  load();
}

function goPage(nextPage) {
  page.value = nextPage;
  load();
}

async function loadPlans() {
  try {
    const data = await api.get('/admin/plans', { params: { page_size: 200 } });
    plans.value = data.items;
  } catch (e) {
    toast.error(e.message);
  }
}

function openCreate() {
  Object.assign(form, { id: null, username: '', password: '', role: 'user', level: 1, plan_id: null, plan_expires_at: '' });
  editExpiresOriginal.value = '';
  dialog.value = true;
}

function openEdit(u) {
  Object.assign(form, {
    id: u.id,
    username: u.username,
    password: '',
    role: u.role,
    level: u.level,
    plan_id: u.plan_id || null,
    plan_expires_at: toExpiresInput(u.plan_expires_at),
  });
  editExpiresOriginal.value = u.plan_expires_at || '';
  dialog.value = true;
}

async function save() {
  saving.value = true;
  try {
    if (form.id) {
      await api.put(`/admin/users/${form.id}`, {
        role: form.role,
        level: form.level,
        plan_id: form.plan_id,
        plan_expires_at: fromExpiresInput(form.plan_expires_at, editExpiresOriginal.value),
      });
      toast.success('已保存');
    } else {
      if (!form.username || !form.password) throw new Error('用户名和密码不能为空');
      await api.post('/admin/users', {
        username: form.username,
        password: form.password,
        role: form.role,
        level: form.level,
        plan_id: form.plan_id,
      });
      toast.success('用户已创建');
    }
    dialog.value = false;
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

function openReset(u) {
  resetTarget.value = u;
  resetPassword.value = '';
  resetDialog.value = true;
}

async function doReset() {
  if (!resetPassword.value || resetPassword.value.length < 6) return toast.error('新密码长度至少 6 位');
  saving.value = true;
  try {
    await api.post(`/admin/users/${resetTarget.value.id}/reset-password`, { password: resetPassword.value });
    toast.success('密码已重置');
    resetDialog.value = false;
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(u) {
  try {
    await api.put(`/admin/users/${u.id}`, { status: u.status === 1 ? 0 : 1 });
    toast.success(u.status === 1 ? '已禁用' : '已启用');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function remove(u) {
  const ok = await confirmDialog({
    title: '删除用户',
    message: `确定删除用户 ${u.username} 吗？该用户的所有账号和邮箱数据将一并删除。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/admin/users/${u.id}`);
    toast.success('已删除');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

onMounted(() => {
  load();
  loadPlans();
});
</script>

<style scoped>
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
