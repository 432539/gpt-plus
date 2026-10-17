<template>
    <div class="accounts-page">
    <div class="channel-banner" :class="isGc ? 'channel-banner-gc' : 'channel-banner-gb'">
      <span class="channel-pill">{{ isGc ? 'GC · GCash' : 'GB · PayPal' }}</span>
      <span>{{ isGc ? '账号管理(GC)：本页只操作菲律宾 GCash 号，流水线写 pipeline_gc，出码后打开支付墙。' : '账号管理(GB)：本页只操作英国 PayPal 号，流水线写 pipeline，已提链可复制支付链。' }}</span>
    </div>
    <div class="card" style="margin-bottom: 0">
      <div class="toolbar">
        <input
          v-model.trim="filters.keyword"
          class="input"
          style="width: 200px"
          placeholder="搜索邮箱 / 进度"
          @keyup.enter="reload"
        />
        <select v-model="filters.status" class="input toolbar-filter" @change="reload">
          <option value="">全部状态</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="filters.has_trial" class="input toolbar-filter" aria-label="试用资格" title="试用资格" @change="reload">
          <option value="">全部资格</option>
          <option value="1">是</option>
          <option value="0">否</option>
          <option value="unset">未检测</option>
        </select>
        <select v-model="filters.plan_type" class="input toolbar-filter" @change="reload">
          <option value="">全部套餐</option>
          <option v-for="p in PLAN_TYPES" :key="p" :value="p">{{ p }}</option>
        </select>
        <button class="btn btn-ghost" @click="reload">查询</button>
        <button v-if="isGc" class="btn" type="button" @click="openGcashWall">二维码墙</button>
        <div class="toolbar-spacer"></div>
        <div class="pipeline-toggles" title="开启后持续自动执行；关闭则不跑对应步骤">
          <button
            v-for="item in pipelineItems"
            :key="item.key"
            class="pipe-toggle"
            :class="{ on: pipeline[item.key] }"
            type="button"
            :disabled="pipelineBusy"
            :title="item.title"
            @click="togglePipeline(item.key)"
          >{{ item.label }}</button>
        </div>
        <button
          v-if="reg.running"
          class="btn btn-danger-fill"
          :disabled="reg.busy"
          type="button"
          @click="stopRegister"
        >立即停止</button>
        <button v-else class="btn" :disabled="reg.busy" type="button" @click="openRegister">{{ isGc ? '开始注册(GC)' : '开始注册' }}</button>
        <div class="ops">
          <button class="btn btn-ghost" @click.stop="toggleOps">
            批量操作
            <span class="ops-caret">▾</span>
          </button>
          <div v-show="opsOpen" class="ops-menu" @click.stop>
            <div class="ops-sep">导入</div>
            <button class="ops-item" type="button" @click="pickImport('credentials')">Sub2 / CPA / TXT 凭据文件</button>
            <button class="ops-item" type="button" @click="pickImport('backup')">完整备份 CSV / Excel</button>
            <button class="ops-item" type="button" @click="openImport">粘贴 JSON / JSONL / TXT</button>
            <div class="ops-sep">导出</div>
            <button class="ops-item" type="button" @click="openExport">选择业务格式并导出</button>
            <div class="ops-sep">账号维护</div>
            <button class="ops-item ops-item-primary" type="button" @click="openAccountOperation('detect')">
              {{ selected.size ? `${isGc ? '检测 GCash 资格' : '检测'}选中账号(${selected.size})` : (isGc ? '检测全部 GCash 资格' : '检测全部账号') }}
            </button>
            <button class="ops-item ops-item-primary" type="button" @click="openAccountOperation('refresh')">
              {{ selected.size ? `刷新选中账号(${selected.size})` : '刷新全部账号' }}
            </button>
            <button class="ops-item ops-item-primary" type="button" :disabled="!selected.size" @click="openAccountOperation('rebind')">
              批量换绑{{ selected.size ? `(${selected.size})` : '' }}
            </button>
            <button class="ops-item ops-item-primary" type="button" :disabled="!selected.size" @click="openAcquireRt">
              {{ isGc ? '拿 RT(PH)' : '获取选中账号 RT' }}{{ selected.size ? `(${selected.size})` : '' }}
            </button>
            <button class="ops-item ops-item-primary" type="button" @click="openAccountOperation('extract')">
              {{ selected.size ? `${isGc ? '出码' : '提链'}选中账号(${selected.size})` : (isGc ? '出码全部账号' : '提链全部账号') }}
            </button>
            <button class="ops-item ops-item-primary" type="button" @click="openAccountOperation('activate')">
              {{ selected.size ? `${isGc ? '打开支付墙' : '支付'}选中账号(${selected.size})` : (isGc ? '支付墙全部账号' : '支付全部账号') }}
            </button>
            <div class="ops-sep"></div>
            <button class="ops-item ops-item-danger" type="button" :disabled="!selected.size" @click="batchDelete('selected')">删除选中{{ selected.size ? `(${selected.size})` : '' }}</button>
            <button class="ops-item ops-item-danger" type="button" @click="batchDelete('invalid')">删除确认失效 / 过期</button>
            <button class="ops-item ops-item-danger" type="button" @click="batchDelete('banned')">删除封禁 / 停用</button>
            <button class="ops-item ops-item-danger" type="button" @click="batchDelete('all')">删除全部账号</button>
          </div>
        </div>
        <input ref="importFile" type="file" class="hidden-file" multiple @change="onHiddenFile" />
      </div>
    </div>

    <div class="card flush">
      <div class="table-wrap accounts-table-wrap">
        <table class="table accounts-table">
          <colgroup>
            <col class="col-check" />
            <col class="col-email" />
            <col class="col-trial" />
            <col class="col-plan" />
            <col class="col-status" />
            <col class="col-expires" />
            <col class="col-remark" />
            <col class="col-ops" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input type="checkbox" :checked="allChecked" @change="toggleAll($event)" />
              </th>
              <th>邮箱</th>
              <th>试用资格</th>
              <th>套餐</th>
              <th>状态</th>
              <th>到期时间</th>
              <th>备注</th>
              <th class="actions-cell col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in items" :key="row.id">
              <td>
                <input type="checkbox" :checked="selected.has(row.id)" @change="toggleOne(row.id, $event)" />
              </td>
              <td>
                <div class="email-cell">
                  <span>{{ row.email }}</span>
                  <span
                    v-if="rebindLabel(row)"
                    class="tag"
                    :class="rebindTag(row)"
                    :title="rebindTitle(row)"
                  >{{ rebindLabel(row) }}</span>
                </div>
              </td>
              <td>
                <span class="tag" :class="trialTag(row.has_trial)">
                  {{ trialText(row.has_trial) }}
                </span>
                <span
                  v-if="rowSkipSync(row)"
                  class="tag tag-gray"
                  title="试用提链失败满 20 次，不同步到平台"
                >不同步</span>
              </td>
              <td><span class="tag" :class="planTag(row.plan_type)">{{ row.plan_type }}</span></td>
              <td><span class="tag" :class="statusTag(row.status)">{{ row.status }}</span></td>
              <td class="expires-cell">{{ formatExpiresAt(row.expires_at) }}</td>
              <td class="remark">
                <span
                  v-if="rowRemark(row) === '已拿RT'"
                  class="progress-tag progress-rt"
                >已拿RT</span>
                <button
                  v-else-if="rowRemark(row) === '已提链'"
                  class="progress-tag"
                  :class="progressClass(rowRemark(row))"
                  type="button"
                  :title="isGc ? '打开 GCash 支付墙' : '点击复制提链'"
                  @click="copyExtractLink(row)"
                >已提链</button>
                <button
                  v-else-if="rowRemark(row) === '已提链(已过期)'"
                  class="progress-tag"
                  :class="progressClass(rowRemark(row))"
                  type="button"
                  :title="isGc ? '二维码已过期，打开支付墙查看' : '提链已过期'"
                  @click="copyExtractLink(row)"
                >已提链(已过期)</button>
                <button
                  v-else-if="rowRemark(row) === '提链中'"
                  class="progress-tag"
                  :class="progressClass(rowRemark(row))"
                  type="button"
                  title="查看提链日志"
                  @click="goExtractLogs(row)"
                >提链中</button>
                <button
                  v-else-if="rowRemark(row) === '支付中'"
                  class="progress-tag"
                  :class="progressClass(rowRemark(row))"
                  type="button"
                  :title="isGc ? '打开 GCash 支付墙查看二维码' : '查看开通日志'"
                  @click="isGc ? openGcashPaywall(row) : goActivateLogs(row)"
                >支付中</button>
                <button
                  v-else-if="rowRemark(row) === '支付待核验'"
                  class="progress-tag"
                  :class="progressClass(rowRemark(row))"
                  type="button"
                  title="查看支付核验日志"
                  @click="goActivateLogs(row)"
                >支付待核验</button>
                <span
                  v-else
                  class="progress-tag"
                  :class="progressClass(rowRemark(row)) || 'progress-empty'"
                >{{ rowRemark(row) || '—' }}</span>
              </td>
              <td class="actions-cell col-ops">
                <div class="row-actions">
                  <button
                    class="btn btn-sm btn-ghost"
                    type="button"
                    :disabled="rowJobDisabled(row, 'detect')"
                    @click="startRowDetect(row)"
                  >{{ isGc ? '检测资格' : '检测' }}</button>
                  <button
                    class="btn btn-sm btn-ghost"
                    type="button"
                    :disabled="rowJobDisabled(row, 'extract')"
                    @click="startRowExtract(row)"
                  >{{ isGc ? '出码' : '提链' }}</button>
                  <button
                    class="btn btn-sm btn-ghost"
                    type="button"
                    :disabled="rowJobDisabled(row, 'activate')"
                    @click="startRowActivate(row)"
                  >{{ isGc ? '支付墙' : (rowProgress(row) === '支付待核验' ? '核验' : '支付') }}</button>
                  <button
                    class="btn btn-sm btn-ghost"
                    type="button"
                    :disabled="rowJobDisabled(row, 'rt')"
                    @click="startRowAcquireRt(row)"
                  >拿RT</button>
                  <button class="btn btn-sm btn-ghost" type="button" @click="openEdit(row)">编辑</button>
                  <button
                    class="btn btn-sm btn-ghost btn-danger"
                    type="button"
                    :disabled="!accountCanDelete(row)"
                    :title="accountCanDelete(row) ? '删除' : deleteKeepMessage(row)"
                    @click="remove(row)"
                  >删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="!items.length">
              <td colspan="8" class="empty">{{ emptyHint }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <div class="pagination-info">共 {{ total }} 条{{ total ? `,当前 ${rangeStart}-${rangeEnd}` : '' }}</div>
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
            <button class="page-btn" :disabled="page >= totalPages" @click="goPage(totalPages)">尾页</button>
          </div>
        </div>
      </div>
    </div>

    <Modal :show="dialog" title="编辑账号" :loading="saving" @close="dialog = false" @confirm="save">
      <div class="form-grid">
        <div class="form-item form-item-full">
          <label>账号邮箱 *</label>
          <input v-model.trim="form.email" class="input" placeholder="example@gmail.com" />
        </div>
        <div class="form-item form-item-full">
          <label>密码</label>
          <div class="pwd-edit">
            <input
              v-model="form.password"
              :type="editPwdVisible ? 'text' : 'password'"
              class="input"
              autocomplete="off"
              placeholder="账号密码"
            />
            <button class="link-btn" type="button" @click="editPwdVisible = !editPwdVisible">
              {{ editPwdVisible ? '隐藏' : '查看' }}
            </button>
          </div>
        </div>
        <div class="form-item">
          <label>状态</label>
          <select v-model="form.status" class="input">
            <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="form-item">
          <label>套餐</label>
          <select v-model="form.plan_type" class="input">
            <option v-for="p in PLAN_TYPES" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="form-item">
          <label>到期时间</label>
          <input v-model="form.expires_at" type="datetime-local" class="input" />
        </div>
        <div class="form-item form-item-full">
          <label>Access Token</label>
          <textarea v-model="form.access_token" class="input token-input" rows="3" autocomplete="off" placeholder="chatgpt access_token"></textarea>
        </div>
        <div class="form-item form-item-full">
          <label>Refresh Token</label>
          <textarea v-model="form.refresh_token" class="input token-input" rows="3" autocomplete="off" placeholder="chatgpt refresh_token"></textarea>
        </div>
        <div class="form-item form-item-full">
          <label>2FA</label>
          <input v-model="form.totp_secret" type="text" class="input" autocomplete="off" placeholder="Base32 TOTP secret" />
        </div>
      </div>
    </Modal>

    <Modal
      :show="operationDialog"
      :title="operationDialogTitle"
      :loading="operation.busy"
      :confirmText="operationDialogConfirm"
      @close="operationDialog = false"
      @confirm="startAccountOperation"
    >
      <div class="form-grid">
        <div class="form-item">
          <label>代理分组</label>
          <input class="input" :value="isGc ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY" disabled />
        </div>
        <div class="form-item">
          <label>并发数</label>
          <input
            v-model.number="activeOperationForm.concurrency"
            type="number"
            min="1"
            :max="operationConcurrencyMax"
            class="input"
          />
        </div>
      </div>
      <p class="reg-hint">{{ operationDialogHint }}</p>
      <p v-if="operationKind === 'rebind'" class="reg-hint">
        <button class="link-btn" type="button" @click="goRebindLogs">查看换绑日志</button>
        （账号检测 / 换绑，来源 [换绑]）
      </p>
      <div v-if="operation.running || operation.finished" class="reg-status" :class="{ running: operation.running }">
        {{ operation.message }}
        <button v-if="operation.running" class="link-btn danger" type="button" @click="stopAccountOperation">停止</button>
      </div>
    </Modal>

    <Modal :show="importDialog" title="粘贴导入凭据" :loading="importing" confirmText="开始导入" @close="importDialog = false" @confirm="doImport">
      <div class="form-item">
        <label>自动识别：Sub2 聚合 JSON、CPA 单对象/数组/JSONL、以及 <code>----</code> 分隔 TXT</label>
        <textarea
          v-model="importText"
          class="input"
          rows="8"
          placeholder="账号----密码----BASE32_2FA&#10;账号----密码----BASE32_2FA----AT&#10;账号----密码----BASE32_2FA----AT----RT"
        ></textarea>
        <p class="reg-hint">TXT 支持 账号/密码/2FA、加 AT、加 AT/RT 三种固定顺序，并兼容旧版 账号----密码----JWT----RT。</p>
      </div>
      <div v-if="importResult" class="import-result">
        导入完成：成功 <b>{{ importResult.success }}</b>，跳过 <b>{{ importResult.skipped }}</b>，
        无效 <b>{{ importResult.invalid }}</b>，重复 <b>{{ importResult.duplicate }}</b>，共 {{ importResult.total }} 条。
        <span v-if="importResult.limited" style="color: var(--danger)">已达套餐上限 {{ importResult.max }} 条。</span>
      </div>
    </Modal>

    <Modal :show="exportDialog" title="导出账号" :loading="exporting" confirmText="下载导出文件" @close="exportDialog = false" @confirm="doExport">
      <div class="export-scope">导出范围：<b>{{ selected.size ? `已选 ${selected.size} 个账号` : `全部 ${total} 个账号` }}</b></div>
      <div class="format-list">
        <label v-for="option in EXPORT_FORMATS" :key="option.value" class="format-option">
          <input v-model="exportFormat" type="radio" :value="option.value" />
          <span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
        </label>
      </div>
      <div v-if="exportFormat === 'txt'" class="txt-fields">
        <label>TXT 字段（固定顺序，所选字段缺失或含换行/<code>----</code> 的账号会跳过）</label>
        <div class="preset-row">
          <button class="btn btn-ghost" type="button" @click="setTxtPreset('security')">账号----密码----2FA</button>
          <button class="btn btn-ghost" type="button" @click="setTxtPreset('access')">账号----密码----2FA----AT</button>
          <button class="btn btn-ghost" type="button" @click="setTxtPreset('refresh')">账号----密码----2FA----AT----RT</button>
        </div>
        <label v-for="field in TXT_FIELDS" :key="field.value" class="field-check">
          <input v-model="txtFields" type="checkbox" :value="field.value" :disabled="field.value === 'email'" /> {{ field.label }}
        </label>
      </div>
    </Modal>

    <Modal
      :show="regDialog"
      :title="isGc ? '批量注册(GC / PH)' : '批量注册'"
      :loading="reg.busy"
      :confirmText="isGc ? '开始 GC 注册' : '开始注册'"
      @close="regDialog = false"
      @confirm="startRegister"
    >
      <div class="reg-meta">
        <span>未使用子号 <b>{{ regOptions.unused_emails }}</b></span>
        <span>Cloak {{ regOptions.cloak.license_configured ? '已授权' : '未配置' }}</span>
        <span>并发上限 {{ regOptions.cloak.max_concurrency }}</span>
      </div>
      <div class="form-grid">
        <div class="form-item">
          <label>邮箱供应商</label>
          <select v-model="regForm.mail_provider" class="input" :disabled="reg.running">
            <option value="mailcom">mail.com 子号</option>
            <option value="cfworker">CF 邮箱</option>
            <option value="mix">mail.com + CF 按比例</option>
          </select>
        </div>
        <div class="form-item">
          <label>注册代理</label>
          <select v-model="regForm.proxy_group" class="input" disabled>
            <option :value="DEFAULT_GC_PROXY">动态代理：PH 菲律宾（CliProxy）</option>
            <option :value="DEFAULT_REGISTER_PROXY_GROUP">动态代理：GB 英国（CliProxy）</option>
          </select>
        </div>
        <div class="form-item">
          <label>注册数量</label>
          <input v-model.number="regForm.count" type="number" min="1" max="2000" class="input" :disabled="reg.running" />
        </div>
        <div class="form-item">
          <label>线程数</label>
          <input v-model.number="regForm.concurrency" type="number" min="1" :max="regOptions.cloak.max_concurrency" class="input" :disabled="reg.running" />
        </div>
        <div class="form-item">
          <label>注册方式</label>
          <select v-model="regForm.register_mode" class="input">
            <option value="protocol">HTTP 协议</option>
            <option value="headless_click">无头模拟点击</option>
          </select>
        </div>
        <div class="form-item">
          <label>性能模式</label>
          <select v-model="regForm.performance_profile" class="input">
            <option value="safe">稳定模式</option>
            <option value="throughput">高吞吐模式</option>
          </select>
        </div>
        <div class="form-item">
          <label>最多尝试</label>
          <input v-model.number="regForm.attempts" type="number" min="1" max="3" class="input" />
        </div>
        <div class="form-item">
          <label>邮箱验证码超时（秒）</label>
          <input v-model.number="regForm.email_timeout_seconds" type="number" min="10" max="1800" class="input" />
        </div>
        <label class="form-item"><span>账号密码</span><input v-model="regForm.set_password" type="checkbox" /> 设置独立 ChatGPT 密码</label>
        <label class="form-item"><span>双重验证</span><input v-model="regForm.enable_totp_2fa" type="checkbox" /> 注册后启用真实 TOTP 2FA</label>
        <label class="form-item"><span>拟人化</span><input v-model="regForm.humanize" type="checkbox" /> 启用拟人鼠标/键盘（Cloak humanize）</label>
        <label class="form-item"><span>浏览器显示</span><input v-model="regForm.visible" type="checkbox" /> 显示浏览器窗口（调试）</label>
      </div>
      <div v-if="reg.running" class="reg-status running">{{ regProgressText }}</div>
      <p class="reg-hint">
        {{ isGc ? 'GC 注册强制走设置里的 CliProxy 动态池 + region-PH，不读手工注册/支付组。' : 'GB 注册强制走设置里的 CliProxy 动态池 + region-GB，不读手工注册/支付组。' }}
        注册数量最多 2000。mail.com 占用未使用子号；CF 邮箱即时生成域名地址；「按比例」按个人设置 → 邮箱域名 里的 mail.com / CF 份数拆分。
        默认无头模拟点击。线程数默认跟 Cloak 并发上限对齐，且不会超过该上限。稳定模式只放慢页面操作，不会把并发打成 1。
      </p>
    </Modal>

    <Modal
      :show="rtDialog"
      :title="isGc ? '已有账号获取 RT（GC / PH）' : '已有账号获取 RT'"
      :loading="rtBusy"
      confirmText="开始获取"
      @close="rtDialog = false"
      @confirm="startAcquireRt"
    >
      <div class="form-grid">
        <div class="form-item">
          <label>代理模式</label>
          <input class="input" :value="isGc ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY" disabled />
        </div>
        <div class="form-item">
          <label>动态代理国家</label>
          <input class="input" :value="isGc ? 'PH' : 'GB'" disabled />
        </div>
        <div class="form-item">
          <label>手机号国家</label>
          <select v-model="rtForm.phone_country" class="input">
            <option v-for="country in phoneCountries" :key="country.value" :value="country.iso || country.value">
              {{ country.iso || country.value }} {{ country.label }}（{{ country.dial_code }}）
            </option>
          </select>
        </div>
        <div class="form-item">
          <label>并发数</label>
          <input v-model.number="rtForm.concurrency" type="number" min="1" :max="regOptions.cloak.max_concurrency" class="input" />
        </div>
        <div class="form-item">
          <label>手机号最高价</label>
          <input v-model="rtForm.phone_max_price" type="number" min="0.01" step="0.01" class="input" placeholder="留空不限制" />
        </div>
      </div>
      <p class="reg-hint">{{ isGc ? 'GC 拿 RT 走 accountRtJob，强制 CliProxy 动态池 + region-PH。接码仍用智利（CL）。已绑过手机不会再买号。' : '协议拿 RT（Codex CLI OAuth），不走 Cloak。强制 CliProxy 动态池 + region-GB，接码共用支付的 SMSBower，OpenAI 绑手机用智利（CL）。已绑过手机不会再买号。' }}</p>
    </Modal>

    <Modal
      :show="paywall.show"
      title="GCash 支付墙"
      :confirmText="paywall.paid ? '完成' : '关闭'"
      @close="closeGcashPaywall"
      @confirm="closeGcashPaywall"
    >
      <div class="gcash-wall">
        <p class="reg-hint">{{ paywall.email || 'GCash 账号' }} · {{ gcashPaywallHint(paywall) }}协议轮询保持同一会话。</p>
        <div v-if="isGcashQrImage(paywall.qr) && !paywall.paid && !paywall.expired" class="gcash-countdown">
          {{ formatGcashCountdown(paywall.qr_remaining_ms) }}
        </div>
        <img v-if="paywall.scannable && isGcashQrImage(paywall.qr)" class="gcash-qr" :src="paywall.qr" alt="GCash QR" />
        <div v-else class="gcash-fallback">
          <p class="reg-hint">{{ paywall.refresh_message || gcashPaywallFallback(paywall) }}</p>
        </div>
        <div class="gcash-actions">
          <button
            class="btn"
            type="button"
            :disabled="paywall.refreshing || !paywall.refreshable || paywall.processing"
            @click="refreshGcashQr(paywall)"
          >{{ paywall.refreshing ? '刷新中…' : '刷新二维码' }}</button>
          <button v-if="paywall.link" class="btn" type="button" @click="openGcashLink">打开 GCash 链接</button>
          <button v-if="paywall.link" class="btn btn-ghost" type="button" @click="copy(paywall.link)">复制链接</button>
        </div>
        <div class="reg-status" :class="{ running: !paywall.paid && !paywall.expired }">
          {{ gcashPaywallStatus(paywall) }}
        </div>
      </div>
    </Modal>

    <Teleport to="body">
      <div v-if="wall.show" class="gcash-wall-mask">
        <section class="gcash-wall-panel" role="dialog" aria-modal="true" aria-labelledby="gcash-wall-title">
          <header class="gcash-wall-head">
            <div>
              <h2 id="gcash-wall-title">GCash 集体二维码墙</h2>
              <p>默认按剩余时间升序，只展示当前可扫码二维码。</p>
            </div>
            <button class="modal-close" type="button" aria-label="关闭二维码墙" @click="closeGcashWall">×</button>
          </header>
          <div class="gcash-wall-toolbar">
            <label><input v-model="wall.onlyScannable" type="checkbox" /> 只看可扫</label>
            <label><input v-model="wall.hideFinished" type="checkbox" /> 隐藏已完成/失败</label>
            <span class="toolbar-spacer"></span>
            <button class="btn" type="button" :disabled="wall.refreshingAll" @click="refreshExpiredGcashWall">
              {{ wall.refreshingAll ? '批量刷新中…' : '刷新全部到期二维码' }}
            </button>
          </div>
          <div class="gcash-wall-body">
            <div v-if="wall.error" class="reg-status">{{ wall.error }}</div>
            <div v-if="!visibleWallItems.length" class="gcash-wall-empty">当前没有符合条件的二维码</div>
            <div v-else class="gcash-wall-grid">
              <article v-for="(item, index) in visibleWallItems" :key="item.id" class="gcash-wall-card">
                <div class="gcash-wall-card-head">
                  <span>#{{ index + 1 }}</span>
                  <span :title="item.email">{{ item.email }}</span>
                </div>
                <div class="gcash-wall-clock">{{ formatGcashCountdown(item.qr_remaining_ms) }}</div>
                <img v-if="item.scannable && isGcashQrImage(item.qr)" :src="item.qr" alt="GCash QR" />
                <div v-else class="gcash-wall-placeholder">{{ item.refresh_message || gcashWallStatusLabel(item) }}</div>
                <div class="gcash-wall-state" :class="`state-${item.status}`">{{ gcashWallStatusLabel(item) }}</div>
                <div class="gcash-actions">
                  <button
                    class="btn btn-sm"
                    type="button"
                    :disabled="item.refreshing || !item.refreshable || item.processing"
                    @click="refreshGcashQr(item)"
                  >{{ item.refreshing ? '刷新中…' : '刷新' }}</button>
                  <button v-if="item.link_available" class="btn btn-sm btn-ghost" type="button" @click="openGcashWallLink(item)">打开链接</button>
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../api';
import Modal from '../components/Modal.vue';
import { toast } from '../utils/toast';
import { confirmDialog } from '../utils/confirm';
import { formatExpiresAt, fromExpiresInput, toExpiresInput } from '../utils/datetime';
import { activateLogsQuery, extractLogsQuery, overlayProgress, remarkDisplay } from '../utils/accountProgress';
import { registrationPayload, accountRtPayload, defaultRegisterConcurrency, DEFAULT_REGISTER_PROXY_GROUP, DEFAULT_RT_PROXY_COUNTRY, DEFAULT_RT_PHONE_COUNTRY } from '../utils/registerUi';
import {
  isGcashQrImage, gcashPaywallHint, gcashPaywallFallback, gcashPaywallStatus,
  formatGcashCountdown, gcashWallStatusLabel, filterAndSortGcashWall,
  GCASH_CONCURRENCY_CAP,
} from '../utils/gcashPaywall';

const router = useRouter();
const route = useRoute();
const channel = computed(() => (route.meta.channel === 'gc' ? 'gc' : 'gb'));
const isGc = computed(() => channel.value === 'gc');
const DEFAULT_GC_PROXY = '__auto__:PH';
const DEFAULT_GB_REBIND_PROXY = '__auto__:GB';
const REBIND_CONCURRENCY_DEFAULT = 10;
const REBIND_CONCURRENCY_MAX = 20;
function withChannel(payload = {}) {
  return { ...payload, channel: channel.value };
}
const PLAN_TYPES = ['Free', 'Plus', 'Pro', 'Team'];
const STATUSES = ['未检测', '正常', '已过期', '已停用', '令牌失效', '已封禁', '检测失败'];
const IMPORT_ACCEPT = {
  credentials: '.json,.jsonl,.txt,application/json,text/plain',
  backup: '.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const EXPORT_FORMATS = [
  { value: 'sub2', label: 'Sub2 JSON（聚合）', description: 'exported_at / proxies / accounts，支持仅 RT 账号' },
  { value: 'cpa', label: 'CPA / CLIProxyAPI（ZIP）', description: '每账号一个标准扁平 OAuth JSON，不生成虚假 token' },
  { value: 'txt', label: '分隔 TXT', description: '自选账号、密码、2FA、AT、RT 字段' },
  { value: 'json', label: '完整备份 JSON', description: '保留全部账号、安全与会话字段' },
  { value: 'csv', label: '完整备份 CSV', description: '适合表格处理与再次导入' },
  { value: 'xlsx', label: '完整备份 Excel', description: 'XLSX 工作簿，可再次导入' },
];
const TXT_FIELDS = [
  { value: 'email', label: '账号 / Email' },
  { value: 'password', label: 'ChatGPT 密码' },
  { value: 'totp_secret', label: 'TOTP / 2FA Secret' },
  { value: 'access_token', label: 'Access Token (AT)' },
  { value: 'refresh_token', label: 'Refresh Token (RT)' },
];

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const filters = reactive({ keyword: '', status: '', has_trial: '', plan_type: '' });
const selected = reactive(new Set());
const opsOpen = ref(false);
const importFile = ref(null);
const pendingImportExt = ref('json');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const rangeStart = computed(() => (total.value ? (page.value - 1) * pageSize.value + 1 : 0));
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, total.value));
const allChecked = computed(() => items.value.length > 0 && items.value.every((r) => selected.has(r.id)));
const emptyHint = computed(() => {
  const filtered = Boolean(filters.keyword || filters.status || filters.has_trial || filters.plan_type);
  if (filtered) return isGc.value ? '没有符合条件的 GC 账号' : '没有符合条件的账号';
  return isGc.value
    ? '还没有 GC 账号。点「开始注册(GC)」走菲律宾通道，或导入后检测 GCash 资格。'
    : '暂无账号';
});

