<template>
  <Teleport to="body">
    <div
      v-if="confirmState.show"
      class="modal-mask confirm-mask"
      @click.self="rejectConfirm"
    >
      <div
        class="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        @keydown.esc.prevent="rejectConfirm"
        @keydown.enter.prevent="resolveConfirm"
      >
        <div class="modal-head">
          <div class="modal-title">{{ confirmState.title }}</div>
          <button class="modal-close" type="button" aria-label="关闭" @click="rejectConfirm">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <p class="confirm-message">{{ confirmState.message }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" type="button" @click="rejectConfirm">
            {{ confirmState.cancelText }}
          </button>
          <button
            class="btn"
            :class="{ 'btn-danger-fill': confirmState.danger }"
            type="button"
            @click="resolveConfirm"
          >
            {{ confirmState.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { watch, nextTick } from 'vue';
import { confirmState, resolveConfirm, rejectConfirm } from '../utils/confirm';

watch(
  () => confirmState.show,
  async (show) => {
    if (!show) return;
    await nextTick();
    document.querySelector('.confirm-modal')?.focus();
  }
);
</script>
