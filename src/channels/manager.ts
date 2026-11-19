import { loadAllWakers } from '../core/registry.ts';
import { FeishuChannel } from './feishu.ts';
import type { Channel, ChannelStatus } from './types.ts';

/**
 * 渠道管理器：按各 profile 的 `channels` 配置构建并启动渠道。
 *
 * 与"员工 / 会话"同属平台对象，但生命周期独立——它是进程级单例，
 * 看板（网关）启动时一并拉起，无需单独的飞书 bot 进程。
 */
class ChannelManager {
  private channels: Channel[] = [];

  /**
   * 依据当前 profile 配置重建渠道列表（先停旧的，可反复调用）。
   *
   * 这里要挡一件事：**同一个 appId 被两个员工配了**。飞书一个应用只该有一条长连接
   * 在收事件，多开会互相争抢（要么都回造成重复，要么随机一方回造成"谁答不确定"）。
   * 第一个占用的员工正常启动，其余标记为错误并在看板/CLI 里明示——比让它悄悄抢要好。
   */
  async rebuild(): Promise<void> {
    await this.stopAll();
    const next: Channel[] = [];
    const ownerOfApp = new Map<string, string>();
    for (const rec of loadAllWakers()) {
      const fs = rec.def.channels?.feishu;
      if (!fs?.enabled) continue;
      const appId = fs.appId?.trim();
      let conflict: string | undefined;
      // 只有"配齐了 appId + appSecret、真的连得上"的才占用名额：
      // 否则一个配置不全的重复项会把名额占走，让能跑的那个反而起不来。
      if (appId && fs.appSecret) {
        const owner = ownerOfApp.get(appId);
        if (owner) conflict = owner;
        else ownerOfApp.set(appId, rec.def.id);
      }
      next.push(new FeishuChannel(rec, fs, conflict));
    }
    this.channels = next;
  }

  /** 启动全部渠道。单个失败不影响其他渠道。 */
  async startAll(): Promise<ChannelStatus[]> {
    for (const c of this.channels) {
      try {
        await c.start();
      } catch (e) {
        console.error(`[channels] ${c.wakerId} 启动失败:`, (e as Error)?.message ?? e);
      }
    }
    return this.statuses();
  }

  async stopAll(): Promise<void> {
    for (const c of this.channels) {
      try {
        await c.stop();
      } catch {
        /* 停止异常忽略，避免影响其他渠道 */
      }
    }
  }

  statuses(): ChannelStatus[] {
    return this.channels.map((c) => c.status());
  }

  /**
   * 主动推送到某个外部会话（待办执行结果回发）。
   *
   * 按**员工**找渠道，而不是按 appId：`externalKey` 只说明"发到哪个飞书会话"，
   * 不关心是哪个应用在发。找不到渠道就返回 false，调用方降级为只写日志。
   */
  async notify(wakerId: string, externalKey: string, text: string): Promise<boolean> {
    const ch = this.channels.find(
      (c) => c.notify && (c.wakerId === wakerId || c.status().agentId === wakerId),
    );
    if (!ch?.notify) return false;
    try {
      return await ch.notify(externalKey, text);
    } catch (e) {
      console.error('[channels] 主动推送失败:', (e as Error)?.message ?? e);
      return false;
    }
  }

  /** 便捷入口：重建并启动，返回最终状态。 */
  async sync(): Promise<ChannelStatus[]> {
    await this.rebuild();
    return this.startAll();
  }
}

export const channelManager = new ChannelManager();
