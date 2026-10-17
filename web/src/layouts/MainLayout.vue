<template>
  <div class="shell" :class="{ 'nav-open': navOpen }" @click="menuOpen = false">
    <div class="sidebar-backdrop" @click="navOpen = false"></div>
    <aside class="sidebar">
      <div class="sidebar__brand">
        <div class="brand__logo">G+</div>
        <div>
          <div class="brand__title">GPT-Plus</div>
          <div class="brand__subtitle">Console</div>
        </div>
      </div>
      <nav class="sidebar__nav">
        <template v-for="group in menuGroups" :key="group.label">
          <div class="nav__group-label">{{ group.label }}</div>
          <router-link
            v-for="m in group.items"
            :key="m.to"
            :to="m.to"
            class="nav__item"
            active-class=""
            exact-active-class="router-link-active"
            @click="navOpen = false"
          >
            <span v-html="m.icon"></span>
            <span>{{ m.label }}</span>
          </router-link>
        </template>
      </nav>
      <div class="sidebar__foot">
        <div>GPT-Plus</div>
        <div>多用户账号与邮箱管理</div>
        <a class="sidebar__oss" href="https://github.com/432539/gpt-plus" target="_blank" rel="noopener noreferrer">开源 github.com/432539/gpt-plus</a>
        <div>QQ 群 1109037692</div>
      </div>
    </aside>

    <div class="main" :class="{ 'main--logs': route.name === 'logs' }">
      <header class="topbar">
        <div class="topbar__left">
          <button class="nav-toggle" type="button" aria-label="菜单" @click="navOpen = true">
            <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div>
            <h1 class="topbar__title">{{ pageTitle }}</h1>
            <p class="topbar__subtitle">{{ pageSubtitle }}</p>
          </div>
        </div>
        <div class="topbar__right">
          <span class="status-pill"><span class="status-dot"></span> 系统运行中</span>
          <div style="position: relative">
            <button class="user-chip" type="button" @click.stop="menuOpen = !menuOpen">
              <span class="user-avatar">{{ initial }}</span>
              <span>{{ auth.user?.username }}</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div v-show="menuOpen" class="dropdown" @click.stop>
              <button class="dropdown__item" type="button" @click="goSettings">个人设置</button>
              <button class="dropdown__item dropdown__item--danger" type="button" @click="logout">退出登录</button>
            </div>
          </div>
        </div>
      </header>
      <main class="page" :class="{ 'page--logs': route.name === 'logs' }">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const navOpen = ref(false);
const menuOpen = ref(false);

const pageTitle = computed(() => route.meta.title || 'GPT-Plus');
const pageSubtitle = computed(() => route.meta.subtitle || '');
const initial = computed(() => (auth.user?.username?.[0] || 'A').toUpperCase());

const svg = {
  dash: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/></svg>',
  account: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
  mail: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>',
  gear: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
  users: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>',
  plan: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2L3 7v10l9 5 9-5V7l-9-5z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>',
  log: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h10"/></svg>',
  chart: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 19V5M4 19h16M8 17V11M12 17V8M16 17v-4"/></svg>',
  sync: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6M20 20v-6h-6M5 19A9 9 0 0019 8M19 5A9 9 0 005 16"/></svg>',
  globe: '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>',
};

const menuGroups = computed(() => {
  const groups = [
    { label: '总览', items: [
      { to: '/dashboard', label: '控制台', icon: svg.dash },
      { to: '/global-extract', label: '全球提链', icon: svg.globe },
    ] },
    {
      label: '资源管理',
      items: [
        { to: '/accounts', label: '账号管理(GB)', icon: svg.account },
        { to: '/accounts-gc', label: '账号管理(GC)', icon: svg.account },
        { to: '/syncs', label: '账号同步', icon: svg.sync },
        { to: '/emails', label: '邮箱管理', icon: svg.mail },
        { to: '/domain-stats', label: '域名统计', icon: svg.chart },
      ],
    },
    { label: '系统', items: [
      { to: '/logs', label: '运行日志', icon: svg.log },
      { to: '/settings', label: '个人设置', icon: svg.gear },
    ] },
  ];
  if (auth.isAdmin) {
    groups[2].items.push(
      { to: '/admin/users', label: '用户管理', icon: svg.users },
      { to: '/admin/plans', label: '套餐配置', icon: svg.plan }
    );
  }
  return groups;
});

watch(() => route.path, () => { menuOpen.value = false; navOpen.value = false; });

function goSettings() {
  menuOpen.value = false;
  router.push({ name: 'settings' });
}
function logout() {
  menuOpen.value = false;
  auth.logout();
  router.push({ name: 'login' });
}
</script>
