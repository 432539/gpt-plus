import axios from 'axios';
import router from '../router';
import { useAuthStore } from '../stores/auth';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

api.interceptors.request.use((config) => {
  const auth = useAuthStore();
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response?.status === 401) {
      const auth = useAuthStore();
      auth.logout();
      if (router.currentRoute.value.name !== 'login') {
        router.push({ name: 'login' });
      }
    }
    const message = err.response?.data?.message || '网络错误,请稍后重试';
    return Promise.reject(new Error(message));
  }
);

export default api;
