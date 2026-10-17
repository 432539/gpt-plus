<template>
  <div class="dash">
    <div class="dashboard-head">
      <div>
        <div class="eyebrow">{{ summary?.scope === 'all' ? '全站运营视图' : '我的运营视图' }}</div>
        <h1>运营与流水线仪表盘</h1>
        <p>容量、实时任务、今日转化与库存健康集中在一页。</p>
      </div>
      <div class="refresh-state">
        <span :class="['live-dot', { stale: liveError }]"></span>
        <span>{{ liveError || (lastLiveAt ? `实时更新 ${formatClock(lastLiveAt)}` : '正在连接实时数据') }}</span>
      </div>
    </div>

    <div v-if="!summary && !live" class="card initial-state">
      <div class="loading-ring"></div>
      <div>
        <h2>正在加载仪表盘</h2>
        <p>{{ summaryError || liveError || '正在汇总业务数据与运行状态…' }}</p>
      </div>
    </div>

    <div v-if="summaryError && summary" class="inline-alert warning">
      汇总数据刷新失败，继续显示上次成功结果：{{ summaryError }}
    </div>

    <section v-if="server" class="health-strip" aria-label="服务器健康">
      <div class="health-item service">
        <span class="health-icon ok"></span>
        <div>
          <span>服务状态</span>
          <strong>运行正常</strong>
        </div>
      </div>
      <div class="health-item">
        <span>CPU</span>
        <strong>{{ server.cpu?.percent ?? 0 }}%</strong>
        <small>{{ server.cpu?.cores || 0 }} 核</small>
      </div>
      <div class="health-item">
        <span>内存</span>
        <strong>{{ formatBytes(server.memory?.used_bytes) }}</strong>
        <small>/ {{ formatBytes(server.memory?.total_bytes) }} · {{ server.memory?.used_percent ?? 0 }}%</small>
      </div>
      <div class="health-item">
        <span>系统负载</span>
        <strong>{{ server.cpu?.load1 ?? 0 }}</strong>
        <small>{{ server.cpu?.load5 ?? 0 }} / {{ server.cpu?.load15 ?? 0 }}</small>
      </div>
      <div class="health-item">
        <span>运行时长</span>
        <strong>{{ formatDuration(server.uptime_seconds) }}</strong>
        <small>Node {{ formatDuration(server.process?.uptime_seconds) }}</small>
      </div>
      <div class="health-item">
        <span>Node RSS</span>
        <strong>{{ formatBytes(server.process?.rss_bytes) }}</strong>
        <small>堆 {{ formatBytes(server.process?.heap_used_bytes) }}</small>
      </div>
      <div class="health-item">
        <span>磁盘</span>
        <strong>{{ server.disk ? `${server.disk.used_percent}%` : '—' }}</strong>
        <small>{{ server.disk ? `${formatBytes(server.disk.free_bytes)} 可用` : '当前平台不可用' }}</small>
      </div>
    </section>

    <section v-if="live" class="section-block">
      <div class="section-head">
        <div>
          <h2>流水线实时状态</h2>
          <p>每 5 秒更新；“待处理”来自当前任务队列或符合条件的库存。</p>
        </div>
        <router-link class="btn btn-ghost btn-sm" to="/accounts">打开账号流水线</router-link>
      </div>

      <div class="pipeline-grid">
        <article
          v-for="stage in stageList"
          :key="stage.key"
          class="pipeline-card"
          :class="{ running: stage.running, attention: stage.needs_watchdog }"
        >
          <div class="pipeline-title">
            <div>
              <span class="stage-kicker">阶段 {{ stage.order }}</span>
              <h3>{{ stage.label }}</h3>
            </div>
            <span class="toggle-pill" :class="{ on: stage.toggle }">
              {{ stage.toggle ? '开关开启' : '开关关闭' }}
            </span>
          </div>

          <div class="run-line">
            <span class="run-dot" :class="{ on: stage.running }"></span>
            <strong>{{ stage.running ? '运行中' : '空闲' }}</strong>
            <span v-if="stage.current_email" class="current-email" :title="stage.current_email">
              {{ stage.current_email }}
            </span>
          </div>

          <div v-if="stage.key === 'register'" class="capacity-grid">
            <div title="流水线设置的目标并发，不代表同时已启动这么多浏览器">
              <span>配置并发</span><strong>{{ stage.configured_concurrency || 0 }}</strong>
            </div>
            <div title="受待处理数量、资源上限和当前批次共同约束">
              <span>有效并发</span><strong>{{ stage.effective_concurrency || 0 }}</strong>
            </div>
            <div title="Cloak 运行时实际活跃的浏览器会话">
              <span>活跃浏览器</span><strong>{{ stage.active_browsers || 0 }}</strong>
            </div>
            <div title="Cloak 运行时当前还可分配的会话槽位">
              <span>可用槽位</span><strong>{{ stage.available_slots || 0 }}</strong>
            </div>
          </div>

          <div class="stage-metrics">
            <div>
              <span>目标</span>
              <strong>{{ stage.continuous ? '持续' : (stage.target || 0) }}</strong>
            </div>
            <div><span>待处理</span><strong>{{ stage.queued || 0 }}</strong></div>
            <div><span>执行中</span><strong>{{ stage.active || 0 }}</strong></div>
            <div><span>成功</span><strong class="good-text">{{ stage.success || 0 }}</strong></div>
            <div><span>失败</span><strong class="bad-text">{{ stage.failed || 0 }}</strong></div>
          </div>

          <div
            class="progress-track"
            :title="stage.continuous
              ? (stage.running ? `本波 ${stage.completed || 0}/${stage.target || 0}` : '持续注册')
              : `已完成 ${stage.completed || 0}/${stage.target || 0}`"
          >
            <span :style="{ width: `${percent(stage.completed, stage.target)}%` }"></span>
          </div>
          <p class="stage-message">{{ stage.message || '暂无状态消息' }}</p>
          <p v-if="stage.key === 'register'" class="capacity-note" :class="{ warn: stage.resource_limited }">
            {{ registerCapacityNote(stage) }}
          </p>
          <p v-if="stage.needs_watchdog" class="watchdog-note">开关开启且有待处理账号，但任务未运行，请关注下一轮看门狗。</p>
        </article>
      </div>
    </section>

    <section v-if="summary" class="section-block">
      <div class="section-head">
        <div>
          <h2>今日转化漏斗</h2>
          <p>按今天本地时间创建的账号统计；百分比为相对上一步转化。</p>
        </div>
        <span class="updated-copy">汇总更新 {{ formatClock(lastSummaryAt) }}</span>
      </div>

      <div class="funnel-grid">
        <article v-for="(step, index) in funnelSteps" :key="step.key" class="funnel-step">
          <span class="funnel-index">{{ index + 1 }}</span>
          <span class="funnel-label">{{ step.label }}</span>
          <strong>{{ step.value }}</strong>
          <small>{{ index ? `${formatPercent(step.value, step.previous)} 转化` : '今日创建' }}</small>
          <div class="mini-track">
            <span :style="{ width: `${percent(step.value, summary.funnel?.registered)}%` }"></span>
          </div>
          <p>{{ step.note }}</p>
          <span v-if="index < funnelSteps.length - 1" class="funnel-arrow">→</span>
        </article>
      </div>

      <div v-if="summary.funnel?.failures?.length" class="blocker-row">
        <span class="blocker-label">今日阻塞</span>
        <span v-for="item in summary.funnel.failures" :key="`${item.category}-${item.key}`" class="blocker-chip">
          {{ item.label }} <strong>{{ item.count }}</strong>
        </span>
      </div>
    </section>

    <section v-if="summary" class="section-block">
      <div class="section-head">
        <div>
          <h2>当前库存</h2>
          <p>聚焦可继续处理、异常和待补齐凭据的账号。</p>
        </div>
        <span class="plan-mix">
          Free {{ summary.inventory?.free || 0 }} · Plus {{ summary.inventory?.plus || 0 }}
          · Pro {{ summary.inventory?.pro || 0 }} · Team {{ summary.inventory?.team || 0 }}
        </span>
      </div>
      <div class="inventory-grid">
        <article v-for="item in inventoryCards" :key="item.key" class="inventory-card" :class="item.tone">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.hint }}</small>
        </article>
      </div>
    </section>

    <section v-if="summary" class="compact-panels">
      <article class="card compact-card">
        <div class="compact-head">
          <div><span class="panel-icon">↗</span><h2>同步与销售</h2></div>
          <router-link to="/syncs">查看明细</router-link>
        </div>
        <div class="key-value-grid">
          <div><span>普通号已同步</span><strong>{{ summary.sync?.successful_regular || 0 }}</strong></div>
          <div><span>Plus 已上架</span><strong>{{ summary.sync?.listed_plus || 0 }}</strong></div>
          <div><span>Plus 上架总额</span><strong>{{ formatYuan(summary.sync?.listing_total_yuan) }}</strong></div>
          <div><span>今日上架金额</span><strong>{{ formatYuan(summary.sync?.today_amount_yuan) }}</strong></div>
        </div>
        <div class="panel-foot">
          今日普通 {{ summary.sync?.today_regular || 0 }} · Plus {{ summary.sync?.today_plus || 0 }}
          <span :class="{ 'bad-text': summary.sync?.failures }">· 失败 {{ summary.sync?.failures || 0 }}</span>
        </div>
      </article>

      <article class="card compact-card">
        <div class="compact-head">
          <div><span class="panel-icon">✉</span><h2>邮箱与后缀</h2></div>
          <router-link to="/emails">邮箱管理</router-link>
        </div>
        <div class="mail-summary">
          <div><strong>{{ summary.mail?.total || 0 }}</strong><span>邮箱总数</span></div>
          <div><strong>{{ summary.mail?.unused || 0 }}</strong><span>未使用子号</span></div>
          <div :class="{ danger: summary.mail?.poll_failures_1h }">
            <strong>{{ summary.mail?.poll_failures_1h || 0 }}</strong><span>近 1 小时轮询失败</span>
          </div>
        </div>
        <div class="domain-columns">
          <div>
            <h4>表现较好</h4>
            <p v-for="item in summary.mail?.domain_top" :key="`top-${item.suffix}`">
              <span>{{ item.suffix }}</span><small>试用 {{ formatRate(item.trial_rate) }} · 提链 {{ formatRate(item.extract_rate) }}</small>
            </p>
            <p v-if="!summary.mail?.domain_top?.length" class="muted-row">暂无足够样本</p>
          </div>
          <div>
            <h4>需要关注</h4>
            <p v-for="item in summary.mail?.domain_bottom" :key="`bottom-${item.suffix}`">
              <span>{{ item.suffix }}</span><small>试用 {{ formatRate(item.trial_rate) }} · 提链 {{ formatRate(item.extract_rate) }}</small>
            </p>
            <p v-if="!summary.mail?.domain_bottom?.length" class="muted-row">暂无异常样本</p>
          </div>
        </div>
      </article>

      <article class="card compact-card">
        <div class="compact-head">
          <div><span class="panel-icon">◎</span><h2>代理健康</h2></div>
          <router-link to="/proxies">代理管理</router-link>
        </div>
        <div class="proxy-hero">
          <div>
            <strong>{{ summary.proxy?.available || 0 }}</strong>
            <span>/ {{ summary.proxy?.total || 0 }} 可用</span>
          </div>
          <span class="latency">{{ summary.proxy?.average_latency_ms == null ? '无延迟样本' : `均值 ${summary.proxy.average_latency_ms} ms` }}</span>
        </div>
        <div class="availability-track">
          <span :style="{ width: `${percent(summary.proxy?.available, summary.proxy?.total)}%` }"></span>
        </div>
        <div class="proxy-stats">
          <span><i class="good-dot"></i>可用 {{ summary.proxy?.available || 0 }}</span>
          <span><i class="bad-dot"></i>不可用 {{ summary.proxy?.unavailable || 0 }}</span>
          <span><i class="wait-dot"></i>测试中 {{ summary.proxy?.testing || 0 }}</span>
        </div>
        <p class="panel-foot">响应仅包含聚合状态，不返回代理地址或凭据。</p>
      </article>
    </section>

    <section v-if="summary" class="card alerts-card">
      <div class="card-head alert-head">
        <div>
          <h2>最近告警</h2>
          <p>只显示安全的错误代码与分类计数，不展示原始日志内容。</p>
        </div>
        <router-link class="btn btn-ghost btn-sm" to="/logs">打开日志</router-link>
      </div>
      <div class="alert-windows">
        <div>
          <h3>近 1 小时</h3>
          <div v-for="item in summary.alerts?.last_hour" :key="`h1-${item.category}-${item.key}`" class="alert-row">
            <span class="alert-code">{{ item.key }}</span>
            <span>{{ item.label }}</span>
            <strong>{{ item.count }}</strong>
          </div>
          <p v-if="!summary.alerts?.last_hour?.length" class="empty-compact">暂无告警</p>
        </div>
        <div>
          <h3>近 24 小时</h3>
          <div v-for="item in summary.alerts?.last_24h" :key="`h24-${item.category}-${item.key}`" class="alert-row">
            <span class="alert-code">{{ item.key }}</span>
            <span>{{ item.label }}</span>
            <strong>{{ item.count }}</strong>
          </div>
          <p v-if="!summary.alerts?.last_24h?.length" class="empty-compact">暂无告警</p>
        </div>
      </div>
    </section>

    <section v-if="summary" class="lower-grid" :class="{ single: !summary.site }">
      <div class="card flush">
        <div class="card-head table-head">
          <div>
            <h2>30 天内到期的 GPT 账号</h2>
            <p>即将到期，请及时续期或更换。</p>
          </div>
          <router-link class="btn btn-ghost btn-sm" to="/accounts">全部账号</router-link>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>账号邮箱</th><th>类型</th><th>到期时间</th></tr></thead>
            <tbody>
              <tr v-for="account in summary.expiringSoon" :key="account.id">
                <td class="cell-name">{{ account.email }}</td>
                <td><span class="tag" :class="account.plan_type === 'Plus' ? 'tag-plus' : 'tag-blue'">{{ account.plan_type }}</span></td>
                <td class="muted">{{ formatExpiresAt(account.expires_at) }}</td>
              </tr>
              <tr v-if="!summary.expiringSoon?.length"><td colspan="3" class="empty">暂无即将到期的账号</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="summary.site" class="card flush">
        <div class="card-head table-head">
          <div><h2>最近注册用户</h2><p>全站最新用户账号。</p></div>
          <router-link class="btn btn-ghost btn-sm" to="/admin/users">用户管理</router-link>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>用户</th><th>角色</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="user in summary.site.recentUsers" :key="user.id">
                <td class="cell-name">{{ user.username }}</td>
                <td><span class="tag" :class="user.role === 'admin' ? 'tag-blue' : 'tag-gray'">{{ user.role === 'admin' ? '管理员' : '用户' }}</span></td>
                <td class="muted">{{ formatShanghaiDate(user.created_at) }}</td>
              </tr>
              <tr v-if="!summary.site.recentUsers?.length"><td colspan="3" class="empty">暂无用户</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../api';
