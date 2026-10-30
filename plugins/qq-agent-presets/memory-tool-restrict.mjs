export const name = 'memory-tool-restrict';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '记忆整理会话不允许使用工具');
}
