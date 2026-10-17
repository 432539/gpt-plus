<template>
  <div class="logs-page">
    <div class="card flush logs-card">
      <div class="logs-head">
        <div class="tabs logs-tabs">
          <button
            v-for="t in tabs"
            :key="t.key"
            class="tab"
            :class="{ active: category === t.key }"
            @click="switchTab(t.key)"
          >
            {{ t.label }}
          </button>
        </div>
        <div class="logs-actions">
          <span v-if="runId" class="run-filter" :title="runId">当前任务 {{ runId.slice(0, 8) }}</span>
          <button v-if="runId" class="btn btn-ghost" @click="clearRunFilter">查看全部</button>
          <span class="muted">共 {{ total }} 条</span>
          <button class="btn btn-ghost" :disabled="loading" @click="load({ manual: true })">刷新</button>
          <button class="btn btn-ghost btn-danger" :disabled="!items.length" @click="clearLogs">一键清空</button>
        </div>
      </div>
      <div ref="logPanel" class="log-panel">
        <div v-if="loading && !items.length" class="log-placeholder">加载中...</div>
        <div v-else-if="!items.length" class="log-placeholder">{{ emptyHint }}</div>
        <div
          v-for="row in items"
          :key="row.id"
          class="log-line"
          :class="logLineClassNames(row)"
        >
          <span class="log-line__ts">{{ formatShanghaiDateTime(row.created_at, { seconds: true }) }}</span>
          <span class="log-line__lv">{{ logLevelText(row.level, category) }}</span>
          <span v-if="row.source" class="log-line__src">[{{ logSourceText(row.source, category) }}]</span>
          <span class="log-line__msg">{{ row.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../api';
import { toast } from '../utils/toast';
import { confirmDialog } from '../utils/confirm';
import {
  LOG_ROW_LIMIT,
  isNearLogBottom,
  mergeLogRows,
  nextLogScrollTop,
  sameLogRows,
  logLineClassNames,
  logLevelText,
  logSourceText,
} from '../utils/logRows';
import { logRouteState } from '../utils/accountProgress';
import { formatShanghaiDateTime } from '../utils/datetime';

const tabs = [
  { key: 'pull', label: '母号拉子号' },
  { key: 'register', label: '注册日志' },
  { key: 'oauth', label: '提链日志' },
  { key: 'activate', label: '开通日志' },
  { key: 'account', label: '账号检测 / 换绑' },
];

const EMPTY = {
  pull: '暂无拉子号日志。在邮箱管理点「拉满 / 同步 / 回收已用」后会记录在这里。',
  register: '暂无注册日志。注册任务运行后会显示在这里。',
  oauth: '暂无提链日志。GB PayPal 提链任务运行后会显示在这里。',
  activate: '暂无开通日志。账号支付/开通任务运行后会显示在这里。',
  account: '暂无账号检测、刷新或换绑日志。换绑记录带 [换绑] 标记。',
};

const route = useRoute();
const router = useRouter();
const synced = logRouteState(route.query, tabs);
const category = ref(synced.category);
const runId = ref(synced.runId);
const items = ref([]);
const total = ref(0);
const loading = ref(false);
const logPanel = ref(null);
let timer = null;
let requestVersion = 0;
let backgroundRefreshing = false;

const emptyHint = computed(() => EMPTY[category.value] || '暂无日志');

async function load({ background = false, manual = false } = {}) {
  if (background && backgroundRefreshing) return;
  if (background) backgroundRefreshing = true;
  else loading.value = true;
  const version = ++requestVersion;
  const requestedCategory = category.value;
  const requestedRunId = runId.value;
  const panel = logPanel.value;
  const wasNearBottom = !panel || isNearLogBottom(panel);
  const oldScrollTop = panel?.scrollTop || 0;
  try {
    const r = await api.get('/logs', {
      params: {
        category: requestedCategory,
        limit: LOG_ROW_LIMIT,
        run_id: requestedRunId || undefined,
      },
    });
    if (
      version !== requestVersion ||
      requestedCategory !== category.value ||
      requestedRunId !== runId.value
    ) return;
    const nextTotal = Number(r.total) || 0;
    total.value = nextTotal;
    const incoming = r.items || [];
    const nextItems = nextTotal === 0
      ? []
      : mergeLogRows(background ? items.value : [], incoming);
    if (!sameLogRows(items.value, nextItems)) {
      items.value = nextItems;
      await nextTick();
      if (panel) {
        panel.scrollTop = nextLogScrollTop({
          wasNearBottom: manual || !background || wasNearBottom,
          oldScrollTop,
          newScrollHeight: panel.scrollHeight,
        });
      }
    }
  } catch (e) {
    if (!background) toast.error(e.message);
  } finally {
    if (background) backgroundRefreshing = false;
    else loading.value = false;
  }
}

function refreshInBackground() {
  load({ background: true });
}

function clearRunFilter() {
  router.replace({ query: { ...route.query, run_id: undefined } });
}

function syncFromRoute() {
  const next = logRouteState(route.query, tabs);
  category.value = next.category;
  runId.value = next.runId;
}

function switchTab(key) {
  if (category.value === key && !runId.value) return;
  router.replace({ query: { ...route.query, tab: key, run_id: undefined } });
}

onMounted(() => {
  timer = setInterval(refreshInBackground, 3000);
});

watch(
  () => `${route.query.tab || ''}|${route.query.run_id || ''}`,
  () => {
    syncFromRoute();
    items.value = [];
    total.value = 0;
    requestVersion += 1;
    load();
  },
  { immediate: true },
);

async function clearLogs() {
  const label = tabs.find((t) => t.key === category.value)?.label || '当前日志';
  const ok = await confirmDialog({
    title: `清空${label}`,
    message: `确认清空「${label}」？此操作不可恢复。`,
    confirmText: '确认清空',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.post('/logs/clear', { category: category.value });
    requestVersion += 1;
    items.value = [];
    total.value = 0;
    toast.success(`已清空 ${r.deleted} 条`);
  } catch (e) {
    toast.error(e.message);
  }
}

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.logs-page {
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1 1 auto;
}
.logs-card {
  width: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}
.logs-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 18px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.logs-tabs {
  width: auto;
  max-width: 100%;
  flex: 1 1 620px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  overflow: visible;
  border: 0;
  background: transparent;
}
.logs-tabs .tab {
  flex: 1 1 118px;
  min-width: 118px;
  padding: 9px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.logs-actions {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}
.run-filter {
  color: #1d4ed8;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  padding: 5px 9px;
  font-size: 12px;
}
.log-panel {
  flex: 1 1 auto;
  min-height: 0;
  max-width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: #0b1020;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.75;
}
.log-placeholder { color: #7b849c; padding: 28px 4px; }
.log-line { display: flex; min-width: 0; gap: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.log-line__ts { color: #5b6580; flex: 0 0 auto; }
.log-line__lv { flex: 0 0 44px; text-transform: uppercase; }
.log-line__src { color: #7dd3fc; flex: 0 0 auto; }
.log-line__msg { color: #c7d0e0; min-width: 0; }
.log-line--info .log-line__lv { color: #38bdf8; }
.log-line--success .log-line__lv { color: #4ade80; }
.log-line--success .log-line__msg { color: #86efac; }
.log-line--warning .log-line__lv,
.log-line--warning .log-line__msg { color: #fbbf24; }
.log-line--error .log-line__lv,
.log-line--error .log-line__msg { color: #f87171; }
.log-line--congrats .log-line__lv,
.log-line--congrats .log-line__msg {
  color: #fbbf24;
  font-weight: 700;
}
@media (max-width: 760px) {
  .logs-actions { width: 100%; margin-left: 0; }
  .logs-head { padding: 8px; }
  .log-panel { padding: 9px 10px; }
  .log-line { display: grid; grid-template-columns: auto 44px 1fr; gap: 2px 8px; }
  .log-line__msg { grid-column: 1 / -1; }
}
</style>
