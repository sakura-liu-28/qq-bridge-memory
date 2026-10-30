import fs from 'node:fs';
import path from 'node:path';

// Account bindings are operator data, never a property of a published persona.
export function loadPersonalSettings(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'config.personal.json'), 'utf8'));
    if (value?.version !== 1 || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid format');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1 };
    throw new Error('个人配置读取失败，已停止加载以保护原权限；请检查 config.personal.json');
  }
}

export function protectedAccounts(config, personal = {}) {
  return [...new Set([config?.ownerQQ, ...(personal.privacy?.protectedQQs || [])]
    .map(value => String(value ?? '').trim().replace(/^0+/, '')).filter(value => /^[1-9]\d*$/.test(value)))];
}

export function personalRolePrompt(personal, role, key) {
  const policy = Object.hasOwn(personal.rolePolicies || {}, role || '') ? personal.rolePolicies[role] : null;
  const scoped = Object.hasOwn(policy?.sessionPrompts || {}, key || '') ? policy.sessionPrompts[key] : '';
  return [policy?.prompt, scoped].filter(value => typeof value === 'string' && value.trim()).join('\n');
}