import { formatClock, formatExpiresAt, formatShanghaiDate } from '../utils/datetime';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatYuan,
  percent,
} from '../utils/dashboardFormat';

const SUMMARY_INTERVAL = 60_000;
const LIVE_INTERVAL = 5_000;
const summary = ref(null);
const live = ref(null);
const summaryError = ref('');
const liveError = ref('');
const lastSummaryAt = ref(null);
const lastLiveAt = ref(null);
let summaryTimer;
let liveTimer;
let summaryLoading = false;
let liveLoading = false;

const server = computed(() => live.value?.server || null);

const stageMeta = [
  { key: 'register', label: '注册', order: '01' },
  { key: 'extract', label: '提链', order: '02' },
  { key: 'pay', label: '支付', order: '03' },
  { key: 'acquire_rt', label: '拿 RT', order: '04' },
];

const stageList = computed(() => stageMeta.map((meta) => ({
  ...meta,
  ...(live.value?.stages?.[meta.key] || {}),
})));

const funnelSteps = computed(() => {
  const funnel = summary.value?.funnel || {};
  const syncTotal = Number(funnel.synced_total) || 0;
  return [
    { key: 'registered', label: '注册', value: Number(funnel.registered) || 0, previous: 0, note: '今日入库账号' },
    {
      key: 'trial', label: '有试用', value: Number(funnel.trial_yes) || 0,
      previous: Number(funnel.registered) || 0,
      note: `无试用 ${funnel.trial_no || 0} · 未检测 ${funnel.trial_unknown || 0}`,
    },
    {
      key: 'extracted', label: '已提链', value: Number(funnel.extracted) || 0,
      previous: Number(funnel.trial_yes) || 0,
      note: `当前待支付 ${summary.value?.inventory?.extracted_waiting_pay || 0}`,
    },
    {
      key: 'paid', label: '已支付', value: Number(funnel.paid) || 0,
      previous: Number(funnel.extracted) || 0,
      note: `已支付未拿 RT ${summary.value?.inventory?.paid_without_rt || 0}`,
    },
    {
      key: 'rt', label: '已拿 RT', value: Number(funnel.got_rt) || 0,
      previous: Number(funnel.paid) || 0,
      note: 'RT 已保存或完成标记',
    },
    {
      key: 'synced', label: '已同步', value: syncTotal,
      previous: Number(funnel.got_rt) || 0,
      note: `普通 ${funnel.synced_regular || 0} · Plus ${funnel.listed_plus || 0}`,
    },
  ];
});