const planTag = (p) => ({ Free: 'tag-gray', Plus: 'tag-plus', Pro: 'tag-blue', Team: 'tag-orange' })[p] || 'tag-gray';
const statusTag = (s) => ({ 正常: 'tag-green', 已过期: 'tag-orange', 已停用: 'tag-red', 令牌失效: 'tag-red', 已封禁: 'tag-red', 检测失败: 'tag-orange', 未检测: 'tag-gray' })[s] || 'tag-gray';
const trialText = (v) => (v === 1 ? '是' : v === 0 ? '否' : '未检测');
const trialTag = (v) => (v === 1 ? 'tag-green' : v === 0 ? 'tag-gray' : 'tag-gray muted-tag');
function maskMail(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) return '';
  return `${text.slice(0, 1)}***@${text.slice(at + 1)}`;
}
function rebindLabel(row) {
  const status = String(row?.rebind_status || '').toLowerCase();
  if (status === 'ok') return '已换绑';
  if (status === 'pending') return '换绑中';
  if (status === 'cooling') return '换绑冷却';
  if (status === 'failed') return '换绑失败';
  return '';
}
const rebindTag = (row) => ({
  ok: 'tag-green',
  pending: 'tag-blue',
  cooling: 'tag-orange',
  failed: 'tag-red',
}[String(row?.rebind_status || '').toLowerCase()] || 'tag-gray');
function rebindTitle(row) {
  const from = maskMail(row?.original_email);
  const to = maskMail(row?.rebind_email || row?.email);
  if (!from || !to) return row?.rebind_error || '';
  return `${from} → ${to}${row?.rebind_error ? `：${row.rebind_error}` : ''}`;
}
function rowSkipSync(row) {
  return row.skip_platform_sync === true || row.skip_platform_sync === 1 || Number(row.extract_attempts) >= 20;
}
function accountCanDelete(row) {
  if (row.can_delete === false) return false;
  if (row.has_trial === 1) return false;
  if (rowSkipSync(row)) return false;
  return true;
}
function deleteKeepMessage(row) {
  if (row.has_trial === 1) return '有试用，已保留';
  if (rowSkipSync(row)) return '提链失败已满 20 次，已保留';
  return '有试用，已保留';
}
const liveJobs = reactive({
  extract: { running: false, emails: [], ids: [], run_id: '' },
  activate: { running: false, emails: [], ids: [], run_id: '' },
  detect: { running: false, emails: [], ids: [], run_id: '' },
});
const rowPending = reactive({});
function applyLiveJobs(data) {
  if (!data) return;
  liveJobs.extract = {
    running: Boolean(data.extract?.running),
    emails: data.extract?.emails || [],
    ids: data.extract?.ids || [],
    run_id: data.extract?.run_id || '',
  };
  liveJobs.activate = {
    running: Boolean(data.activate?.running),
    emails: data.activate?.emails || [],
    ids: data.activate?.ids || [],
    run_id: data.activate?.run_id || '',
  };
  liveJobs.detect = {
    running: Boolean(data.detect?.running),
    emails: data.detect?.emails || [],
    ids: data.detect?.ids || [],
    run_id: data.detect?.run_id || '',
  };
}
function liveMatch(live, row) {
  if (!live?.running) return false;
  const email = String(row.email || '').toLowerCase();
  const id = Number(row.id);
  if (email && live.emails.includes(email)) return true;
  return Number.isInteger(id) && live.ids.includes(id);
}
function rowProgress(row) {
  return overlayProgress(row, liveJobs, rowPending);
}
function rowRemark(row) {
  return remarkDisplay(row, liveJobs, rowPending);
}
function rowJobDisabled(row, kind) {
  if (rowPending[row.id]) return true;
  if (kind === 'detect') return liveMatch(liveJobs.detect, row);
  if (kind === 'extract') {
    return rowProgress(row) === '支付待核验' || liveMatch(liveJobs.extract, row);
  }
  if (kind === 'activate') return isGc.value ? false : liveMatch(liveJobs.activate, row);
  if (kind === 'rt') return !row.has_password || !row.has_totp_secret;
  return false;
}
const progressClass = (p) => ({
  已注册: 'progress-registered',
  提链中: 'progress-running',
  已提链: 'progress-extracted',
  '已提链(已过期)': 'progress-expired',
  支付中: 'progress-paying',
  支付待核验: 'progress-review',
  已支付: 'progress-paid',
  已拿RT: 'progress-rt',
})[p] || '';

