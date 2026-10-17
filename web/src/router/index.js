import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '控制台', subtitle: '账号与邮箱运营总览' } },
      { path: 'global-extract', name: 'global-extract', component: () => import('../views/GlobalExtract.vue'), meta: { title: '全球提链', subtitle: '国家与支付方式通道状态' } },
      { path: 'accounts', name: 'accounts', component: () => import('../views/Accounts.vue'), meta: { title: '账号管理(GB)', subtitle: 'GB PayPal 批量注册、导入导出与维护', channel: 'gb' } },
      { path: 'accounts-gc', name: 'accounts-gc', component: () => import('../views/Accounts.vue'), meta: { title: '账号管理(GC)', subtitle: 'GCash 批量注册、出码与支付墙', channel: 'gc' } },
      { path: 'syncs', name: 'syncs', component: () => import('../views/Syncs.vue'), meta: { title: '账号同步', subtitle: '已传送普通号与已上架 PLUS' } },
      { path: 'emails', name: 'emails', component: () => import('../views/Emails.vue'), meta: { title: '邮箱管理', subtitle: '母号与子号' } },
      { path: 'domain-stats', name: 'domain-stats', component: () => import('../views/DomainStats.vue'), meta: { title: '域名统计', subtitle: '按邮箱后缀看注册、试用与支付成功率' } },
      { path: 'logs', name: 'logs', component: () => import('../views/Logs.vue'), meta: { title: '运行日志', subtitle: '拉子号、注册、提链与开通记录' } },
      { path: 'settings', name: 'settings', component: () => import('../views/Settings.vue'), meta: { title: '个人设置', subtitle: '授权、代理、域名与 mail.com 后缀' } },
      { path: 'admin/users', name: 'admin-users', component: () => import('../views/admin/Users.vue'), meta: { title: '用户管理', subtitle: '账号、套餐与权限', admin: true } },
      { path: 'admin/plans', name: 'admin-plans', component: () => import('../views/admin/Plans.vue'), meta: { title: '套餐配置', subtitle: '等级、限额与时长', admin: true } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login' };
  }
  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'dashboard' };
  }
  if (to.meta.admin && !auth.isAdmin) {
    return { name: 'dashboard' };
  }
  document.title = to.meta.title ? `${to.meta.title} - GPT-Plus 控制台` : 'GPT-Plus 控制台';
});

export default router;
