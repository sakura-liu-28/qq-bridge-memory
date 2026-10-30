import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SENSITIVE_RE } from './sensitive.js';
import { synthesizeVolcengine } from './volcengine-tts.js';
import { synthesizeFreeSpeech } from './bailian-tts.js';
import { FreeQuotaExhausted, getFreeModelPool } from './free-model-pool.js';

const run = promisify(execFile);
const PYTHON = `import asyncio, sys
from pathlib import Path
import edge_tts
async def main():
    text = Path(sys.argv[1]).read_text(encoding='utf-8')
    await edge_tts.Communicate(text, voice=sys.argv[3], rate=sys.argv[4]).save(sys.argv[2])
asyncio.run(main())`;

// Only administrator configuration chooses the executable, voice and directory.
// Model input is plain text; it never becomes shell code or a filesystem path.
export async function synthesizeSpeech({ text, config, root, secrets = [], style = 'natural' }) {
  const tts = config.socialV2?.voice?.tts;
  if (config.socialV2?.voice?.enabled === false || config.socialV2?.tools?.sendVoice === false || tts?.enabled !== true || !['edge', 'volcengine'].includes(tts.provider)) {
    throw new Error('在线语音未启用');
  }
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new Error('语音内容不能为空');
  if (SENSITIVE_RE.test(spoken) || /\bsk-[A-Za-z0-9_-]{16,}/i.test(spoken) || secrets.some((s) => s && spoken.includes(s))) {
    throw new Error('语音内容疑似含凭据或内部信息，已阻止合成');
  }
  const voice = tts.provider === 'volcengine' ? (tts.voice || 'zh_female_tianmeitaozi_uranus_bigtts') : (tts.voice ?? 'zh-CN-XiaoxiaoNeural');
  const rate = tts.rate ?? '+0%';
  if (tts.provider === 'edge') {
    if (!/^zh-CN-[A-Za-z]+Neural$/.test(voice) || !/^[+-]\d{1,2}%$/.test(rate)) throw new Error('在线音色或语速配置无效');
    if (!path.isAbsolute(tts.pythonPath ?? '')) throw new Error('请配置语音专用 Python 环境');
  }
  const directory = path.resolve(root, config.socialV2.voice.dir ?? 'audio');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = `.tts-${randomUUID()}`;
  const input = path.join(directory, `${stem}.txt`);
  let file = path.join(directory, `${stem}.mp3`);
  const cleanup = () => fs.rm(file, { force: true });
  const started = Date.now();
  console.error(`[tts] start chars=${spoken.length} voice=${voice}`);
  try {
    if (tts.provider === 'volcengine') {
      const fallback = tts.freeFallback;
      const maxBytes = config.socialV2.voice.maxBytes ?? 20971520;
      const primary = { provider: 'volcengine', model: tts.voice ? `voice-chain:${tts.voice}` : 'seed-tts-2.0/peach' };
      const pool = getFreeModelPool('voice-primary', fallback?.quotaStatePath);
      let audio;
      try {
        if (pool.state.exhausted[`${primary.provider}/${primary.model}`]) throw new FreeQuotaExhausted();
        audio = await synthesizeVolcengine({ text: spoken, tts, maxBytes, style });
      } catch (error) {
        if (!(error instanceof FreeQuotaExhausted) || fallback?.enabled !== true) throw error;
        await pool.markExhausted(primary);
        console.error('[tts] configured voices quota exhausted; using protected free voice');
        audio = await synthesizeFreeSpeech({ text: spoken, settings: fallback, maxBytes });
        file = path.join(directory, `${stem}.wav`);
      }
      await fs.writeFile(file, audio, { mode: 0o600, flag: 'wx' });
    } else {
      await fs.writeFile(input, spoken, { mode: 0o600, flag: 'wx' });
      await run(tts.pythonPath, ['-c', PYTHON, input, file, voice, rate], { timeout: 45000, maxBuffer: 65536 });
    }
    const { size } = await fs.stat(file);
    if (!size || size > (config.socialV2.voice.maxBytes ?? 20971520)) throw new Error('合成音频为空或超出大小限制');
    await fs.chmod(file, 0o600);
    console.error(`[tts] ready bytes=${size} elapsedMs=${Date.now() - started}`);
    return { file, name: path.basename(file), cleanup };
  } catch (error) {
    await cleanup();
    // Do not echo subprocess stderr: it may contain the input text or local paths.
    console.error(`[tts] failed code=${String(error?.code ?? 'invalid-audio').slice(0, 40)}`);
    throw new Error('在线语音生成失败或超时，请稍后重试；可以先用文字回复');
  } finally {
    await fs.rm(input, { force: true });
  }
}
