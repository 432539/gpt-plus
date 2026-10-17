<template>
  <div class="syncs-page">
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">已同步普通</div>
        <div class="value">{{ summary.regular_count }}</div>
        <div class="sub">提链次数用尽 / 没试用 传送</div>
      </div>
      <div class="stat-card">
        <div class="label">已同步 PLUS</div>
        <div class="value">{{ summary.plus_count }}</div>
        <div class="sub">nvtokens 自动上架</div>
      </div>
      <div class="stat-card good">
        <div class="label">PLUS 成交额合计</div>
        <div class="value" style="font-size: 22px">¥{{ summary.plus_amount_yuan }}</div>
        <div class="sub">有价格的上架记录</div>
      </div>
    </div>

    <div class="card flush">
      <div class="card-head syncs-head">
        <div class="tabs">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="tab"
            :class="{ active: kind === tab.key }"
            type="button"
            @click="switchKind(tab.key)"
          >
            {{ tab.label }}
          </button>
        </div>
        <button class="btn btn-ghost" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>邮箱</th>
              <th>类型</th>
              <th>原因 / 价格</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="muted">{{ formatExpiresAt(row.synced_at) }}</td>
              <td class="cell-name">{{ row.email }}</td>
              <td>
                <span class="tag" :class="row.kind === 'plus' ? 'tag-plus' : 'tag-gray'">
                  {{ row.kind_label }}
                </span>
              </td>
              <td>{{ detailText(row) }}</td>
              <td>
                <span class="tag" :class="row.remote_ok ? 'tag-green' : 'tag-red'">{{ row.status }}</span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="5" class="empty">{{ emptyHint }}</td>
            </tr>
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
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '../api';
import { toast } from '../utils/toast';
import { formatExpiresAt } from '../utils/datetime';

const tabs = [
  { key: 'regular', label: '已同步普通' },
  { key: 'plus', label: '已同步PLUS' },
];

const kind = ref('regular');
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const summary = ref({
  regular_count: 0,
  plus_count: 0,
  plus_amount: 0,
  plus_amount_yuan: '0.00',
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const rangeStart = computed(() => (total.value ? (page.value - 1) * pageSize.value + 1 : 0));
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, total.value));
const emptyHint = computed(() => (
  kind.value === 'plus' ? '暂无已上架 PLUS 记录' : '暂无已传送普通号记录'
));

function detailText(row) {
  if (row.kind === 'plus') {
    const price = row.price_yuan ? `¥${row.price_yuan}` : '';
    return [row.reason, price].filter(Boolean).join(' · ') || '—';
  }
  return row.reason || '—';
}

async function load() {
  loading.value = true;
  try {
    const data = await api.get('/syncs', {
      params: { kind: kind.value, page: page.value, page_size: pageSize.value },
    });
    if (data.total > 0 && page.value > Math.ceil(data.total / pageSize.value)) {
      page.value = Math.ceil(data.total / pageSize.value);
      loading.value = false;
      return load();
    }
    rows.value = data.items || [];
    total.value = data.total || 0;
    if (data.summary) summary.value = data.summary;
  } catch (error) {
    toast.error(error.message);
  } finally {
    loading.value = false;
  }
}

function switchKind(next) {
  kind.value = next;
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

onMounted(load);
</script>

<style scoped>
.syncs-page { display: flex; flex-direction: column; gap: 18px; }
.syncs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 24px;
  margin: 0;
}
</style>
