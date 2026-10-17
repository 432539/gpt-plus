<template>
  <div class="gem">
    <div class="dashboard-head">
      <div>
        <div class="eyebrow">独立监控页 · 不并入控制台</div>
        <h1>全球提链监控</h1>
        <p>按国家 / 支付方式探测通道。已接入通道会按计划真实提链，结果写入监控表，不改生产支付链。</p>
      </div>
      <div class="refresh-state">
        <span :class="['live-dot', { stale: Boolean(loadError) }]"></span>
        <span>{{ loadError || (lastAt ? `更新 ${formatClock(lastAt)}` : '正在加载') }}</span>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="load">
          {{ loading ? '刷新中' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="!overview && loading" class="card initial-state">
      <div class="loading-ring"></div>
      <div>
        <h2>正在加载全球提链</h2>
        <p>读取通道状态与探测计划…</p>
      </div>
    </div>

    <div v-if="loadError && overview" class="inline-alert warning">
      刷新失败，继续显示上次结果：{{ loadError }}
    </div>

    <section v-if="overview" class="inline-alert" :class="overview.plan?.enabled ? 'info' : 'warning'">
      {{ overview.engine?.label }} — {{ overview.engine?.note }}
    </section>

    <section v-if="overview" class="card plan-card">
      <div class="plan-copy">
        <h2>定时探测计划</h2>
        <p>
          打开后按间隔探测全部启用通道。间隔最少 5 分钟，并发 1–20（硬顶 20）。
          当前启用 {{ (plan.enabled_channels || []).length || overview.counts?.connected || 0 }} 路。
          上次 {{ formatExpiresAt(overview.plan?.last_run_at) }} · 下轮 {{ formatExpiresAt(overview.plan?.next_run_at) }}
        </p>
      </div>
      <div class="plan-controls">
        <button
          class="pipe-toggle"
          :class="{ on: plan.enabled }"
          type="button"
          :disabled="saving"
          @click="plan.enabled = !plan.enabled"
        >{{ plan.enabled ? '计划开启' : '计划关闭' }}</button>
        <label class="interval-field">
          <span>间隔</span>
          <input
            v-model.number="plan.interval_minutes"
            class="input"
            type="number"
            min="5"
            max="1440"
            step="5"
          />
          <span>分钟</span>
        </label>
        <label class="interval-field">
          <span>并发</span>
          <input
            v-model.number="plan.concurrency"
            class="input"
            type="number"
            min="1"
            max="20"
            step="1"
          />
        </label>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="saving" @click="enableAll">
          全部开启探测
        </button>
        <button class="btn btn-sm" type="button" :disabled="saving" @click="savePlan(false)">
          {{ saving ? '保存中' : '保存计划' }}
        </button>
      </div>
    </section>

    <section v-if="overview" class="inventory-grid">
      <article class="inventory-card good">
        <span>已落地通道</span>
        <strong>{{ overview.counts?.connected || 0 }}</strong>
        <small>PayPal 精选国 + 本地支付</small>
      </article>
      <article class="inventory-card">
        <span>明确不做</span>
        <strong>{{ (overview.unsupported || []).length || 0 }}</strong>
        <small>Klarna / Bancontact / 卡 / Bizum</small>
      </article>
      <article class="inventory-card" :class="overview.pool?.trial_total ? '' : 'warn'">
        <span>试用号</span>
        <strong>{{ overview.pool?.trial_total || 0 }}</strong>
        <small>可借 {{ overview.pool?.ready || 0 }} · 监控池 {{ overview.pool?.monitor_pool || 0 }}</small>
      </article>
      <article class="inventory-card" :class="overview.pool?.cliproxy_configured ? '' : 'bad'">
        <span>CliProxy 动态池</span>
        <strong>{{ overview.pool?.cliproxy_configured ? '已配置' : '未配置' }}</strong>
        <small>粘性 {{ overview.pool?.cliproxy_sticky_minutes || 30 }} 分钟 · 按通道改 region/sid</small>
      </article>
    </section>

    <section v-if="overview" class="card success-card">
      <div class="section-head">
        <div>
          <h2>成功提取列表</h2>
          <p>只显示探测成功记录，最近 {{ overview.successes?.length || 0 }} 条。不写生产支付链。</p>
        </div>
        <label class="interval-field">
          <span>通道</span>
          <select v-model="successFilter" class="input">
            <option value="all">全部</option>
            <option v-for="item in successChannelOptions" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>
      </div>
      <div v-if="filteredSuccesses.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>通道 / 国家</th>
              <th>方式</th>
              <th>账号</th>
              <th>结果主机</th>
              <th>出口</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredSuccesses" :key="`ok-${row.id}`">
              <td>{{ formatExpiresAt(row.finished_at || row.started_at) }}</td>
              <td class="cell-name">{{ row.country }} {{ row.country_name }}</td>
              <td>{{ row.method_label }}</td>
              <td>{{ row.account_email_mask || '—' }}</td>
              <td class="muted">{{ row.result_host || '—' }}</td>
              <td>{{ row.verified_exit || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="panel-foot">还没有成功探测记录。</p>
    </section>

    <section v-if="overview" class="section-block">
      <div class="section-head">
        <div>
          <h2>国家 / 方式状态</h2>
          <p>点卡片或表格行下钻。勾选后纳入计划。状态灯：成功 / 限流 / 风控 / 无试用号 / 无代理 / 待探测。</p>
        </div>
        <div class="family-pills">
          <button
            v-for="item in familyOptions"
            :key="item.key"
            type="button"
            class="pipe-toggle"
            :class="{ on: family === item.key }"
            @click="family = item.key"
          >{{ item.label }}</button>
        </div>
      </div>

      <div class="legend">
        <span v-for="item in statusLegend" :key="item.key">
          <i :class="['status-dot', item.key]"></i>{{ item.label }}
        </span>
      </div>

      <div class="board-grid">
        <div class="channel-grid">
          <button
            v-for="row in filteredChannels"
            :key="row.id"
            type="button"
            class="channel-card"
            :class="[row.status, { active: selectedId === row.id }]"
            @click="selectedId = row.id"
          >
            <span class="channel-top">
              <input
                class="channel-check"
                type="checkbox"
                :checked="isChannelEnabled(row.id)"
                @click.stop
                @change="toggleChannel(row.id, $event.target.checked)"
              />
              <i :class="['status-dot', row.status]"></i>
              <strong>{{ row.country }}</strong>
              <span class="tag" :class="statusTag(row.status)">{{ row.status_label }}</span>
            </span>
            <span class="channel-name">{{ row.country_name }} · {{ row.method_label }}</span>
            <small>{{ row.phase }}</small>
          </button>
        </div>

        <div class="card flush">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th></th>
                  <th>国家</th>
                  <th>方式</th>
                  <th>状态</th>
                  <th>最近</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredChannels"
                  :key="`row-${row.id}`"
                  :class="{ selected: selectedId === row.id }"
                  @click="selectedId = row.id"
                >
                  <td>
                    <input
                      type="checkbox"
                      :checked="isChannelEnabled(row.id)"
                      @click.stop
                      @change="toggleChannel(row.id, $event.target.checked)"
                    />
                  </td>
                  <td class="cell-name">{{ row.country }} {{ row.country_name }}</td>
                  <td>{{ row.method_label }}</td>
                  <td>
                    <span class="tag" :class="statusTag(row.status)">
                      <i :class="['status-dot', row.status]"></i>{{ row.status_label }}
                    </span>
                  </td>
                  <td class="muted">{{ formatExpiresAt(row.last_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section v-if="selected" class="card drill-card">
      <div class="card-head">
        <div>
          <h2>下钻 {{ selected.country }} {{ selected.country_name }} · {{ selected.method_label }}</h2>
          <p>{{ selected.phase }} · {{ selected.connected ? (isChannelEnabled(selected.id) ? '计划内探测' : '已接入未勾选') : '未接入' }}</p>
        </div>
        <span class="tag" :class="statusTag(selected.status)">{{ selected.status_label }}</span>
      </div>
      <p class="drill-detail">{{ selected.detail }}</p>
      <div class="key-value-grid">
        <div><span>校验出口</span><strong>{{ selected.verified_exit || '—' }}</strong></div>
        <div><span>错误类</span><strong>{{ selected.last_error_class || '—' }}</strong></div>
        <div><span>结果主机</span><strong>{{ selected.result_host || '—' }}</strong></div>
        <div><span>账号掩码</span><strong>{{ selected.account_email_mask || '—' }}</strong></div>
        <div><span>冷却至</span><strong>{{ formatExpiresAt(selected.cooldown_until) }}</strong></div>
        <div><span>与 GB 生产冲突</span><strong>{{ selected.production_conflict ? '是' : '否' }}</strong></div>
      </div>
      <div v-if="selected.recent_runs?.length" class="table-wrap recent-runs">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>状态</th>
              <th>错误类</th>
              <th>出口</th>
              <th>主机</th>
              <th>账号</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(run, index) in selected.recent_runs" :key="`${run.started_at}-${index}`">
              <td>{{ formatExpiresAt(run.finished_at || run.started_at) }}</td>
              <td>{{ statusLabel(run.status) }}</td>
              <td class="muted">{{ run.error_class || '—' }}</td>
              <td>{{ run.verified_exit || '—' }}</td>
              <td>{{ run.result_host || '—' }}</td>
              <td>{{ run.account_email_mask || '—' }}</td>
              <td>{{ formatDuration(run.duration_ms) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="panel-foot">
        本页不返回代理主机、用户名、密码、token 或完整支付 URL。Klarna / Bancontact / 卡 / Bizum 不做。
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../api';
import { formatClock, formatExpiresAt } from '../utils/datetime';
import { toast } from '../utils/toast';

const LIVE_INTERVAL = 5_000;

const overview = ref(null);
const loading = ref(false);
const saving = ref(false);
const loadError = ref('');
const lastAt = ref(null);
const family = ref('all');
const successFilter = ref('all');
const selectedId = ref('paypal_uk');
const plan = ref({ enabled: false, interval_minutes: 60, concurrency: 1, enabled_channels: [] });
let liveTimer;
let inFlight = false;

const familyOptions = [
  { key: 'all', label: '全部' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'local', label: '本地支付' },
];

const statusLegend = [
  { key: 'ok', label: '成功' },
  { key: 'rate', label: '限流' },
  { key: 'risk', label: '风控' },
  { key: 'no_trial', label: '无试用号' },
  { key: 'no_proxy', label: '无代理' },
  { key: 'idle', label: '待探测' },
];

const filteredChannels = computed(() => {
  const rows = overview.value?.channels || [];
  if (family.value === 'all') return rows;
  return rows.filter((row) => row.family === family.value);
});

const selected = computed(() => {
  const rows = overview.value?.channels || [];
  return rows.find((row) => row.id === selectedId.value) || rows[0] || null;
});

const successChannelOptions = computed(() => {
  const seen = new Map();
  for (const row of overview.value?.successes || []) {
    if (!seen.has(row.channel_id)) {
      seen.set(row.channel_id, {
        id: row.channel_id,
        label: `${row.country || ''} ${row.method_label || row.channel_id}`.trim(),
      });
    }
  }
  return [...seen.values()];
});

const filteredSuccesses = computed(() => {
  const rows = overview.value?.successes || [];
  if (successFilter.value === 'all') return rows;
  return rows.filter((row) => row.channel_id === successFilter.value);
});

function statusTag(status) {
  if (status === 'ok') return 'tag-green';
  if (status === 'rate' || status === 'no_trial') return 'tag-orange';
  if (status === 'risk' || status === 'no_proxy') return 'tag-red';
  return 'tag-gray';
}

function statusLabel(status) {
  return statusLegend.find((item) => item.key === status)?.label || status || '—';
}

function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function applyOverview(data) {
  overview.value = data;
  plan.value = {
    enabled: data.plan?.enabled === true,
    interval_minutes: Number(data.plan?.interval_minutes) || 60,
    concurrency: Number(data.plan?.concurrency) || 1,
    enabled_channels: Array.isArray(data.plan?.enabled_channels)
      ? data.plan.enabled_channels.slice()
      : (data.channels || []).filter((row) => row.connected).map((row) => row.id),
  };
  const ids = (data.channels || []).map((row) => row.id);
  if (!ids.includes(selectedId.value)) selectedId.value = ids[0] || '';
}

async function load(silent = false) {
  if (inFlight) return;
  inFlight = true;
  if (!silent) loading.value = true;
  try {
    const data = await api.get('/global-extract');
    applyOverview(data);
    loadError.value = '';
    lastAt.value = new Date();
  } catch (error) {
    loadError.value = error.message;
    if (!overview.value) toast.error(error.message);
  } finally {
    inFlight = false;
    loading.value = false;
  }
}

function connectedIds() {
  return (overview.value?.channels || []).filter((row) => row.connected).map((row) => row.id);
}

function isChannelEnabled(id) {
  const list = plan.value.enabled_channels;
  if (!Array.isArray(list) || !list.length) return true;
  return list.includes(id);
}

function toggleChannel(id, on) {
  const current = new Set(plan.value.enabled_channels?.length ? plan.value.enabled_channels : connectedIds());
  if (on) current.add(id);
  else current.delete(id);
  plan.value.enabled_channels = [...current];
}

async function enableAll() {
  plan.value.enabled = true;
  plan.value.enabled_channels = connectedIds();
  await savePlan(true);
}

async function savePlan(all = false) {
  saving.value = true;
  try {
    const data = await api.put('/global-extract/plan', {
      enabled: plan.value.enabled,
      interval_minutes: plan.value.interval_minutes,
      concurrency: plan.value.concurrency,
      enabled_channels: plan.value.enabled_channels,
      enable_all: all === true,
    });
    applyOverview(data);
    toast.success(data.message || '计划已保存');
  } catch (error) {
    toast.error(error.message);
  } finally {
    saving.value = false;
  }
}

function onVisibilityChange() {
  if (!document.hidden) load(true);
}

onMounted(() => {
  load();
  liveTimer = window.setInterval(() => {
    if (!document.hidden) load(true);
  }, LIVE_INTERVAL);
  document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
  window.clearInterval(liveTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<style scoped>
.gem { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.dashboard-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.dashboard-head h1 { font-size: 24px; letter-spacing: -0.02em; }
.dashboard-head p { color: var(--ink-500); margin-top: 5px; }
.eyebrow { color: var(--klein); font-size: 11px; font-weight: 700; letter-spacing: .1em; margin-bottom: 5px; }
.refresh-state { display: flex; align-items: center; gap: 8px; color: var(--ink-500); font-size: 12px; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 4px rgba(22,163,74,.12); }
.live-dot.stale { background: var(--warn); box-shadow: 0 0 0 4px rgba(217,138,0,.12); }
.initial-state { min-height: 180px; display: flex; align-items: center; justify-content: center; flex-direction: row; gap: 18px; }
.initial-state p { color: var(--ink-500); margin-top: 4px; }
.loading-ring { width: 30px; height: 30px; border: 3px solid var(--klein-100); border-top-color: var(--klein); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.inline-alert { padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.inline-alert.warning { background: var(--warn-bg); color: #8a5700; border: 1px solid #f1d79d; }
.inline-alert.info { background: var(--klein-50); color: var(--klein-deep); border: 1px solid var(--klein-100); }

.plan-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.plan-copy h2 { font-size: 16px; }
.plan-copy p { color: var(--ink-500); font-size: 12px; margin-top: 4px; max-width: 560px; }
.plan-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.interval-field { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-500); font-size: 13px; }
.interval-field .input { width: 88px; }
.interval-field select.input { width: 220px; }
.success-card { display: flex; flex-direction: column; gap: 12px; }
.success-card .section-head { margin-bottom: 0; }
.recent-runs { margin-top: 14px; }
.pipe-toggle {
  min-width: 52px;
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--ink-500);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}
.pipe-toggle:hover { border-color: var(--klein); color: var(--klein); }
.pipe-toggle.on { background: #ecfdf5; border-color: #86efac; color: #166534; }
.pipe-toggle:disabled { opacity: 0.55; cursor: not-allowed; }

.inventory-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.inventory-card { background: #fff; border: 1px solid var(--line); border-top: 3px solid var(--klein); border-radius: 11px; padding: 14px; box-shadow: var(--shadow-sm); min-width: 0; }
.inventory-card.good { border-top-color: var(--good); }
.inventory-card.warn { border-top-color: var(--warn); }
.inventory-card.bad { border-top-color: var(--bad); }
.inventory-card > span { display: block; color: var(--ink-500); font-size: 10.5px; }
.inventory-card > strong { display: block; color: var(--ink-900); font-size: 24px; margin: 3px 0 1px; }
.inventory-card > small { color: var(--ink-400); font-size: 9.5px; }

.section-block { display: flex; flex-direction: column; gap: 14px; }
.section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.section-head h2 { font-size: 17px; }
.section-head p { color: var(--ink-500); font-size: 12px; margin-top: 3px; }
.family-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--ink-500); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-300); display: inline-block; }
.status-dot.ok { background: var(--good); }
.status-dot.rate, .status-dot.no_trial { background: var(--warn); }
.status-dot.risk, .status-dot.no_proxy { background: var(--bad); }
.status-dot.idle { background: var(--ink-300); }

.board-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; min-width: 0; }
.channel-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; align-content: start; }
.channel-card {
  text-align: left;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 12px;
  box-shadow: var(--shadow-sm);
  min-width: 0;
}
.channel-card:hover { border-color: var(--klein-200); }
.channel-card.active { border-color: var(--klein); background: var(--klein-50); }
.channel-top { display: flex; align-items: center; gap: 6px; }
.channel-check { margin: 0; }
.channel-top strong { font-size: 16px; color: var(--ink-900); }
.channel-name { display: block; margin-top: 8px; font-size: 12px; color: var(--ink-700); }
.channel-card small { display: block; margin-top: 4px; color: var(--ink-400); font-size: 10px; }
.table tbody tr { cursor: pointer; }
.table tbody tr.selected td { background: var(--klein-50); }
.cell-name { font-weight: 600; color: var(--ink-900); }
.muted { color: var(--ink-400); }
.tag { gap: 6px; }
.drill-detail { color: var(--ink-700); font-size: 13px; margin: 0 0 14px; line-height: 1.6; }
.key-value-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 9px; }
.key-value-grid div { background: var(--bg); padding: 9px 10px; border-radius: 8px; }
.key-value-grid span { display: block; color: var(--ink-500); font-size: 9.5px; }
.key-value-grid strong { font-size: 15px; color: var(--ink-900); word-break: break-all; }
.panel-foot { color: var(--ink-400); font-size: 10px; margin-top: 12px; }

@media (max-width: 1150px) {
  .board-grid { grid-template-columns: 1fr; }
  .inventory-grid { grid-template-columns: 1fr 1fr; }
  .key-value-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 680px) {
  .inventory-grid, .channel-grid, .key-value-grid { grid-template-columns: 1fr; }
}
</style>