async function load() {
  try {
    const params = { ...filters, page: page.value, page_size: pageSize.value, channel: channel.value };
    const data = await api.get('/accounts', { params });
    if (data.total > 0 && page.value > Math.ceil(data.total / pageSize.value)) {
      page.value = Math.ceil(data.total / pageSize.value);
      return load();
    }
    items.value = data.items;
    total.value = data.total;
    applyLiveJobs(data.live_jobs);
  } catch (e) {
    toast.error(e.message);
  }
}

async function loadAccounts() {
  return load();
}

function reload() {
  page.value = 1;
  load();
}
function goPage(p) {
  const next = Math.max(1, Math.min(totalPages.value, Number(p) || 1));
  page.value = next;
  load();
}
function changePageSize() {
  page.value = 1;
  load();
}

function toggleOne(id, e) {
  if (e.target.checked) selected.add(id);
  else selected.delete(id);
}
function toggleAll(e) {
  if (e.target.checked) items.value.forEach((r) => selected.add(r.id));
  else items.value.forEach((r) => selected.delete(r.id));
}

function toggleOps() {
  opsOpen.value = !opsOpen.value;
}
function closeOps() {
  opsOpen.value = false;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制到剪贴板');
  } catch {
    toast.error('复制失败,请手动复制');
  }
}
function gcashReady(row) {
  const progress = rowProgress(row);
  return progress === '已提链'
    || progress === '已提链(已过期)'
    || progress === '支付中'
    || Boolean(row.has_gcash_link || row.gcash_qr || row.gcash_link);
}

