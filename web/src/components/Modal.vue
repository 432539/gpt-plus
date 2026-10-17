<template>
  <Teleport to="body">
    <div v-if="show" class="modal-mask" @click.self="$emit('close')">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">{{ title }}</div>
          <button class="modal-close" aria-label="关闭" @click="$emit('close')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="$emit('close')">取消</button>
          <button class="btn" :class="{ 'btn-danger-fill': danger }" :disabled="loading" @click="$emit('confirm')">
            {{ loading ? '提交中...' : confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
defineProps({
  show: Boolean,
  title: String,
  loading: Boolean,
  confirmText: { type: String, default: '确定' },
  danger: { type: Boolean, default: false },
});
defineEmits(['close', 'confirm']);
</script>
