<template>
  <div>
    <div class="page-header">
      <div class="toolbar" style="width: 100%; justify-content: flex-end">
        <button class="btn" @click="openCreate">新增套餐</button>
      </div>
    </div>

    <div class="card flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th><th>套餐名称</th><th>等级</th><th>账号限额</th><th>邮箱限额</th>
              <th>时长(天)</th><th>使用人数</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in rows" :key="p.id">
              <td>{{ p.id }}</td>
              <td><b>{{ p.name }}</b></td>
              <td><span class="tag tag-blue">Lv.{{ p.level }}</span></td>
              <td>{{ p.max_accounts }}</td>
              <td>{{ p.max_emails }}</td>
              <td>{{ p.duration_days }}</td>
              <td>{{ p.user_count }}</td>
              <td>{{ p.remark || '—' }}</td>
              <td>
                <button class="btn btn-ghost btn-sm" @click="openEdit(p)">编辑</button>
                <button class="btn btn-danger btn-sm" style="margin-left: 6px" @click="remove(p)">删除</button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="9" class="empty">暂无套餐</td></tr>
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

    <Modal :show="dialog" :title="form.id ? '编辑套餐' : '新增套餐'" :loading="saving" @close="dialog = false" @confirm="save">
      <div class="form-item">
        <label>套餐名称 *</label>
        <input v-model.trim="form.name" class="input" placeholder="如:专业版" />
      </div>
      <div class="form-item">
        <label>套餐等级</label>
        <input v-model.number="form.level" type="number" min="1" max="99" class="input" />
      </div>
      <div class="form-item">
        <label>账号限额</label>
        <input v-model.number="form.max_accounts" type="number" min="1" class="input" />
      </div>
      <div class="form-item">
        <label>邮箱限额</label>
        <input v-model.number="form.max_emails" type="number" min="1" class="input" />
      </div>
      <div class="form-item">
        <label>套餐时长(天)</label>
        <input v-model.number="form.duration_days" type="number" min="1" class="input" />
      </div>
      <div class="form-item">
        <label>备注</label>
        <input v-model="form.remark" class="input" placeholder="备注信息" />
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

const rows = ref([]);
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const dialog = ref(false);
const saving = ref(false);
const form = reactive({ id: null, name: '', level: 1, max_accounts: 5, max_emails: 5, duration_days: 30, remark: '' });

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const rangeStart = computed(() => (total.value ? (page.value - 1) * pageSize.value + 1 : 0));
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, total.value));

async function load() {
  try {
    const data = await api.get('/admin/plans', {
      params: { page: page.value, page_size: pageSize.value },
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

function changePageSize() {
  page.value = 1;
  load();
}

function goPage(nextPage) {
  page.value = nextPage;
  load();
}

function openCreate() {
  Object.assign(form, { id: null, name: '', level: 1, max_accounts: 5, max_emails: 5, duration_days: 30, remark: '' });
  dialog.value = true;
}

function openEdit(p) {
  Object.assign(form, {
    id: p.id,
    name: p.name,
    level: p.level,
    max_accounts: p.max_accounts,
    max_emails: p.max_emails,
    duration_days: p.duration_days,
    remark: p.remark || '',
  });
  dialog.value = true;
}

async function save() {
  if (!form.name) return toast.error('套餐名称不能为空');
  saving.value = true;
  try {
    if (form.id) {
      await api.put(`/admin/plans/${form.id}`, { ...form });
      toast.success('已保存');
    } else {
      await api.post('/admin/plans', { ...form });
      toast.success('套餐已创建');
    }
    dialog.value = false;
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(p) {
  const ok = await confirmDialog({
    title: '删除套餐',
    message: `确定删除套餐「${p.name}」吗？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/admin/plans/${p.id}`);
    toast.success('已删除');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

onMounted(load);
</script>