const inventoryCards = computed(() => {
  const inventory = summary.value?.inventory || {};
  return [
    { key: 'total', label: '账号总库存', value: inventory.total || 0, hint: `正常 ${inventory.normal || 0}`, tone: '' },
    { key: 'plus', label: 'Plus 库存', value: inventory.plus || 0, hint: `Pro ${inventory.pro || 0} · Team ${inventory.team || 0}`, tone: 'good' },
    { key: 'invalid', label: '令牌失效', value: inventory.token_invalid || 0, hint: `禁用 / 过期 ${inventory.disabled || 0}`, tone: inventory.token_invalid ? 'bad' : '' },
    { key: 'paid-no-rt', label: '已支付未拿 RT', value: inventory.paid_without_rt || 0, hint: '优先补齐 RT', tone: inventory.paid_without_rt ? 'warn' : '' },
    { key: 'waiting-pay', label: '已提链待支付', value: inventory.extracted_waiting_pay || 0, hint: `可提链 ${inventory.ready_to_extract || 0}`, tone: '' },
    { key: 'trial-unknown', label: '试用未检测', value: inventory.trial_unknown || 0, hint: '影响提链转化判断', tone: inventory.trial_unknown ? 'warn' : '' },
  ];
});

function formatRate(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value) * 100)}%`;
}

function registerCapacityNote(stage) {
  const configured = Number(stage.configured_concurrency) || 0;
  const effective = Number(stage.effective_concurrency) || 0;
  const active = Number(stage.active_browsers) || 0;
  const slots = Number(stage.slot_capacity) || 0;
  if (!stage.toggle) return `配置 ${configured}，流水线开关关闭，当前不调度。`;
  if (stage.continuous) {
    return stage.running
      ? `配置 ${configured}，持续注册，本波并行 ${effective || configured}，槽位 ${slots}，活跃 ${active}。`
      : `配置 ${configured}，流水线持续注册，并行上限 ${configured}，槽位 ${slots}。`;
  }
  if (!stage.target && !stage.queued) return `配置 ${configured}，当前没有符合条件的邮箱或账号。`;
  if (stage.resource_limited) return `配置 ${configured}，资源槽位上限 ${slots}，当前有效 ${effective}、实际活跃 ${active}。`;
  if (effective < configured) return `配置 ${configured}，受当前待处理量或批次目标影响，有效 ${effective}、实际活跃 ${active}。`;
  return `配置 ${configured}，有效 ${effective}，实际活跃 ${active}；浏览器只在进入会话阶段后占用槽位。`;
}

async function loadSummary() {
  if (summaryLoading || document.hidden) return;
  summaryLoading = true;
  try {
    const result = await api.get('/dashboard/summary');
    summary.value = result;
    summaryError.value = '';
    lastSummaryAt.value = new Date();
  } catch (error) {
    summaryError.value = error.message;
  } finally {
    summaryLoading = false;
  }
}

async function loadLive() {
  if (liveLoading || document.hidden) return;
  liveLoading = true;
  try {
    const result = await api.get('/dashboard/live');
    live.value = result;
    liveError.value = '';
    lastLiveAt.value = new Date();
  } catch (error) {
    liveError.value = error.message;
  } finally {
    liveLoading = false;
  }
}

function onVisibilityChange() {
  if (!document.hidden) {
    loadLive();
    loadSummary();
  }
}

onMounted(() => {
  loadSummary();
  loadLive();
  summaryTimer = window.setInterval(loadSummary, SUMMARY_INTERVAL);
  liveTimer = window.setInterval(loadLive, LIVE_INTERVAL);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  window.clearInterval(summaryTimer);
  window.clearInterval(liveTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
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

.health-strip { display: grid; grid-template-columns: 1.15fr repeat(6, minmax(110px, 1fr)); background: #071c53; color: #fff; border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
.health-item { padding: 15px 16px; border-right: 1px solid rgba(255,255,255,.1); display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.health-item:last-child { border-right: 0; }
.health-item > span { font-size: 11px; color: rgba(255,255,255,.62); }
.health-item strong { font-size: 17px; color: #fff; white-space: nowrap; margin-top: 2px; }
.health-item small { color: rgba(255,255,255,.6); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.health-item.service { flex-direction: row; align-items: center; gap: 11px; }
.health-item.service div { display: flex; flex-direction: column; }
.health-icon { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
.health-icon.ok { background: #42db7a; box-shadow: 0 0 0 5px rgba(66,219,122,.14); }

.section-block { display: flex; flex-direction: column; gap: 14px; }
.section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.section-head h2 { font-size: 17px; }
.section-head p, .updated-copy, .plan-mix { color: var(--ink-500); font-size: 12px; margin-top: 3px; }
.pipeline-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.pipeline-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 17px; box-shadow: var(--shadow-sm); min-width: 0; position: relative; overflow: hidden; }
.pipeline-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--ink-300); }
.pipeline-card.running::before { background: var(--good); }
.pipeline-card.attention::before { background: var(--warn); }
.pipeline-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.pipeline-title h3 { font-size: 18px; margin-top: 1px; }
.stage-kicker { color: var(--ink-400); font-size: 10px; letter-spacing: .08em; }
.toggle-pill { border-radius: 999px; padding: 3px 8px; font-size: 10px; color: var(--ink-500); background: var(--line-soft); white-space: nowrap; }
.toggle-pill.on { color: var(--klein); background: var(--klein-50); }
.run-line { display: flex; align-items: center; gap: 7px; margin: 12px 0; min-width: 0; font-size: 12px; }
.run-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); }
.run-dot.on { background: var(--good); box-shadow: 0 0 0 3px rgba(22,163,74,.12); }
.current-email { color: var(--ink-500); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 10.5px; }
.capacity-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 9px; border-radius: 9px; background: var(--klein-50); margin-bottom: 10px; }
.capacity-grid div { text-align: center; min-width: 0; }
.capacity-grid span { display: block; color: var(--ink-500); font-size: 9px; white-space: nowrap; }
.capacity-grid strong { color: var(--klein); font-size: 17px; }
.stage-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; }
.stage-metrics div { min-width: 0; }
.stage-metrics span { display: block; color: var(--ink-400); font-size: 9.5px; }
.stage-metrics strong { font-size: 15px; color: var(--ink-800); }
.good-text { color: var(--good) !important; }
.bad-text { color: var(--bad) !important; }
.progress-track, .mini-track, .availability-track { height: 4px; background: var(--line-soft); border-radius: 999px; overflow: hidden; }
.progress-track { margin-top: 11px; }
.progress-track span, .mini-track span, .availability-track span { display: block; height: 100%; background: var(--klein); border-radius: inherit; transition: width .25s ease; }
.pipeline-card.running .progress-track span { background: var(--good); }
.stage-message { color: var(--ink-500); font-size: 10.5px; margin-top: 8px; min-height: 31px; line-height: 1.45; }
.capacity-note { color: var(--klein); background: var(--klein-50); border-radius: 7px; padding: 6px 8px; font-size: 10px; line-height: 1.45; margin-top: 7px; }
.capacity-note.warn { color: #8a5700; background: var(--warn-bg); }
.watchdog-note { color: #8a5700; font-size: 10px; margin-top: 7px; }

.funnel-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.funnel-step { position: relative; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 14px; min-width: 0; box-shadow: var(--shadow-sm); }
.funnel-index { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; color: var(--klein); background: var(--klein-50); font-size: 9px; font-weight: 700; }
.funnel-label { color: var(--ink-500); font-size: 11px; margin-left: 5px; }
.funnel-step > strong { display: block; font-size: 25px; line-height: 1.1; margin-top: 8px; color: var(--ink-900); }
.funnel-step > small { display: block; color: var(--klein); font-size: 10px; margin-top: 2px; }
.mini-track { margin: 9px 0 7px; }
.funnel-step p { color: var(--ink-400); font-size: 9.5px; min-height: 28px; line-height: 1.4; }
.funnel-arrow { position: absolute; right: -16px; top: 50%; transform: translateY(-50%); z-index: 2; color: var(--ink-300); font-size: 15px; }
.blocker-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.blocker-label { color: var(--bad); font-size: 11px; font-weight: 700; margin-right: 3px; }
.blocker-chip { border-radius: 999px; padding: 4px 9px; background: var(--bad-bg); color: #9d2424; font-size: 10.5px; }
.blocker-chip strong { margin-left: 3px; }

.inventory-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.inventory-card { background: #fff; border: 1px solid var(--line); border-top: 3px solid var(--klein); border-radius: 11px; padding: 14px; box-shadow: var(--shadow-sm); min-width: 0; }
.inventory-card.good { border-top-color: var(--good); }
.inventory-card.warn { border-top-color: var(--warn); }
.inventory-card.bad { border-top-color: var(--bad); }
.inventory-card > span { display: block; color: var(--ink-500); font-size: 10.5px; }
.inventory-card > strong { display: block; color: var(--ink-900); font-size: 24px; margin: 3px 0 1px; }
.inventory-card > small { color: var(--ink-400); font-size: 9.5px; }

.compact-panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.compact-card { padding: 17px; min-width: 0; }
.compact-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); }
.compact-head > div { display: flex; align-items: center; gap: 8px; }
.compact-head h2 { font-size: 15px; }
.compact-head > a { color: var(--klein); font-size: 10.5px; }
.panel-icon { display: inline-flex; align-items: center; justify-content: center; width: 25px; height: 25px; border-radius: 7px; background: var(--klein-50); color: var(--klein); font-weight: 700; }
.key-value-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.key-value-grid div { background: var(--bg); padding: 9px 10px; border-radius: 8px; }
.key-value-grid span { display: block; color: var(--ink-500); font-size: 9.5px; }
.key-value-grid strong { font-size: 17px; color: var(--ink-900); }
.panel-foot { color: var(--ink-400); font-size: 10px; margin-top: 10px; }
.mail-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.mail-summary div { background: var(--bg); border-radius: 8px; padding: 8px; text-align: center; }
.mail-summary div.danger { background: var(--bad-bg); }
.mail-summary strong { display: block; font-size: 17px; }
.mail-summary span { color: var(--ink-500); font-size: 8.5px; }
.domain-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
.domain-columns h4 { color: var(--ink-500); font-size: 9.5px; margin-bottom: 5px; }
.domain-columns p { display: flex; flex-direction: column; padding: 4px 0; border-bottom: 1px solid var(--line-soft); min-width: 0; }
.domain-columns p > span { color: var(--ink-700); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.domain-columns p small { color: var(--ink-400); font-size: 8.5px; }
.muted-row { color: var(--ink-400); font-size: 10px; border: 0 !important; }
.proxy-hero { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.proxy-hero strong { font-size: 28px; color: var(--ink-900); }
.proxy-hero span { color: var(--ink-500); font-size: 11px; }
.proxy-hero .latency { color: var(--klein); background: var(--klein-50); border-radius: 999px; padding: 3px 8px; font-size: 9px; }
.availability-track { height: 7px; margin: 10px 0; }
.availability-track span { background: var(--good); }
.proxy-stats { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; color: var(--ink-500); font-size: 9.5px; }
.proxy-stats i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 3px; }
.good-dot { background: var(--good); }
.bad-dot { background: var(--bad); }
.wait-dot { background: var(--warn); }

.alerts-card { padding: 18px 20px; }
.alert-head { margin: 0 0 13px; padding-bottom: 13px; }
.alert-windows { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.alert-windows h3 { color: var(--ink-500); font-size: 10.5px; margin-bottom: 6px; }
.alert-row { display: grid; grid-template-columns: minmax(100px, .8fr) minmax(100px, 1fr) auto; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px solid var(--line-soft); font-size: 11px; }
.alert-row:last-child { border-bottom: 0; }
.alert-code { font-family: var(--mono); color: var(--bad); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alert-row > span:nth-child(2) { color: var(--ink-500); }
.alert-row strong { display: inline-flex; align-items: center; justify-content: center; min-width: 25px; height: 21px; border-radius: 7px; background: var(--bad-bg); color: var(--bad); }
.empty-compact { color: var(--ink-400); font-size: 11px; padding: 15px 0; }
.lower-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 14px; }
.lower-grid.single { grid-template-columns: 1fr; }
.table-head { padding: 17px 20px 13px; margin: 0; }
.cell-name { font-weight: 600; color: var(--ink-900); }

@media (max-width: 1420px) {
  .pipeline-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .health-strip { grid-template-columns: repeat(4, 1fr); }
  .health-item:nth-child(4) { border-right: 0; }
  .health-item:nth-child(-n+4) { border-bottom: 1px solid rgba(255,255,255,.1); }
}
@media (max-width: 1150px) {
  .funnel-grid, .inventory-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .funnel-arrow { display: none; }
  .compact-panels { grid-template-columns: 1fr 1fr; }
  .compact-card:last-child { grid-column: 1 / -1; }
}
@media (max-width: 900px) {
  .compact-panels, .lower-grid, .alert-windows { grid-template-columns: 1fr; }
  .compact-card:last-child { grid-column: auto; }
  .health-strip { grid-template-columns: repeat(2, 1fr); }
  .health-item { border-bottom: 1px solid rgba(255,255,255,.1); }
  .health-item:nth-child(even) { border-right: 0; }
}
@media (max-width: 680px) {
  .dashboard-head { align-items: flex-start; }
  .pipeline-grid, .funnel-grid, .inventory-grid { grid-template-columns: 1fr; }
  .capacity-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .health-strip { grid-template-columns: 1fr; }
  .health-item { border-right: 0; }
  .domain-columns { grid-template-columns: 1fr; }
}
</style>