async function copyExtractLink(row) {
  if (isGc.value) {
    await openGcashPaywall(row);
    return;
  }
  if (rowProgress(row) === '已提链(已过期)' || row.extract_expired) {
    return toast.error('提链已过期，请重新提取');
  }
  try {
    const { link } = await api.get(`/accounts/${row.id}/extract-link`);
    if (!link) return toast.error('该账号还没有可复制的提链');
    await copy(link);
  } catch (e) {
    toast.error(e.message || '复制失败');
  }
}

async function startRowDetect(row) {
  if (rowJobDisabled(row, 'detect')) return;
  rowPending[row.id] = 'detect';
  try {
    const data = await api.post(`/accounts/${row.id}/detect`, withChannel({
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY,
    }));
    if (data?.transport) toast.error('检测传输失败，账号状态保持不变');
    else toast.success(`检测完成：${data?.status || row.status}${data?.has_trial === 1 ? '，有试用' : data?.has_trial === 0 ? '，无试用' : ''}`);
    await load();
  } catch (e) {
    toast.error(e.message || '检测失败');
  } finally {
    delete rowPending[row.id];
  }
}

async function startRowExtract(row) {
  if (rowJobDisabled(row, 'extract')) return;
  rowPending[row.id] = 'extract';
  try {
    const data = await api.post(`/accounts/${row.id}/extract`, withChannel({
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY,
      concurrency: 1,
    }));
    liveJobs.extract = {
      running: true,
      ids: [...new Set([...(liveJobs.extract.ids || []), Number(row.id)])],
      emails: [...new Set([...(liveJobs.extract.emails || []), String(row.email || '').toLowerCase()].filter(Boolean))],
      run_id: data?.run_id || liveJobs.extract.run_id || '',
    };
    toast.success('已开始提链');
  } catch (e) {
    toast.error(e.message || '启动提链失败');
  } finally {
    delete rowPending[row.id];
  }
}

async function startRowActivate(row) {
  if (isGc.value) {
    if (!gcashReady(row)) return toast.error('请先出码');
    await openGcashPaywall(row);
    return;
  }
  if (rowJobDisabled(row, 'activate')) return;
  rowPending[row.id] = 'activate';
  try {
    const data = await api.post(`/accounts/${row.id}/activate`, withChannel({
      proxy_group: DEFAULT_GB_REBIND_PROXY,
      concurrency: 1,
    }));
    liveJobs.activate = {
      running: true,
      ids: [...new Set([...(liveJobs.activate.ids || []), Number(row.id)])],
      emails: [...new Set([...(liveJobs.activate.emails || []), String(row.email || '').toLowerCase()].filter(Boolean))],
      run_id: data?.run_id || liveJobs.activate.run_id || '',
    };
    toast.success('已开始支付');
  } catch (e) {
    toast.error(e.message || '启动支付失败');
  } finally {
    delete rowPending[row.id];
  }
}

async function startRowAcquireRt(row) {
  if (rowJobDisabled(row, 'rt')) return;
  const ok = await confirmDialog({
    title: '拿 RT',
    message: `对 ${row.email} 用协议（账号→密码→2FA）拿 RT？已绑定手机则不会再买号；若 OpenAI 仍要求手机验证，将使用支付同一套 SMSBower 智利号。`,
    confirmText: '开始',
  });
  if (!ok) return;
  rowPending[row.id] = 'rt';
  try {
    await loadRegOptions().catch(() => {});
    const data =     await api.post('/accounts/acquire-rt', withChannel(accountRtPayload({
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : `__auto__:${DEFAULT_RT_PROXY_COUNTRY}`,
      proxy_country: isGc.value ? 'PH' : DEFAULT_RT_PROXY_COUNTRY,
      phone_country: DEFAULT_RT_PHONE_COUNTRY,
      concurrency: 1,
      force: true,
      performance_profile: regForm.performance_profile,
    }, [row.id], 1)));
    toast.success(`已启动拿 RT${data.skipped ? `，预检跳过 ${data.skipped}` : ''}`);
  } catch (e) {
    toast.error(e.message || '启动拿 RT 失败');
  } finally {
    delete rowPending[row.id];
  }
}

const dialog = ref(false);
const saving = ref(false);
const editPwdVisible = ref(true);
const emptyForm = () => ({
  id: null, email: '', password: '', plan_type: 'Free',
  status: '未检测', expires_at: '',
  access_token: '', refresh_token: '', totp_secret: '',
});
const form = reactive(emptyForm());
const editExpiresOriginal = ref('');

async function openEdit(row) {
  try {
    const detail = await api.get(`/accounts/${row.id}`);
    Object.assign(form, emptyForm(), {
      id: detail.id,
      email: detail.email,
      password: detail.password || '',
      plan_type: detail.plan_type || 'Free',
      status: detail.status,
      expires_at: toExpiresInput(detail.expires_at),
      access_token: detail.access_token || '',
      refresh_token: detail.refresh_token || '',
      totp_secret: detail.totp_secret || '',
    });
    editExpiresOriginal.value = detail.expires_at || '';
    editPwdVisible.value = true;
    dialog.value = true;
  } catch (e) {
    toast.error(e.message);
  }
}

