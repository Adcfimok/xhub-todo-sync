<script setup lang="ts">
// 大类面板的加载占位：面板按需加载（见 SettingsView.vue 头部说明），
// 切换大类时先显示它，避免右侧短暂空白。
// 本地 chunk 通常毫秒级加载完 —— 配合左栏悬停预加载，实际几乎看不到它。
</script>

<template>
  <div class="panel-loading" aria-hidden="true">
    <span v-for="i in 3" :key="i" class="pl-row">
      <span class="pl-name"></span>
      <span class="pl-ctl"></span>
    </span>
  </div>
</template>

<style scoped>
/* 与真实设置项行同构（左标题、右控件），加载完成时视觉不跳 */
.panel-loading {
  padding: 4px 0;
}
.pl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 0;
  border-bottom: 1px solid var(--border-soft);
}
.pl-row:first-child {
  border-top: 1px solid var(--border-soft);
}
.pl-name,
.pl-ctl {
  border-radius: 6px;
  background: var(--bg-card-soft);
}
.pl-name {
  width: 132px;
  height: 12px;
}
.pl-ctl {
  width: 76px;
  height: 22px;
}
</style>
