<template>
  <div class="settings-page">
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: activeTab === t.key }"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 账户信息 + 修改密码 -->
    <div v-show="activeTab === 'account'" class="settings-grid">
      <div class="card">
        <div class="card-title">账户信息</div>
        <div v-if="profile" class="info-list">
          <div class="info-row"><span>用户名</span><b>{{ profile.username }}</b></div>
          <div class="info-row">
            <span>角色</span>
            <span class="tag" :class="profile.role === 'admin' ? 'tag-blue' : 'tag-gray'">
              {{ profile.role === 'admin' ? '管理员' : '普通用户' }}
            </span>
          </div>
          <div class="info-row"><span>用户等级</span><b>Lv.{{ profile.level }}</b></div>
          <div class="info-row">
            <span>当前套餐</span>
            <span v-if="profile.plan" class="tag" :class="profile.planExpired ? 'tag-red' : 'tag-green'">
              {{ profile.plan.name }}{{ profile.planExpired ? '(已过期)' : '' }}
            </span>
            <span v-else class="tag tag-gray">未分配</span>
          </div>
          <div class="info-row" v-if="profile.plan">
            <span>套餐限额</span>
            <b>账号 {{ profile.plan.max_accounts }} 条 / 邮箱 {{ profile.plan.max_emails }} 条</b>
          </div>
          <div class="info-row"><span>套餐到期</span><b>{{ formatExpiresAt(profile.plan_expires_at) }}</b></div>
          <div class="info-row"><span>注册时间</span><b>{{ formatShanghaiDateTime(profile.created_at, { seconds: true }) }}</b></div>
          <div class="info-row">
            <span>开源地址</span>
            <a class="oss-link" href="https://github.com/432539/gpt-plus" target="_blank" rel="noopener noreferrer">github.com/432539/gpt-plus</a>
          </div>
          <div class="info-row"><span>交流群</span><b>QQ 群 1109037692</b></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">修改密码</div>
        <form @submit.prevent="changePassword">
          <div class="form-item">
            <label>原密码</label>
            <input v-model="pwd.oldPassword" type="password" class="input" autocomplete="current-password" />
          </div>
          <div class="form-item">
            <label>新密码(至少 6 位)</label>
            <input v-model="pwd.newPassword" type="password" class="input" autocomplete="new-password" />
          </div>
          <div class="form-item">
            <label>确认新密码</label>
            <input v-model="pwd.confirm" type="password" class="input" autocomplete="new-password" />
          </div>
          <button class="btn" type="submit" :disabled="saving">{{ saving ? '提交中...' : '修改密码' }}</button>
        </form>
      </div>
    </div>

    <!-- CloakBrowser 授权 -->
    <div v-show="activeTab === 'cloak'" class="settings-grid">
      <div class="card">
        <div class="card-title">
          CloakBrowser 授权
          <span class="tag" :class="settings.cloak.license_configured ? 'tag-green' : 'tag-gray'">
            {{ cloakLicenseLabel }}
          </span>
        </div>
        <div class="form-item">
          <label>License Keys</label>
          <textarea
            v-model="cloakForm.license_key"
            class="input"
            rows="4"
            placeholder="每行一个 cb_xxxxxxxx（留空则不修改已保存的授权）"
          ></textarea>
        </div>
        <div class="two-col">
          <div class="form-item">
            <label>最大并发</label>
            <input v-model.number="cloakForm.max_concurrency" type="number" min="1" max="200" class="input" />
          </div>
          <div class="form-item">
            <label>无头模式</label>
            <select v-model="cloakForm.headless" class="input">
              <option :value="true">开启(后台运行)</option>
              <option :value="false">关闭(显示浏览器)</option>
            </select>
          </div>
        </div>
        <div class="two-col">
          <label class="form-item"><span>注册密码</span><input v-model="registrationForm.set_password" type="checkbox" /> 默认设置独立 ChatGPT 密码</label>
          <label class="form-item"><span>TOTP 2FA</span><input v-model="registrationForm.enable_totp_2fa" type="checkbox" /> 默认启用真实 TOTP 双重验证</label>
        </div>
        <label class="form-item"><span>拟人化</span><input v-model="cloakForm.humanize" type="checkbox" /> 启用拟人鼠标/键盘（Cloak humanize，默认开；与稳定模式不是同一件事）</label>
        <div class="two-col">
          <div class="form-item">
            <label>注册性能模式</label>
            <select v-model="registrationForm.performance_profile" class="input">
              <option value="safe">稳定模式</option>
              <option value="throughput">高吞吐模式</option>
            </select>
          </div>
          <div class="form-item">
            <label>默认业务尝试次数</label>
            <input v-model.number="registrationForm.attempts" type="number" min="1" max="3" class="input" />
          </div>
        </div>
        <div class="form-item">
          <label>默认注册邮箱</label>
          <select v-model="registrationForm.mail_provider" class="input">
            <option value="mailcom">mail.com 子号</option>
            <option value="cfworker">CF 邮箱</option>
            <option value="mix">mail.com + CF 按比例</option>
            <option value="herosms">HeroSMS</option>
            <option value="imported">导入邮箱</option>
          </select>
        </div>
        <div class="two-col">
          <div class="form-item">
            <label>mail.com 份数</label>
            <input v-model.number="registrationForm.mailcom_share" type="number" min="0" max="100" class="input" />
          </div>
          <div class="form-item">
            <label>CF 邮箱份数</label>
            <input v-model.number="registrationForm.cfworker_share" type="number" min="0" max="100" class="input" />
          </div>
        </div>
        <p class="hint" style="margin-top: 0">选「mail.com + CF 按比例」时按份数拆分。流水线自动注册以「邮箱域名」页保存的比例为准，例如 5:5 注册 100 个就是各 50 个。</p>
        <div class="toolbar">
          <button class="btn" @click="saveCloak" :disabled="savingCloak">保存授权</button>
          <button class="btn btn-ghost" @click="saveRegistration" :disabled="savingRegistration">保存注册邮箱</button>
          <button class="btn btn-ghost" @click="clearCloak" v-if="settings.cloak.license_configured">清除授权</button>
        </div>
        <p class="hint">授权密钥加密后按用户隔离存储，页面不回显明文。填写则整体替换已保存的授权；留空只改并发/无头等其它项。多个授权轮询使用，某个许可证席位暂满时自动换下一个。浏览器编排（注册/检测/mail.com 收件）将使用这些授权。</p>
      </div>

      <div class="card">
        <div class="card-title">账号验活轮询</div>
        <div class="form-item">
          <label>验活间隔(分钟,0=关闭)</label>
          <input v-model.number="accountsForm.detect_poll_minutes" type="number" min="0" max="1440" class="input" />
        </div>
        <button class="btn" @click="saveAccountsDetect" :disabled="savingAccounts">保存验活配置</button>
        <p class="hint">
          默认 15 分钟用账号 access token 检查一次存活（正常 / 令牌失效 / 封禁等），不启动 Cloak。验活与试用回填一律走设置里的 CliProxy 动态池（GB=region-GB，GC 资格检测=region-PH），不再使用手工「检测」组或直连。动态池未配置时本轮失败并写日志，不会回退导入分组。代理或传输失败不会把账号标成失效。试用资格「未检测」每 2 分钟单独探测一次（把验活间隔设为 0 也不影响）；写成「是 / 否」后不再重查。
        </p>
      </div>

      <div class="card">
        <div class="card-title">流水线上限</div>
        <div class="two-col">
          <div class="form-item">
            <label>注册 每天上限</label>
            <input v-model.number="pipelineForm.daily_register_limit" type="number" min="0" max="10000" class="input" />
          </div>
          <div class="form-item">
            <label>注册并发</label>
            <input v-model.number="pipelineForm.register_concurrency" type="number" min="1" max="200" class="input" />
          </div>
        </div>
        <p class="hint" style="margin-top: 0">每天上限按当天成功入库的账号数统计（本地时间），0 表示不限制。并发是流水线自动注册同时开几个线程（1–200，默认 5）。</p>
        <div class="two-col">
          <div class="form-item">
            <label>提链 每个号最多提链多少次</label>
            <input v-model.number="pipelineForm.extract_attempts" type="number" min="1" max="50" class="input" />
          </div>
          <div class="form-item">
            <label>提链 单个账号间隔时间多久（分钟）</label>
            <input v-model.number="pipelineForm.extract_interval_minutes" type="number" min="0" max="1440" class="input" />
          </div>
        </div>
        <div class="two-col">
          <div class="form-item">
            <label>支付 最多重试几次</label>
            <input v-model.number="pipelineForm.pay_attempts" type="number" min="1" max="50" class="input" />
          </div>
          <div class="form-item">
            <label>拿RT 最多重试几次</label>
            <input v-model.number="pipelineForm.rt_attempts" type="number" min="1" max="50" class="input" />
          </div>
        </div>
        <button class="btn" @click="savePipelineLimits" :disabled="savingPipeline">保存流水线上限</button>
        <p class="hint">
          提链次数与间隔相互独立：同一账号两次提链之间至少等待设定分钟数（默认 10 分钟，0 表示不等待）；达到次数上限后流水线不再自动重试该步骤。
        </p>
      </div>

      <div class="card">
        <div class="card-title">
          手工推送 PLUS 到 nvtokens 出售
          <span class="tag" :class="settings.nvtokens?.api_key_configured ? 'tag-green' : 'tag-gray'">
            {{ settings.nvtokens?.api_key_configured ? '库存密钥已配置' : '未配置密钥' }}
          </span>
          <span class="tag" :class="settings.nvtokens?.has_session ? 'tag-green' : 'tag-gray'">
            {{ settings.nvtokens?.has_session
              ? (settings.nvtokens.session_last4 ? `价格查询已配置 · ${settings.nvtokens.session_last4}` : '价格查询已配置')
              : '未配置价格查询 Token' }}
          </span>
        </div>
        <div class="form-item">
          <label>最低价多少（元）</label>
          <input v-model="nvtokensForm.min_price_yuan" type="number" min="0.01" step="0.01" class="input" />
        </div>
        <div class="form-item">
          <label>库存 API Key</label>
          <input v-model="nvtokensForm.api_key" type="password" autocomplete="new-password" class="input" placeholder="留空保留已保存密钥" />
        </div>
        <div class="form-item">
          <label>查询价格的 token/session（Cookie scm_session 值）</label>
          <input
            v-model="nvtokensForm.session_cookie"
            type="password"
            autocomplete="new-password"
            class="input"
            :placeholder="settings.nvtokens?.has_session ? '已保存，过期后粘贴新 token（留空保留）' : '粘贴 Cookie scm_session 值'"
          />
        </div>
        <div class="toolbar">
          <button class="btn" type="button" @click="saveNvtokens" :disabled="savingNvtokens">保存上架配置</button>
          <button class="btn btn-ghost" type="button" :disabled="testingNvtokensPrice" @click="testNvtokensPrice">
            {{ testingNvtokensPrice ? '查询中...' : '测试价格' }}
          </button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="listingPlus || !settings.nvtokens?.api_key_configured"
            @click="runNvtokensList"
          >
            {{ listingPlus ? '推送中...' : '立即推送现有 PLUS' }}
          </button>
        </div>
        <p class="hint" v-if="nvtokensPriceHint">{{ nvtokensPriceHint }}</p>
        <p class="hint">
          不会自动上架，必须点「立即推送现有 PLUS」。密钥与价格查询 Token 只保存在服务端，页面只显示是否已配置和尾号。从浏览器开发者工具 Cookie 复制 scm_session；过期后替换再保存。手工推送会把 Plus+RT 以整号 JSON（CPA / type=codex）按元直卖到普通号池，不勾选「默认加入兜底池」、不按 0.08 倍率结算。售价严格按看板 Plus 最低价（min/floor）；没有 Token 时才用设置最低价兜底，避免 0 元上架。用户最低价不会把售价抬到看板最低价以上。已上架的账号不会重复提交。
        </p>
      </div>

      <div class="card">
        <div class="card-title">
          无试用普号手工导出
          <span class="tag" :class="settings.import_dump?.configured ? 'tag-green' : 'tag-gray'">
            {{ settings.import_dump?.configured ? '已配置' : '未配置' }}
          </span>
        </div>
        <div class="form-item">
          <label>远程导入地址</label>
          <input v-model="importDumpForm.url" class="input" placeholder="留空保留已保存地址" />
        </div>
        <div class="form-item">
          <label>X-API-Key</label>
          <input v-model="importDumpForm.api_key" type="password" autocomplete="new-password" class="input" placeholder="留空保留已保存密钥" />
        </div>
        <div class="toolbar">
          <button class="btn" type="button" :disabled="savingImportDump" @click="saveImportDump">保存导出配置</button>
          <button class="btn btn-ghost" type="button" :disabled="dumpingNoTrial || dumpingAllAccounts || !settings.import_dump?.configured" @click="runImportDump">立即推送现有无试用普号</button>
          <button class="btn btn-ghost" type="button" :disabled="dumpingNoTrial || dumpingAllAccounts || !settings.import_dump?.configured" @click="runDumpAllAccounts">{{ dumpingAllAccounts ? '推送中...' : '立即推送全部账号' }}</button>
        </div>
        <p class="hint">
          不会自动导出。必须点「立即推送现有无试用普号」才会推送，且只包含已经检测为无试用的普通 Free 账号，成功后从本地删除。未检测、有试用、检测失败未定性的账号一律不导出、不删除。已支付以及 Plus/Pro/Team 不会导出。令牌失效的未支付普通号会直接清理，不会推送。
        </p>
        <p class="hint">
          「立即推送全部账号」会把已检测的普通号（含有试用，GB 与 GC）一并推到同一远程导入地址，成功后同样从本库删除，可能有几百个。未检测、已支付、Plus/Pro/Team、令牌失效、封禁、停用、检测失败、无 AT、已标记不同步的仍不会导出。点按钮后会再确认一次。
        </p>
      </div>
    </div>

    <!-- 接码平台 -->
    <div v-show="activeTab === 'sms'" class="settings-grid">
      <div class="card">
        <div class="card-title">
          接码平台
          <span class="tag" :class="settings.sms.api_key_configured ? 'tag-green' : 'tag-gray'">
            {{ settings.sms.api_key_configured ? 'API Key 已配置' : '未配置' }}
          </span>
        </div>
        <div class="two-col">
          <div class="form-item">
            <label>平台标识</label>
            <input v-model="smsForm.provider" class="input" placeholder="auto" />
          </div>
          <div class="form-item">
            <label>API 地址</label>
            <input v-model="smsForm.api_url" class="input" placeholder="https://smsbower.app/stubs/handler_api.php" />
          </div>
        </div>
        <div class="form-item">
          <label>API Key</label>
          <input v-model="smsForm.api_key" class="input" placeholder="留空则不修改已保存的 Key" />
        </div>
        <div class="two-col">
          <div class="form-item">
            <label>国家 / 地区</label>
            <input v-model="smsForm.country" class="input" placeholder="usa" />
          </div>
          <div class="form-item">
            <label>业务 / 产品</label>
            <input v-model="smsForm.product" class="input" placeholder="openai" />
          </div>
        </div>
        <button class="btn" @click="saveSms" :disabled="savingSms">保存接码配置</button>
        <p class="hint">
          支付/开通使用 SMSBower：取号、等短信、提交后释放号码。Key 只保存在服务端，页面不会回显。PayPal 开通任务固定英国号码和服务 ts（PayPal），即使这里填了其它国家或 openai。已保存的 Key 留空即可继续使用。
        </p>
      </div>
    </div>

    <div v-show="activeTab === 'providers'" class="settings-grid">
      <div class="card">
        <div class="card-title">注册供应商</div>
        <div v-for="provider in providerCards" :key="provider.id" class="provider-block">
          <div class="provider-head">
            <b>{{ provider.label }}</b>
            <span class="tag" :class="provider.configured ? 'tag-green' : 'tag-gray'">
              {{ provider.configured ? 'configured' : 'not configured' }}
            </span>
          </div>
          <div class="two-col">
            <div class="form-item"><label>API 地址</label><input v-model="providerForms[provider.id].api_url" class="input" /></div>
            <div class="form-item"><label>默认域名</label><input v-model="providerForms[provider.id].domain" class="input" /></div>
          </div>
          <template v-if="provider.id === 'herosms'">
            <div class="two-col">
              <div class="form-item"><label>请求 RPS</label><input v-model.number="providerForms.herosms.requests_per_second" type="number" min="1" max="30" class="input" /></div>
              <div class="form-item"><label>HTTP 并发</label><input v-model.number="providerForms.herosms.max_request_concurrency" type="number" min="1" max="32" class="input" /></div>
            </div>
            <div class="two-col">
              <div class="form-item"><label>最大在途 activation</label><input v-model.number="providerForms.herosms.max_active_activations" type="number" min="1" max="50" class="input" /></div>
              <div class="form-item"><label>购买尝试次数</label><input v-model.number="providerForms.herosms.acquire_attempts" type="number" min="1" max="5" class="input" /></div>
            </div>
            <div class="two-col">
              <div class="form-item"><label>封禁冷却（毫秒）</label><input v-model.number="providerForms.herosms.ban_cooldown_ms" type="number" min="60000" max="21600000" class="input" /></div>
              <div class="form-item"><label>限速冷却（毫秒）</label><input v-model.number="providerForms.herosms.rate_cooldown_ms" type="number" min="10000" max="300000" class="input" /></div>
            </div>
            <div class="two-col">
              <div class="form-item"><label>读取瞬态重试</label><input v-model.number="providerForms.herosms.max_transient_retries" type="number" min="0" max="3" class="input" /></div>
              <div class="form-item"><label>重试基准延迟（毫秒）</label><input v-model.number="providerForms.herosms.transient_retry_base_ms" type="number" min="100" max="5000" class="input" /></div>
            </div>
            <div class="form-item"><label>单邮箱最大 reorder</label><input v-model.number="providerForms.herosms.max_reorders" type="number" min="0" max="10" class="input" /></div>
          </template>
          <div class="two-col">
            <div class="form-item"><label>API Key / Token</label><input v-model="providerForms[provider.id].api_key" type="password" autocomplete="new-password" class="input" placeholder="留空保留已保存密钥" /></div>
            <div class="form-item" v-if="provider.id !== 'cfworker_mail'"><label>国家 / 服务码</label><input v-model="providerForms[provider.id].country" class="input" placeholder="gb" /></div>
          </div>
          <div class="two-col" v-if="provider.id !== 'cfworker_mail'">
            <div class="form-item"><label>邮箱服务码</label><input v-model="providerForms[provider.id].service" class="input" placeholder="openai" /></div>
            <div class="form-item" v-if="provider.id === 'herosms'"><label>目标站点</label><input v-model="providerForms.herosms.site" class="input" placeholder="openai.com" /></div>
          </div>
        </div>
        <button class="btn" :disabled="savingProviders" @click="saveProviders">保存供应商</button>
        <p class="hint">页面只返回 configured 状态；所有密钥输入在保存后立即清空，服务端不回显明文。</p>
      </div>

      <div class="card">
        <div class="card-title">动态代理池</div>
        <div class="form-item">
          <label>当前供应商</label>
          <select v-model="dynamicProxyForm.active_pool" class="input">
            <option v-for="item in dynamicProxyProviders" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </div>
        <div v-for="provider in dynamicProxyProviders" :key="provider.id" class="provider-block">
          <div class="provider-head">
            <b>{{ provider.label }}</b>
            <span class="tag" :class="provider.configured ? 'tag-green' : 'tag-gray'">
              {{ provider.configured ? 'configured' : 'not configured' }}
            </span>
          </div>
          <div class="two-col">
            <div class="form-item"><label>账号</label><input v-model="dynamicProxyForm.providers[provider.id].username" class="input" autocomplete="username" /></div>
            <div class="form-item"><label>密码</label><input v-model="dynamicProxyForm.providers[provider.id].password" type="password" class="input" autocomplete="new-password" placeholder="留空保留已保存密码" /></div>
          </div>
          <div class="form-item"><label>粘性时长（分钟）</label><input v-model.number="dynamicProxyForm.providers[provider.id].sticky_minutes" type="number" min="1" max="120" class="input" /></div>
        </div>
        <button class="btn" :disabled="savingDynamicProxy" @click="saveDynamicProxy">保存动态代理</button>
        <p class="hint">动态代理按任务生成独立会话，并在注册前校验出口；密码不会回显。</p>
      </div>
    </div>

    <!-- 代理管理 -->
    <div v-show="activeTab === 'proxy'">
      <div class="card flush proxy-card">
        <div class="page-header proxy-toolbar">
          <div class="card-title" style="margin: 0">代理管理</div>
          <div class="toolbar">
            <select v-model="proxyGroupFilter" class="input toolbar-select" @change="onProxyGroupChange">
              <option value="">全部分组</option>
              <option v-for="g in proxyGroups" :key="g.group_name" :value="g.group_name">
                {{ g.group_name }} ({{ g.count }})
              </option>
            </select>
            <div class="toolbar-spacer"></div>
            <button class="btn btn-ghost btn-danger" v-if="selectedProxies.length" @click="batchDeleteProxies">
              删除选中({{ selectedProxies.length }})
            </button>
            <button class="btn btn-ghost btn-danger" :disabled="!proxyTotal" @click="clearAllProxies">批量清空</button>
            <button class="btn btn-ghost" @click="openProxyImport">批量导入</button>
            <button class="btn" @click="openProxyForm()">新增代理</button>
          </div>
        </div>
        <p class="hint" style="margin: 0 20px 14px">
          注册、提链、支付、检测、换绑、拿 RT 已改走「设置 → 注册供应商 / 动态代理」里的 CliProxy 动态池：GB 通道改写 region-GB，GC 通道改写 region-PH，并按任务生成 sticky SID（不会吃掉 -t-*）。本页手工导入分组只兼容旧数据或备用（例如 mail.com 邮箱组），不再作为上述业务流量来源。HTTP(S) 与 SOCKS5 仍可导入，但业务任务未配置动态池时会直接失败，不会回退到这里。
        </p>
        <div class="table-wrap">
          <table class="table proxy-table">
            <thead>
              <tr>
                <th class="col-check"><input type="checkbox" :checked="allProxiesChecked" @change="toggleAllProxies" /></th>
                <th>分组</th>
                <th>类型</th>
                <th>地址</th>
                <th>状态</th>
                <th class="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!proxies.length"><td colspan="6" class="empty">暂无代理,点击「新增代理」或「批量导入」</td></tr>
              <tr v-for="p in proxies" :key="p.id">
                <td class="col-check"><input type="checkbox" :value="p.id" v-model="selectedProxies" /></td>
                <td><span class="tag tag-blue">{{ p.group_name }}</span></td>
                <td>{{ p.proxy_type }}</td>
                <td class="mono">{{ p.host }}:{{ p.port }}</td>
                <td>
                  <span class="tag" :class="proxyStatusClass(p.status)">{{ p.status || '未检测' }}</span>
                  <span v-if="p.latency" class="muted latency">{{ p.latency }}ms</span>
                </td>
                <td class="col-ops">
                  <div class="row-actions">
                    <button class="btn btn-sm btn-ghost" :disabled="testingProxy[p.id]" @click="testOneProxy(p)">
                      {{ testingProxy[p.id] ? '测试中' : '测试' }}
                    </button>
                    <button class="btn btn-sm btn-ghost" @click="openProxyForm(p)">编辑</button>
                    <button class="btn btn-sm btn-danger" @click="deleteProxy(p)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <div class="pagination-info">
            共 {{ proxyTotal }} 条{{ proxyTotal ? `,当前 ${proxyRangeStart}-${proxyRangeEnd}` : '' }}
          </div>
          <div class="pagination-actions">
            <label class="page-size">
              每页
              <select v-model.number="proxyPageSize" class="input" style="width: 80px" @change="onProxyPageSizeChange">
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
              </select>
              条
            </label>
            <div class="pagination-btns">
              <button class="page-btn" :disabled="proxyPage <= 1" @click="goProxyPage(1)">首页</button>
              <button class="page-btn" :disabled="proxyPage <= 1" @click="goProxyPage(proxyPage - 1)">上一页</button>
              <span class="page-current">{{ proxyPage }} / {{ proxyTotalPages }}</span>
              <button class="page-btn" :disabled="proxyPage >= proxyTotalPages" @click="goProxyPage(proxyPage + 1)">下一页</button>
              <button class="page-btn" :disabled="proxyPage >= proxyTotalPages" @click="goProxyPage(proxyTotalPages)">末页</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 邮箱域名后缀 -->
    <div v-show="activeTab === 'domains'" class="settings-grid">
      <div class="card">
        <div class="card-title">邮箱域名后缀策略</div>
        <div class="form-item">
          <label>策略模式</label>
          <select v-model="domainForm.mode" class="input">
            <option value="all">不限制(全部允许)</option>
            <option value="whitelist">白名单(仅允许列出的后缀)</option>
            <option value="blacklist">黑名单(禁用列出的后缀)</option>
          </select>
        </div>
        <div class="form-item" v-show="domainForm.mode === 'whitelist'">
          <label>允许的域名后缀(每行一个,如 outlook.com)</label>
          <textarea v-model="domainForm.allowText" class="input" rows="6" placeholder="outlook.com&#10;hotmail.com&#10;mail.com"></textarea>
        </div>
        <div class="form-item" v-show="domainForm.mode === 'blacklist'">
          <label>禁用的域名后缀(每行一个)</label>
          <textarea v-model="domainForm.denyText" class="input" rows="6" placeholder="qq.com&#10;163.com"></textarea>
        </div>
        <button class="btn" @click="saveDomains" :disabled="savingDomains">保存域名策略</button>
        <p class="hint">导入邮箱时会按此策略过滤:白名单只保留列出的后缀,黑名单会剔除列出的后缀。</p>
      </div>

      <div class="card">
        <div class="card-title">mail.com / CF 注册比例</div>
        <div class="two-col">
          <div class="form-item">
            <label>mail.com 份数</label>
            <input v-model.number="registrationForm.mailcom_share" type="number" min="0" max="100" class="input" />
          </div>
          <div class="form-item">
            <label>CF 邮箱份数</label>
            <input v-model.number="registrationForm.cfworker_share" type="number" min="0" max="100" class="input" />
          </div>
        </div>
        <p class="hint" style="margin-top: 0">
          流水线自动注册按这个比例拆分。例如 mail.com 5、CF 5，注册 100 个就是 mail.com 50 个、CF 50 个。
          按当前比例，注册 100 个：mail.com {{ mixPreview100.mailcom }} 个，CF {{ mixPreview100.cfworker }} 个。
        </p>
        <button class="btn" @click="saveMailMix" :disabled="savingRegistration">保存比例</button>
      </div>

      <div class="card">
        <div class="card-title">每个后缀的邮箱额度（mail.com + CF 共用）</div>
        <div class="two-col">
          <div class="form-item">
            <label>每小时每个后缀最多几个邮箱</label>
            <input v-model.number="suffixQuotaForm.hourly" type="number" min="0" max="10000" class="input" />
          </div>
          <div class="form-item">
            <label>每天每个后缀最多几个邮箱</label>
            <input v-model.number="suffixQuotaForm.daily" type="number" min="0" max="10000" class="input" />
          </div>
        </div>
        <p class="hint" style="margin-top: 0">
          0 表示不限制。按<strong>每个域名后缀单独计数</strong>：这个小时/当天，该后缀最多拉这么多个子号、或拿这么多个邮箱去注册。
          mail.com 拉子号算「生成」，拿子号去注册算「注册」；CF 生成地址并注册两项一起算。到上限后换其它后缀，不会再往这个后缀加。
          本小时单后缀最高：生成 {{ settings.suffix_quota?.hour_generated_peak || 0 }} / 注册 {{ settings.suffix_quota?.hour_registered_peak || 0 }}{{ suffixQuotaForm.hourly ? '（上限 ' + suffixQuotaForm.hourly + '）' : '（不限）' }}
          ；今日最高：生成 {{ settings.suffix_quota?.day_generated_peak || 0 }} / 注册 {{ settings.suffix_quota?.day_registered_peak || 0 }}{{ suffixQuotaForm.daily ? '（上限 ' + suffixQuotaForm.daily + '）' : '（不限）' }}。
        </p>
        <button class="btn" @click="saveSuffixQuota" :disabled="savingSuffixQuota">保存额度</button>
      </div>

      <div class="card" style="grid-column: 1 / -1">
        <div class="card-title">当前可用邮箱后缀</div>
        <p class="hint" style="margin-top: 0">mail.com 已启用后缀与 CF 已启用收信域。关掉的不会出现在这里，也不会被拉号或注册使用。</p>
        <div class="suffix-grid">
          <span v-for="name in availableSuffixNames" :key="name" class="suffix-item">
            <span class="suffix-main"><span class="mono">{{ name }}</span></span>
          </span>
        </div>
        <p v-if="!availableSuffixNames.length" class="hint">还没有启用的后缀。请在本页打开 CF 域名，或到「邮箱轮询 / 后缀」启用 mail.com 后缀。</p>
      </div>

      <div class="card" style="grid-column: 1 / -1">
        <div class="page-header" style="margin-bottom: 12px">
          <div class="card-title" style="margin: 0">
            CF 收信域名
            <span class="tag tag-blue">启用 {{ enabledCfCount }} / {{ cfDomainItems.length }}</span>
            <span v-if="settings.cfworker_mail?.ready" class="tag tag-green">已接入</span>
            <span v-else class="tag tag-gray">未接入</span>
          </div>
          <div class="toolbar">
            <input v-model.trim="cfDomainDraft" class="input" style="width: 220px" placeholder="添加域名，如 mail.example.com" />
            <button class="btn btn-ghost btn-sm" type="button" @click="addCfDomain">添加</button>
            <button class="btn btn-ghost btn-sm" @click="setAllCfDomains(true)">全部启用</button>
            <button class="btn btn-ghost btn-sm" @click="setAllCfDomains(false)">全部禁用</button>
            <button class="btn btn-sm" @click="saveCfDomains" :disabled="savingCfDomains">保存 CF 域名</button>
          </div>
        </div>
        <p class="hint" style="margin: 0 0 12px">
          关掉或拉黑的域名后缀不会再用来生成 CF 注册邮箱。OpenAI 拒绝创建账号时也会自动禁用该后缀，和 mail.com 一样。
          <a v-if="settings.cfworker_mail?.api_url" :href="settings.cfworker_mail.api_url" target="_blank" rel="noopener">打开 CF 邮箱管理面板</a>
        </p>
        <div class="guide-box">
          <b>阿里云域名要这样解析才会生效</b>
          <ol>
            <li>先在同一个 Cloudflare 账号添加站点。</li>
            <li>复制该站点两台 NS，形如 <code>xxx.ns.cloudflare.com</code>。</li>
            <li>阿里云 → 域名 → 管理 → <b>DNS 修改</b>（不是「云解析 DNS」里加 MX）。</li>
            <li>把 DNS 服务器改成那两台。只加 MX、NS 不改，邮件进不了 Worker。</li>
            <li>点「测试解析」：NS 应是 Cloudflare，MX 应是 <code>route1/2/3.mx.cloudflare.net</code>。</li>
          </ol>
        </div>
        <div class="form-item" style="margin-top: 12px">
          <label>批量添加域名（每行一个，也可用逗号分隔）</label>
          <textarea v-model="cfDomainBulk" class="input" rows="4" placeholder="mail.example.com"></textarea>
        </div>
        <div class="toolbar" style="margin-bottom: 12px">
          <button class="btn" type="button" :disabled="addingCfBulk" @click="addCfBulkAndTest">批量加入并检测</button>
          <button class="btn btn-ghost" type="button" :disabled="testingCfDomains" @click="testCfDomains">测试解析</button>
        </div>
        <p v-if="cfDomainWarning" class="hint">{{ cfDomainWarning }}</p>
        <div v-if="cfDomainTests.length" class="suffix-grid" style="max-height: none; margin-bottom: 12px">
          <div v-for="row in cfDomainTests" :key="'t-'+row.domain" class="suffix-item" :class="{ blocked: !row.ok }">
            <span class="suffix-main">
              <span class="suffix-name"><span class="mono">{{ row.domain }}</span>
                <span class="tag" :class="row.ok ? 'tag-green' : 'tag-red'">{{ row.ok ? '通过' : '未就绪' }}</span>
              </span>
              <span class="suffix-stats">{{ row.message }}</span>
            </span>
          </div>
        </div>
        <div class="suffix-grid">
          <label
            v-for="it in cfDomainItems"
            :key="it.domain"
            class="suffix-item"
            :class="{ off: !it.enabled }"
          >
            <span class="suffix-main">
              <span class="suffix-name">
                <span class="mono">{{ it.domain }}</span>
                <span v-if="cfTestByDomain[it.domain]" class="tag" :class="cfTestByDomain[it.domain].ok ? 'tag-green' : 'tag-red'">
                  {{ cfTestByDomain[it.domain].ok ? '解析通过' : '解析未就绪' }}
                </span>
              </span>
            </span>
            <input type="checkbox" v-model="it.enabled" />
          </label>
        </div>
        <p v-if="!cfDomainItems.length" class="hint">还没有 CF 域名。接入 Worker 后会显示账号里的收信域。</p>
      </div>
    </div>

    <!-- 邮箱轮询(mail.com) -->
    <div v-show="activeTab === 'mailcom'">
      <div class="settings-grid" style="max-width: none">
        <div class="card">
          <div class="card-title">
            mail.com 协议与轮询
            <span class="tag tag-green">OAuth 公钥已内置</span>
          </div>
          <div class="form-item">
            <label>mail.com 代理分组</label>
            <select v-model="mailcomForm.proxy_group" class="input">
              <option value="">直连（不使用代理）</option>
              <option v-for="g in proxyGroups" :key="g.group_name" :value="g.group_name">
                {{ g.group_name }} ({{ g.count }})
              </option>
            </select>
          </div>
          <div class="two-col">
            <div class="form-item">
              <label>轮询间隔(分钟,0=关闭)</label>
              <input v-model.number="mailcomForm.poll_minutes" type="number" min="0" max="1440" class="input" />
            </div>
            <div class="form-item">
              <label>每个母号地址上限(含母号)</label>
              <input v-model.number="mailcomForm.cap" type="number" min="2" max="10" class="input" />
            </div>
          </div>
          <div class="two-col">
            <div class="form-item">
              <label>自动删除已使用子号</label>
              <select v-model="mailcomForm.auto_delete_used" class="input">
                <option :value="false">关闭</option>
                <option :value="true">开启</option>
              </select>
            </div>
            <div class="form-item">
              <label>删除后自动拉满子号</label>
              <select v-model="mailcomForm.auto_repull" class="input">
                <option :value="false">关闭</option>
                <option :value="true">开启</option>
              </select>
            </div>
          </div>
          <button class="btn" @click="saveMailcom" :disabled="savingMailcom">保存轮询配置</button>
          <p class="hint">
            收件/拉子号走 mail.com 网页协议(OAuth 公钥已内置,无需填写)。「直连」不会回退到注册、支付、验活或动态代理（IPRocket）。仅在明确选择代理分组后，每次操作会从该组固定使用一条 HTTP/HTTPS/SOCKS5 代理，并仅在传输或 halogin 失败时轮换；SOCKS5 由代理端解析域名。IMAP 回退保持直连。开启轮询后,到点会自动同步子号;「自动删除已用」会清掉已使用子号,配合「自动拉满」按下方启用的后缀补齐。
          </p>
        </div>
      </div>

      <div class="card" style="margin-top: 20px">
        <div class="page-header" style="margin-bottom: 12px">
          <div class="card-title" style="margin: 0">
            拉子号后缀
            <span class="tag tag-blue">可拉 {{ enabledSuffixCount }} / {{ suffixItems.length }}</span>
            <span v-if="unavailableEnabledCount" class="tag tag-red">不允许 {{ unavailableEnabledCount }}</span>
          </div>
          <div class="toolbar">
            <input v-model.trim="suffixQuery" class="input" style="width: 200px" placeholder="搜索后缀" />
            <select v-model="suffixView" class="input" style="width: 150px">
              <option value="all">全部后缀</option>
              <option value="enabled">仅已启用</option>
              <option value="unavailable">不允许的</option>
            </select>
            <button class="btn btn-ghost btn-sm" @click="setAllSuffixes(true)">全部启用</button>
            <button class="btn btn-ghost btn-sm" @click="setAllSuffixes(false)">全部禁用</button>
            <button class="btn btn-ghost btn-sm" @click="setDefaultSuffixes">仅默认拉子</button>
            <button
              class="btn btn-ghost btn-sm btn-danger"
              :disabled="!unavailableEnabledCount || savingMailcom"
              @click="disableUnavailableSuffixes"
            >
              一键禁用不允许的后缀
            </button>
            <button class="btn btn-sm" @click="saveMailcom" :disabled="savingMailcom">保存后缀</button>
          </div>
        </div>
        <p class="hint" style="margin: 0 0 12px">关掉的后缀不会再用来拉子号。拉子号与注册会在启用后缀里加权随机，尽量避开当前用得最多的那个；样本够时更偏向试用/提链成功率高的后缀。每个后缀会显示邮箱数、试用资格成功率、提链成功率。</p>
        <div class="suffix-grid">
          <label
            v-for="it in pagedSuffixes"
            :key="it.suffix"
            class="suffix-item"
            :class="{ off: !it.enabled, blocked: it.unavailable }"
            :title="it.last_error || unavailableReasonText(it)"
          >
            <span class="suffix-main">
              <span class="suffix-name">
                <span class="mono">{{ it.suffix }}</span>
                <span v-if="it.unavailable" class="tag tag-red">不允许{{ it.unavailable_count ? ' ×' + it.unavailable_count : '' }}</span>
              </span>
              <span class="suffix-stats">
                邮箱 {{ it.mailbox_count || 0 }}
                · 试用 {{ formatSuffixRate(it.trial_rate, it.trial_yes, it.trial_detected) }}
                · 提链 {{ formatSuffixRate(it.extract_rate, it.extract_ok, it.account_count) }}
              </span>
            </span>
            <input type="checkbox" v-model="it.enabled" />
          </label>
        </div>
        <p v-if="!filteredSuffixes.length" class="hint">没有匹配的后缀</p>
        <div class="pagination">
          <div class="pagination-info">
            共 {{ filteredSuffixes.length }} 条{{ filteredSuffixes.length ? `,当前 ${suffixRangeStart}-${suffixRangeEnd}` : '' }}
          </div>
          <div class="pagination-actions">
            <label class="page-size">
              每页
              <select v-model.number="suffixPageSize" class="input" style="width: 80px" @change="changeSuffixPageSize">
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
                <option :value="200">200</option>
              </select>
              条
            </label>
            <div class="pagination-btns">
              <button class="page-btn" :disabled="suffixPage <= 1" @click="suffixPage = 1">首页</button>
              <button class="page-btn" :disabled="suffixPage <= 1" @click="suffixPage -= 1">上一页</button>
              <span class="page-current">{{ suffixPage }} / {{ suffixTotalPages }}</span>
              <button class="page-btn" :disabled="suffixPage >= suffixTotalPages" @click="suffixPage += 1">下一页</button>
              <button class="page-btn" :disabled="suffixPage >= suffixTotalPages" @click="suffixPage = suffixTotalPages">末页</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 代理新增/编辑弹窗 -->
    <Modal
      :show="proxyModal"
      :title="proxyEditing ? '编辑代理' : '新增代理'"
      confirmText="保存"
      @close="proxyModal = false"
      @confirm="saveProxy"
    >
      <div class="two-col">
        <div class="form-item"><label>分组</label><input v-model="proxyForm.group_name" class="input" placeholder="默认分组" /></div>
        <div class="form-item">
          <label>类型</label>
          <select v-model="proxyForm.proxy_type" class="input">
            <option value="http">http</option>
            <option value="https">https</option>
            <option value="socks5">socks5</option>
          </select>
        </div>
      </div>
      <div class="two-col">
        <div class="form-item"><label>主机</label><input v-model="proxyForm.host" class="input" placeholder="1.2.3.4" /></div>
        <div class="form-item"><label>端口</label><input v-model.number="proxyForm.port" type="number" class="input" placeholder="8080" /></div>
      </div>
      <div class="two-col">
        <div class="form-item"><label>账号(可选)</label><input v-model="proxyForm.username" class="input" /></div>
        <div class="form-item"><label>密码(可选)</label><input v-model="proxyForm.password" class="input" placeholder="留空不修改" /></div>
      </div>
      <div class="form-item"><label>备注</label><input v-model="proxyForm.remark" class="input" /></div>
    </Modal>

    <!-- 代理批量导入弹窗 -->
    <Modal
      :show="proxyImportModal"
      title="批量导入代理"
      :loading="importingProxy"
      confirmText="开始导入"
      @close="proxyImportModal = false"
      @confirm="submitProxyImport"
    >
      <div class="form-item">
        <label>导入到分组</label>
        <input v-model="proxyImportGroup" class="input" placeholder="默认分组" />
      </div>
      <div class="form-item">
        <label>代理列表(每行一条)</label>
        <textarea v-model="proxyImportText" class="input" rows="8"
          placeholder="支持:&#10;socks5://user:pass@host:port&#10;socks5h://user:pass@host:port&#10;http://user:pass@host:port&#10;user:pass@host:port&#10;host:port:user:pass&#10;host:port"></textarea>
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useAuthStore } from '../stores/auth';
import { toast } from '../utils/toast';
import Modal from '../components/Modal.vue';
import { confirmDialog } from '../utils/confirm';
import { splitMailMix } from '../utils/registerUi';
import { formatExpiresAt, formatShanghaiDateTime } from '../utils/datetime';

