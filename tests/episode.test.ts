/**
 * 离场快照（episode）的单测。
 *
 * 钉三件事：
 *  1. **流程噪声不许进摘要/向量**——询问卡回退文本、切换提示、纯数字选项；
 *  2. 送进向量的文本是"摘要在前 + 最后两轮在后"，且不超过 embedding 的输入上限；
 *  3. 快照块参与 vmax/support，但**不进 bg**（否则长会话的背景分被摊平，快照白做）。
 */
import {
  buildEpisodePrompt,
  cleanEpisodeSummary,
  episodeVectorText,
  isFlowNoise,
} from '../src/core/episode.ts';
import { scoreSessionChunks, type IndexChunk } from '../src/core/sessionIndex.ts';
import type { ChatMessage } from '../src/core/sessionHistory.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('isFlowNoise');

{
  const noisy = [
    '已切到《树莓派 AI 问答机落地》。',
    '已从《旧金山行程》切到《树莓派》，这条提问装在这里',
    '已退回《默认会话》。',
    '已处理完成',
    '话题判定：不可用（超时），直接发送',
    '好，就在当前话题里回答…',
    '留在当前',
    '以上都不是',
    '看看全部话题',
    '不切',
    '2',
    '1',
  ];
  for (const t of noisy) check(`噪声：${t}`, isFlowNoise(t), `被判成有效内容`);
}

{
  const real = [
    '树莓派的摄像头换成 ToF 了，你看看还差什么',
    '我昨天买了 3 个模块，其中一个坏的',
    '日本行第二天的酒店还没定',
    '换个思路，ESP32 保留但摄像头换成 ToF',
  ];
  for (const t of real) check(`有效：${t}`, !isFlowNoise(t), '被误判成噪声');
  check('system 一律排除（压缩节点没有正文）', isFlowNoise('任何内容', 'system'));
  check('空文本排除', isFlowNoise('   '));
}

console.log('episodeVectorText');

{
  const text = episodeVectorText('在聊树莓派 AI 问答机的落地，摄像头方案待定。', [
    '用户：摄像头用 ToF 还是普通？\n助手：ToF 更稳，但贵一些',
  ]);
  check('摘要排在最前', text.startsWith('在聊树莓派'), text.slice(0, 40));
  check('最后两轮原文跟在后面', text.includes('助手：ToF 更稳'));
  const long = episodeVectorText('x'.repeat(2000), ['y'.repeat(2000)]);
  check('总长不超过 embedding 上限 1200', long.length === 1200, String(long.length));
  check('只有摘要也成立', episodeVectorText('只有摘要', []) === '只有摘要');
}

console.log('buildEpisodePrompt');

{
  const msgs: ChatMessage[] = [
    { role: 'user', text: '树莓派 3b 的摄像头换成 ToF 行不行', at: '' },
    { role: 'assistant', text: '可以，接线要改，我给你列一下', at: '' },
  ];
  const p = buildEpisodePrompt(msgs);
  check('要求保留专名', p.includes('专名'));
  check('要求写结论而不是过程', p.includes('结论'));
  check('带上用户消息原文', p.includes('用户：树莓派 3b'));
  check('带上助手消息原文', p.includes('助手：可以，接线要改'));
  check('不要求输出标题（这是检索用摘要，不是会话卡）', !p.includes('标题：'));
}

console.log('cleanEpisodeSummary');

{
  check('去「摘要：」标签', cleanEpisodeSummary('摘要：在聊树莓派落地') === '在聊树莓派落地');
  check('去 markdown 强调', cleanEpisodeSummary('**在聊** `树莓派`') === '在聊 树莓派');
  check('压成一行', cleanEpisodeSummary('第一句。\n\n第二句。') === '第一句。 第二句。');
  const long = cleanEpisodeSummary('字'.repeat(400));
  check('超过 160 字截断并加省略号', long.length === 161 && long.endsWith('…'), String(long.length));
  check('空输出保持为空（调用方据此跳过）', cleanEpisodeSummary('   ') === '');
}

console.log('scoreSessionChunks（episode 不进 bg）');

{
  const mk = (role: IndexChunk['role'], vec: number[]): IndexChunk => ({
    key: `${role}-${vec.join('-')}`,
    sid: 's1',
    role,
    text: role,
    vec,
  });
  // 查询向量 [1,0]：user 块完全一致（1），episode 块正交（0）
  const { vmax, bg } = scoreSessionChunks([1, 0], [mk('user', [1, 0]), mk('episode', [0, 1])]);
  check('vmax 取最像的块（两条都参与）', vmax === 1, String(vmax));
  check('bg 只统计普通块（episode 不摊平背景）', bg === 1, String(bg));
}

{
  const only = scoreSessionChunks([1, 0], [
    { key: 'ep', sid: 's1', role: 'episode', text: 'ep', vec: [1, 0] },
  ]);
  check('只有快照时不出现 NaN（bg 回落到快照本身）', only.bg === 1, String(only.bg));
}

console.log('');

if (fail) {
  console.error(`episode：${pass} 通过，${fail} 失败`);
  process.exit(1);
}
console.log(`episode：${pass} 通过`);