async function save() {
  if (!form.email) return toast.error('账号邮箱不能为空');
  saving.value = true;
  try {
    await api.put(`/accounts/${form.id}`, {
      email: form.email,
      password: form.password,
      status: form.status,
      plan_type: form.plan_type,
      expires_at: fromExpiresInput(form.expires_at, editExpiresOriginal.value),
      access_token: form.access_token,
      refresh_token: form.refresh_token,
      totp_secret: form.totp_secret,
    });
    toast.success('已保存');
    dialog.value = false;
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  if (!accountCanDelete(row)) {
    toast.error(deleteKeepMessage(row));
    return;
  }
  const ok = await confirmDialog({
    title: '删除账号',
    message: `确定删除账号 ${row.email} 吗？有试用或提链失败满 20 次的账号会保留。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/accounts/${row.id}`);
    selected.delete(row.id);
    toast.success('已删除');
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

async function batchDelete(mode = 'selected') {
  const ids = [...selected];
  closeOps();
  if (mode === 'selected' && !ids.length) return;
  const meanings = {
    selected: '选中的账号',
    invalid: '已确认令牌失效或已过期且未支付的普通号；已支付、有试用、提链失败满 20 次以及 Plus/Pro/Team 不会删除',
    banned: '状态为已封禁、已停用或具有明确停用安全状态的账号',
    all: '当前用户的全部账号',
  };
  let count = mode === 'selected' ? ids.length : 0;
  try {
    const preview = await api.post('/accounts/batch-delete', withChannel({ mode, ids, dry_run: true }));
    count = preview.count;
  } catch (e) {
    return toast.error(e.message);
  }
  if (!count) {
    if (mode === 'selected' && ids.length) return toast.error('有试用，已保留');
    return toast.error('没有符合该条件的账号');
  }
  const ok = await confirmDialog({
    title: '批量删除账号',
    message: `将永久删除 ${count} 个${meanings[mode]}。有试用或提链失败满 20 次的账号会保留。此操作不可恢复，确定继续吗？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const data = await api.post('/accounts/batch-delete', withChannel({ mode, ids }));
    if (mode === 'selected') ids.forEach((id) => selected.delete(id));
    else selected.clear();
    toast.success(`已删除 ${data.deleted} 个账号`);
    load();
  } catch (e) {
    toast.error(e.message);
  }
}

const importDialog = ref(false);
const importing = ref(false);
const importText = ref('');
const importResult = ref(null);

function openImport() {
  closeOps();
  importText.value = '';
  importResult.value = null;
  importDialog.value = true;
}

function pickImport(ext) {
  closeOps();
  pendingImportExt.value = ext;
  const el = importFile.value;
  if (!el) return;
  el.accept = IMPORT_ACCEPT[ext] || '*';
  el.value = '';
  el.click();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function onHiddenFile(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  importing.value = true;
  try {
    const payload = await Promise.all(files.map(async (file) => ({
      filename: file.name,
      content_base64: await fileToBase64(file),
    })));
    const data = await api.post('/accounts/import-file', withChannel({ files: payload }));
    toast.success(`导入完成：成功 ${data.success}，跳过 ${data.skipped}，无效 ${data.invalid}，重复 ${data.duplicate}`);
    load();
  } catch (err) {
    toast.error(err.message);
  } finally {
    importing.value = false;
  }
}

async function doImport() {
  if (!importText.value.trim()) return toast.error('请粘贴要导入的内容');
  importing.value = true;
  importResult.value = null;
  try {
    const data = await api.post('/accounts/batch-import', withChannel({ text: importText.value }));
    importResult.value = data;
    toast.success(`导入完成:成功 ${data.success} 个`);
    load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    importing.value = false;
  }
}

function downloadBase64(filename, b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const exportDialog = ref(false);
const exporting = ref(false);
const exportFormat = ref('sub2');
const txtFields = ref(['email', 'password', 'totp_secret']);

function openExport() {
  closeOps();
  exportDialog.value = true;
}

function setTxtPreset(preset) {
  const presets = {
    security: ['email', 'password', 'totp_secret'],
    access: ['email', 'password', 'totp_secret', 'access_token'],
    refresh: ['email', 'password', 'totp_secret', 'access_token', 'refresh_token'],
  };
  txtFields.value = [...presets[preset]];
}

async function doExport() {
  closeOps();
  exporting.value = true;
  try {
    const ids = [...selected];
    const data = await api.post('/accounts/export', withChannel({
      format: exportFormat.value,
      ids,
      fields: exportFormat.value === 'txt' ? txtFields.value : undefined,
    }));
    downloadBase64(data.filename, data.content_base64, data.mime);
    exportDialog.value = false;
    toast.success(`已导出 ${data.exported} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ''}`);
  } catch (e) {
    toast.error(e.message);
  } finally {
    exporting.value = false;
  }
}

const regDialog = ref(false);
const reg = reactive({
  run_id: '',
  running: false,
  busy: false,
  finished: false,
  target: 0,
  success: 0,
  failed: 0,
  retried: 0,
  message: '',
  current_email: '',
});
const regOptions = reactive({
  unused_emails: 0,
  groups: [],
  default_proxy_group: DEFAULT_REGISTER_PROXY_GROUP,
  cloak: { license_configured: false, headless: true, max_concurrency: 5, humanize: true },
  registration: {
    set_password: true, enable_totp_2fa: true, mail_provider: 'mailcom', mail_providers: {},
    dynamic_proxy_configured: false, dynamic_proxy_active_pool: '1024proxy',
  },
});
const regForm = reactive({
  proxy_group: DEFAULT_REGISTER_PROXY_GROUP, count: 1, concurrency: null, mail_provider: 'mailcom',
  set_password: true, enable_totp_2fa: true,
  register_mode: 'headless_click', performance_profile: 'safe', humanize: true, visible: false,
  attempts: 3, email_timeout_seconds: 300,
});
const phoneCountries = ref([
  { value: 'BR', label: '巴西', dial_code: '+55' },
  { value: 'JP', label: '日本', dial_code: '+81' },
  { value: 'US', label: '美国', dial_code: '+1' },
  { value: 'GB', label: '英国', dial_code: '+44' },
]);
const pipeline = reactive({ register: false, rebind: false, extract: false, pay: false, acquire_rt: false });
const pipelineBusy = ref(false);
const pipelineItems = computed(() => (isGc.value
  ? [
    { key: 'register', label: '注册', title: '写 pipeline_gc.register。持续注册 GC 号（PH），不会启动 GB PayPal。' },
    { key: 'rebind', label: '换绑', title: '写 pipeline_gc.rebind。注册且有试用后自动换绑，走 __auto__:PH。失败不提链，不删有试用的号。' },
    { key: 'extract', label: '出码', title: '写 pipeline_gc.extract。有 GCash 资格的账号自动出码，写入 gcash_*。' },
    { key: 'pay', label: '支付墙', title: '写 pipeline_gc.pay。出码后打开 GCash 支付墙轮询，不进 PayPal。' },
    { key: 'acquire_rt', label: '拿RT', title: '写 pipeline_gc.acquire_rt。支付成功后拿 RT，走 PH 代理。' },
  ]
  : [
    { key: 'register', label: '注册', title: '开启后持续自动注册；有试用的账号会进入后续步骤' },
    { key: 'rebind', label: '换绑', title: '注册且有试用后自动换绑，走 __auto__:GB。失败不提链，不删有试用的号。关掉则跳过换绑。' },
    { key: 'extract', label: '提链', title: '有试用资格的账号自动提链；失败 5 分钟后重试' },
    { key: 'pay', label: '支付', title: '提链成功后自动支付' },
    { key: 'acquire_rt', label: '拿RT', title: '该账号提链并支付成功后才拿 RT；单号支付成功立刻入队，不等整批结束' },
  ]));
const rtDialog = ref(false);
const rtBusy = ref(false);
const rtForm = reactive({
  proxy_group: `__auto__:${DEFAULT_RT_PROXY_COUNTRY}`,
  proxy_country: DEFAULT_RT_PROXY_COUNTRY,
  phone_country: DEFAULT_RT_PHONE_COUNTRY,
  concurrency: 5,
  phone_max_price: '',
  visible: false,
});
let regTimer = null;

const regProgressText = computed(() => {
  if (reg.running) {
    const extra = reg.failed ? `，失败 ${reg.failed}` : '';
    return `注册中 ${reg.success}/${reg.target}${extra}`;
  }
  if (reg.finished || reg.target) return `已结束 成功 ${reg.success}/${reg.target}，失败 ${reg.failed}`;
  return '';
});

function applyPipeline(data = {}) {
  pipeline.register = data.register === true;
  pipeline.rebind = data.rebind === true;
  pipeline.extract = data.extract === true;
  pipeline.pay = data.pay === true;
  pipeline.acquire_rt = data.acquire_rt === true;
}

async function loadPipeline() {
  const data = await api.get('/settings');
  applyPipeline(isGc.value ? (data.pipeline_gc || {}) : (data.pipeline || {}));
}

async function togglePipeline(key) {
  const item = pipelineItems.value.find((entry) => entry.key === key);
  if (!item) return;
  const previous = pipeline[key];
  pipeline[key] = !previous;
  pipelineBusy.value = true;
  try {
    const path = isGc.value ? '/settings/pipeline-gc' : '/settings/pipeline';
    const data = await api.put(path, { ...pipeline });
    applyPipeline(isGc.value ? (data.pipeline_gc || pipeline) : (data.pipeline || pipeline));
    toast.success(pipeline[key] ? `已开启${item.label}` : `已关闭${item.label}`);
  } catch (e) {
    pipeline[key] = previous;
    toast.error(e.message || '保存流水线开关失败');
  } finally {
    pipelineBusy.value = false;
  }
}

function applyRegStatus(st) {
  if (!st) return;
  const wasRunning = reg.running;
  reg.run_id = st.run_id || reg.run_id || '';
  reg.running = Boolean(st.running);
  reg.finished = Boolean(st.finished);
  reg.target = st.target || 0;
  reg.success = st.success || 0;
  reg.failed = st.failed || 0;
  reg.retried = st.retried || 0;
  reg.message = st.message || '';
  reg.current_email = st.current_email || '';
  if (wasRunning && !st.running) load();
}

async function loadRegOptions() {
  const data = await api.get('/register/options');
  regOptions.unused_emails = data.unused_emails || 0;
  regOptions.groups = data.groups || [];
  Object.assign(regOptions.cloak, data.cloak || {});
  Object.assign(regOptions.registration, data.registration || {});
  regOptions.default_proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_REGISTER_PROXY_GROUP;
  regForm.mail_provider = data.registration?.mail_provider || 'mailcom';
  regForm.set_password = data.registration?.set_password !== false;
  regForm.enable_totp_2fa = data.registration?.enable_totp_2fa !== false;
  regForm.humanize = data.cloak?.humanize !== false;
  regForm.performance_profile = data.registration?.performance_profile || 'safe';
  regForm.attempts = Number(data.registration?.attempts) || 3;
  if (!isGc.value) applyRegStatus(data.runtime);
  if (!regForm.count) regForm.count = Math.min(1, data.unused_emails || 1);
  if (regForm.concurrency == null || !Number(regForm.concurrency)) {
    regForm.concurrency = defaultRegisterConcurrency(data.cloak?.max_concurrency);
  }
  regForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_REGISTER_PROXY_GROUP;
  extractForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY;
  if (!extractForm.concurrency) extractForm.concurrency = 1;
}

async function loadRegisterMetadata() {
  const countries = await api.get('/register/sms-phone-countries');
  if (countries.items?.length) phoneCountries.value = countries.items;
}

async function openRegister() {
  closeOps();
  try {
    await loadRegOptions();
    if (!regForm.count) regForm.count = Math.max(1, Math.min(5, regOptions.unused_emails || 1));
    if (regForm.concurrency == null || !Number(regForm.concurrency)) {
      regForm.concurrency = defaultRegisterConcurrency(regOptions.cloak.max_concurrency);
    }
    regForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_REGISTER_PROXY_GROUP;
    regDialog.value = true;
  } catch (e) {
    toast.error(e.message);
  }
}

async function pollReg() {
  try {
    applyRegStatus(await api.get('/register/status', { params: { channel: channel.value } }));
  } catch {
    /* 轮询失败忽略 */
  }
}

async function startRegister() {
  if (!regOptions.cloak.license_configured) return toast.error('请先在个人设置配置 CloakBrowser 授权');
  if (regForm.mail_provider === 'mailcom' && !regOptions.unused_emails) return toast.error('没有可用的未使用子号');
  if (regForm.register_mode === 'headless_click' && !regForm.set_password) return toast.error('无头模拟点击必须设置登录密码');
  const count = Math.max(1, Math.min(2000, Number(regForm.count) || 1));
  const maxThreads = Math.max(1, Number(regOptions.cloak.max_concurrency) || 1);
  const concurrency = Math.max(1, Math.min(Number(regForm.concurrency) || 1, maxThreads));
  regForm.concurrency = concurrency;
  regForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_REGISTER_PROXY_GROUP;
  reg.busy = true;
  try {
    const data = await api.post('/register/start', registrationPayload({
      ...regForm,
      count,
      concurrency,
      groups: regOptions.groups,
      channel: channel.value,
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : DEFAULT_REGISTER_PROXY_GROUP,
      proxy_country: isGc.value ? 'PH' : 'GB',
    }));
    applyRegStatus({
      run_id: data.run_id,
      running: true,
      target: data.target,
      success: 0,
      failed: 0,
      message: `已启动，目标 ${data.target}，并发 ${data.concurrency}`,
    });
    if (data.warning) toast.success(`已开始注册 ${data.target} 个账号。${data.warning}`);
    else toast.success(`已开始注册 ${data.target} 个账号`);
    regDialog.value = false;
  } catch (e) {
    toast.error(e.message);
  } finally {
    reg.busy = false;
  }
}

async function stopRegister() {
  reg.busy = true;
  try {
    const data = await api.post('/register/stop', { channel: channel.value });
    toast.success(data.message || '已发送停止指令');
    await pollReg();
  } catch (e) {
    toast.error(e.message);
  } finally {
    reg.busy = false;
  }
}

async function startAcquireRt() {
  const ids = [...selected];
  if (!ids.length) return toast.error('请先选择要获取 RT 的账号');
  rtBusy.value = true;
  try {
    const data = await api.post('/accounts/acquire-rt', withChannel(accountRtPayload({
      ...rtForm,
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY,
      proxy_country: isGc.value ? 'PH' : DEFAULT_RT_PROXY_COUNTRY,
      performance_profile: regForm.performance_profile,
    }, ids, regOptions.cloak.max_concurrency)));
    toast.success(`已启动 ${data.accepted} 个账号的 RT 任务${data.skipped ? `，预检跳过 ${data.skipped}` : ''}`);
    rtDialog.value = false;
  } catch (e) {
    toast.error(e.message);
  } finally {
    rtBusy.value = false;
  }
}

async function openAcquireRt() {
  closeOps();
  if (!selected.size) return toast.error('请先选择要获取 RT 的账号');
  try {
    await Promise.all([loadRegOptions(), loadRegisterMetadata()]);
    rtForm.concurrency = Math.max(1, Math.min(Number(rtForm.concurrency) || 5, Number(regOptions.cloak.max_concurrency) || 5));
    syncRtAutoProxy();
    rtDialog.value = true;
  } catch (e) {
    toast.error(e.message);
  }
}

function syncRtAutoProxy() {
  rtForm.proxy_country = isGc.value ? 'PH' : DEFAULT_RT_PROXY_COUNTRY;
  rtForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY;
}

function goExtractLogs() {
  router.push({
    name: 'logs',
    query: extractLogsQuery(liveJobs.extract),
  });
}

function goActivateLogs() {
  router.push({
    name: 'logs',
    query: activateLogsQuery(liveJobs.activate),
  });
}

function goRebindLogs() {
  router.push({
    name: 'logs',
    query: { tab: 'account' },
  });
}

const operationDialog = ref(false);
const operationKind = ref('detect');
const operationForm = reactive({ proxy_group: '', concurrency: 1 });
const extractForm = reactive({ proxy_group: '', concurrency: 1 });
const operation = reactive({ running: false, finished: false, busy: false, message: '' });
let operationTimer = null;
let liveTimer = null;

const payOperation = computed(() => operationKind.value === 'extract' || operationKind.value === 'activate');
const jobbedOperation = computed(() => payOperation.value || operationKind.value === 'rebind');
const activeOperationForm = computed(() => (payOperation.value ? extractForm : operationForm));
const operationConcurrencyMax = computed(() => {
  if (operationKind.value === 'rebind') return REBIND_CONCURRENCY_MAX;
  if (isGc.value && (operationKind.value === 'extract' || operationKind.value === 'activate' || operationKind.value === 'detect')) {
    return GCASH_CONCURRENCY_CAP;
  }
  if (operationKind.value === 'extract') return 5;
  if (operationKind.value === 'activate') return Math.min(5, Number(regOptions.cloak.max_concurrency) || 5);
  return Number(regOptions.cloak.max_concurrency) || 5;
});
const operationDialogTitle = computed(() => {
  if (isGc.value) {
    return {
      detect: '批量检测 GCash 资格',
      refresh: '批量刷新账号',
      rebind: '批量换绑',
      extract: '批量出码（GCash）',
      activate: '打开 GCash 支付墙',
    }[operationKind.value] || '批量操作';
  }
  return {
    detect: '批量检测账号',
    refresh: '批量刷新账号',
    rebind: '批量换绑',
    extract: '批量提链',
    activate: '批量支付 / 开通',
  }[operationKind.value] || '批量操作';
});
const operationDialogConfirm = computed(() => {
  if (isGc.value) {
    return {
      detect: '开始检测',
      refresh: '开始刷新',
      rebind: '开始换绑',
      extract: '开始出码',
      activate: '打开支付墙',
    }[operationKind.value] || '开始';
  }
  return {
    detect: '开始检测',
    refresh: '开始刷新',
    rebind: '开始换绑',
    extract: '开始提链',
    activate: '开始支付',
  }[operationKind.value] || '开始';
});
const operationDialogHint = computed(() => {
  if (operationKind.value === 'rebind') {
    return `手工强制换绑当前勾选的 ${selected.size} 个账号（未检测、无试用也会执行）。只跳过缺少密码或 TOTP 的号，原因会写明是缺密码还是缺 TOTP。没有 AT 会先用密码+TOTP 登录再换绑。自动流水线仍是「有试用才换」。默认 ${REBIND_CONCURRENCY_DEFAULT} 线程，上限 ${REBIND_CONCURRENCY_MAX}。走当前页通道（${isGc.value ? 'GC / __auto__:PH' : 'GB / __auto__:GB'}）。过程见日志「账号检测 / 换绑」。`;
  }
  if (operationKind.value === 'extract') {
    return isGc.value
      ? `将处理${selected.size ? `选中的 ${selected.size} 个` : '全部'} GC 账号的 GCash 出码。使用菲律宾动态代理 __auto__:PH，不走 oauth/PayPal，成功后写 gcash_* 并打开支付墙。默认 ${GCASH_CONCURRENCY_CAP} 路并发出码/H5（上限 ${GCASH_CONCURRENCY_CAP}）。`
      : `将处理${selected.size ? `选中的 ${selected.size} 个` : '全部'}账号的 GB PayPal 提链。走设置里的 CliProxy 动态池 + region-GB，不读手工「支付」组。并发上限 5（协议 HTTP，不占用 Cloak 席位）。不会真实扣款；成功后进度变为已提链，点击可复制 PayPal 支付链。`;
  }
  if (operationKind.value === 'activate') {
    return isGc.value
      ? `将处理${selected.size ? `选中的 ${selected.size} 个` : '全部'} GC 账号的 GCash 支付墙。每张码独立 H5 + consult UUID，墙上几张码就并行等几笔付款，上限 ${GCASH_CONCURRENCY_CAP} 路。`
      : `将处理${selected.size ? `选中的 ${selected.size} 个` : '全部'}账号的 GB PayPal 支付/开通。必须先有未过期提链（90 分钟），走设置里的 CliProxy 动态池 + region-GB，不读手工「支付」组，并发上限 5。接码走设置里已保存的 SMSBower Key，固定英国号码 + PayPal 服务。成功后进度变为已支付；代理/传输失败不会把账号标成封禁。`;
  }
  return `将处理${selected.size ? `选中的 ${selected.size} 个` : '全部'}账号。传输故障只记录失败，不会把账号标记为失效。刷新优先轮换 RT；没有 RT 时会使用已保存的 ChatGPT 密码登录，并按页面要求读取邮箱 OTP 或本地 TOTP。若上游强制手机验证，将保留已验证的新会话 AT 并报告部分成功。`;
});

async function openAccountOperation(kind) {
  closeOps();
  if (kind === 'rebind' && !selected.size) {
    toast.error('请先勾选要换绑的账号');
    return;
  }
  if (isGc.value && kind === 'activate') {
    const rows = selected.size ? items.value.filter((r) => selected.has(r.id)) : items.value;
    const ready = rows.find((r) => gcashReady(r));
    if (ready) {
      await openGcashPaywall(ready);
      return;
    }
    if (selected.size) {
      toast.error('请先出码');
      return;
    }
  }
  operationKind.value = kind;
  if (!regOptions.groups.length) await loadRegOptions().catch(() => {});
  if (kind === 'extract' || kind === 'activate') {
    extractForm.proxy_group = isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY;
    if (isGc.value) {
      extractForm.concurrency = GCASH_CONCURRENCY_CAP;
    } else {
      const cap = kind === 'extract'
        ? 5
        : Math.max(1, Math.min(5, Number(regOptions.cloak.max_concurrency) || 5));
      const fallbackConcurrency = kind === 'extract' ? 1 : 5;
      extractForm.concurrency = Math.max(1, Math.min(Number(extractForm.concurrency) || fallbackConcurrency, cap));
    }
  }
  if (kind === 'detect' && isGc.value) {
    operationForm.concurrency = GCASH_CONCURRENCY_CAP;
  }
  if (kind === 'rebind') {
    operationForm.concurrency = REBIND_CONCURRENCY_DEFAULT;
  }
  operationDialog.value = true;
  await pollAccountOperation();
}

async function startAccountOperation() {
  if (operationKind.value === 'rebind' && !selected.size) {
    return toast.error('请先勾选要换绑的账号');
  }
  const count = selected.size || total.value;
  const kindLabel = { detect: '检测', refresh: '刷新', extract: '提链', activate: '支付', rebind: '换绑' }[operationKind.value] || '处理';
  const ok = await confirmDialog({
    title: `确认${kindLabel}账号`,
    message: operationKind.value === 'rebind'
      ? `确认强制换绑选中的 ${selected.size} 个账号？勾选号会强制执行（未检测、无试用也会执行）；只跳过缺少密码或 TOTP 的号并写日志，不会删号。`
      : `确认${kindLabel}${selected.size ? `选中的 ${count} 个` : `全部 ${count} 个`}账号？`,
    confirmText: operationKind.value === 'rebind' ? '开始换绑' : '开始',
  });
  if (!ok) return;
  operation.busy = true;
  try {
    const path = `/accounts/operations/${operationKind.value}`;
    const form = activeOperationForm.value;
    const extractCap = isGc.value && payOperation.value
      ? GCASH_CONCURRENCY_CAP
      : operationKind.value === 'extract'
        ? 5
        : Math.max(1, Math.min(5, Number(regOptions.cloak.max_concurrency) || 5));
    const concurrency = operationKind.value === 'rebind'
      ? Math.max(1, Math.min(Number(form.concurrency) || REBIND_CONCURRENCY_DEFAULT, REBIND_CONCURRENCY_MAX))
      : payOperation.value
        ? Math.max(
          1,
          Math.min(
            Number(form.concurrency) || (isGc.value ? GCASH_CONCURRENCY_CAP : (operationKind.value === 'extract' ? 1 : 5)),
            extractCap,
            Math.max(1, count),
          ),
        )
        : form.concurrency;
    const data = await api.post(path, withChannel({
      ids: [...selected],
      proxy_group: isGc.value ? DEFAULT_GC_PROXY : DEFAULT_GB_REBIND_PROXY,
      concurrency,
      ...(operationKind.value === 'rebind' ? { source: 'batch' } : {}),
    }));
    if (operationKind.value === 'rebind' && !data.accepted) {
      operation.running = false;
      operation.message = data.message || `已跳过 ${data.skipped || 0} 个（缺少密码或 TOTP）`;
      toast.success(`${operation.message}。详情见日志「账号检测 / 换绑」`);
      return;
    }
    operation.running = true;
    operation.message = '任务已启动';
    if (operationKind.value === 'extract') {
      liveJobs.extract = {
        ...liveJobs.extract,
        running: true,
        run_id: data?.run_id || liveJobs.extract.run_id || '',
      };
    }
    if (operationKind.value === 'activate') {
      liveJobs.activate = {
        ...liveJobs.activate,
        running: true,
        run_id: data?.run_id || liveJobs.activate.run_id || '',
      };
    }
    if (operationKind.value === 'rebind') {
      toast.success(`已强制启动 ${data.accepted} 个换绑${data.skipped ? `，跳过 ${data.skipped} 个无法登录` : ''}，过程见日志「账号检测 / 换绑」`);
    } else {
      toast.success({
        extract: '提链任务已启动',
        activate: '支付任务已启动',
      }[operationKind.value] || '账号任务已启动');
    }
  } catch (e) {
    toast.error(e.message);
  } finally {
    operation.busy = false;
  }
}

async function pollAccountOperation() {
  try {
    const path = jobbedOperation.value
      ? `/accounts/operations/${operationKind.value}/status`
      : '/accounts/operations/status';
    const data = await api.get(path, { params: { channel: channel.value } });
    const wasRunning = operation.running;
    operation.running = Boolean(data.running);
    operation.finished = Boolean(data.finished);
    operation.message = data.message || '';
    if (operationKind.value === 'extract' && data?.run_id) {
      liveJobs.extract.run_id = data.run_id;
    }
    if (operationKind.value === 'activate' && data?.run_id) {
      liveJobs.activate.run_id = data.run_id;
    }
    if (wasRunning && !operation.running) {
      await loadAccounts();
      if (operationKind.value === 'rebind') {
        toast.success('换绑结束，列表已刷新新邮箱/AT。详情见日志「账号检测 / 换绑」');
      }
    }
  } catch {}
}

async function pollLiveJobs() {
  try {
    const data = await api.get('/accounts/live-jobs', { params: { channel: channel.value } });
    const wasBusy = liveJobs.extract.running || liveJobs.activate.running || liveJobs.detect.running;
    applyLiveJobs(data);
    const busy = liveJobs.extract.running || liveJobs.activate.running || liveJobs.detect.running;
    if (wasBusy && !busy) {
      load();
    }
  } catch {}
}

async function stopAccountOperation() {
  const path = jobbedOperation.value
    ? `/accounts/operations/${operationKind.value}/stop`
    : '/accounts/operations/stop';
  await api.post(path, { channel: channel.value });
  toast.success('已发送停止指令');
  pollAccountOperation();
}

const paywall = reactive({
  show: false, email: '', qr: '', link: '', cs_id: '', paid: false, expired: false, id: 0, error: '',
  qr_remaining_ms: 0, continue_submitted: false, continue_error: '', phase: '', scannable: false,
  refreshable: false, refreshing: false, refresh_message: '', processing: false, status: '',
});
let paywallTimer = null;
let paywallTick = null;

function applyPaywallPayload(data = {}) {
  if (Object.prototype.hasOwnProperty.call(data, 'qr')) paywall.qr = data.qr || '';
  if (Object.prototype.hasOwnProperty.call(data, 'link')) paywall.link = data.link || '';
  if (Object.prototype.hasOwnProperty.call(data, 'cs_id')) paywall.cs_id = data.cs_id || '';
  paywall.paid = Boolean(data.paid);
  paywall.expired = Boolean(data.expired);
  paywall.continue_submitted = Boolean(data.continue_submitted);
  paywall.continue_error = data.continue_error || '';
  paywall.phase = data.phase || paywall.phase;
  paywall.status = data.status || paywall.status;
  paywall.scannable = Boolean(data.scannable);
  paywall.processing = Boolean(data.processing);
  paywall.refreshable = Boolean(data.refreshable);
  paywall.refreshing = Boolean(data.refreshing);
  paywall.refresh_message = data.refresh_message || '';
  if (data.qr_remaining_ms != null) paywall.qr_remaining_ms = Number(data.qr_remaining_ms) || 0;
}


function openGcashLink() {
  if (!paywall.link) return;
  window.open(paywall.link, '_blank', 'noopener');
}

async function openGcashPaywall(row) {
  paywall.show = true;
  paywall.id = row.id;
  paywall.email = row.email || '';
  paywall.qr = '';
  paywall.link = '';
  paywall.cs_id = '';
  paywall.paid = false;
  paywall.expired = false;
  paywall.error = '';
  paywall.qr_remaining_ms = 0;
  paywall.continue_submitted = false;
  paywall.phase = '';
  paywall.scannable = false;
  paywall.refreshable = false;
  paywall.refreshing = false;
  paywall.refresh_message = '';
  paywall.processing = false;
  paywall.status = '';
  if (paywallTimer) {
    clearInterval(paywallTimer);
    paywallTimer = null;
  }
  if (paywallTick) {
    clearInterval(paywallTick);
    paywallTick = null;
  }
  try {
    const data = await api.get(`/accounts/${row.id}/gcash-qr`);
    applyPaywallPayload(data);
    if (data.qr_missing || (!paywall.qr && paywall.link)) {
      paywall.error = data.message || '已有跳转链但未抽到二维码。请重新出码；可临时打开或复制链接。';
    } else if (!paywall.qr && !paywall.link) {
      paywall.error = data.message || '没有二维码，也没有可打开的链接。请先出码。';
    }
    if (paywall.cs_id || paywall.qr || paywall.link) {
      paywallTimer = setInterval(pollGcashPaywall, 4000);
      paywallTick = setInterval(() => {
        if (paywall.qr_remaining_ms > 0) {
          paywall.qr_remaining_ms = Math.max(0, paywall.qr_remaining_ms - 1000);
          if (paywall.qr_remaining_ms === 0) paywall.scannable = false;
        }
      }, 1000);
    }
  } catch (e) {
    paywall.expired = Boolean(e.expired) || /过期/.test(String(e.message || ''));
    paywall.qr = e.qr || '';
    paywall.link = e.link || '';
    paywall.error = e.message || '打开支付墙失败';
  }
}

async function pollGcashPaywall() {
  if (!paywall.show || !paywall.id) return;
  try {
    const data = await api.get(`/accounts/${paywall.id}/gcash-pay-status`);
    applyPaywallPayload(data);
    if (data.paid || data.expired) {
      if (paywallTimer) clearInterval(paywallTimer);
      paywallTimer = null;
      if (paywallTick) clearInterval(paywallTick);
      paywallTick = null;
      if (data.paid) toast.success('GCash 已开通 Plus');
      load();
    }
  } catch {
    /* keep waiting */
  }
}

const wall = reactive({
  show: false,
  items: [],
  onlyScannable: true,
  hideFinished: true,
  refreshingAll: false,
  error: '',
});
const visibleWallItems = computed(() => filterAndSortGcashWall(wall.items, {
  onlyScannable: wall.onlyScannable,
  hideFinished: wall.hideFinished,
}));
let wallTimer = null;
let wallTick = null;

function applyGcashWall(data = {}) {
  const current = new Map(wall.items.map((item) => [Number(item.id), item]));
  wall.items = (data.items || []).map((item) => ({
    ...current.get(Number(item.id)),
    ...item,
  }));
}

async function pollGcashWall() {
  if (!wall.show) return;
  try {
    applyGcashWall(await api.get('/accounts/gcash/paywall-wall'));
    wall.error = '';
  } catch (error) {
    wall.error = error.message || '二维码墙刷新失败';
  }
}

async function openGcashWall() {
  wall.show = true;
  wall.error = '';
  await pollGcashWall();
  if (wallTimer) clearInterval(wallTimer);
  if (wallTick) clearInterval(wallTick);
  wallTimer = setInterval(pollGcashWall, 4000);
  wallTick = setInterval(() => {
    wall.items.forEach((item) => {
      item.qr_remaining_ms = Math.max(0, Number(item.qr_remaining_ms || 0) - 1000);
      if (item.qr_remaining_ms === 0) item.scannable = false;
    });
  }, 1000);
}

function closeGcashWall() {
  wall.show = false;
  if (wallTimer) clearInterval(wallTimer);
  if (wallTick) clearInterval(wallTick);
  wallTimer = null;
  wallTick = null;
}

async function refreshGcashQr(target) {
  if (!target?.id || target.refreshing || !target.refreshable || target.processing) return;
  target.refreshing = true;
  target.refresh_message = '';
  try {
    const data = await api.post(`/accounts/${target.id}/gcash-qr/refresh`, { channel: 'gc' });
    if (target === paywall) applyPaywallPayload(data.item || {});
    else Object.assign(target, data.item || {});
    if (!data.ok) {
      target.status = 'refresh_failed';
      target.refresh_message = data.message || '二维码刷新失败，请稍后重试';
      toast.error(target.refresh_message);
      return;
    }
    toast.success('二维码已刷新');
  } catch (error) {
    target.refreshing = false;
    target.scannable = false;
    target.refreshable = false;
    target.status = 'refresh_failed';
    target.refresh_message = error.message || '会话已失效，需要新号重新出码';
  }
}

async function refreshExpiredGcashWall() {
  if (wall.refreshingAll) return;
  wall.refreshingAll = true;
  try {
    const data = await api.post('/accounts/gcash/paywall-wall/refresh', { channel: 'gc' });
    applyGcashWall(data);
    toast.success(`已刷新 ${Number(data.refreshed || 0)} 个二维码`);
  } catch (error) {
    wall.error = error.message || '批量刷新二维码失败';
  } finally {
    wall.refreshingAll = false;
  }
}

async function openGcashWallLink(item) {
  try {
    const data = await api.get(`/accounts/${item.id}/gcash-qr`);
    if (!data.link) throw new Error('链接不可用');
    window.open(data.link, '_blank', 'noopener');
  } catch (error) {
    toast.error(error.message || '打开链接失败');
  }
}

function closeGcashPaywall() {
  paywall.show = false;
  if (paywallTimer) clearInterval(paywallTimer);
  paywallTimer = null;
  if (paywallTick) clearInterval(paywallTick);
  paywallTick = null;
}

watch(channel, () => {
  selected.clear();
  page.value = 1;
  load();
  loadPipeline().catch(() => {});
  loadRegOptions().catch(() => {});
});

onMounted(() => {
  load();
  loadPipeline().catch(() => {});
  loadRegOptions().catch(() => {});
  loadRegisterMetadata().catch(() => {});
  document.addEventListener('click', closeOps);
  regTimer = setInterval(pollReg, 2000);
  operationTimer = setInterval(pollAccountOperation, 2000);
  liveTimer = setInterval(pollLiveJobs, 2000);
});
onUnmounted(() => {
  document.removeEventListener('click', closeOps);
  if (regTimer) clearInterval(regTimer);
  if (operationTimer) clearInterval(operationTimer);
  if (liveTimer) clearInterval(liveTimer);
  if (paywallTimer) clearInterval(paywallTimer);
  if (paywallTick) clearInterval(paywallTick);
  if (wallTimer) clearInterval(wallTimer);
  if (wallTick) clearInterval(wallTick);
});
</script>

<style scoped>
.channel-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--line, var(--border));
  border-radius: 10px;
  font-size: 13px;
  color: var(--ink-500, var(--text-sub));
  background: #fff;
}
.channel-banner-gb { border-color: #bfdbfe; background: #eff6ff; }
.channel-banner-gc { border-color: #bbf7d0; background: #f0fdf4; }
.channel-pill {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff;
  color: var(--ink, var(--text));
  font-size: 12px;
  font-weight: 700;
}
.gcash-wall { display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 120px; }
.gcash-countdown {
  font-size: 28px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.gcash-qr { width: 240px; height: 240px; object-fit: contain; background: #fff; border: 1px solid var(--line, var(--border)); border-radius: 8px; }
.gcash-fallback {
  width: 100%;
  padding: 16px;
  border: 1px dashed var(--line, var(--border));
  border-radius: 8px;
  text-align: center;
  background: #fafafa;
}
.gcash-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.gcash-wall-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 12px;
  background: rgba(15, 23, 42, 0.72);
}
.gcash-wall-panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: min(1100px, 94vw);
  height: min(80vh, 820px);
  min-height: 420px;
  overflow: hidden;
  border-radius: 12px;
  background: #f8fafc;
}
.gcash-wall-panel,
.gcash-wall-panel * {
  font-weight: 400;
}
.gcash-wall-head,
.gcash-wall-toolbar,
.gcash-wall-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.gcash-wall-head {
  justify-content: space-between;
  padding: 10px 12px 7px;
  background: #f8fafc;
}
.gcash-wall-head h2 { margin: 0 0 2px; font-size: 17px; }
.gcash-wall-head p { margin: 0; color: var(--ink-500, var(--text-sub)); font-size: 12px; }
.gcash-wall-head .modal-close {
  border: 0;
  background: transparent;
  font-size: 25px;
  line-height: 1;
  cursor: pointer;
}
.gcash-wall-toolbar {
  z-index: 2;
  min-height: 38px;
  padding: 5px 12px;
  border-block: 1px solid var(--line, var(--border));
  background: #fff;
  font-size: 13px;
}
.gcash-wall-toolbar label { display: inline-flex; align-items: center; gap: 4px; }
.gcash-wall-toolbar .btn { padding: 5px 9px; font-size: 12px; }
.gcash-wall-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
}
.gcash-wall-body > .reg-status { margin: 0 0 8px; }
.gcash-wall-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  align-items: start;
  gap: 8px;
}
.gcash-wall-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line, var(--border));
  border-radius: 8px;
  background: #fff;
  font-size: 13px;
}
.gcash-wall-card-head { align-self: stretch; min-width: 0; }
.gcash-wall-card-head span:first-child { flex: 0 0 auto; }
.gcash-wall-card-head span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gcash-wall-card img,
.gcash-wall-placeholder {
  width: clamp(135px, 13vw, 158px);
  max-width: 100%;
  aspect-ratio: 1;
  height: auto;
  border: 1px solid var(--line, var(--border));
  border-radius: 6px;
  background: #fff;
  object-fit: contain;
}
.gcash-wall-placeholder {
  display: grid;
  place-items: center;
  padding: 8px;
  color: var(--ink-500, var(--text-sub));
  text-align: center;
}
.gcash-wall-clock {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.gcash-wall-state { font-size: 12px; line-height: 1.2; }
.gcash-wall-card .gcash-actions {
  flex-wrap: nowrap;
  gap: 6px;
}
.gcash-wall-card .btn {
  padding: 4px 8px;
  font-size: 12px;
}
.state-waiting_scan { color: #166534; }
.state-processing,
.state-continue_success { color: #1d4ed8; }
.state-expired,
.state-refresh_failed { color: #b91c1c; }
.gcash-wall-empty {
  padding: 48px 16px;
  color: var(--ink-500, var(--text-sub));
  text-align: center;
}
@media (max-width: 700px) {
  .gcash-wall-mask { padding: 8px; }
  .gcash-wall-panel {
    width: calc(100vw - 16px);
    height: calc(100dvh - 16px);
    min-height: 0;
    border-radius: 10px;
  }
  .gcash-wall-head { padding: 8px 10px 6px; }
  .gcash-wall-head p { display: none; }
  .gcash-wall-toolbar { flex-wrap: wrap; padding: 5px 8px; }
  .gcash-wall-toolbar .toolbar-spacer { display: none; }
  .gcash-wall-toolbar .btn { margin-left: auto; }
  .gcash-wall-body { padding: 6px; }
  .gcash-wall-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .gcash-wall-card { padding: 6px; }
  .gcash-wall-card img,
  .gcash-wall-placeholder { width: clamp(128px, 39vw, 150px); }
}
@media (max-width: 330px) {
  .gcash-wall-grid { grid-template-columns: 1fr; }
}
.accounts-page { min-width: 0; max-width: 100%; }
.toolbar-spacer { flex: 1; }
.pipeline-toggles {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.pipe-toggle {
  min-width: 52px;
  padding: 6px 12px;
  border: 1px solid var(--line, var(--border));
  border-radius: 999px;
  background: #fff;
  color: var(--ink-500, var(--text-sub));
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1.2;
}
.pipe-toggle:hover { border-color: var(--kb); color: var(--kb); }
.pipe-toggle.on {
  background: #ecfdf5;
  border-color: #86efac;
  color: #166534;
}
.pipe-toggle:disabled { opacity: 0.55; cursor: not-allowed; }
.toolbar-filter { width: 118px; flex: 0 0 118px; }
.pwd-edit { display: flex; align-items: center; gap: 10px; }
.pwd-edit .input { flex: 1; }
.remark { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-tag {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 2px 8px;
  border: 0;
  border-radius: 999px;
  background: var(--line-soft);
  color: var(--ink-500);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
}
.progress-tag.progress-empty {
  padding: 0;
  background: transparent;
  color: var(--ink-400);
  font-weight: 400;
}
.progress-tag.progress-registered {
  background: var(--line-soft);
  color: var(--ink-500);
}
.progress-tag.progress-extracted {
  background: var(--klein-50);
  color: var(--klein);
}
.progress-tag.progress-paid {
  background: var(--good-bg);
  color: var(--good);
}
.progress-tag.progress-running,
.progress-tag.progress-paying,
.progress-tag.progress-review {
  background: var(--warn-bg);
  color: var(--warn);
}
.progress-tag.progress-expired {
  background: var(--line-soft);
  color: var(--ink-500);
}
.progress-tag.progress-rt {
  background: var(--good-bg);
  color: var(--good);
}
button.progress-tag {
  font-family: inherit;
  cursor: pointer;
}
button.progress-tag:hover {
  filter: brightness(0.97);
}
button.progress-tag:focus-visible {
  outline: 2px solid var(--klein-200);
  outline-offset: 1px;
}
.muted-tag { opacity: 0.72; }
.expires-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }
.row-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  white-space: nowrap;
}
.row-actions .btn-sm {
  padding: 3px 6px;
  font-size: 12px;
  min-height: 26px;
  line-height: 1.2;
  border-radius: 6px;
  box-shadow: none;
  flex: 0 0 auto;
}
.accounts-table-wrap {
  position: relative;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.accounts-table {
  min-width: 1140px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}
.accounts-table .col-check { width: 40px; }
.accounts-table .col-email { width: 280px; }
.email-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.email-cell span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.accounts-table .col-trial { width: 88px; }
.accounts-table .col-plan { width: 78px; }
.accounts-table .col-status { width: 84px; }
.accounts-table .col-expires { width: 142px; }
.accounts-table .col-remark { width: 148px; }
.accounts-table .col-ops { width: 300px; }
.accounts-table th.col-ops,
.accounts-table td.col-ops {
  padding-left: 6px;
  padding-right: 6px;
  text-align: center;
}
.accounts-table th,
.accounts-table td {
  height: 52px;
}
.accounts-table thead th {
  height: 46px;
}
.accounts-table .actions-cell {
  position: sticky;
  right: 0;
  z-index: 1;
  text-align: center;
  white-space: nowrap;
  background: var(--surface);
  border-left: 1px solid var(--line-soft);
  box-shadow: -8px 0 12px -12px rgba(10, 19, 48, 0.35);
}
.accounts-table thead .actions-cell {
  z-index: 2;
  background: var(--bg);
  border-left-color: var(--line);
}
.accounts-table tbody tr:hover .actions-cell {
  background: var(--klein-50);
}
.hidden-file { display: none; }
.link-btn {
  background: none;
  border: none;
  color: var(--kb);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
}
.link-btn:hover { text-decoration: underline; }
.link-btn.danger { color: var(--danger); }

.ops { position: relative; }
.ops-caret { margin-left: 6px; opacity: 0.75; }
.reg-progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 280px;
  padding: 6px 12px;
  border: 1px solid var(--line, var(--border));
  border-radius: 999px;
  background: #fff;
  color: var(--ink-700, var(--text-main));
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reg-progress:hover { background: var(--klein-50, #eef4ff); border-color: var(--kb); }
.reg-progress.running { background: #ecfdf5; border-color: #86efac; color: #166534; }
.reg-progress.failed { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.reg-progress__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  flex-shrink: 0;
}
.reg-progress.running .reg-progress__dot {
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.16);
}
.ops-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 220px;
  background: #fff;
  border: 1px solid var(--line, var(--border));
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12);
  overflow: hidden;
  z-index: 40;
  padding: 6px 0;
}
.ops-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  padding: 9px 16px;
  font-size: 13px;
  color: var(--ink-700, var(--text-main));
  cursor: pointer;
}
.ops-item:hover { background: var(--klein-50, #eef4ff); }
.ops-item:disabled { opacity: 0.45; cursor: not-allowed; }
.ops-item-primary { color: var(--kb); font-weight: 600; }
.ops-item-danger { color: var(--danger); }
.ops-sep {
  padding: 8px 16px 4px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-500, var(--text-sub));
}
.ops-sep:empty {
  padding: 0;
  margin: 6px 12px;
  border-top: 1px solid var(--line, var(--border));
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  flex-wrap: wrap;
  gap: 12px;
}
.pagination-info { color: var(--text-sub); font-size: 13px; }
.pagination-actions { display: flex; align-items: center; gap: 16px; }
.page-size { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-sub); }
.pagination-btns { display: flex; align-items: center; gap: 8px; }
.page-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.page-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.page-current { font-size: 13px; color: var(--text-main); }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.form-item-full { grid-column: 1 / -1; }
.token-input { font-family: Consolas, monospace; font-size: 12px; min-height: 72px; }
.token-toggle {
  cursor: pointer;
  color: var(--kb);
  font-size: 13px;
  margin: 8px 0 14px;
  user-select: none;
}
.import-result {
  margin-top: 12px;
  padding: 12px;
  background: var(--kb-lighter);
  border-radius: 8px;
  font-size: 13px;
}
.export-scope {
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: var(--kb-lighter);
  font-size: 13px;
}
.format-list { display: grid; gap: 8px; }
.format-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid var(--line, var(--border));
  border-radius: 8px;
  cursor: pointer;
}
.format-option:has(input:checked) { border-color: var(--kb); background: var(--klein-50); }
.format-option span { display: grid; gap: 3px; }
.format-option small { color: var(--text-sub); line-height: 1.4; }
.txt-fields { margin-top: 14px; font-size: 13px; }
.preset-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.preset-row .btn { padding: 6px 8px; font-size: 12px; }
.field-check { display: inline-flex; align-items: center; gap: 4px; margin: 4px 12px 4px 0; }
textarea.input { resize: vertical; font-family: Consolas, monospace; }

.reg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--text-sub);
}
.reg-hint {
  margin: 8px 0 12px;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}
.reg-status {
  padding: 12px;
  border-radius: 8px;
  background: var(--kb-lighter, #eef4ff);
  font-size: 13px;
  margin-bottom: 10px;
}
.reg-status.running { background: #ecfdf5; }
.reg-current { margin-top: 4px; color: var(--text-sub); }
.reg-counts { margin-top: 4px; font-weight: 600; }
.reg-batches { margin-top: 16px; }
.reg-batch-row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(130px, .7fr) minmax(360px, 2fr) minmax(220px, 1fr);
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-700);
  text-align: left;
  cursor: pointer;
}
.reg-batch-row + .reg-batch-row { margin-top: 8px; }
.reg-job-list { margin-top: 10px; padding: 10px; border-radius: 8px; background: var(--bg); }
.reg-job-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 90px 50px minmax(150px, .7fr) minmax(220px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.reg-job-row code { color: var(--danger); }
@media (max-width: 900px) {
  .reg-batch-row, .reg-job-row { grid-template-columns: 1fr; }
}
</style>