const router = useRouter();
const auth = useAuthStore();

const tabs = [
  { key: 'account', label: '账户 / 密码' },
  { key: 'cloak', label: 'Cloak / 验活' },
  { key: 'sms', label: '接码平台' },
  { key: 'providers', label: '注册供应商 / 动态代理' },
  { key: 'proxy', label: '代理管理' },
  { key: 'domains', label: '邮箱域名' },
  { key: 'mailcom', label: '邮箱轮询 / 后缀' },
];
const activeTab = ref('account');

const profile = ref(null);
const saving = ref(false);
const pwd = reactive({ oldPassword: '', newPassword: '', confirm: '' });

const settings = reactive({
  cloak: { license_configured: false, license_count: 0, headless: true, max_concurrency: 3, humanize: true },
  registration: { set_password: true, enable_totp_2fa: true, performance_profile: 'safe', attempts: 3 },
  sms: { provider: 'auto', api_url: '', api_key_configured: false, country: 'usa', product: 'openai' },
  email_domains: { mode: 'all', allow: [], deny: [] },
  mailcom: { oauth_builtin: true, proxy_group: '', poll_minutes: 0, auto_delete_used: false, auto_repull: false, cap: 10, suffixes: [], enabled_count: 0, unavailable_enabled_count: 0, suffix_total: 0 },
  accounts: { detect_poll_minutes: 15, detect_proxy_group: '' },
  import_dump: { configured: false },
  pipeline: {
    daily_register_limit: 0, register_concurrency: 5, extract_attempts: 5, extract_interval_minutes: 10,
    pay_attempts: 5, rt_attempts: 5,
  },
  nvtokens: { auto_list_plus: false, min_price_yuan: '20.00', api_key_configured: false, session_configured: false, has_session: false, session_last4: '' },
  herosms: { api_url: '', api_key_configured: false, country: '', service: '', domain: '' },
  smsbower: { api_url: '', api_key_configured: false, country: '', service: '', domain: '' },
  cfworker_mail: { api_url: '', api_key_configured: false, domain: '' },
  dynamic_proxy: { active_pool: '1024proxy', providers: {} },
});
const cloakForm = reactive({ license_key: '', headless: true, max_concurrency: 3, humanize: true });
const cloakLicenseLabel = computed(() => {
  if (!settings.cloak.license_configured) return '未配置';
  const count = Number(settings.cloak.license_count) || 0;
  return count > 1 ? `已配置 ${count} 个` : '已配置';
});
const registrationForm = reactive({
  set_password: true, enable_totp_2fa: true, performance_profile: 'safe', attempts: 3,
  mail_provider: 'mailcom', mailcom_share: 5, cfworker_share: 5,
});
const mixPreview100 = computed(() => splitMailMix(100, registrationForm.mailcom_share, registrationForm.cfworker_share));
const accountsForm = reactive({ detect_poll_minutes: 15, detect_proxy_group: '' });
const pipelineForm = reactive({
  daily_register_limit: 0,
  register_concurrency: 5,
  extract_attempts: 5,
  extract_interval_minutes: 10,
  pay_attempts: 5,
  rt_attempts: 5,
});
const nvtokensForm = reactive({
  auto_list_plus: false,
  min_price_yuan: '20.00',
  api_key: '',
  session_cookie: '',
});
const importDumpForm = reactive({ url: '', api_key: '' });
const mailcomForm = reactive({ proxy_group: '', poll_minutes: 0, auto_delete_used: false, auto_repull: false, cap: 10 });
const suffixItems = ref([]);
const suffixQuery = ref('');
const suffixView = ref('all');
const suffixPage = ref(1);
const suffixPageSize = ref(10);
const enabledSuffixCount = computed(() => suffixItems.value.filter((it) => it.enabled).length);
const unavailableEnabledCount = computed(() => suffixItems.value.filter((it) => it.enabled && it.unavailable).length);
function suffixRank(it) {
  if (it.unavailable && it.enabled) return 0;
  if (it.unavailable) return 1;
  if (it.enabled) return 2;
  return 3;
}
function mapSuffixItem(it) {
  return {
    suffix: it.suffix,
    enabled: !!it.enabled,
    unavailable: !!it.unavailable,
    unavailable_count: Number(it.unavailable_count) || 0,
    unavailable_reason: it.unavailable_reason || '',
    last_error: it.last_error || '',
    mailbox_count: Number(it.mailbox_count) || 0,
    unused_count: Number(it.unused_count) || 0,
    account_count: Number(it.account_count) || 0,
    trial_detected: Number(it.trial_detected) || 0,
    trial_yes: Number(it.trial_yes) || 0,
    trial_rate: it.trial_rate == null ? null : Number(it.trial_rate),
    extract_ok: Number(it.extract_ok) || 0,
    extract_rate: it.extract_rate == null ? null : Number(it.extract_rate),
  };
}
function formatSuffixRate(rate, yes, total) {
  const n = Number(total) || 0;
  if (!n) return '—';
  const pct = Math.round((Number(rate) || 0) * 100);
  return `${pct}%（${Number(yes) || 0}/${n}）`;
}
function unavailableReasonText(it) {
  if (it.unavailable_reason === 'not_in_listDomains') return '该账号后缀目录未开放';
  if (it.unavailable_reason === 'http_400') return it.last_error || '添加别名 HTTP 400';
  if (it.unavailable_reason === 'validate_rejected') return 'mail.com 校验拒绝';
  return it.last_error || '';
}
const filteredSuffixes = computed(() => {
  const q = suffixQuery.value.toLowerCase();
  return suffixItems.value
    .filter((it) => {
      if (suffixView.value === 'enabled' && !it.enabled) return false;
      if (suffixView.value === 'unavailable' && !it.unavailable) return false;
      if (q && !it.suffix.includes(q)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => suffixRank(a) - suffixRank(b) || a.suffix.localeCompare(b.suffix));
});
const suffixTotalPages = computed(() => Math.max(1, Math.ceil(filteredSuffixes.value.length / suffixPageSize.value)));
const suffixRangeStart = computed(() => (filteredSuffixes.value.length ? (suffixPage.value - 1) * suffixPageSize.value + 1 : 0));
const suffixRangeEnd = computed(() => Math.min(suffixPage.value * suffixPageSize.value, filteredSuffixes.value.length));
const pagedSuffixes = computed(() => {
  const start = (suffixPage.value - 1) * suffixPageSize.value;
  return filteredSuffixes.value.slice(start, start + suffixPageSize.value);
});
watch(suffixQuery, () => {
  suffixPage.value = 1;
});
watch(suffixView, () => {
  suffixPage.value = 1;
});
function changeSuffixPageSize() {
  suffixPage.value = 1;
}
const DEFAULT_PULL = [
  'brew-meister.com', 'pacific-ocean.com', 'deliveryman.com', 'dr.com', 'computer4u.com',
  'homemail.com', 'salesperson.net', 'clubmember.org', 'usa.com', 'toke.com',
];
function setAllSuffixes(on) {
  suffixItems.value.forEach((it) => { it.enabled = on; });
}
function setDefaultSuffixes() {
  const allow = new Set(DEFAULT_PULL);
  suffixItems.value.forEach((it) => { it.enabled = allow.has(it.suffix); });
}
async function disableUnavailableSuffixes() {
  const n = unavailableEnabledCount.value;
  if (!n) return;
  const ok = await confirmDialog({
    title: '禁用不允许的后缀',
    message: `将禁用 ${n} 个该账号未开放或添加被拒的后缀，保存后不再用来拉子号。`,
    confirmText: '禁用并保存',
    danger: true,
  });
  if (!ok) return;
  suffixItems.value.forEach((it) => {
    if (it.unavailable) it.enabled = false;
  });
  await saveMailcom();
}
const savingMailcom = ref(false);
const savingCloak = ref(false);
const savingRegistration = ref(false);
const savingCfDomains = ref(false);
const savingSuffixQuota = ref(false);
const suffixQuotaForm = reactive({ hourly: 0, daily: 0 });
const cfDomainItems = ref([]);
const cfDomainDraft = ref('');
const cfDomainBulk = ref('');
const cfDomainTests = ref([]);
const cfDomainWarning = ref('');
const addingCfBulk = ref(false);
const testingCfDomains = ref(false);
const enabledCfCount = computed(() => cfDomainItems.value.filter((it) => it.enabled).length);
const cfTestByDomain = computed(() => {
  const map = {};
  for (const row of cfDomainTests.value) {
    if (row?.domain) map[row.domain] = row;
  }
  return map;
});
const availableSuffixNames = computed(() => {
  const names = new Set();
  for (const item of suffixItems.value) {
    if (item.enabled && item.suffix) names.add(item.suffix);
  }
  for (const item of cfDomainItems.value) {
    if (item.enabled && item.domain) names.add(item.domain);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});
const savingAccounts = ref(false);
const savingPipeline = ref(false);
const savingNvtokens = ref(false);
const listingPlus = ref(false);
const testingNvtokensPrice = ref(false);
const nvtokensPriceHint = ref('');
const savingImportDump = ref(false);
const dumpingNoTrial = ref(false);
const dumpingAllAccounts = ref(false);
const smsForm = reactive({ provider: '', api_url: '', api_key: '', country: '', product: '' });
const savingSms = ref(false);
const savingProviders = ref(false);
const savingDynamicProxy = ref(false);
const providerForms = reactive({
  herosms: {
    api_url: '', api_key: '', country: 'usa', service: 'openai', domain: 'outlook.com',
    requests_per_second: 12, max_request_concurrency: 16, max_active_activations: 20,
    acquire_attempts: 3, max_reorders: 4, max_transient_retries: 2,
    transient_retry_base_ms: 500, ban_cooldown_ms: 1800000, rate_cooldown_ms: 12000,
  },
  smsbower: { api_url: '', api_key: '', country: '', service: 'dr', domain: '' },
  cfworker_mail: { api_url: '', api_key: '', country: '', domain: '' },
});
const providerCards = computed(() => [
  { id: 'herosms', label: 'HeroSMS', configured: Boolean(settings.herosms?.api_key_configured) },
  { id: 'smsbower', label: 'SMSBower', configured: Boolean(settings.smsbower?.api_key_configured) },
  { id: 'cfworker_mail', label: 'CF Worker 域名邮箱', configured: Boolean(settings.cfworker_mail?.api_key_configured) },
]);
const dynamicProxyForm = reactive({
  active_pool: '1024proxy',
  providers: Object.fromEntries(['1024proxy', 'b2proxy', 'cliproxy', 'iprocket'].map(id => [
    id, { username: '', password: '', sticky_minutes: 30 },
  ])),
});
const dynamicProxyProviders = computed(() => (
  [
    ['1024proxy', '1024proxy'], ['b2proxy', 'b2proxy'],
    ['cliproxy', 'CliProxy'], ['iprocket', 'IPRocket'],
  ].map(([id, label]) => ({
    id, label,
    configured: Boolean(settings.dynamic_proxy?.providers?.[id]?.password_configured
      && settings.dynamic_proxy?.providers?.[id]?.username),
  }))
));
const domainForm = reactive({ mode: 'all', allowText: '', denyText: '' });
const savingDomains = ref(false);

const proxies = ref([]);
const proxyGroups = ref([]);
const proxyGroupFilter = ref('');
const selectedProxies = ref([]);
const proxyPage = ref(1);
const proxyPageSize = ref(10);
const proxyTotal = ref(0);
const testingProxy = reactive({});
const proxyModal = ref(false);
const proxyEditing = ref(null);
const proxyForm = reactive({ group_name: '默认分组', proxy_type: 'http', host: '', port: null, username: '', password: '', remark: '' });
const proxyImportModal = ref(false);
const proxyImportText = ref('');
const proxyImportGroup = ref('默认分组');
const importingProxy = ref(false);

const proxyTotalPages = computed(() => Math.max(1, Math.ceil(proxyTotal.value / proxyPageSize.value)));
const proxyRangeStart = computed(() => (proxyTotal.value ? (proxyPage.value - 1) * proxyPageSize.value + 1 : 0));
const proxyRangeEnd = computed(() => Math.min(proxyPage.value * proxyPageSize.value, proxyTotal.value));

onMounted(async () => {
  await Promise.all([loadProfile(), loadSettings(), loadProxies(), loadProxyGroups()]);
});

async function loadProfile() {
  try {
    profile.value = await api.get('/profile');
  } catch (e) {
    toast.error(e.message);
  }
}

async function loadSettings() {
  try {
    const s = await api.get('/settings');
    Object.assign(settings, s);
    cloakForm.headless = s.cloak.headless;
    cloakForm.max_concurrency = s.cloak.max_concurrency;
    cloakForm.humanize = s.cloak.humanize !== false;
    Object.assign(registrationForm, s.registration || {});
    smsForm.provider = s.sms.provider;
    smsForm.api_url = s.sms.api_url;
    smsForm.country = s.sms.country;
    smsForm.product = s.sms.product;
    for (const id of ['herosms', 'smsbower', 'cfworker_mail']) {
      Object.assign(providerForms[id], s[id] || {}, { api_key: '' });
    }
    dynamicProxyForm.active_pool = s.dynamic_proxy?.active_pool || '1024proxy';
    for (const id of Object.keys(dynamicProxyForm.providers)) {
      Object.assign(dynamicProxyForm.providers[id], s.dynamic_proxy?.providers?.[id] || {}, { password: '' });
    }
    domainForm.mode = s.email_domains.mode;
    domainForm.allowText = (s.email_domains.allow || []).join('\n');
    domainForm.denyText = (s.email_domains.deny || []).join('\n');
    applyCfDomains(s.cfworker_mail?.domains);
    try {
      const remote = await api.get('/settings/cfworker-mail/domains');
      const have = new Set(cfDomainItems.value.map((it) => it.domain));
      for (const domain of remote.domains || []) {
        if (domain && !have.has(domain)) {
          have.add(domain);
          cfDomainItems.value.push({ domain, enabled: true });
        }
      }
    } catch {
      // Worker 未配置或暂时不可达时仍显示本地列表
    }
    if (s.suffix_quota) {
      suffixQuotaForm.hourly = Number(s.suffix_quota.hourly) || 0;
      suffixQuotaForm.daily = Number(s.suffix_quota.daily) || 0;
    }
    if (s.mailcom) {
      mailcomForm.proxy_group = s.mailcom.proxy_group || '';
      mailcomForm.poll_minutes = s.mailcom.poll_minutes;
      mailcomForm.cap = s.mailcom.cap;
      mailcomForm.auto_delete_used = s.mailcom.auto_delete_used;
      mailcomForm.auto_repull = s.mailcom.auto_repull;
      suffixItems.value = (s.mailcom.suffixes || []).map(mapSuffixItem);
    }
    if (s.accounts) {
      accountsForm.detect_poll_minutes = s.accounts.detect_poll_minutes;
      accountsForm.detect_proxy_group = s.accounts.detect_proxy_group || '';
    }
    if (s.pipeline) {
      pipelineForm.daily_register_limit = s.pipeline.daily_register_limit ?? 0;
      pipelineForm.register_concurrency = s.pipeline.register_concurrency ?? 5;
      pipelineForm.extract_attempts = s.pipeline.extract_attempts || 5;
      pipelineForm.extract_interval_minutes = s.pipeline.extract_interval_minutes ?? 10;
      pipelineForm.pay_attempts = s.pipeline.pay_attempts || 5;
      pipelineForm.rt_attempts = s.pipeline.rt_attempts || 5;
    }
    if (s.nvtokens) {
      nvtokensForm.auto_list_plus = false;
      nvtokensForm.min_price_yuan = s.nvtokens.min_price_yuan || '20.00';
    }
  } catch (e) {
    toast.error(e.message);
  }
}

async function changePassword() {
  if (!pwd.oldPassword || !pwd.newPassword) return toast.error('请填写完整');
  if (pwd.newPassword.length < 6) return toast.error('新密码长度至少 6 位');
  if (pwd.newPassword !== pwd.confirm) return toast.error('两次输入的新密码不一致');
  saving.value = true;
  try {
    await api.put('/profile/password', { oldPassword: pwd.oldPassword, newPassword: pwd.newPassword });
    toast.success('密码已修改,请重新登录');
    setTimeout(() => {
      auth.logout();
      router.push({ name: 'login' });
    }, 1200);
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function saveRegistration() {
  savingRegistration.value = true;
  try {
    const s = await api.put('/settings/registration', { ...registrationForm });
    Object.assign(settings, s);
    if (s.registration) Object.assign(registrationForm, s.registration);
    toast.success('注册邮箱与比例已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingRegistration.value = false;
  }
}

function mailProviderFromShares(mailShare, cfShare) {
  if (cfShare > 0 && mailShare > 0) return 'mix';
  if (cfShare > 0) return 'cfworker';
  return registrationForm.mail_provider === 'cfworker' || registrationForm.mail_provider === 'mix'
    ? 'mailcom'
    : registrationForm.mail_provider;
}

async function saveMailMix() {
  savingRegistration.value = true;
  try {
    const mailcom_share = Math.max(0, Math.min(100, Number(registrationForm.mailcom_share) || 0));
    const cfworker_share = Math.max(0, Math.min(100, Number(registrationForm.cfworker_share) || 0));
    const mail_provider = mailProviderFromShares(mailcom_share, cfworker_share);
    const s = await api.put('/settings/registration', { mailcom_share, cfworker_share, mail_provider });
    Object.assign(settings, s);
    if (s.registration) Object.assign(registrationForm, s.registration);
    toast.success('mail.com / CF 比例已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingRegistration.value = false;
  }
}

function applyCfDomains(list) {
  cfDomainItems.value = (Array.isArray(list) ? list : []).map((it) => ({
    domain: String(it.domain || it.suffix || '').trim().toLowerCase(),
    enabled: it.enabled !== false,
  })).filter((it) => it.domain);
}

function setAllCfDomains(on) {
  cfDomainItems.value.forEach((it) => { it.enabled = on; });
}

function addCfDomain() {
  const domain = String(cfDomainDraft.value || '').trim().toLowerCase().replace(/^@/, '');
  if (!domain) return;
  if (cfDomainItems.value.some((it) => it.domain === domain)) {
    toast.error('该域名已在列表中');
    return;
  }
  cfDomainItems.value.push({ domain, enabled: true });
  cfDomainDraft.value = '';
}

async function saveCfDomains() {
  savingCfDomains.value = true;
  try {
    const s = await api.put('/settings/registration-providers', {
      cfworker_mail: { domains: cfDomainItems.value },
    });
    Object.assign(settings, s);
    applyCfDomains(s.cfworker_mail?.domains);
    toast.success('CF 收信域名已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingCfDomains.value = false;
  }
}

async function addCfBulkAndTest() {
  addingCfBulk.value = true;
  cfDomainWarning.value = '';
  try {
    const s = await api.post('/settings/cfworker-mail/domains', { text: cfDomainBulk.value, test: true });
    Object.assign(settings, s);
    applyCfDomains(s.cfworker_mail?.domains);
    cfDomainTests.value = s.worker?.results || [];
    cfDomainBulk.value = '';
    cfDomainWarning.value = s.warning || '';
    if (s.warning) toast.error(s.warning);
    else toast.success('已加入域名并完成检测');
  } catch (e) {
    toast.error(e.message);
  } finally {
    addingCfBulk.value = false;
  }
}

async function testCfDomains() {
  testingCfDomains.value = true;
  cfDomainWarning.value = '';
  try {
    const payload = cfDomainBulk.value.trim()
      ? { text: cfDomainBulk.value }
      : { domains: cfDomainItems.value.map((it) => it.domain) };
    const data = await api.post('/settings/cfworker-mail/test', payload);
    cfDomainTests.value = data.results || [];
    const failed = cfDomainTests.value.filter((row) => !row.ok).length;
    toast.success(failed ? `检测完成，${failed} 个未就绪` : '检测完成，解析均指向 Cloudflare');
  } catch (e) {
    toast.error(e.message);
  } finally {
    testingCfDomains.value = false;
  }
}

async function saveCloak() {
  savingCloak.value = true;
  try {
    const s = await api.put('/settings/cloak', {
      license_key: cloakForm.license_key,
      headless: cloakForm.headless,
      max_concurrency: cloakForm.max_concurrency,
      humanize: cloakForm.humanize !== false,
    });
    await api.put('/settings/registration', { ...registrationForm });
    Object.assign(settings, s);
    cloakForm.license_key = '';
    toast.success('授权已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingCloak.value = false;
  }
}

async function saveAccountsDetect() {
  savingAccounts.value = true;
  try {
    const s = await api.put('/settings/accounts', { ...accountsForm });
    Object.assign(settings, s);
    if (s.accounts) {
      accountsForm.detect_poll_minutes = s.accounts.detect_poll_minutes;
      accountsForm.detect_proxy_group = s.accounts.detect_proxy_group || '';
    }
    toast.success('验活配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingAccounts.value = false;
  }
}

async function savePipelineLimits() {
  savingPipeline.value = true;
  try {
    const s = await api.put('/settings/pipeline', { ...pipelineForm });
    Object.assign(settings, s);
    if (s.pipeline) {
      pipelineForm.daily_register_limit = s.pipeline.daily_register_limit ?? 0;
      pipelineForm.register_concurrency = s.pipeline.register_concurrency ?? 5;
      pipelineForm.extract_attempts = s.pipeline.extract_attempts || 5;
      pipelineForm.extract_interval_minutes = s.pipeline.extract_interval_minutes ?? 10;
      pipelineForm.pay_attempts = s.pipeline.pay_attempts || 5;
      pipelineForm.rt_attempts = s.pipeline.rt_attempts || 5;
    }
    toast.success('流水线上限已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingPipeline.value = false;
  }
}

async function saveNvtokens() {
  savingNvtokens.value = true;
  try {
    const s = await api.put('/settings/nvtokens', { ...nvtokensForm, auto_list_plus: false });
    Object.assign(settings, s);
    nvtokensForm.api_key = '';
    nvtokensForm.session_cookie = '';
    if (s.nvtokens) {
      nvtokensForm.auto_list_plus = false;
      nvtokensForm.min_price_yuan = s.nvtokens.min_price_yuan || '20.00';
    }
    toast.success('上架配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingNvtokens.value = false;
  }
}

async function runNvtokensList() {
  listingPlus.value = true;
  try {
    const data = await api.post('/settings/nvtokens/list-now');
    if (data.skipped && data.reason === 'no_key') return toast.error('请先保存库存 API Key');
    toast.success(`已手工上架 ${data.listed || 0} 个 PLUS${data.failed ? `，失败 ${data.failed}` : ''}`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    listingPlus.value = false;
  }
}

async function testNvtokensPrice() {
  testingNvtokensPrice.value = true;
  nvtokensPriceHint.value = '';
  try {
    const body = {};
    const typed = String(nvtokensForm.session_cookie || '').trim();
    if (typed) body.session = typed;
    const r = await api.post('/settings/nvtokens/price-board-test', body);
    if (!r?.ok) {
      nvtokensPriceHint.value = r?.message || '价格查询失败';
      return toast.error(nvtokensPriceHint.value);
    }
    nvtokensPriceHint.value = r.text || `Plus 最低 ${r.min || '—'} – 最高 ${r.max || '—'} – 均价 ${r.avg || '—'} – P25 ${r.p25 || '—'} – 库存 ${r.inventory_label || '未知'}`;
    toast.success(nvtokensPriceHint.value);
  } catch (e) {
    nvtokensPriceHint.value = e.message;
    toast.error(e.message);
  } finally {
    testingNvtokensPrice.value = false;
  }
}

async function saveImportDump() {
  savingImportDump.value = true;
  try {
    const s = await api.put('/settings/import-dump', { ...importDumpForm });
    Object.assign(settings, s);
    importDumpForm.url = '';
    importDumpForm.api_key = '';
    toast.success('导出配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingImportDump.value = false;
  }
}

async function runImportDump() {
  dumpingNoTrial.value = true;
  try {
    const data = await api.post('/accounts/dump-no-trial');
    if (data.skipped && data.reason === 'not_configured') return toast.error('请先保存远程导入地址和密钥');
    toast.success(`已推送 ${data.pushed || 0} 个无试用普号并删除 ${data.deleted || 0} 个${data.failed ? `，失败 ${data.failed}` : ''}`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    dumpingNoTrial.value = false;
  }
}

async function runDumpAllAccounts() {
  const ok = await confirmDialog({
    title: '推送全部账号',
    message: '将把本库已检测的普通号（含有试用，GB 与 GC）推到已配置的远程导入地址，成功后从本库删除。可能有几百个账号，不可恢复。未检测、已支付、Plus/Pro/Team、令牌失效、封禁、停用、检测失败、无 AT、已标记不同步的仍不会推送。确认继续？',
    confirmText: '确认推送并删除',
    danger: true,
  });
  if (!ok) return;
  dumpingAllAccounts.value = true;
  try {
    const data = await api.post('/accounts/dump-all-accounts');
    if (data.skipped && data.reason === 'not_configured') return toast.error('请先保存远程导入地址和密钥');
    toast.success(`已推送 ${data.pushed || 0} 个账号并删除 ${data.deleted || 0} 个${data.failed ? `，失败 ${data.failed}` : ''}`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    dumpingAllAccounts.value = false;
  }
}

async function clearCloak() {
  try {
    const s = await api.delete('/settings/cloak');
    Object.assign(settings, s);
    toast.success('已清除授权');
  } catch (e) {
    toast.error(e.message);
  }
}

async function saveSms() {
  savingSms.value = true;
  try {
    const s = await api.put('/settings/sms', { ...smsForm });
    Object.assign(settings, s);
    smsForm.api_key = '';
    toast.success('接码配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingSms.value = false;
  }
}

async function saveProviders() {
  savingProviders.value = true;
  try {
    const payload = Object.fromEntries(Object.entries(providerForms).map(([id, form]) => [id, { ...form }]));
    const s = await api.put('/settings/registration-providers', payload);
    Object.assign(settings, s);
    Object.values(providerForms).forEach(form => { form.api_key = ''; });
    toast.success('注册供应商配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingProviders.value = false;
  }
}

async function saveDynamicProxy() {
  savingDynamicProxy.value = true;
  try {
    const s = await api.put('/settings/dynamic-proxy', {
      active_pool: dynamicProxyForm.active_pool,
      providers: dynamicProxyForm.providers,
    });
    Object.assign(settings, s);
    Object.values(dynamicProxyForm.providers).forEach(form => { form.password = ''; });
    toast.success('动态代理配置已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingDynamicProxy.value = false;
  }
}

async function saveDomains() {
  savingDomains.value = true;
  try {
    const s = await api.put('/settings/email-domains', {
      mode: domainForm.mode,
      allow: domainForm.allowText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      deny: domainForm.denyText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    });
    Object.assign(settings, s);
    toast.success('域名策略已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingDomains.value = false;
  }
}

async function saveSuffixQuota() {
  savingSuffixQuota.value = true;
  try {
    const s = await api.put('/settings/suffix-quota', { ...suffixQuotaForm });
    Object.assign(settings, s);
    if (s.suffix_quota) {
      suffixQuotaForm.hourly = Number(s.suffix_quota.hourly) || 0;
      suffixQuotaForm.daily = Number(s.suffix_quota.daily) || 0;
    }
    toast.success('拉号额度已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingSuffixQuota.value = false;
  }
}

async function saveMailcom() {
  savingMailcom.value = true;
  try {
    const enabled = suffixItems.value.filter((it) => it.enabled).map((it) => it.suffix);
    const disabled = suffixItems.value.filter((it) => !it.enabled).map((it) => it.suffix);
    const s = await api.put('/settings/mailcom', {
      ...mailcomForm,
      enabled_suffixes: enabled,
      disabled_suffixes: disabled,
    });
    Object.assign(settings, s);
    if (s.mailcom?.suffixes) {
      suffixItems.value = s.mailcom.suffixes.map(mapSuffixItem);
    }
    toast.success('已保存');
  } catch (e) {
    toast.error(e.message);
  } finally {
    savingMailcom.value = false;
  }
}

// ---- 代理管理 ----
function proxyStatusClass(status) {
  if (status === '可用') return 'tag-green';
  if (status === '失败') return 'tag-red';
  return 'tag-gray';
}

async function loadProxies() {
  try {
    const r = await api.get('/proxies', {
      params: {
        group: proxyGroupFilter.value || undefined,
        page: proxyPage.value,
        pageSize: proxyPageSize.value,
      },
    });
    const items = Array.isArray(r) ? r : r.items || [];
    proxyTotal.value = Array.isArray(r) ? r.length : Number(r.total || 0);
    if (proxyPage.value > Math.max(1, Math.ceil(proxyTotal.value / proxyPageSize.value))) {
      proxyPage.value = Math.max(1, Math.ceil(proxyTotal.value / proxyPageSize.value) || 1);
      if (proxyTotal.value && items.length === 0) return loadProxies();
    }
    proxies.value = items;
    selectedProxies.value = [];
  } catch (e) {
    toast.error(e.message);
  }
}
async function loadProxyGroups() {
  try {
    proxyGroups.value = await api.get('/proxies/groups');
  } catch (e) {
    toast.error(e.message);
  }
}

function onProxyGroupChange() {
  proxyPage.value = 1;
  loadProxies();
}
function onProxyPageSizeChange() {
  proxyPage.value = 1;
  loadProxies();
}
function goProxyPage(n) {
  proxyPage.value = Math.min(proxyTotalPages.value, Math.max(1, n));
  loadProxies();
}

const allProxiesChecked = computed(() => proxies.value.length > 0 && selectedProxies.value.length === proxies.value.length);
function toggleAllProxies(e) {
  selectedProxies.value = e.target.checked ? proxies.value.map((p) => p.id) : [];
}

function openProxyForm(row) {
  proxyEditing.value = row || null;
  Object.assign(proxyForm, {
    group_name: row?.group_name || '默认分组',
    proxy_type: row?.proxy_type || 'http',
    host: row?.host || '',
    port: row?.port ?? null,
    username: row?.username || '',
    password: '',
    remark: row?.remark || '',
  });
  proxyModal.value = true;
}

async function saveProxy() {
  if (!proxyForm.host || !proxyForm.port) return toast.error('请填写主机和端口');
  try {
    if (proxyEditing.value) await api.put(`/proxies/${proxyEditing.value.id}`, { ...proxyForm });
    else await api.post('/proxies', { ...proxyForm });
    proxyModal.value = false;
    toast.success('已保存');
    await Promise.all([loadProxies(), loadProxyGroups()]);
  } catch (e) {
    toast.error(e.message);
  }
}

async function deleteProxy(row) {
  const ok = await confirmDialog({
    title: '删除代理',
    message: `确认删除代理 ${row.host}:${row.port} ？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/proxies/${row.id}`);
    toast.success('已删除');
    await Promise.all([loadProxies(), loadProxyGroups()]);
  } catch (e) {
    toast.error(e.message);
  }
}

async function batchDeleteProxies() {
  const ok = await confirmDialog({
    title: '批量删除代理',
    message: `确认删除选中的 ${selectedProxies.value.length} 条代理？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post('/proxies/batch-delete', { ids: selectedProxies.value });
    toast.success('已删除');
    await Promise.all([loadProxies(), loadProxyGroups()]);
  } catch (e) {
    toast.error(e.message);
  }
}

async function clearAllProxies() {
  const scope = proxyGroupFilter.value ? `分组「${proxyGroupFilter.value}」` : '全部代理';
  const ok = await confirmDialog({
    title: '清空代理',
    message: `确认清空${scope}？此操作不可恢复。`,
    confirmText: '确认清空',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.post('/proxies/clear-all', { group: proxyGroupFilter.value || '' });
    toast.success(`已清空 ${r.deleted} 条`);
    proxyPage.value = 1;
    await Promise.all([loadProxies(), loadProxyGroups()]);
  } catch (e) {
    toast.error(e.message);
  }
}

async function testOneProxy(row) {
  testingProxy[row.id] = true;
  try {
    const r = await api.post(`/proxies/${row.id}/test`, {}, { timeout: 20000 });
    const idx = proxies.value.findIndex((p) => p.id === row.id);
    if (idx >= 0) {
      proxies.value[idx] = {
        ...proxies.value[idx],
        status: r.status,
        latency: r.latency,
        region: r.region,
      };
    }
    if (r.ok) toast.success(`可用 ${r.ip || ''} ${r.latency}ms`);
    else toast.error(r.message || '测试失败');
  } catch (e) {
    const idx = proxies.value.findIndex((p) => p.id === row.id);
    if (idx >= 0) proxies.value[idx] = { ...proxies.value[idx], status: '失败' };
    toast.error(e.message);
  } finally {
    testingProxy[row.id] = false;
  }
}

function openProxyImport() {
  proxyImportText.value = '';
  proxyImportGroup.value = '默认分组';
  proxyImportModal.value = true;
}
async function submitProxyImport() {
  if (!proxyImportText.value.trim()) return toast.error('请粘贴代理列表');
  importingProxy.value = true;
  try {
    const r = await api.post('/proxies/batch-import', { text: proxyImportText.value, group_name: proxyImportGroup.value });
    toast.success(`导入成功 ${r.success}/${r.total} 条，状态：${r.status || '可用'}`);
    proxyImportModal.value = false;
    proxyPage.value = 1;
    await Promise.all([loadProxies(), loadProxyGroups()]);
  } catch (e) {
    toast.error(e.message);
  } finally {
    importingProxy.value = false;
  }
}
</script>

<style scoped>
.settings-page { width: 100%; min-width: 0; }
.settings-grid {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
  gap: 20px;
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 560px) { .two-col { grid-template-columns: 1fr; } }
.info-list { display: flex; flex-direction: column; }
.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}
.info-row:last-child { border-bottom: none; }
.info-row > span:first-child { color: var(--ink-500); }
.oss-link { color: var(--klein-600, #2450d6); text-decoration: none; font-weight: 600; }
.oss-link:hover { text-decoration: underline; }
.card-title .tag { margin-left: 8px; vertical-align: middle; }
.hint { margin-top: 12px; font-size: 12px; color: var(--ink-500); line-height: 1.6; }
.guide-box {
  background: var(--klein-50);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.65;
}
.guide-box ol { margin: 8px 0 0; padding-left: 18px; }
.guide-box code { font-family: var(--mono); font-size: 12px; }
.suffix-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  max-height: 460px;
  overflow: auto;
  padding: 2px;
}
.suffix-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--klein-50);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.suffix-item.off { opacity: 0.55; }
.suffix-item.blocked { border-color: #fecaca; background: #fff7f7; }
.suffix-item .suffix-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.suffix-item .suffix-name { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.suffix-item .suffix-stats { color: var(--ink-500); font-size: 11px; line-height: 1.4; }
.suffix-item .mono { font-family: var(--mono); word-break: break-all; }
.suffix-item .tag { margin-left: 0; font-size: 11px; }

.proxy-card { width: 100%; }
.proxy-toolbar { padding: 16px 20px 12px; margin: 0; align-items: center; }
.proxy-table { table-layout: fixed; width: 100%; }
.proxy-table .col-check { width: 44px; text-align: center; }
.proxy-table .col-ops { width: 280px; }
.proxy-table td.col-ops { white-space: nowrap; }
.row-actions { display: flex; flex-wrap: nowrap; gap: 6px; align-items: center; }
.latency { margin-left: 8px; font-size: 12px; }
.toolbar-select { width: auto; flex: 0 0 auto; }
.provider-block {
  margin-bottom: 14px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
}
.provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
</style>
