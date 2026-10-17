<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">
        <div class="brand__logo">G+</div>
        <div>
          <div class="login-title">GPT-Plus 管理控制台</div>
          <div class="brand__subtitle" style="color: var(--klein-200)">Enterprise Console</div>
        </div>
      </div>
      <p class="login-sub">请输入账号与密码登录控制台</p>
      <div v-if="error" class="login-error">{{ error }}</div>
      <label class="field">
        <span>账号</span>
        <input v-model.trim="username" class="field-input" type="text" placeholder="用户名" autocomplete="username" autofocus />
      </label>
      <label class="field">
        <span>密码</span>
        <input v-model="password" class="field-input" type="password" placeholder="密码" autocomplete="current-password" />
      </label>
      <button class="btn" type="submit" :disabled="loading">{{ loading ? '登录中...' : '登录' }}</button>
      <p class="login-oss">
        开源地址
        <a href="https://github.com/432539/gpt-plus" target="_blank" rel="noopener noreferrer">github.com/432539/gpt-plus</a>
        · QQ 群 1109037692
      </p>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function submit() {
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await api.post('/auth/login', {
      username: username.value,
      password: password.value,
    });
    auth.setSession(data.token, data.user);
    router.push({ name: 'dashboard' });
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  position: relative;
  overflow: hidden;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background:
    radial-gradient(900px 520px at 12% 8%, rgba(80, 130, 255, 0.38), transparent 55%),
    radial-gradient(760px 520px at 88% 96%, rgba(20, 190, 235, 0.22), transparent 55%),
    linear-gradient(150deg, #001a63 0%, #001038 55%, #00071d 100%);
}
.login-wrap::before,
.login-wrap::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  filter: blur(24px);
}
.login-wrap::before {
  width: 540px;
  height: 540px;
  top: -180px;
  right: -140px;
  background: radial-gradient(circle, rgba(100, 145, 255, 0.30), transparent 62%);
}
.login-wrap::after {
  width: 460px;
  height: 460px;
  bottom: -170px;
  left: -120px;
  background: radial-gradient(circle, rgba(0, 170, 220, 0.22), transparent 62%);
}
.login-card {
  position: relative;
  z-index: 1;
  width: 400px;
  max-width: 100%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.05) 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 16px;
  box-shadow: 0 30px 80px rgba(0, 8, 40, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  padding: 34px 32px;
  color: #eaf0ff;
}
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.login-title { font-size: 18px; color: #fff; letter-spacing: 0.2px; }
.login-sub { color: rgba(203, 216, 248, 0.8); font-size: 13px; margin: 2px 0 24px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.field > span { font-size: 12px; font-weight: 500; color: rgba(212, 224, 252, 0.92); }
.field-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.20);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
  color: #fff;
  font-family: inherit;
  outline: none;
}
.field-input::placeholder { color: rgba(203, 216, 248, 0.52); }
.field-input:focus {
  border-color: rgba(125, 165, 255, 0.75);
  box-shadow: 0 0 0 3px rgba(95, 135, 255, 0.28);
  background: rgba(255, 255, 255, 0.14);
}
.login-card .btn {
  width: 100%;
  padding: 12px;
  margin-top: 4px;
  font-size: 15px;
  background: linear-gradient(180deg, #3068ff 0%, #1a48d1 100%);
  box-shadow: 0 12px 26px rgba(20, 60, 200, 0.48);
}
.login-card .btn:hover { background: linear-gradient(180deg, #4076ff 0%, #2251e2 100%); }
.login-oss {
  margin: 16px 0 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(203, 216, 248, 0.72);
}
.login-oss a {
  color: #c8d8ff;
  text-decoration: none;
}
.login-oss a:hover { text-decoration: underline; }
.login-error {
  background: rgba(220, 38, 38, 0.20);
  border: 1px solid rgba(248, 113, 113, 0.42);
  color: #fecaca;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 16px;
}
@media (max-width: 480px) {
  .login-card { padding: 28px 20px; }
}
</style>
