<template>
  <router-view />
  <ConfirmDialog />
  <div class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
  </div>
</template>

<script setup>
import { toasts } from './utils/toast';
import ConfirmDialog from './components/ConfirmDialog.vue';
</script>
