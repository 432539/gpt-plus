<template>
  <div class="stats-page">
    <div class="page-header">
      <div>
        <div class="card-title" style="margin: 0">邮箱域名成功率</div>
        <p class="hint">按邮箱后缀汇总注册、试用资格与支付结果。注册成功率来自注册任务终态，试用与支付来自已入库账号。</p>
      </div>
      <button class="btn btn-ghost" :disabled="loading" @click="load">{{ loading ? '刷新中' : '刷新' }}</button>
    </div>

    <div class="card flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>邮箱域名</th>
              <th>注册</th>
              <th>注册成功率</th>
              <th>试用</th>
              <th>试用成功率</th>
              <th>已支付 / 账号</th>
              <th>支付成功率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!items.length && !loading">
              <td colspan="7" class="empty">暂无域名数据。完成注册后会按邮箱后缀出现在这里。</td>
            </tr>
            <tr v-for="row in items" :key="row.suffix">
              <td class="mono">{{ row.suffix }}</td>
              <td>{{ row.register_success }} / {{ row.register_total }}</td>
              <td>
                <span class="rate" :class="rateClass(row.register_rate)">{{ formatRate(row.register_rate) }}</span>
              </td>
              <td>{{ row.trial_yes }} / {{ row.trial_detected }}</td>
              <td>
                <span class="rate" :class="rateClass(row.trial_rate)">{{ formatRate(row.trial_rate) }}</span>
              </td>
              <td>{{ row.paid_count }} / {{ row.account_count }}</td>
              <td>
                <span class="rate" :class="rateClass(row.pay_rate)">{{ formatRate(row.pay_rate) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '../api';
import { toast } from '../utils/toast';

const items = ref([]);
const loading = ref(false);

function formatRate(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(1)}%`;
}

function rateClass(value) {
  if (value == null) return '';
  if (value >= 60) return 'good';
  if (value >= 30) return 'mid';
  return 'bad';
}

async function load() {
  loading.value = true;
  try {
    const data = await api.get('/domain-stats');
    items.value = data.items || [];
  } catch (error) {
    toast.error(error.message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.stats-page { width: 100%; min-width: 0; }
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.hint { margin: 8px 0 0; font-size: 12px; color: var(--ink-500); line-height: 1.6; max-width: 720px; }
.table-wrap { overflow: auto; }
.mono { font-family: var(--mono); }
.empty { text-align: center; color: var(--ink-400); padding: 28px 12px; }
.rate { font-weight: 600; }
.rate.good { color: var(--good, #0f7b3a); }
.rate.mid { color: var(--warn, #b45309); }
.rate.bad { color: var(--bad, #b42318); }
</style>
