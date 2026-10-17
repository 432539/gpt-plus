import { reactive } from 'vue';

const defaults = {
  show: false,
  title: '请确认',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
};

export const confirmState = reactive({ ...defaults });

let resolver = null;

function settle(ok) {
  confirmState.show = false;
  const resolve = resolver;
  resolver = null;
  resolve?.(Boolean(ok));
}

export function confirmDialog(options = {}) {
  const opts = typeof options === 'string' ? { message: options } : options;
  if (resolver) settle(false);
  return new Promise((resolve) => {
    resolver = resolve;
    Object.assign(confirmState, defaults, opts, { show: true });
  });
}

export function resolveConfirm() {
  settle(true);
}

export function rejectConfirm() {
  settle(false);
}
