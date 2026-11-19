"""队列积压监控 —— 防「worker 静默死亡」无人察觉。

背景 (2026-10-06)
-----------------
2026-10-05 夜里 worker 进程死亡, pidfile 丢失, 守护链断裂。
结果: 队列 18 条任务 pending, 队首等了 23.8 小时。
而健康检查一直在返回 ok:true —— 因为 app.py 本身活得好好的,
队列积压它压根不看。pi 那边写入无感(入队即返回),
读记忆也正常, 于是整整一天没人发现新记忆全都没被抽取。

这类故障的特征是「症状全无」: 不是崩, 是慢慢积压。
所以必须在积压超过阈值时主动喊人, 而不是等人来看。

判定规则
--------
- pending 数 >= min_pending 且 最老 pending 等待 >= min_age_sec → 告警
- 单条任务正常耗时几十秒到几分钟, 给足 30 分钟宽限, 避免误报
- 同一状态只告警一次, 恢复后重置 (防刷屏)
"""
import json
import time
import urllib.request

import queue_db

# 默认: 积压 >=5 条 且 队首等了 >=30 分钟 → 告警
DEFAULT_MIN_PENDING = 5
DEFAULT_MIN_AGE_SEC = 1800
# 告警冷却: 同一轮积压最多每 30 分钟提醒一次
ALERT_COOLDOWN_SEC = 1800

_last_alert_at = 0.0
_alerting = False


def check(cfg: dict) -> dict:
    """检查队列健康。返回 {level, ...}。level: ok | warn"""
    q = cfg.get("queue_alert") or {}
    if q.get("enabled", True) is False:
        return {"level": "ok", "skipped": True}

    min_pending = int(q.get("min_pending", DEFAULT_MIN_PENDING))
    min_age = float(q.get("min_age_sec", DEFAULT_MIN_AGE_SEC))

    st = queue_db.stats()
    pending = int(st.get("pending", 0))
    oldest = float(st.get("oldest_pending_age", 0.0))
    running = int(st.get("running", 0))

    out = {"pending": pending, "running": running,
           "oldest_pending_age": oldest,
           "threshold_pending": min_pending, "threshold_age_sec": min_age}

    # worker 是否在消费 —— running>0 说明有人在干活, 积压属正常消化中
    if pending >= min_pending and oldest >= min_age and running == 0:
        out["level"] = "warn"
        out["reason"] = (f"抽取队列积压: {pending} 条待处理, "
                         f"队首已等 {oldest / 60:.0f} 分钟, 且无任务在跑")
    else:
        out["level"] = "ok"
    return out


def maybe_alert(cfg: dict, result: dict):
    """按冷却策略发送飞书告警。返回 True 表示本次真的发了。"""
    global _last_alert_at, _alerting
    if result.get("level") != "warn":
        _alerting = False      # 恢复, 允许下次再报
        return False

    now = time.time()
    if _alerting and now - _last_alert_at < ALERT_COOLDOWN_SEC:
        return False

    q = cfg.get("queue_alert") or {}
    hook = q.get("webhook")
    if not hook:
        print(f"[queue-alert] {result.get('reason')} (未配置 webhook, 仅打日志)")
        _alerting = True
        _last_alert_at = now
        return False

    text = (f"⚠️ pi 记忆抽取队列积压\n{result.get('reason')}\n"
            f"队列: pending={result['pending']} running={result['running']}\n"
            f"请检查 worker 进程: pgrep -f worker.py\n"
            f"日志: logs/memory-worker.log")
    body = json.dumps({"msg_type": "text", "content": {"text": text}}).encode()
    req = urllib.request.Request(hook, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5).read()
        print(f"[queue-alert] 已推送飞书告警: {result.get('reason')}")
        _alerting = True
        _last_alert_at = now
        return True
    except Exception as e:
        print(f"[queue-alert] 推送失败: {type(e).__name__}: {e}")
        return False
