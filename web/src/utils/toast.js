import { reactive } from 'vue';

export const toasts = reactive([]);

let seq = 0;

function push(text, type) {
  const id = ++seq;
  toasts.push({ id, text, type });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 2600);
}

export const toast = {
  success: (text) => push(text, 'success'),
  error: (text) => push(text, 'error'),
};
